import { describe, expect, it } from "vitest";
import {
  LevelHistoryReason,
  MatchScoreValue,
  MatchStatus,
  RankingBoard,
  Result,
  SettlementDocStatus,
  SettlementItemStatus,
  SettlementPhase,
  SettlementStatus,
  UserStatus,
} from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type {
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
import { WeeklyLevelEvalService } from "./weekly-level-eval.js";

const AS_OF = new Date("2026-08-10T02:00:00.000Z");
const RUN_AT = new Date("2026-08-10T02:10:00.000Z");
const FIRST_EVAL = new Date("2026-06-29T02:00:00.000Z");
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
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_level: 1,
    career_best_level: 1,
    career_last_scoring_match_at: null,
    career_level_state: defaultLevelState(),
    deleted_at: null,
    created_at: AS_OF,
    updated_at: AS_OF,
    ...overrides,
  };
}

function makeSeasonStats(userId: string, overrides: Partial<UserSeasonStats> = {}): UserSeasonStats {
  return {
    schema_version: 1,
    user_id: userId,
    level_season_id: "2026_2027",
    points: 0,
    valid_predictions: 0,
    wdl_hits: 0,
    exact_hits: 0,
    level: 1,
    best_level: 1,
    level_state: defaultLevelState(),
    is_level_frozen: false,
    created_at: AS_OF,
    updated_at: AS_OF,
    ...overrides,
  };
}

async function addAppliedPrediction(
  repo: InMemoryRepository,
  userId: string,
  index: number,
  appliedAt: Date,
  score = MatchScoreValue.ExactHit,
  levelSeasonId = "2026_2027",
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
    season_id: levelSeasonId,
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
    finish_detected_at: appliedAt,
    settled_at: appliedAt,
    created_at: appliedAt,
    updated_at: appliedAt,
  };
  const prediction: Prediction = {
    schema_version: 1,
    prediction_id: predictionId,
    user_id: userId,
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
    created_at: appliedAt,
    updated_at: appliedAt,
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
    created_at: appliedAt,
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
    started_at: appliedAt,
    settled_at: appliedAt,
    attempt_count: 1,
    last_error_code: null,
    last_error_message: null,
    created_at: appliedAt,
    updated_at: appliedAt,
  };
  const item: SettlementItem = {
    schema_version: 1,
    settlement_id: settlementId,
    prediction_id: predictionId,
    user_id: userId,
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
    applied_at: appliedAt,
    attempt_count: 1,
    last_error_code: null,
    last_error_message: null,
    created_at: appliedAt,
    updated_at: appliedAt,
  };

  await repo.matches.insert(match);
  await repo.predictions.insert(prediction);
  await repo.matchResults.insert(result);
  await repo.settlements.insert(settlement);
  await repo.settlementItems.insert(item);
}

async function seedUser(
  repo: InMemoryRepository,
  count: number,
  options: {
    user?: User;
    seasonStats?: UserSeasonStats;
    lateIndex?: number;
    lateAppliedAt?: Date;
    levelSeasonId?: string;
  } = {},
): Promise<User> {
  const user = options.user ?? makeUser({
    career_points: count * 12,
    career_valid_predictions: count,
    career_wdl_hits: count,
    career_exact_hits: count,
  });
  await repo.users.insert(user);
  const lateIndex = options.lateIndex ?? -1;
  for (let index = 0; index < count; index += 1) {
    await addAppliedPrediction(
      repo,
      user.user_id,
      index,
      index === lateIndex ? (options.lateAppliedAt ?? AS_OF) : new Date(AS_OF.getTime() - 60_000),
      MatchScoreValue.ExactHit,
      options.levelSeasonId,
    );
  }
  if (options.seasonStats !== undefined) {
    await repo.userSeasonStats.insert(options.seasonStats);
  } else {
    await repo.userSeasonStats.insert(makeSeasonStats(user.user_id, {
      points: count * 12,
      valid_predictions: count,
      wdl_hits: count,
      exact_hits: count,
    }));
  }
  return user;
}

function weekly(repo: InMemoryRepository): WeeklyLevelEvalService {
  return new WeeklyLevelEvalService(repo, FIRST_EVAL);
}

