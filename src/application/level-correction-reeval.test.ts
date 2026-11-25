import { describe, expect, it, vi } from "vitest";
import {
  LevelHistoryReason,
  LevelScope,
  MatchScoreValue,
  MatchStatus,
  Result,
  SettlementDocStatus,
  SettlementItemStatus,
  SettlementPhase,
  SettlementStatus,
  UserStatus,
} from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type {
  LevelHistoryEntry,
  Match,
  MatchResult,
  Prediction,
  SettlementDoc,
  SettlementItem,
  User,
  UserSeasonStats,
} from "../domain/types.js";
import { defaultLevelState } from "../domain/types.js";
import { InMemoryRepository, type UnitOfWork } from "../infrastructure/repositories.js";
import {
  LEVEL_CORRECTION_REEVAL_LOCK_KEY,
  LevelCorrectionReevalService,
} from "./level-correction-reeval.js";
import {
  buildReplayFacts,
  loadAppliedSettlementFacts,
} from "./rebuild-service-support.js";
import {
  levelScopeLockKey,
  WEEKLY_LEVEL_EVAL_LOCK_KEY,
  WeeklyLevelEvalService,
} from "./weekly-level-eval.js";

const WEEKLY_AS_OF = new Date("2026-08-10T02:00:00.000Z");
const CORRECTION_AS_OF = new Date("2026-08-12T02:00:00.000Z");
const FIRST_EVAL = new Date("2026-08-03T02:00:00.000Z");
const RULE = "scoring_v1";

function makeUser(overrides: Partial<User> = {}): User {
  return {
    schema_version: 1,
    user_id: "u1",
    openid: "openid_u1",
    unionid: null,
    nickname: "User",
    favorite_team_id: null,
    status: UserStatus.Active,
    career_points: 180,
    career_valid_predictions: 15,
    career_wdl_hits: 15,
    career_exact_hits: 15,
    career_level: 4,
    career_best_level: 4,
    career_last_scoring_match_at: null,
    career_level_state: {
      ...defaultLevelState(),
      week_base_level: 3,
      week_base_below_count: 0,
      week_base_as_of: WEEKLY_AS_OF,
      last_eval_as_of: WEEKLY_AS_OF,
      last_eval_n: 15,
      last_eval_score_sum: 180,
      last_eval_b_points: 180,
      last_eval_rule_version: "level_v3.0",
    },
    deleted_at: null,
    created_at: WEEKLY_AS_OF,
    updated_at: WEEKLY_AS_OF,
    ...overrides,
  };
}

function makeSeasonStats(
  userId: string,
  overrides: Partial<UserSeasonStats> = {},
): UserSeasonStats {
  return {
    schema_version: 1,
    user_id: userId,
    level_season_id: "2026_2027",
    points: 180,
    valid_predictions: 15,
    wdl_hits: 15,
    exact_hits: 15,
    last_scoring_match_at: WEEKLY_AS_OF,
    level: 4,
    best_level: 4,
    level_state: {
      ...defaultLevelState(),
      week_base_level: 3,
      week_base_below_count: 0,
      week_base_as_of: WEEKLY_AS_OF,
      last_eval_as_of: WEEKLY_AS_OF,
      last_eval_n: 15,
      last_eval_score_sum: 180,
      last_eval_b_points: 180,
      last_eval_rule_version: "level_v3.0",
    },
    is_level_frozen: false,
    created_at: WEEKLY_AS_OF,
    updated_at: WEEKLY_AS_OF,
    ...overrides,
  };
}

function makeHistory(
  scope: LevelHistoryEntry["scope"],
  fromLevel: number,
  toLevel: number,
): LevelHistoryEntry {
  return {
    schema_version: 1,
    level_history_id: newUuid(),
    user_id: "u1",
    scope,
    level_season_id: scope === LevelScope.Season ? "2026_2027" : null,
    from_level: fromLevel,
    to_level: toLevel,
    reason: LevelHistoryReason.WeeklyEval,
    eval_as_of: WEEKLY_AS_OF,
    window_n: 20,
    window_score_sum: 180,
    b_points: 180,
    level_rule_version: "level_v3.0",
    settlement_id: null,
    changed_at: WEEKLY_AS_OF,
  };
}

async function addAppliedPrediction(
  repo: InMemoryRepository,
  index: number,
  score: MatchScoreValue,
): Promise<void> {
  const matchId = `m${index}`;
  const predictionId = `p${index}`;
  const settlementId = `s${index}`;
  const anchor = new Date(Date.UTC(2026, 7, 1, 0, index, 0));
  const resultHome = score === MatchScoreValue.ExactHit ? 2 : 0;
  const resultAway = score === MatchScoreValue.ExactHit ? 1 : 0;
  const match: Match = {
    schema_version: 1,
    match_id: matchId,
    canonical_match_id: matchId,
    superseded_by: null,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: "home",
    away_team_id: "away",
    kickoff_at: anchor,
    kickoff_confirmed: true,
    prediction_deadline_at: new Date(anchor.getTime() - 600_000),
    prediction_closed_at: new Date(anchor.getTime() - 600_000),
    period_anchor_at: anchor,
    match_status: MatchStatus.Finished,
    settlement_status: SettlementStatus.Settled,
    regular_home_score: resultHome,
    regular_away_score: resultAway,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 1,
    settled_result_version: 1,
    result_source: "provider",
    scoring_rule_version: RULE,
    finish_detected_at: WEEKLY_AS_OF,
    settled_at: WEEKLY_AS_OF,
    created_at: WEEKLY_AS_OF,
    updated_at: WEEKLY_AS_OF,
  };
  const prediction: Prediction = {
    schema_version: 1,
    prediction_id: predictionId,
    user_id: "u1",
    match_id: matchId,
    canonical_match_id: matchId,
    idempotency_key: newUuid(),
    pred_home_score: 2,
    pred_away_score: 1,
    derived_result: Result.Home,
    submitted_at: new Date(anchor.getTime() - 3_600_000),
    scoring_rule_version: RULE,
    match_score: score,
    wdl_hit: score === MatchScoreValue.ExactHit,
    exact_hit: score === MatchScoreValue.ExactHit,
    applied_result_version: 1,
    created_at: WEEKLY_AS_OF,
    updated_at: WEEKLY_AS_OF,
  };
  const result: MatchResult = {
    schema_version: 1,
    match_id: matchId,
    result_version: 1,
    regular_home_score: resultHome,
    regular_away_score: resultAway,
    source: "provider",
    provider_status: "FT",
    admin_id: null,
    reason: null,
    created_at: WEEKLY_AS_OF,
  };
  const settlement: SettlementDoc = {
    schema_version: 1,
    settlement_id: settlementId,
    match_id: matchId,
    result_version: 1,
    rule_version: RULE,
    status: SettlementDocStatus.Settled,
    phase: SettlementPhase.Done,
    is_correction: false,
    started_at: WEEKLY_AS_OF,
    settled_at: WEEKLY_AS_OF,
    attempt_count: 1,
    last_error_code: null,
    last_error_message: null,
    created_at: WEEKLY_AS_OF,
    updated_at: WEEKLY_AS_OF,
  };
  const item: SettlementItem = {
    schema_version: 1,
    settlement_id: settlementId,
    prediction_id: predictionId,
    user_id: "u1",
    old_score: MatchScoreValue.Miss,
    new_score: score,
    score_delta: score,
    old_wdl_hit: false,
    new_wdl_hit: score === MatchScoreValue.ExactHit,
    old_exact_hit: false,
    new_exact_hit: score === MatchScoreValue.ExactHit,
    valid_prediction_delta: 1,
    source_result_version: 1,
    status: SettlementItemStatus.Applied,
    applied_at: new Date("2026-08-09T23:00:00.000Z"),
    attempt_count: 1,
    last_error_code: null,
    last_error_message: null,
    created_at: WEEKLY_AS_OF,
    updated_at: WEEKLY_AS_OF,
  };

  await repo.matches.insert(match);
  await repo.predictions.insert(prediction);
  await repo.matchResults.insert(result);
  await repo.settlements.insert(settlement);
  await repo.settlementItems.insert(item);
}

