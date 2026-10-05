import { describe, expect, it } from "vitest";
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
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { LevelCorrectionReevalService } from "./level-correction-reeval.js";
import { WEEKLY_LEVEL_EVAL_LOCK_KEY, WeeklyLevelEvalService } from "./weekly-level-eval.js";

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

async function seedCorrection(downward: boolean, frozen = false) {
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
    regular_home_score: downward ? 0 : 2,
    regular_away_score: downward ? 0 : 1,
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
    match_score: downward ? MatchScoreValue.Miss : MatchScoreValue.ExactHit,
    wdl_hit: !downward,
    exact_hit: !downward,
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
    new_score: downward ? MatchScoreValue.Miss : MatchScoreValue.ExactHit,
    score_delta: downward ? -12 : 12,
    old_wdl_hit: downward,
    new_wdl_hit: !downward,
    old_exact_hit: downward,
    new_exact_hit: !downward,
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

describe("LevelCorrectionReevalService §17.7 / §32.10", () => {
  it("[J73] [J74] [J75] correction 改判当前等级并保留 career_best_level", async () => {
    const { repo, user, correctionSettlementId } = await seedCorrection(true);

    await reeval(repo).runForSettlement(correctionSettlementId, CORRECTION_AS_OF);

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

  it("[F1] 用户没有本周周评估且周任务已结束时以当前状态重评", async () => {
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

    expect(outcome.kind).toBe("completed");
    expect(await repo.users.findById(user.user_id)).toMatchObject({
      career_level: 4,
      career_level_state: { week_base_as_of: WEEKLY_AS_OF },
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

  it("[F2] 周评估已落账后仍以同周 week_base 改判", async () => {
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

    expect(outcome.evaluated_count).toBeGreaterThan(0);
    expect(await repo.users.findById(user.user_id)).toMatchObject({
      career_level: 3,
      career_level_state: { last_eval_as_of: CORRECTION_AS_OF },
    });
  });
});