describe("WeeklyLevelEvalService §17.6 / §32.9", () => {
  it("generates the strength snapshot after a completed weekly evaluation", async () => {
    const repo = new InMemoryRepository();

    await expect(weekly(repo).run(RUN_AT)).resolves.toMatchObject({ kind: "completed" });
    await expect(
      repo.boardSnapshots.findByBoardAndSnapshotAt(RankingBoard.Strength, RUN_AT),
    ).resolves.toMatchObject([{ snapshot_kind: "head", snapshot_at: RUN_AT }]);
  });

  it("[L91] 第 20 场于周一 10:05 applied：当周仍 Lv1，下周升 Lv2", async () => {
    const repo = new InMemoryRepository();
    const user = await seedUser(repo, 20, {
      lateIndex: 19,
      lateAppliedAt: new Date(AS_OF.getTime() + 5 * 60_000),
    });

    await weekly(repo).run(RUN_AT);
    expect(await repo.users.findById(user.user_id)).toMatchObject({
      career_level: 1,
      career_level_state: { last_eval_as_of: AS_OF },
    });

    await weekly(repo).run(new Date("2026-08-17T02:10:00.000Z"));
    expect(await repo.users.findById(user.user_id)).toMatchObject({ career_level: 2 });
  });

  it("[L92] Lv1 一周最多升一级，下一周才能继续升级", async () => {
    const repo = new InMemoryRepository();
    const user = await seedUser(repo, 60);

    await weekly(repo).run(RUN_AT);
    expect(await repo.users.findById(user.user_id)).toMatchObject({ career_level: 2 });

    await weekly(repo).run(new Date("2026-08-17T02:10:00.000Z"));
    expect(await repo.users.findById(user.user_id)).toMatchObject({ career_level: 3 });
  });

  it("[L105] 同一 as_of 重跑不重复等级变更或 history", async () => {
    const repo = new InMemoryRepository();
    const user = await seedUser(repo, 20);
    const service = weekly(repo);

    await service.run(RUN_AT);
    await service.run(new Date(RUN_AT.getTime() + 3_600_000));

    expect(await repo.users.findById(user.user_id)).toMatchObject({
      career_level: 2,
      career_level_state: { last_eval_as_of: AS_OF },
    });
    expect((await repo.levelHistory.findByUser(user.user_id)).filter(
      (entry) => entry.reason === LevelHistoryReason.WeeklyEval && entry.scope === "career",
    )).toHaveLength(1);
  });

  it("[L106] 延迟三小时运行仍以固定周一 10:00 数据截止", async () => {
    const repo = new InMemoryRepository();
    const user = await seedUser(repo, 20, {
      lateIndex: 19,
      lateAppliedAt: new Date(AS_OF.getTime() + 5 * 60_000),
    });

    await weekly(repo).run(new Date("2026-08-10T05:00:00.000Z"));

    expect(await repo.users.findById(user.user_id)).toMatchObject({
      career_level: 1,
      career_level_state: { last_eval_as_of: AS_OF, last_eval_n: 19 },
    });
  });

  it("[L111] 新赛季等级 1 不产生等级 history", async () => {
    const repo = new InMemoryRepository();
    const user = await seedUser(repo, 1);

    await weekly(repo).run(RUN_AT);

    expect((await repo.levelHistory.findByUser(user.user_id))).toEqual([]);
    expect(await repo.userSeasonStats.findByUserAndSeason(user.user_id, "2026_2027"))
      .toMatchObject({ level: 1, best_level: 1 });
  });

  it("[L114] deleted 用户停止周评估", async () => {
    const repo = new InMemoryRepository();
    const user = await seedUser(repo, 20, {
      user: makeUser({
        status: UserStatus.Deleted,
        career_points: 240,
        career_valid_predictions: 20,
        career_wdl_hits: 20,
        career_exact_hits: 20,
      }),
    });

    await weekly(repo).run(RUN_AT);

    expect(await repo.users.findById(user.user_id)).toMatchObject({
      career_level: 1,
      career_level_state: { last_eval_as_of: null },
    });
    expect(await repo.levelHistory.findByUser(user.user_id)).toEqual([]);
  });

  it("赛季结束后的首次周评估冻结旧赛季等级", async () => {
    const repo = new InMemoryRepository();
    const oldSeason = makeSeasonStats("u1", {
      level_season_id: "2025_2026",
      points: 12,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
    });
    const user = await seedUser(repo, 0, {
      user: makeUser({ career_points: 12, career_valid_predictions: 1 }),
      seasonStats: oldSeason,
      levelSeasonId: "2025_2026",
    });
    await addAppliedPrediction(
      repo,
      user.user_id,
      0,
      new Date("2026-06-30T12:00:00.000Z"),
      MatchScoreValue.ExactHit,
      "2025_2026",
    );

    await weekly(repo).run(new Date("2026-07-06T02:10:00.000Z"));

    expect(await repo.userSeasonStats.findByUserAndSeason(user.user_id, "2025_2026"))
      .toMatchObject({ is_level_frozen: true, level_state: { last_eval_as_of: new Date("2026-07-06T02:00:00.000Z") } });
  });
});