async function seedCorrection(
  downward: boolean,
  frozen = false,
  options: { zeroDelta?: boolean } = {},
) {
  const zeroDelta = options.zeroDelta === true;
  const repo = new InMemoryRepository();
  const user = makeUser({
    career_points: downward ? 168 : 180,
    career_valid_predictions: 20,
    career_wdl_hits: downward ? 14 : 15,
    career_exact_hits: downward ? 14 : 15,
    career_level: downward ? 4 : 3,
    career_best_level: downward ? 4 : 3,
    career_level_state: {
      ...defaultLevelState(),
      week_base_level: 3,
      week_base_below_count: 0,
      week_base_as_of: WEEKLY_AS_OF,
      last_eval_as_of: WEEKLY_AS_OF,
      last_eval_n: 20,
      last_eval_score_sum: downward ? 180 : 168,
      last_eval_b_points: downward ? 180 : 168,
      last_eval_rule_version: "level_v3.0",
    },
  });
  await repo.users.insert(user);
  for (let index = 0; index < 20; index += 1) {
    const initialScore = downward
      ? index < 15 ? MatchScoreValue.ExactHit : MatchScoreValue.Miss
      : index < 14 ? MatchScoreValue.ExactHit : MatchScoreValue.Miss;
    await addAppliedPrediction(repo, index, initialScore);
  }

  const correctionMatchId = downward ? "m14" : "m19";
  const correctionPredictionId = downward ? "p14" : "p19";
  const correctionSettlementId = "scorrection";
  const match = await repo.matches.findById(correctionMatchId);
  const prediction = await repo.predictions.findById(correctionPredictionId);
  if (match === null || prediction === null) throw new Error("test fixture missing correction target");
  await repo.matchResults.insert({
    schema_version: 1,
    match_id: correctionMatchId,
    result_version: 2,
    regular_home_score: zeroDelta === downward ? 2 : 0,
    regular_away_score: zeroDelta === downward ? 1 : 0,
    source: "admin",
    provider_status: null,
    admin_id: "admin",
    reason: "test correction",
    created_at: CORRECTION_AS_OF,
  });
  await repo.matches.update({
    ...match,
    result_version: 2,
    settled_result_version: 2,
    settled_at: CORRECTION_AS_OF,
    updated_at: CORRECTION_AS_OF,
  });
  await repo.predictions.update({
    ...prediction,
    applied_result_version: 2,
    match_score: zeroDelta
      ? downward ? MatchScoreValue.ExactHit : MatchScoreValue.Miss
      : downward ? MatchScoreValue.Miss : MatchScoreValue.ExactHit,
    wdl_hit: zeroDelta ? downward : !downward,
    exact_hit: zeroDelta ? downward : !downward,
    updated_at: CORRECTION_AS_OF,
  });
  const settlement: SettlementDoc = {
    schema_version: 1,
    settlement_id: correctionSettlementId,
    match_id: correctionMatchId,
    result_version: 2,
    rule_version: RULE,
    status: SettlementDocStatus.Settled,
    phase: SettlementPhase.Done,
    is_correction: true,
    started_at: CORRECTION_AS_OF,
    settled_at: CORRECTION_AS_OF,
    attempt_count: 1,
    last_error_code: null,
    last_error_message: null,
    created_at: CORRECTION_AS_OF,
    updated_at: CORRECTION_AS_OF,
  };
  const correctionItem: SettlementItem = {
    schema_version: 1,
    settlement_id: correctionSettlementId,
    prediction_id: correctionPredictionId,
    user_id: user.user_id,
    old_score: downward ? MatchScoreValue.ExactHit : MatchScoreValue.Miss,
    new_score: zeroDelta
      ? downward ? MatchScoreValue.ExactHit : MatchScoreValue.Miss
      : downward ? MatchScoreValue.Miss : MatchScoreValue.ExactHit,
    score_delta: zeroDelta ? 0 : downward ? -12 : 12,
    old_wdl_hit: downward,
    new_wdl_hit: zeroDelta ? downward : !downward,
    old_exact_hit: downward,
    new_exact_hit: zeroDelta ? downward : !downward,
    valid_prediction_delta: 0,
    source_result_version: 2,
    status: SettlementItemStatus.Applied,
    applied_at: new Date(CORRECTION_AS_OF.getTime() - 1),
    attempt_count: 1,
    last_error_code: null,
    last_error_message: null,
    created_at: CORRECTION_AS_OF,
    updated_at: CORRECTION_AS_OF,
  };
  await repo.settlements.insert(settlement);
  await repo.settlementItems.insert(correctionItem);
  const seasonStats = makeSeasonStats(user.user_id, {
    points: downward ? 168 : 180,
    valid_predictions: 20,
    level: user.career_level,
    best_level: user.career_best_level,
    wdl_hits: user.career_wdl_hits,
    exact_hits: user.career_exact_hits,
    is_level_frozen: frozen,
  });
  await repo.userSeasonStats.insert(seasonStats);
  if (downward) {
    await repo.levelHistory.insert(makeHistory(LevelScope.Career, 3, 4));
  }
  return { repo, user, correctionSettlementId };
}

function reeval(repo: InMemoryRepository): LevelCorrectionReevalService {
  return new LevelCorrectionReevalService(repo, FIRST_EVAL);
}

async function addCorrectionParticipant(
  repo: InMemoryRepository,
  userId: string,
  match: Match,
  settlementId: string,
): Promise<void> {
  await repo.users.insert(makeUser({
    user_id: userId,
    openid: `openid_${userId}`,
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_level: 1,
    career_best_level: 1,
    career_level_state: defaultLevelState(),
  }));
  const predictionId = `p-${userId}`;
  await repo.predictions.insert({
    schema_version: 1,
    prediction_id: predictionId,
    user_id: userId,
    match_id: match.match_id,
    canonical_match_id: match.canonical_match_id,
    idempotency_key: newUuid(),
    pred_home_score: 2,
    pred_away_score: 1,
    derived_result: Result.Home,
    submitted_at: new Date(match.kickoff_at.getTime() - 3_600_000),
    scoring_rule_version: RULE,
    match_score: MatchScoreValue.ExactHit,
    wdl_hit: true,
    exact_hit: true,
    applied_result_version: match.settled_result_version ?? 2,
    created_at: CORRECTION_AS_OF,
    updated_at: CORRECTION_AS_OF,
  });
  await repo.settlementItems.insert({
    schema_version: 1,
    settlement_id: settlementId,
    prediction_id: predictionId,
    user_id: userId,
    old_score: MatchScoreValue.Miss,
    new_score: MatchScoreValue.ExactHit,
    score_delta: 12,
    old_wdl_hit: false,
    new_wdl_hit: true,
    old_exact_hit: false,
    new_exact_hit: true,
    valid_prediction_delta: 1,
    source_result_version: 2,
    status: SettlementItemStatus.Applied,
    applied_at: new Date(CORRECTION_AS_OF.getTime() - 1),
    attempt_count: 1,
    last_error_code: null,
    last_error_message: null,
    created_at: CORRECTION_AS_OF,
    updated_at: CORRECTION_AS_OF,
  });
}

async function addStandaloneCorrection(
  repo: InMemoryRepository,
  params: {
    settlementId: string;
    userId: string;
    settledAt: Date;
    user?: User;
  },
): Promise<void> {
  const { settlementId, userId, settledAt } = params;
  if (params.user !== undefined) await repo.users.insert(params.user);
  const matchId = `match-${settlementId}`;
  const predictionId = `prediction-${settlementId}`;
  const anchor = new Date(settledAt.getTime() - 3_600_000);
  await repo.matches.insert({
    schema_version: 1,
    match_id: matchId,
    canonical_match_id: matchId,
    superseded_by: null,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: "home",
    away_team_id: "away",
    kickoff_at: anchor,
    kickoff_confirmed: true,
    prediction_deadline_at: new Date(anchor.getTime() - 600_000),
    prediction_closed_at: new Date(anchor.getTime() - 600_000),
    period_anchor_at: anchor,
    match_status: MatchStatus.Finished,
    settlement_status: SettlementStatus.Settled,
    regular_home_score: 2,
    regular_away_score: 1,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 2,
    settled_result_version: 2,
    result_source: "provider",
    scoring_rule_version: RULE,
    finish_detected_at: settledAt,
    settled_at: settledAt,
    created_at: settledAt,
    updated_at: settledAt,
  });
  await repo.predictions.insert({
    schema_version: 1,
    prediction_id: predictionId,
    user_id: userId,
    match_id: matchId,
    canonical_match_id: matchId,
    idempotency_key: newUuid(),
    pred_home_score: 2,
    pred_away_score: 1,
    derived_result: Result.Home,
    submitted_at: new Date(anchor.getTime() - 3_600_000),
    scoring_rule_version: RULE,
    match_score: MatchScoreValue.ExactHit,
    wdl_hit: true,
    exact_hit: true,
    applied_result_version: 2,
    created_at: settledAt,
    updated_at: settledAt,
  });
  await repo.matchResults.insert({
    schema_version: 1,
    match_id: matchId,
    result_version: 2,
    regular_home_score: 2,
    regular_away_score: 1,
    source: "provider",
    provider_status: "FT",
    admin_id: null,
    reason: null,
    created_at: settledAt,
  });
  await repo.settlements.insert({
    schema_version: 1,
    settlement_id: settlementId,
    match_id: matchId,
    result_version: 2,
    rule_version: RULE,
    status: SettlementDocStatus.Settled,
    phase: SettlementPhase.Done,
    is_correction: true,
    level_reeval_status: "pending",
    level_reeval_completed_at: null,
    started_at: settledAt,
    settled_at: settledAt,
    attempt_count: 1,
    last_error_code: null,
    last_error_message: null,
    created_at: settledAt,
    updated_at: settledAt,
  });
  await repo.settlementItems.insert({
    schema_version: 1,
    settlement_id: settlementId,
    prediction_id: predictionId,
    user_id: userId,
    old_score: MatchScoreValue.Miss,
    new_score: MatchScoreValue.ExactHit,
    score_delta: 12,
    old_wdl_hit: false,
    new_wdl_hit: true,
    old_exact_hit: false,
    new_exact_hit: true,
    valid_prediction_delta: 1,
    source_result_version: 2,
    status: SettlementItemStatus.Applied,
    applied_at: new Date(settledAt.getTime() - 1),
    attempt_count: 1,
    last_error_code: null,
    last_error_message: null,
    created_at: settledAt,
    updated_at: settledAt,
  });
}

describe("LevelCorrectionReevalService §17.7 / §32.10", () => {
  it("[J73] [J74] [J75] correction 改判当前等级并保留 career_best_level", async () => {
    const { repo, user, correctionSettlementId } = await seedCorrection(true);

    await reeval(repo).runForSettlement(correctionSettlementId, CORRECTION_AS_OF);

    await expect(repo.userSeasonStats.findByUserAndSeason(user.user_id, "2026_2027"))
      .resolves.toMatchObject({ last_scoring_match_at: WEEKLY_AS_OF });

    expect(await repo.users.findById(user.user_id)).toMatchObject({
      career_level: 3,
      career_best_level: 4,
      career_level_state: { week_base_level: 3, week_base_as_of: WEEKLY_AS_OF },
    });
    expect((await repo.levelHistory.findByUser(user.user_id)).filter(
      (entry) => entry.scope === LevelScope.Career,
    )).toEqual([
      expect.objectContaining({ reason: LevelHistoryReason.WeeklyEval, from_level: 3, to_level: 4 }),
      expect.objectContaining({
        reason: LevelHistoryReason.CorrectionReeval,
        from_level: 4,
        to_level: 3,
        eval_as_of: CORRECTION_AS_OF,
        settlement_id: correctionSettlementId,
      }),
    ]);
  });

  it("[L102] correction 改判保留原 weekly_eval history，两种 reason 并存", async () => {
    const { repo, user, correctionSettlementId } = await seedCorrection(true);
    const service = reeval(repo);

    await service.runForSettlement(correctionSettlementId, CORRECTION_AS_OF);
    await service.runForSettlement(correctionSettlementId, CORRECTION_AS_OF);

    expect((await repo.levelHistory.findByUser(user.user_id))
      .filter((entry) => entry.scope === LevelScope.Career)
      .map((entry) => entry.reason))
      .toEqual([LevelHistoryReason.WeeklyEval, LevelHistoryReason.CorrectionReeval]);
  });

  it("[L103] 周一未升级时，修正后只按 week_base 升一级", async () => {
    const { repo, user, correctionSettlementId } = await seedCorrection(false);

    await reeval(repo).runForSettlement(correctionSettlementId, CORRECTION_AS_OF);

    expect(await repo.users.findById(user.user_id)).toMatchObject({
      career_level: 4,
      career_best_level: 4,
      career_level_state: { week_base_level: 3 },
    });
    expect(await repo.levelHistory.findByUser(user.user_id)).toContainEqual(
      expect.objectContaining({
        reason: LevelHistoryReason.CorrectionReeval,
        from_level: 3,
        to_level: 4,
      }),
    );
  });

  it("[L104] 修正后 B 值下降不导致等级下降", async () => {
    const { repo, user, correctionSettlementId } = await seedCorrection(true);
    const current = await repo.users.findById(user.user_id);
    if (current === null) throw new Error("test user missing");
    await repo.users.update({
      ...current,
      career_level: 4,
      career_best_level: 4,
      career_level_state: {
        ...current.career_level_state!,
        week_base_level: 4,
      },
    });
    const season = await repo.userSeasonStats.findByUserAndSeason(user.user_id, "2026_2027");
    if (season !== null) {
      await repo.userSeasonStats.update({ ...season, level: 4, best_level: 4, level_state: {
        ...season.level_state!, week_base_level: 4,
      } });
    }

    await reeval(repo).runForSettlement(correctionSettlementId, CORRECTION_AS_OF);

    expect(await repo.users.findById(user.user_id)).toMatchObject({
      career_level: 4,
      career_best_level: 4,
    });
  });

  it("[L110] frozen season correction 不改赛季等级但仍重评 career", async () => {
    const { repo, user, correctionSettlementId } = await seedCorrection(true, true);
    const season = await repo.userSeasonStats.findByUserAndSeason(user.user_id, "2026_2027");
    if (season === null) throw new Error("test season missing");
    await repo.userSeasonStats.update({ ...season, level: 4, best_level: 4 });

    await reeval(repo).runForSettlement(correctionSettlementId, CORRECTION_AS_OF);

    expect(await repo.userSeasonStats.findByUserAndSeason(user.user_id, "2026_2027"))
      .toMatchObject({ level: 4, best_level: 4, is_level_frozen: true });
    expect(await repo.users.findById(user.user_id)).toMatchObject({ career_level: 3 });
  });

  it("[A-S4-05] 7/1 后未冻结上赛季的修正重评按比赛所属赛季执行", async () => {
    const { repo, user, correctionSettlementId } = await seedCorrection(false);
    const oldSeasonWeeklyAsOf = new Date("2027-06-28T02:00:00.000Z");
    const crossSeasonCorrectionAsOf = new Date("2027-07-02T02:00:00.000Z");
    for (const item of await repo.settlementItems.findByStatus(SettlementItemStatus.Applied)) {
      if (item.settlement_id !== correctionSettlementId) continue;
      await repo.settlementItems.update({
        ...item,
        applied_at: new Date(crossSeasonCorrectionAsOf.getTime() - 1),
      });
    }
    const settlement = await repo.settlements.findById(correctionSettlementId);
    const currentUser = await repo.users.findById(user.user_id);
    const oldSeason = await repo.userSeasonStats.findByUserAndSeason(user.user_id, "2026_2027");
    if (settlement === null || currentUser === null || oldSeason === null) {
      throw new Error("test state missing");
    }
    await repo.settlements.update({
      ...settlement,
      started_at: crossSeasonCorrectionAsOf,
      settled_at: crossSeasonCorrectionAsOf,
      updated_at: crossSeasonCorrectionAsOf,
    });
    const oldSeasonState = {
      ...oldSeason.level_state!,
      week_base_as_of: oldSeasonWeeklyAsOf,
      last_eval_as_of: oldSeasonWeeklyAsOf,
    };
    await repo.users.update({
      ...currentUser,
      career_level_state: {
        ...currentUser.career_level_state!,
        week_base_as_of: oldSeasonWeeklyAsOf,
        last_eval_as_of: oldSeasonWeeklyAsOf,
      },
    });
    await repo.userSeasonStats.update({
      ...oldSeason,
      is_level_frozen: false,
      level_state: oldSeasonState,
      updated_at: oldSeasonWeeklyAsOf,
    });
    await repo.userSeasonStats.insert(makeSeasonStats(user.user_id, {
      level_season_id: "2027_2028",
      points: 0,
      valid_predictions: 0,
      wdl_hits: 0,
      exact_hits: 0,
      last_scoring_match_at: null,
      level: 1,
      best_level: 1,
      level_state: {
        ...defaultLevelState(),
        week_base_as_of: oldSeasonWeeklyAsOf,
        last_eval_as_of: oldSeasonWeeklyAsOf,
      },
      is_level_frozen: false,
    }));

    const outcome = await reeval(repo).runForSettlement(
      correctionSettlementId,
      crossSeasonCorrectionAsOf,
    );

    expect(outcome.kind).toBe("completed");
    expect(outcome.evaluated_count).toBe(2);
    await expect(repo.userSeasonStats.findByUserAndSeason(user.user_id, "2026_2027"))
      .resolves.toMatchObject({
        is_level_frozen: false,
        level_state: { last_eval_as_of: crossSeasonCorrectionAsOf },
      });
    await expect(repo.userSeasonStats.findByUserAndSeason(user.user_id, "2027_2028"))
      .resolves.toMatchObject({
        level_state: { last_eval_as_of: oldSeasonWeeklyAsOf },
      });
  });

  it("[A-S4-05][D-S4-01] score_delta=0 的修正仍进入线上重评与回放事件", async () => {
    const { repo, user, correctionSettlementId } = await seedCorrection(
      true,
      false,
      { zeroDelta: true },
    );
    const applied = await repo.settlementItems.findByStatus(SettlementItemStatus.Applied);
    const replayFacts = buildReplayFacts(await loadAppliedSettlementFacts(repo, applied));

    expect(replayFacts.correctionSettledAts.map((at) => at.getTime()))
      .toContain(CORRECTION_AS_OF.getTime());

    const outcome = await reeval(repo).runForSettlement(
      correctionSettlementId,
      CORRECTION_AS_OF,
    );

    expect(outcome.evaluated_count).toBe(2);
    await expect(repo.users.findById(user.user_id)).resolves.toMatchObject({
      career_level_state: { last_eval_as_of: CORRECTION_AS_OF },
    });
    await expect(repo.userSeasonStats.findByUserAndSeason(user.user_id, "2026_2027"))
      .resolves.toMatchObject({
        level_state: { last_eval_as_of: CORRECTION_AS_OF },
      });
  });

  it("[F3] applied_at 与 settled_at 同刻的修正 item 不进入该 as_of 截面", async () => {
    const { repo, user, correctionSettlementId } = await seedCorrection(false);
    const item = await repo.settlementItems.findBySettlementAndPrediction(
      correctionSettlementId,
      "p19",
    );
    if (item === null) throw new Error("correction item missing");
    await repo.settlementItems.update({ ...item, applied_at: CORRECTION_AS_OF });

    await reeval(repo).runForSettlement(correctionSettlementId, CORRECTION_AS_OF);

    expect(await repo.users.findById(user.user_id)).toMatchObject({
      career_level: 3,
      career_level_state: {
        last_eval_as_of: CORRECTION_AS_OF,
        last_eval_score_sum: 168,
        last_eval_b_points: 168,
      },
    });
  });

  it("[F1] 用户没有本周周评估且周任务已结束时延后重评", async () => {
    const { repo, user, correctionSettlementId } = await seedCorrection(false);
    const previousWeek = new Date("2026-08-03T02:00:00.000Z");
    const currentUser = await repo.users.findById(user.user_id);
    const currentSeason = await repo.userSeasonStats.findByUserAndSeason(user.user_id, "2026_2027");
    if (currentUser === null || currentSeason === null) throw new Error("test state missing");
    await repo.users.update({
      ...currentUser,
      career_level_state: {
        ...currentUser.career_level_state!,
        week_base_as_of: previousWeek,
        last_eval_as_of: previousWeek,
      },
    });
    await repo.userSeasonStats.update({
      ...currentSeason,
      level_state: {
        ...currentSeason.level_state!,
        week_base_as_of: previousWeek,
        last_eval_as_of: previousWeek,
      },
    });

    const outcome = await new LevelCorrectionReevalService(repo).runForSettlement(
      correctionSettlementId,
      CORRECTION_AS_OF,
    );

    expect(outcome.kind).toBe("deferred");
    expect(await repo.users.findById(user.user_id)).toMatchObject({
      career_level: currentUser.career_level,
      career_level_state: { week_base_as_of: previousWeek },
    });
  });

  it("[F1] 周评估任务实际运行期间延后修正重评", async () => {
    const { repo, user, correctionSettlementId } = await seedCorrection(false);
    const previousWeek = new Date("2026-08-03T02:00:00.000Z");
    const currentUser = await repo.users.findById(user.user_id);
    const currentSeason = await repo.userSeasonStats.findByUserAndSeason(user.user_id, "2026_2027");
    if (currentUser === null || currentSeason === null) throw new Error("test state missing");
    await repo.users.update({
      ...currentUser,
      career_level_state: {
        ...currentUser.career_level_state!,
        week_base_as_of: previousWeek,
        last_eval_as_of: previousWeek,
      },
    });
    await repo.userSeasonStats.update({
      ...currentSeason,
      level_state: {
        ...currentSeason.level_state!,
        week_base_as_of: previousWeek,
        last_eval_as_of: previousWeek,
      },
    });
    const lockOwner = newUuid();
    await repo.jobLocks.acquire(
      WEEKLY_LEVEL_EVAL_LOCK_KEY,
      lockOwner,
      new Date(CORRECTION_AS_OF.getTime() + 60_000),
    );

    const outcome = await new LevelCorrectionReevalService(repo).runForSettlement(
      correctionSettlementId,
      CORRECTION_AS_OF,
    );

    await repo.jobLocks.release(WEEKLY_LEVEL_EVAL_LOCK_KEY, lockOwner);
    expect(outcome.kind).toBe("deferred");
    expect(await repo.users.findById(user.user_id)).toMatchObject({ career_level: 3 });
    expect((await repo.levelHistory.findByUser(user.user_id))
      .filter((entry) => entry.scope === LevelScope.Career))
      .toHaveLength(0);
  });

  it("[L105] 周评估结束后续跑之前延后的 correction", async () => {
    const { repo, user, correctionSettlementId } = await seedCorrection(false);
    const previousWeek = new Date("2026-08-03T02:00:00.000Z");
    const currentUser = await repo.users.findById(user.user_id);
    const currentSeason = await repo.userSeasonStats.findByUserAndSeason(user.user_id, "2026_2027");
    if (currentUser === null || currentSeason === null) throw new Error("test state missing");
    await repo.users.update({
      ...currentUser,
      career_level_state: {
        ...currentUser.career_level_state!,
        week_base_as_of: previousWeek,
        last_eval_as_of: previousWeek,
      },
    });
    await repo.userSeasonStats.update({
      ...currentSeason,
      level_state: {
        ...currentSeason.level_state!,
        week_base_as_of: previousWeek,
        last_eval_as_of: previousWeek,
      },
    });
    const lockOwner = newUuid();
    await repo.jobLocks.acquire(
      WEEKLY_LEVEL_EVAL_LOCK_KEY,
      lockOwner,
      new Date(CORRECTION_AS_OF.getTime() + 60_000),
    );
    const correctionOutcome = await new LevelCorrectionReevalService(repo).runForSettlement(
      correctionSettlementId,
      CORRECTION_AS_OF,
    );
    await repo.jobLocks.release(WEEKLY_LEVEL_EVAL_LOCK_KEY, lockOwner);
    expect(correctionOutcome.kind).toBe("deferred");

    await new WeeklyLevelEvalService(repo).run(
      new Date("2026-08-13T05:00:00.000Z"),
    );

    expect(await repo.users.findById(user.user_id)).toMatchObject({ career_level: 4 });
    expect((await repo.levelHistory.findByUser(user.user_id)).filter(
      (entry) => entry.scope === LevelScope.Career,
    )).toContainEqual(expect.objectContaining({
      reason: LevelHistoryReason.CorrectionReeval,
      from_level: 3,
      to_level: 4,
    }));
  });

  it("[Slice 2] 周评估未完成时不提前标记改判单已完成，解锁后补齐", async () => {
    const { repo, user, correctionSettlementId } = await seedCorrection(true);
    const previousWeek = new Date("2026-08-03T02:00:00.000Z");
    const currentUser = await repo.users.findById(user.user_id);
    const currentSeason = await repo.userSeasonStats.findByUserAndSeason(user.user_id, "2026_2027");
    const firstMatch = await repo.matches.findById("m0");
    const correction = await repo.settlements.findById(correctionSettlementId);
    if (currentUser === null || currentSeason === null || firstMatch === null || correction === null) {
      throw new Error("test state missing");
    }
    await repo.settlements.update({ ...correction, level_reeval_status: "pending" });
    await repo.users.update({
      ...currentUser,
      career_level_state: {
        ...currentUser.career_level_state!,
        week_base_as_of: previousWeek,
        last_eval_as_of: previousWeek,
      },
    });
    await repo.userSeasonStats.update({
      ...currentSeason,
      level_state: {
        ...currentSeason.level_state!,
        week_base_as_of: previousWeek,
        last_eval_as_of: previousWeek,
      },
    });
    await repo.matches.update({ ...firstMatch, settlement_status: SettlementStatus.Correcting });

    const service = new WeeklyLevelEvalService(repo, FIRST_EVAL);
    const first = await service.run(new Date("2026-08-13T02:10:00.000Z"));

    expect(first.settlement_skipped_count).toBeGreaterThanOrEqual(1);
    expect((await repo.settlements.findById(correctionSettlementId))?.level_reeval_status)
      .toBe("pending");
    expect(await repo.users.findById(user.user_id)).toMatchObject({
      career_level: 4,
      career_level_state: { week_base_as_of: previousWeek },
    });
    expect((await repo.levelHistory.findByUser(user.user_id)).filter(
      (entry) => entry.scope === LevelScope.Career &&
        entry.reason === LevelHistoryReason.CorrectionReeval,
    )).toHaveLength(0);

    await repo.matches.update({ ...firstMatch, settlement_status: SettlementStatus.Settled });
    const second = await service.run(new Date("2026-08-13T02:15:00.000Z"));

    expect(second.settlement_skipped_count).toBe(0);
    expect((await repo.settlements.findById(correctionSettlementId))?.level_reeval_status)
      .toBe("completed");
    expect(await repo.users.findById(user.user_id)).toMatchObject({
      career_level_state: { week_base_as_of: WEEKLY_AS_OF },
    });
    expect((await repo.settlements.findById(correctionSettlementId))
      ?.level_reeval_completed_at).toBeInstanceOf(Date);
  });

  it("[Slice 2] 停机超过 7 天的 pending 改判单恢复后补偿，completed 不再重复扫描", async () => {
    const { repo, correctionSettlementId } = await seedCorrection(false);
    const scanSpy = vi.spyOn(
      InMemoryRepository.prototype as unknown as {
        findSettlementItemsBySettlementAndStatus: (...args: unknown[]) => Promise<unknown>;
      },
      "findSettlementItemsBySettlementAndStatus",
    );
    const service = new WeeklyLevelEvalService(repo, FIRST_EVAL);

    await service.run(new Date("2026-08-25T02:10:00.000Z"));

    const completed = await repo.settlements.findById(correctionSettlementId);
    expect(completed).toMatchObject({ level_reeval_status: "completed" });
    expect(completed?.level_reeval_completed_at).toBeInstanceOf(Date);
    expect(scanSpy).toHaveBeenCalled();
    const callsAfterFirstRun = scanSpy.mock.calls.length;

    await service.run(new Date("2026-09-01T02:10:00.000Z"));

    expect(scanSpy.mock.calls.length).toBe(callsAfterFirstRun);
  });

  it("[F1] 下次周评估前按 as_of 顺序重试更早的修正", async () => {
    const { repo, user } = await seedCorrection(false);

    await new WeeklyLevelEvalService(repo, FIRST_EVAL).run(
      new Date("2026-08-17T02:10:00.000Z"),
    );

    expect(await repo.users.findById(user.user_id)).toMatchObject({ career_level: 4 });
    expect((await repo.levelHistory.findByUser(user.user_id)).filter(
      (entry) => entry.scope === LevelScope.Career,
    )).toContainEqual(expect.objectContaining({
      reason: LevelHistoryReason.CorrectionReeval,
      eval_as_of: CORRECTION_AS_OF,
      from_level: 3,
      to_level: 4,
    }));
  });

  it("[F2] 周末修正归最近已到达的周一周期", async () => {
    const { repo, user, correctionSettlementId } = await seedCorrection(false);
    const previousWeek = new Date("2026-08-03T02:00:00.000Z");
    const sundayAsOf = new Date("2026-08-09T01:59:00.000Z");
    const currentUser = await repo.users.findById(user.user_id);
    const currentSeason = await repo.userSeasonStats.findByUserAndSeason(user.user_id, "2026_2027");
    const settlement = await repo.settlements.findById(correctionSettlementId);
    const item = await repo.settlementItems.findBySettlementAndPrediction(
      correctionSettlementId,
      "p19",
    );
    if (
      currentUser === null || currentSeason === null || settlement === null || item === null
    ) throw new Error("test state missing");
    for (const appliedItem of await repo.settlementItems.findByStatus(SettlementItemStatus.Applied)) {
      if (appliedItem.settlement_id !== correctionSettlementId) {
        await repo.settlementItems.update({
          ...appliedItem,
          applied_at: new Date(sundayAsOf.getTime() - 2),
        });
      }
    }
    await repo.users.update({
      ...currentUser,
      career_level_state: {
        ...currentUser.career_level_state!,
        week_base_as_of: previousWeek,
        last_eval_as_of: previousWeek,
      },
    });
    await repo.userSeasonStats.update({
      ...currentSeason,
      level_state: {
        ...currentSeason.level_state!,
        week_base_as_of: previousWeek,
        last_eval_as_of: previousWeek,
      },
    });
    await repo.settlements.update({ ...settlement, settled_at: sundayAsOf });
    await repo.settlementItems.update({
      ...item,
      applied_at: new Date(sundayAsOf.getTime() - 1),
    });

    const outcome = await reeval(repo).runForSettlement(correctionSettlementId, sundayAsOf);

    expect(outcome.kind).toBe("completed");
    expect(await repo.users.findById(user.user_id)).toMatchObject({ career_level: 4 });
  });

  it("[F2] 后续评估已落账时不重放旧 correction", async () => {
    const { repo, user, correctionSettlementId } = await seedCorrection(false);
    const laterSameWeek = new Date("2026-08-15T02:00:00.000Z");
    const currentUser = await repo.users.findById(user.user_id);
    const currentSeason = await repo.userSeasonStats.findByUserAndSeason(user.user_id, "2026_2027");
    if (currentUser === null || currentSeason === null) throw new Error("test state missing");
    await repo.users.update({
      ...currentUser,
      career_level_state: {
        ...currentUser.career_level_state!,
        week_base_level: 2,
        last_eval_as_of: laterSameWeek,
      },
    });
    await repo.userSeasonStats.update({
      ...currentSeason,
      level_state: {
        ...currentSeason.level_state!,
        week_base_level: 2,
        last_eval_as_of: laterSameWeek,
      },
    });

    const outcome = await reeval(repo).runForSettlement(correctionSettlementId, CORRECTION_AS_OF);

    expect(outcome.evaluated_count).toBe(0);
    expect(await repo.users.findById(user.user_id)).toMatchObject({
      career_level: currentUser.career_level,
      career_level_state: { last_eval_as_of: laterSameWeek },
    });
  });

  it("[Slice 2] 落后墙钟的 serverNow 时 LEVEL_CORRECTION_REEVAL_LOCK_KEY 租约仍晚于 Date.now()", async () => {
    const { repo, correctionSettlementId } = await seedCorrection(false);
    const jobLocks = repo.jobLocks;
    const acquireSpy = vi.spyOn(jobLocks, "acquire");
    const repoProxy = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "jobLocks") return jobLocks;
        return Reflect.get(target, prop, receiver);
      },
    });
    const staleNow = new Date(Date.now() - 15 * 60 * 1000);
    const wallClockBefore = Date.now();

    await new LevelCorrectionReevalService(repoProxy, FIRST_EVAL)
      .runForSettlement(correctionSettlementId, staleNow);

    const correctionAcquires = acquireSpy.mock.calls.filter(
      ([key]) => key === LEVEL_CORRECTION_REEVAL_LOCK_KEY,
    );
    expect(correctionAcquires.length).toBeGreaterThan(0);
    const leaseUntil = correctionAcquires[0]![2] as Date;
    expect(leaseUntil.getTime()).toBeGreaterThan(wallClockBefore);
    expect(leaseUntil.getTime()).toBeGreaterThan(Date.now());
  });

  it("[Slice 3] 撞锁 skipped 后保留 pending，锁释放后周内补偿完成", async () => {
    const { repo, correctionSettlementId } = await seedCorrection(false);
    const correction = await repo.settlements.findById(correctionSettlementId);
    if (correction === null) throw new Error("test fixture missing correction");
    await repo.settlements.update({ ...correction, level_reeval_status: "pending" });
    const lockOwner = newUuid();
    await repo.jobLocks.acquire(
      LEVEL_CORRECTION_REEVAL_LOCK_KEY,
      lockOwner,
      new Date(Date.now() + 60_000),
    );
    const service = new LevelCorrectionReevalService(repo, FIRST_EVAL);

    const blocked = await service.runPendingCompensation(CORRECTION_AS_OF);

    expect(blocked).toMatchObject({
      kind: "skipped",
      scanned_count: 1,
      completed_count: 0,
      pending_count: 1,
    });
    expect((await repo.settlements.findById(correctionSettlementId))?.level_reeval_status)
      .toBe("pending");

    await repo.jobLocks.release(LEVEL_CORRECTION_REEVAL_LOCK_KEY, lockOwner);
    const compensated = await service.runPendingCompensation(CORRECTION_AS_OF);

    expect(compensated).toMatchObject({
      kind: "completed",
      scanned_count: 1,
      completed_count: 1,
      pending_count: 0,
    });
    const completed = await repo.settlements.findById(correctionSettlementId);
    expect(completed).toMatchObject({ level_reeval_status: "completed" });
    expect(completed?.level_reeval_completed_at).toBeInstanceOf(Date);
  });

  it("[Slice 3] 补偿扫描不被其他用户的锁饥饿", async () => {
    const { repo, user, correctionSettlementId } = await seedCorrection(false);
    const correction = await repo.settlements.findById(correctionSettlementId);
    if (correction === null) throw new Error("test fixture missing correction");
    await repo.settlements.update({ ...correction, level_reeval_status: "pending" });
    const laterAsOf = new Date(CORRECTION_AS_OF.getTime() + 60 * 60 * 1000);
    const otherSettlementId = "scorrection-other-user";
    await addStandaloneCorrection(repo, {
      settlementId: otherSettlementId,
      userId: "u2",
      settledAt: laterAsOf,
      user: makeUser({
        user_id: "u2",
        openid: "openid_u2",
        career_valid_predictions: 20,
      }),
    });
    const lockOwner = newUuid();
    const userLockKey = levelScopeLockKey(user.user_id, LevelScope.Career, null);
    await repo.jobLocks.acquire(
      userLockKey,
      lockOwner,
      new Date(Date.now() + 60_000),
    );

    const outcome = await new LevelCorrectionReevalService(repo, FIRST_EVAL)
      .runPendingCompensation(laterAsOf);

    expect(outcome).toMatchObject({
      kind: "deferred",
      scanned_count: 2,
      completed_count: 1,
      pending_count: 1,
      deferred_reason: "user_lock_held",
    });
    await expect(repo.settlements.findById(otherSettlementId)).resolves.toMatchObject({
      level_reeval_status: "completed",
    });
    await expect(repo.settlements.findById(correctionSettlementId)).resolves.toMatchObject({
      level_reeval_status: "pending",
    });
    await repo.jobLocks.release(userLockKey, lockOwner);
  });

  it("[Slice 3] 同一用户前序单据 deferred 时后续单据不越序处理", async () => {
    const { repo, user, correctionSettlementId } = await seedCorrection(false);
    const correction = await repo.settlements.findById(correctionSettlementId);
    if (correction === null) throw new Error("test fixture missing correction");
    await repo.settlements.update({ ...correction, level_reeval_status: "pending" });
    const laterAsOf = new Date(CORRECTION_AS_OF.getTime() + 60 * 60 * 1000);
    const laterSettlementId = "scorrection-same-user-later";
    await addStandaloneCorrection(repo, {
      settlementId: laterSettlementId,
      userId: user.user_id,
      settledAt: laterAsOf,
    });
    const jobLocks = repo.jobLocks;
    const acquire = jobLocks.acquire.bind(jobLocks);
    let failedOnce = false;
    const acquireSpy = vi.spyOn(jobLocks, "acquire").mockImplementation(
      async (key, ownerId, leaseUntil) => {
        if (!failedOnce && key === levelScopeLockKey(user.user_id, LevelScope.Career, null)) {
          failedOnce = true;
          return false;
        }
        return acquire(key, ownerId, leaseUntil);
      },
    );
    const repoProxy = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "jobLocks") return jobLocks;
        return Reflect.get(target, prop, receiver);
      },
    });
    const service = new LevelCorrectionReevalService(repoProxy, FIRST_EVAL);

    const first = await service.runPendingCompensation(laterAsOf);

    expect(first).toMatchObject({
      kind: "deferred",
      scanned_count: 2,
      completed_count: 0,
      pending_count: 2,
      deferred_reason: "user_lock_held",
    });
    await expect(repo.settlements.findById(correctionSettlementId)).resolves.toMatchObject({
      level_reeval_status: "pending",
    });
    await expect(repo.settlements.findById(laterSettlementId)).resolves.toMatchObject({
      level_reeval_status: "pending",
    });

    acquireSpy.mockRestore();
    const second = await service.runPendingCompensation(laterAsOf);

    expect(second).toMatchObject({
      kind: "completed",
      scanned_count: 2,
      completed_count: 2,
      pending_count: 0,
    });
  });

  it("[Slice 2] 单单超过 20 个用户时循环内续租并回调 onStep", async () => {
    const { repo, correctionSettlementId } = await seedCorrection(false);
    const correction = await repo.settlements.findById(correctionSettlementId);
    const match = await repo.matches.findById(correction!.match_id);
    if (correction === null || match === null) throw new Error("test fixture missing correction");
    await repo.settlements.update({ ...correction, level_reeval_status: "pending" });
    for (let index = 1; index <= 20; index += 1) {
      await addCorrectionParticipant(repo, `renew-u${index}`, match, correctionSettlementId);
    }
    const jobLocks = repo.jobLocks;
    const renewSpy = vi.spyOn(jobLocks, "renew");
    const repoProxy = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "jobLocks") return jobLocks;
        return Reflect.get(target, prop, receiver);
      },
    });
    const onStep = vi.fn(async () => undefined);

    await new LevelCorrectionReevalService(repoProxy, FIRST_EVAL).runPending(
      WEEKLY_AS_OF,
      CORRECTION_AS_OF,
      onStep,
    );

    expect(renewSpy.mock.calls.some(([key]) => key === LEVEL_CORRECTION_REEVAL_LOCK_KEY)).toBe(true);
    expect(onStep).toHaveBeenCalled();
  });

  it("[Slice 2] 单单循环内续租失败则 deferred 且不标记 completed", async () => {
    const { repo, correctionSettlementId } = await seedCorrection(false);
    const correction = await repo.settlements.findById(correctionSettlementId);
    const match = await repo.matches.findById(correction!.match_id);
    if (correction === null || match === null) throw new Error("test fixture missing correction");
    await repo.settlements.update({ ...correction, level_reeval_status: "pending" });
    for (let index = 1; index <= 20; index += 1) {
      await addCorrectionParticipant(repo, `abort-u${index}`, match, correctionSettlementId);
    }
    const jobLocks = repo.jobLocks;
    vi.spyOn(jobLocks, "renew").mockResolvedValue(false);
    const repoProxy = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "jobLocks") return jobLocks;
        return Reflect.get(target, prop, receiver);
      },
    });

    const outcome = await new LevelCorrectionReevalService(repoProxy, FIRST_EVAL)
      .runForSettlement(correctionSettlementId, CORRECTION_AS_OF);

    expect(outcome.kind).toBe("deferred");
    expect((await repo.settlements.findById(correctionSettlementId))?.level_reeval_status)
      .toBe("pending");
  });
});

const SCORE_AT = new Date("2026-08-11T03:04:05.000Z");

function installScoreRace(repo: InMemoryRepository, log: string[]): void {
  const injected = new Set<string>();
  const original = repo.withTransaction.bind(repo);
  repo.withTransaction = (async (fn) => original(async (tx) => {
    const rawUsers = tx.users;
    const rawStats = tx.userSeasonStats;
    const users = {
      ...rawUsers,
      findByIdForUpdate: async (userId: string) => {
        log.push(`users.findByIdForUpdate|${userId}`);
        const user = await rawUsers.findByIdForUpdate!(userId);
        if (user !== null && !injected.has(`user:${userId}`)) {
          injected.add(`user:${userId}`);
          await rawUsers.update({
            ...user,
            career_points: 7777,
            career_last_scoring_match_at: SCORE_AT,
          });
        }
        return user;
      },
      update: async (user: User) => {
        log.push(`users.update|${user.user_id}`);
        return rawUsers.update(user);
      },
      patchFields: async (userId: string, fields: Partial<User>) => {
        log.push(`users.patchFields|${userId}|${Object.keys(fields).sort().join(",")}`);
        return rawUsers.patchFields!(userId, fields);
      },
    };
    const stats = rawStats === undefined ? undefined : {
      ...rawStats,
      findByUserAndSeasonForUpdate: async (userId: string, seasonId: string) => {
        log.push(`stats.findByUserAndSeasonForUpdate|${seasonId}`);
        const row = await rawStats.findByUserAndSeasonForUpdate!(userId, seasonId);
        const key = `stats:${userId}:${seasonId}`;
        if (row !== null && !injected.has(key)) {
          injected.add(key);
          await rawStats.update({
            ...row,
            points: 8888,
            last_scoring_match_at: SCORE_AT,
          });
        }
        return row;
      },
      update: async (row: UserSeasonStats) => {
        log.push(`stats.update|${row.level_season_id}`);
        return rawStats.update(row);
      },
      patchFields: async (
        userId: string,
        seasonId: string,
        fields: Partial<UserSeasonStats>,
      ) => {
        log.push(`stats.patchFields|${seasonId}|${Object.keys(fields).sort().join(",")}`);
        return rawStats.patchFields!(userId, seasonId, fields);
      },
    };
    const proxied = new Proxy(tx, {
      get(target, prop) {
        if (prop === "users") return users;
        if (prop === "userSeasonStats") return stats;
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    log.push("tx:begin");
    try {
      return await fn(proxied as UnitOfWork);
    } finally {
      log.push("tx:end");
    }
  })) as InMemoryRepository["withTransaction"];
}

function writeTransactions(log: string[]): string[][] {
  const groups: string[][] = [];
  let current: string[] | null = null;
  for (const line of log) {
    if (line === "tx:begin") current = [];
    else if (line === "tx:end") {
      if (current !== null) groups.push(current);
      current = null;
    } else if (current !== null) current.push(line);
  }
  return groups.filter((events) => events.some((event) =>
    event.startsWith("users.patchFields") ||
    event.startsWith("stats.patchFields") ||
    event.startsWith("users.update") ||
    event.startsWith("stats.update") ||
    event.includes("ForUpdate"),
  ));
}

describe("LevelCorrectionReevalService A-S4-01", () => {
  it("修正重评先行锁 users 再锁 user_season_stats，只局部更新等级字段", async () => {
    const { repo, user, correctionSettlementId } = await seedCorrection(true);
    const log: string[] = [];
    installScoreRace(repo, log);

    await reeval(repo).runForSettlement(correctionSettlementId, CORRECTION_AS_OF);

    expect(writeTransactions(log)).toEqual([
      [
        `users.findByIdForUpdate|${user.user_id}`,
        `users.patchFields|${user.user_id}|career_best_level,career_level,career_level_state,updated_at`,
      ],
      [
        `users.findByIdForUpdate|${user.user_id}`,
        "stats.findByUserAndSeasonForUpdate|2026_2027",
        "stats.patchFields|2026_2027|best_level,level,level_state,updated_at",
      ],
    ]);
    await expect(repo.users.findById(user.user_id)).resolves.toMatchObject({
      career_level: 3,
      career_best_level: 4,
      career_points: 7777,
      career_valid_predictions: 20,
      career_last_scoring_match_at: SCORE_AT,
    });
    await expect(repo.userSeasonStats.findByUserAndSeason(user.user_id, "2026_2027"))
      .resolves.toMatchObject({
        level: 3,
        best_level: 4,
        is_level_frozen: false,
        points: 8888,
        valid_predictions: 20,
        last_scoring_match_at: SCORE_AT,
      });
  });
});
