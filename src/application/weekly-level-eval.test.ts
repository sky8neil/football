import { describe, expect, it, vi } from "vitest";
import {
  LevelHistoryReason,
  LevelScope,
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
import { replayLevel } from "../domain/levels.js";
import { levelProtectionEndAsOf, seasonFinalEvalAsOf } from "../domain/time.js";
import { InMemoryRepository, type UnitOfWork } from "../infrastructure/repositories.js";
import { DailyConsistencyService } from "./daily-consistency-service.js";
import { RepositoryDailyConsistencySnapshotSource } from "./daily-consistency-snapshot.js";
import { LevelCorrectionReevalService } from "./level-correction-reeval.js";
import { buildReplayFacts, loadAppliedSettlementFacts } from "./rebuild-service-support.js";
import { RebuildUserStatsService } from "./stats-rebuild-service.js";
import { levelScopeLockKey, listDueSeasonFinalIds, WeeklyLevelEvalService } from "./weekly-level-eval.js";

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
    last_scoring_match_at: null,
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
  score: MatchScoreValue = MatchScoreValue.ExactHit,
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
    canonical_match_id: matchId,
    superseded_by: null,
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
    indexOffset?: number;
    score?: MatchScoreValue;
  } = {},
): Promise<User> {
  const score = options.score ?? MatchScoreValue.ExactHit;
  const hitCount = score === MatchScoreValue.ExactHit ? count : 0;
  const user = options.user ?? makeUser({
    career_points: count * score,
    career_valid_predictions: count,
    career_wdl_hits: hitCount,
    career_exact_hits: hitCount,
  });
  await repo.users.insert(user);
  const lateIndex = options.lateIndex ?? -1;
  const indexOffset = options.indexOffset ?? 0;
  for (let index = 0; index < count; index += 1) {
    await addAppliedPrediction(
      repo,
      user.user_id,
      indexOffset + index,
      index === lateIndex ? (options.lateAppliedAt ?? AS_OF) : new Date(AS_OF.getTime() - 60_000),
      score,
      options.levelSeasonId,
    );
  }
  if (options.seasonStats !== undefined) {
    await repo.userSeasonStats.insert(options.seasonStats);
  } else {
    await repo.userSeasonStats.insert(makeSeasonStats(user.user_id, {
      points: count * score,
      valid_predictions: count,
      wdl_hits: hitCount,
      exact_hits: hitCount,
      last_scoring_match_at: hitCount > 0
        ? new Date(Date.UTC(2026, 7, 1, 0, indexOffset + count - 1))
        : null,
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

  it("generates all due season finals after weekly evaluation and skips them on later runs", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({ user_id: "season-final-user" });
    await repo.users.insert(user);
    await repo.userSeasonStats.insert(makeSeasonStats(user.user_id, {
      level_season_id: "2024_2025",
      points: 24,
      valid_predictions: 2,
      wdl_hits: 2,
      exact_hits: 1,
      last_scoring_match_at: new Date("2025-06-28T12:00:00.000Z"),
      is_level_frozen: true,
    }));
    await repo.userSeasonStats.insert(makeSeasonStats(user.user_id, {
      level_season_id: "2025_2026",
      points: 36,
      valid_predictions: 3,
      wdl_hits: 3,
      exact_hits: 2,
      last_scoring_match_at: new Date("2026-06-28T12:00:00.000Z"),
      is_level_frozen: true,
    }));

    await weekly(repo).run(RUN_AT);

    await expect(repo.boardSnapshots.findFinalBySeason("2024_2025"))
      .resolves.toMatchObject([{
        is_final: true,
        season_points: 24,
        snapshot_at: new Date("2025-07-07T02:00:00.000Z"),
      }]);
    await expect(repo.boardSnapshots.findFinalBySeason("2025_2026"))
      .resolves.toMatchObject([{
        is_final: true,
        season_points: 36,
        snapshot_at: new Date("2026-07-06T02:00:00.000Z"),
      }]);

    await weekly(repo).run(new Date("2026-08-17T02:10:00.000Z"));
    await expect(repo.boardSnapshots.findFinalBySeason("2024_2025"))
      .resolves.toHaveLength(1);
    await expect(repo.boardSnapshots.findFinalBySeason("2025_2026"))
      .resolves.toHaveLength(1);
  });

  it("does not list or generate a season final before that season's final eval freezes levels", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({ user_id: "unfrozen-season-user" });
    await repo.users.insert(user);
    await repo.userSeasonStats.insert(makeSeasonStats(user.user_id, {
      level_season_id: "2025_2026",
      points: 36,
      valid_predictions: 3,
      wdl_hits: 3,
      exact_hits: 2,
      last_scoring_match_at: new Date("2026-06-28T12:00:00.000Z"),
      is_level_frozen: false,
    }));

    await expect(listDueSeasonFinalIds(repo, AS_OF)).resolves.toEqual([]);
    expect(await repo.boardSnapshots.findFinalBySeason("2025_2026")).toEqual([]);
    expect(await repo.userSeasonStats.findByUserAndSeason(user.user_id, "2025_2026"))
      .toMatchObject({ is_level_frozen: false });
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
      last_scoring_match_at: new Date("2026-06-30T12:00:00.000Z"),
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
      .toMatchObject({
        is_level_frozen: true,
        last_scoring_match_at: new Date("2026-06-30T12:00:00.000Z"),
        level_state: { last_eval_as_of: new Date("2026-07-06T02:00:00.000Z") },
      });
  });

  it("[Slice 1] 注入合法 firstEvalAsOf 时，L=3 未达标用户在保护期内不降级、保护期后累计 below_count，不抛 SPEC_GAP", async () => {
    const repo = new InMemoryRepository();
    const firstEval = new Date("2026-08-03T02:00:00.000Z");
    const user = await seedUser(repo, 20, {
      score: MatchScoreValue.Miss,
      user: makeUser({
        user_id: "u-l3",
        career_level: 3,
        career_best_level: 3,
        career_points: 0,
        career_valid_predictions: 20,
        career_wdl_hits: 0,
        career_exact_hits: 0,
      }),
    });
    const service = new WeeklyLevelEvalService(repo, firstEval);

    // 保护期内（第 2 次周评估：2026-08-10T02:00Z < firstEval + 13 weeks）
    const protectedOutcome = await service.run(new Date("2026-08-10T02:10:00.000Z"));
    expect(protectedOutcome.failed_count).toBe(0);
    expect(protectedOutcome.settlement_skipped_count).toBe(0);
    expect(await repo.users.findById(user.user_id)).toMatchObject({
      career_level: 3,
      career_level_state: {
        below_count: 0,
        last_eval_as_of: new Date("2026-08-10T02:00:00.000Z"),
      },
    });

    // 保护期后（第 14 次周评估：firstEval + 13 weeks = 2026-11-02T02:00Z）
    const afterProtectionRun = new Date("2026-11-02T02:10:00.000Z");
    const afterOutcome = await service.run(afterProtectionRun);
    expect(afterOutcome.failed_count).toBe(0);
    expect(afterOutcome.settlement_skipped_count).toBe(0);
    expect(await repo.users.findById(user.user_id)).toMatchObject({
      career_level: 3,
      career_level_state: {
        below_count: 1,
        last_eval_as_of: new Date("2026-11-02T02:00:00.000Z"),
      },
    });
  });

  it("[Slice 1] 对 Lv.5 用户执行 stats-rebuild 与 daily-consistency（注入同一 firstEvalAsOf），重建后保持 Lv.5 且对账无差异", async () => {
    const repo = new InMemoryRepository();
    const firstEval = new Date("2026-08-03T02:00:00.000Z");
    // 60 场全中（每场 12 分）足够逐周升至 Lv.5（2026-08-10 -> Lv.2, 08-17 -> Lv.3, 08-24 -> Lv.4, 08-31 -> Lv.5）
    const user = await seedUser(repo, 60, {
      user: makeUser({
        user_id: "u-lv5",
        career_points: 720,
        career_valid_predictions: 60,
        career_wdl_hits: 60,
        career_exact_hits: 60,
      }),
    });

    const weeklyService = new WeeklyLevelEvalService(repo, firstEval);
    const weekRuns = [
      new Date("2026-08-10T02:10:00.000Z"),
      new Date("2026-08-17T02:10:00.000Z"),
      new Date("2026-08-24T02:10:00.000Z"),
      new Date("2026-08-31T02:10:00.000Z"),
    ];
    for (const runAt of weekRuns) {
      await weeklyService.run(runAt);
    }

    const beforeRebuild = await repo.users.findById(user.user_id);
    expect(beforeRebuild).toMatchObject({
      career_level: 5,
      career_best_level: 5,
      career_level_state: {
        last_eval_as_of: new Date("2026-08-31T02:00:00.000Z"),
      },
    });

    // 使用同一 firstEvalAsOf 执行 RebuildUserStatsService
    const rebuildAt = new Date("2026-08-31T03:00:00.000Z");
    const rebuilt = await new RebuildUserStatsService(repo, firstEval).rebuildUserStats(
      user.user_id,
      rebuildAt,
    );
    expect(rebuilt.user).toMatchObject({
      career_level: 5,
      career_best_level: 5,
      career_level_state: {
        last_eval_as_of: new Date("2026-08-31T02:00:00.000Z"),
        last_eval_n: beforeRebuild!.career_level_state!.last_eval_n,
        last_eval_score_sum: beforeRebuild!.career_level_state!.last_eval_score_sum,
      },
    });

    // 使用同一 firstEvalAsOf 执行 DailyConsistencyService，career/season 等级零差异
    const consistency = await new DailyConsistencyService(
      repo,
      new RepositoryDailyConsistencySnapshotSource(repo, firstEval),
      firstEval,
    ).run(rebuildAt);
    expect(consistency.kind).toBe("completed");
    if (consistency.kind === "completed") {
      const levelDiffs = consistency.differences.filter(
        (diff) => diff.scope === "career" || diff.scope === "season_stats",
      );
      expect(levelDiffs).toEqual([]);
    }
  });

  it("[Slice 1] 第 1 个用户触发 SETTLEMENT_ALREADY_RUNNING 时，第 2 个用户仍能正常完成周评估", async () => {
    const repo = new InMemoryRepository();
    const u1 = await seedUser(repo, 20, {
      indexOffset: 0,
      user: makeUser({
        user_id: "u-settling",
        openid: "openid_u_settling",
        career_points: 240,
        career_valid_predictions: 20,
        career_wdl_hits: 20,
        career_exact_hits: 20,
      }),
    });
    const u2 = await seedUser(repo, 20, {
      indexOffset: 100,
      user: makeUser({
        user_id: "u-healthy",
        openid: "openid_u_healthy",
        career_points: 240,
        career_valid_predictions: 20,
        career_wdl_hits: 20,
        career_exact_hits: 20,
      }),
    });

    // 将 u1 的第 1 场比赛置为 correcting，触发 loadAppliedSettlementFacts 抛出 SETTLEMENT_ALREADY_RUNNING
    const u1Match = await repo.matches.findById("m0");
    expect(u1Match).not.toBeNull();
    await repo.matches.update({
      ...u1Match!,
      settlement_status: SettlementStatus.Correcting,
    });

    const log = vi.fn();
    const service = new WeeklyLevelEvalService(repo, FIRST_EVAL, log);
    const outcome = await service.run(RUN_AT);

    expect(outcome.kind).toBe("completed");
    expect(outcome.settlement_skipped_count).toBeGreaterThanOrEqual(1);
    expect(outcome.failed_count).toBe(0);
    expect(outcome.evaluated_count).toBeGreaterThanOrEqual(1);

    // u1 被跳过（保持 Lv.1，未写 last_eval_as_of），u2 正常升至 Lv.2
    expect(await repo.users.findById(u1.user_id)).toMatchObject({
      career_level: 1,
      career_level_state: { last_eval_as_of: null },
    });
    expect(await repo.users.findById(u2.user_id)).toMatchObject({
      career_level: 2,
      career_level_state: { last_eval_as_of: AS_OF },
    });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "weekly_level_eval_user_skipped",
      user_id: u1.user_id,
      reason: "SETTLEMENT_ALREADY_RUNNING",
    }));

    // 比赛恢复 settled 后再次重跑：u2 幂等跳过，u1 补齐评估升至 Lv.2
    await repo.matches.update({
      ...u1Match!,
      settlement_status: SettlementStatus.Settled,
    });
    const retryOutcome = await service.run(new Date(RUN_AT.getTime() + 5 * 60_000));
    expect(retryOutcome.settlement_skipped_count).toBe(0);
    expect(retryOutcome.failed_count).toBe(0);
    expect(await repo.users.findById(u1.user_id)).toMatchObject({
      career_level: 2,
      career_level_state: { last_eval_as_of: AS_OF },
    });
    expect(await repo.users.findById(u2.user_id)).toMatchObject({
      career_level: 2,
      career_level_state: { last_eval_as_of: AS_OF },
    });
  });

  it("用户 career 锁被占用时记为 deferred 而非 skipped，且不写 last_eval_as_of", async () => {
    const repo = new InMemoryRepository();
    const u1 = await seedUser(repo, 20, {
      indexOffset: 0,
      user: makeUser({
        user_id: "u-free",
        openid: "openid_u_free",
        career_points: 240,
        career_valid_predictions: 20,
        career_wdl_hits: 20,
        career_exact_hits: 20,
      }),
    });
    const u2 = await seedUser(repo, 20, {
      indexOffset: 100,
      user: makeUser({
        user_id: "u-locked",
        openid: "openid_u_locked",
        career_points: 240,
        career_valid_predictions: 20,
        career_wdl_hits: 20,
        career_exact_hits: 20,
      }),
    });
    await repo.jobLocks.acquire(
      levelScopeLockKey(u2.user_id, LevelScope.Career, null),
      "correction-reeval",
      new Date(Date.now() + 60 * 60 * 1000),
    );

    const outcome = await weekly(repo).run(RUN_AT);

    expect(outcome.kind).toBe("completed");
    expect(outcome.deferred_count).toBe(1);
    expect(outcome.skipped_count).toBe(0);
    expect(outcome.settlement_skipped_count).toBe(0);
    expect(outcome.failed_count).toBe(0);
    expect(await repo.users.findById(u1.user_id)).toMatchObject({
      career_level: 2,
      career_level_state: { last_eval_as_of: AS_OF },
    });
    expect(await repo.users.findById(u2.user_id)).toMatchObject({
      career_level: 1,
      career_level_state: { last_eval_as_of: null },
    });
  });

  it("[Slice 1] 第 1 个用户触发 SPEC_GAP 时隔离错误并继续评估第 2 个用户", async () => {
    const repo = new InMemoryRepository();
    const u1 = await seedUser(repo, 20, {
      indexOffset: 0,
      score: MatchScoreValue.Miss,
      user: makeUser({
        user_id: "u-spec-gap",
        openid: "openid_u_spec_gap",
        career_level: 3,
        career_best_level: 3,
        career_points: 0,
        career_valid_predictions: 20,
        career_wdl_hits: 0,
        career_exact_hits: 0,
      }),
    });
    const u2 = await seedUser(repo, 20, {
      indexOffset: 100,
      user: makeUser({
        user_id: "u-ok",
        openid: "openid_u_ok",
        career_points: 240,
        career_valid_predictions: 20,
        career_wdl_hits: 20,
        career_exact_hits: 20,
      }),
    });

    const log = vi.fn();
    // firstEvalAsOf = null 时，u1 (L=3 未达标) 触发 SPEC_GAP，但不应阻断 u2
    const service = new WeeklyLevelEvalService(repo, null, log);
    const outcome = await service.run(RUN_AT);

    expect(outcome.kind).toBe("completed");
    expect(outcome.failed_count).toBeGreaterThanOrEqual(1);
    expect(await repo.users.findById(u1.user_id)).toMatchObject({
      career_level: 3,
      career_level_state: { last_eval_as_of: null },
    });
    expect(await repo.users.findById(u2.user_id)).toMatchObject({
      career_level: 2,
      career_level_state: { last_eval_as_of: AS_OF },
    });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "weekly_level_eval_user_failed",
      user_id: u1.user_id,
      error_code: "SPEC_GAP",
    }));
    // [Slice 2] 出现失败用户时不得生成半成品 Strength 快照，也不得触发终榜冻结
    expect(await repo.boardSnapshots.findLatestByBoard(RankingBoard.Strength)).toEqual([]);
  });

  it("[Slice 4] listDueSeasonFinalIds 不调用 users.findAll()，无 N+1 查询", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({ user_id: "no-n-plus-1-user" });
    await repo.users.insert(user);
    await repo.userSeasonStats.insert(makeSeasonStats(user.user_id, {
      level_season_id: "2025_2026",
      points: 24,
      valid_predictions: 2,
      wdl_hits: 2,
      exact_hits: 1,
      last_scoring_match_at: new Date("2026-06-28T12:00:00.000Z"),
      is_level_frozen: true,
    }));
    const findAllUsers = vi.spyOn(repo.users, "findAll");
    const due = await listDueSeasonFinalIds(repo, AS_OF);
    expect(due).toEqual(["2025_2026"]);
    expect(findAllUsers).not.toHaveBeenCalled();
  });

  it("[Slice 5.2] 每处理 20 名活跃用户自动续租主锁", async () => {
    const repo = new InMemoryRepository();
    for (let i = 1; i <= 25; i += 1) {
      await repo.users.insert(makeUser({
        user_id: `renew-user-${String(i).padStart(2, "0")}`,
        openid: `openid_renew_${i}`,
        career_valid_predictions: 0,
      }));
    }
    const jobLocks = repo.jobLocks;
    const renewSpy = vi.spyOn(jobLocks, "renew");
    const repoProxy = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "jobLocks") return jobLocks;
        return Reflect.get(target, prop, receiver);
      },
    });
    const service = new WeeklyLevelEvalService(repoProxy, FIRST_EVAL);
    const outcome = await service.run(RUN_AT);

    expect(outcome.kind).toBe("completed");
    expect(renewSpy).toHaveBeenCalledTimes(1);
  });

  it("[Slice 5.2] 锁续租失败时立即安全中止本轮且不生成榜单快照", async () => {
    const repo = new InMemoryRepository();
    for (let i = 1; i <= 22; i += 1) {
      await repo.users.insert(makeUser({
        user_id: `abort-user-${String(i).padStart(2, "0")}`,
        openid: `openid_abort_${i}`,
        career_valid_predictions: 0,
      }));
    }
    const jobLocks = repo.jobLocks;
    vi.spyOn(jobLocks, "renew").mockResolvedValueOnce(false);
    const repoProxy = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "jobLocks") return jobLocks;
        return Reflect.get(target, prop, receiver);
      },
    });
    const log = vi.fn();
    const service = new WeeklyLevelEvalService(repoProxy, FIRST_EVAL, log);
    const outcome = await service.run(RUN_AT);

    expect(outcome.kind).toBe("skipped");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "weekly_level_eval_lock_lost",
      processed_users: 20,
    }));
    expect(await repo.boardSnapshots.findLatestByBoard(RankingBoard.Strength)).toEqual([]);
  });

  it("[Slice 1] 存量已注销用户未冻结的 user_season_stats 不阻塞赛季终榜生成", async () => {
    const repo = new InMemoryRepository();
    const activeUser = makeUser({ user_id: "active-final-user", openid: "openid-active-final" });
    const deletedUser = makeUser({
      user_id: "deleted-unfrozen-user",
      openid: "deleted:deleted-unfrozen-user",
      status: UserStatus.Deleted,
      nickname: null,
      deleted_at: AS_OF,
    });
    await repo.users.insert(activeUser);
    await repo.users.insert(deletedUser);
    await repo.userSeasonStats.insert(makeSeasonStats(activeUser.user_id, {
      level_season_id: "2025_2026",
      points: 30,
      valid_predictions: 3,
      wdl_hits: 3,
      exact_hits: 1,
      last_scoring_match_at: new Date("2026-06-28T12:00:00.000Z"),
      is_level_frozen: true,
    }));
    await repo.userSeasonStats.insert(makeSeasonStats(deletedUser.user_id, {
      level_season_id: "2025_2026",
      points: 12,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
      last_scoring_match_at: new Date("2026-06-28T12:00:00.000Z"),
      is_level_frozen: false,
    }));

    const findAllUsers = vi.spyOn(repo.users, "findAll");
    await expect(listDueSeasonFinalIds(repo, AS_OF)).resolves.toEqual(["2025_2026"]);
    expect(findAllUsers).not.toHaveBeenCalled();

    const evalOutcome = await new WeeklyLevelEvalService(repo, FIRST_EVAL).run(RUN_AT);
    expect(evalOutcome.kind).toBe("completed");
    const finals = await repo.boardSnapshots.findFinalBySeason("2025_2026");
    expect(finals.map((row) => row.user_id)).toEqual([activeUser.user_id]);
  });

  it("[Slice 2] 存在 INVALID_LEDGER 失败用户时不生成 Strength 快照与赛季终榜", async () => {
    const repo = new InMemoryRepository();
    const uBad = await seedUser(repo, 20, {
      indexOffset: 0,
      user: makeUser({
        user_id: "u-bad-ledger",
        openid: "openid_u_bad_ledger",
        career_points: 240,
        career_valid_predictions: 20,
      }),
    });
    const uGood = await seedUser(repo, 20, {
      indexOffset: 100,
      user: makeUser({
        user_id: "u-good-ledger",
        openid: "openid_u_good_ledger",
        career_points: 240,
        career_valid_predictions: 20,
      }),
    });
    await repo.userSeasonStats.insert(makeSeasonStats(uGood.user_id, {
      level_season_id: "2025_2026",
      points: 24,
      valid_predictions: 2,
      is_level_frozen: true,
    }));
    const badItems = await repo.settlementItems.findByStatus(SettlementItemStatus.Applied);
    const firstBad = badItems.find((row) => row.user_id === uBad.user_id)!;
    // 破坏版本链触发 INVALID_LEDGER
    await repo.settlementItems.update({ ...firstBad, valid_prediction_delta: 0 });

    const log = vi.fn();
    const outcome = await new WeeklyLevelEvalService(repo, FIRST_EVAL, log).run(RUN_AT);

    expect(outcome.failed_count).toBe(2);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "weekly_level_eval_user_failed",
      user_id: uBad.user_id,
      error_code: "INVALID_LEDGER",
    }));
    expect(await repo.boardSnapshots.findLatestByBoard(RankingBoard.Strength)).toEqual([]);
    expect(await repo.boardSnapshots.findFinalBySeason("2025_2026")).toEqual([]);
  });

  it("[Slice 2] 落后墙钟的 serverNow 时内层 levelScopeLockKey 租约仍晚于 Date.now()", async () => {
    const repo = new InMemoryRepository();
    await seedUser(repo, 1);
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

    await new WeeklyLevelEvalService(repoProxy, FIRST_EVAL).run(staleNow);

    const innerAcquires = acquireSpy.mock.calls.filter(([key]) =>
      String(key).startsWith("sync:level_scope:"),
    );
    expect(innerAcquires.length).toBeGreaterThan(0);
    for (const [, , leaseUntil] of innerAcquires) {
      expect((leaseUntil as Date).getTime()).toBeGreaterThan(wallClockBefore);
      expect((leaseUntil as Date).getTime()).toBeGreaterThan(Date.now());
    }
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

describe("WeeklyLevelEvalService A-S4-01", () => {
  it("周评估先行锁 users 再锁 user_season_stats，只局部更新等级字段", async () => {
    const repo = new InMemoryRepository();
    const user = await seedUser(repo, 20);
    const log: string[] = [];
    installScoreRace(repo, log);

    await weekly(repo).run(RUN_AT);

    expect(writeTransactions(log)).toEqual([
      [
        `users.findByIdForUpdate|${user.user_id}`,
        `users.patchFields|${user.user_id}|career_best_level,career_level,career_level_state,updated_at`,
      ],
      [
        `users.findByIdForUpdate|${user.user_id}`,
        "stats.findByUserAndSeasonForUpdate|2026_2027",
        "stats.patchFields|2026_2027|best_level,is_level_frozen,level,level_state,updated_at",
      ],
    ]);
    await expect(repo.users.findById(user.user_id)).resolves.toMatchObject({
      career_level: 2,
      career_best_level: 2,
      career_points: 7777,
      career_valid_predictions: 20,
      career_wdl_hits: 20,
      career_exact_hits: 20,
      career_last_scoring_match_at: SCORE_AT,
    });
    await expect(repo.userSeasonStats.findByUserAndSeason(user.user_id, "2026_2027"))
      .resolves.toMatchObject({
        level: 2,
        best_level: 2,
        is_level_frozen: false,
        points: 8888,
        valid_predictions: 20,
        wdl_hits: 20,
        exact_hits: 20,
        last_scoring_match_at: SCORE_AT,
      });
  });
});

async function replayExpectedScope(
  repo: InMemoryRepository,
  userId: string,
  scope: LevelScope,
  firstEvalAsOf: Date,
  untilAsOf: Date,
  levelSeasonId?: string,
) {
  const applied = await repo.settlementItems.findAppliedByUserBefore(
    userId,
    new Date(untilAsOf.getTime() + 1),
  );
  const loaded = await loadAppliedSettlementFacts(repo, applied);
  const { facts, correctionSettledAts } = buildReplayFacts(loaded);
  return replayLevel({
    scope,
    facts,
    firstEvalAsOf,
    untilAsOf,
    correctionSettledAts,
    ruleVersion: "level_v3.0",
    protectionEndAsOf: levelProtectionEndAsOf(firstEvalAsOf),
    ...(levelSeasonId === undefined ? {} : { levelSeasonId }),
  });
}

describe("WeeklyLevelEvalService CR42-06 跨周漏算补算", () => {
  it("漏掉中间两周后恢复评估，career 与 season 终态及 level_history 与按时逐周和 replayLevel 完全一致", async () => {
    const onTimeRepo = new InMemoryRepository();
    const catchUpRepo = new InMemoryRepository();
    const firstEval = new Date("2026-08-03T02:00:00.000Z");

    const buildBaseUser = () =>
      makeUser({
        user_id: "u-catchup",
        openid: "openid_u_catchup",
        career_points: 720,
        career_valid_predictions: 60,
        career_wdl_hits: 60,
        career_exact_hits: 60,
        career_last_scoring_match_at: new Date(Date.UTC(2026, 7, 1, 0, 59, 0)),
      });
    const seed60BeforeWeek1 = async (repo: InMemoryRepository) => {
      await seedUser(repo, 60, {
        user: buildBaseUser(),
        lateIndex: -1,
        indexOffset: 0,
      });
      // 确保所有 applied_at 落在 2026-08-10T02:00Z 之前（seedUser 已使用 AS_OF - 60s = 08-10T01:59Z）
    };

    await seed60BeforeWeek1(onTimeRepo);
    await seed60BeforeWeek1(catchUpRepo);

    const onTimeService = new WeeklyLevelEvalService(onTimeRepo, firstEval);
    for (const runAt of [
      new Date("2026-08-10T02:10:00.000Z"),
      new Date("2026-08-17T02:10:00.000Z"),
      new Date("2026-08-24T02:10:00.000Z"),
      new Date("2026-08-31T02:10:00.000Z"),
    ]) {
      await onTimeService.run(runAt);
    }

    const catchUpService = new WeeklyLevelEvalService(catchUpRepo, firstEval);
    // 仅评估 08-10，随后漏算 08-17 与 08-24，在 08-31 恢复
    await catchUpService.run(new Date("2026-08-10T02:10:00.000Z"));
    await catchUpService.run(new Date("2026-08-31T02:10:00.000Z"));

    const endAsOf = new Date("2026-08-31T02:00:00.000Z");
    const onTimeUser = (await onTimeRepo.users.findById("u-catchup"))!;
    const catchUpUser = (await catchUpRepo.users.findById("u-catchup"))!;
    expect(catchUpUser.career_level).toBe(5);
    expect(catchUpUser.career_level).toBe(onTimeUser.career_level);
    expect(catchUpUser.career_best_level).toBe(onTimeUser.career_best_level);
    expect(catchUpUser.career_level_state).toEqual(onTimeUser.career_level_state);

    const onTimeSeason = (await onTimeRepo.userSeasonStats.findByUserAndSeason("u-catchup", "2026_2027"))!;
    const catchUpSeason = (await catchUpRepo.userSeasonStats.findByUserAndSeason("u-catchup", "2026_2027"))!;
    expect(catchUpSeason.level).toBe(5);
    expect(catchUpSeason.level).toBe(onTimeSeason.level);
    expect(catchUpSeason.best_level).toBe(onTimeSeason.best_level);
    expect(catchUpSeason.level_state).toEqual(onTimeSeason.level_state);

    const expectedCareer = await replayExpectedScope(
      catchUpRepo,
      "u-catchup",
      LevelScope.Career,
      firstEval,
      endAsOf,
    );
    const expectedSeason = await replayExpectedScope(
      catchUpRepo,
      "u-catchup",
      LevelScope.Season,
      firstEval,
      endAsOf,
      "2026_2027",
    );
    expect(catchUpUser.career_level).toBe(expectedCareer.level);
    expect(catchUpUser.career_best_level).toBe(expectedCareer.best_level);
    expect(catchUpUser.career_level_state).toMatchObject({
      below_count: expectedCareer.below_count,
      last_eval_as_of: expectedCareer.last_eval_as_of,
      last_eval_n: expectedCareer.last_inputs?.n,
      last_eval_score_sum: expectedCareer.last_inputs?.S,
      last_eval_b_points: expectedCareer.last_inputs?.b_points,
    });
    expect(catchUpSeason.level).toBe(expectedSeason.level);
    expect(catchUpSeason.best_level).toBe(expectedSeason.best_level);
    expect(catchUpSeason.level_state).toMatchObject({
      below_count: expectedSeason.below_count,
      last_eval_as_of: expectedSeason.last_eval_as_of,
      last_eval_n: expectedSeason.last_inputs?.n,
      last_eval_score_sum: expectedSeason.last_inputs?.S,
      last_eval_b_points: expectedSeason.last_inputs?.b_points,
    });

    const sortHistory = (entries: Awaited<ReturnType<typeof onTimeRepo.levelHistory.findByUser>>) =>
      entries
        .map((entry) => ({ scope: entry.scope, from: entry.from_level, to: entry.to_level, asOf: entry.eval_as_of.toISOString() }))
        .sort((left, right) =>
          left.scope.localeCompare(right.scope) || left.asOf.localeCompare(right.asOf),
        );
    const onTimeHist = sortHistory(await onTimeRepo.levelHistory.findByUser("u-catchup"));
    const catchUpHist = sortHistory(await catchUpRepo.levelHistory.findByUser("u-catchup"));
    expect(catchUpHist).toEqual(onTimeHist);

    const consistency = await new DailyConsistencyService(
      catchUpRepo,
      new RepositoryDailyConsistencySnapshotSource(catchUpRepo, firstEval),
      firstEval,
    ).run(new Date("2026-08-31T03:00:00.000Z"));
    expect(consistency.kind).toBe("completed");
    if (consistency.kind === "completed") {
      expect(consistency.differences.filter((d) => d.scope === "career" || d.scope === "season_stats")).toEqual([]);
    }
  });

  it("跨赛季漏算恢复时，仅在到达/超过赛季终评且切出赛季时冻结，不提前冻结也不超评到新赛季", async () => {
    const repo = new InMemoryRepository();
    const firstEval = new Date("2025-07-07T02:00:00.000Z");
    const seasonFinal = seasonFinalEvalAsOf("2025_2026"); // 2026-07-06T02:00:00Z
    expect(seasonFinal.toISOString()).toBe("2026-07-06T02:00:00.000Z");

    const user = makeUser({
      user_id: "u-season-gap",
      openid: "openid_season_gap",
      career_points: 720,
      career_valid_predictions: 60,
      career_wdl_hits: 60,
      career_exact_hits: 60,
    });
    await repo.users.insert(user);
    await repo.userSeasonStats.insert(makeSeasonStats(user.user_id, {
      level_season_id: "2025_2026",
      points: 720,
      valid_predictions: 60,
      wdl_hits: 60,
      exact_hits: 60,
      last_scoring_match_at: new Date("2026-06-20T12:00:00.000Z"),
    }));
    const appliedAt = new Date("2026-06-21T12:00:00.000Z");
    for (let i = 0; i < 60; i += 1) {
      const seasonAnchor = new Date(Date.UTC(2026, 5, 1, 0, i, 0));
      const matchId = `ms${i}`;
      const predictionId = `ps${i}`;
      const settlementId = `ss${i}`;
      await repo.matches.insert({
        schema_version: 1,
        match_id: matchId,
        canonical_match_id: matchId,
        superseded_by: null,
        league_id: "premier_league",
        season_id: "2025_2026",
        round_id: "01",
        home_team_id: "home",
        away_team_id: "away",
        kickoff_at: seasonAnchor,
        kickoff_confirmed: true,
        prediction_deadline_at: new Date(seasonAnchor.getTime() - 600_000),
        prediction_closed_at: new Date(seasonAnchor.getTime() - 600_000),
        period_anchor_at: seasonAnchor,
        match_status: MatchStatus.Finished,
        settlement_status: SettlementStatus.Settled,
        regular_home_score: 2,
        regular_away_score: 1,
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
      });
      await repo.predictions.insert({
        schema_version: 1,
        prediction_id: predictionId,
        user_id: user.user_id,
        match_id: matchId,
        canonical_match_id: matchId,
        idempotency_key: newUuid(),
        pred_home_score: 2,
        pred_away_score: 1,
        derived_result: Result.Home,
        submitted_at: new Date(seasonAnchor.getTime() - 3_600_000),
        scoring_rule_version: RULE,
        match_score: MatchScoreValue.ExactHit,
        wdl_hit: true,
        exact_hit: true,
        applied_result_version: 1,
        created_at: appliedAt,
        updated_at: appliedAt,
      });
      await repo.matchResults.insert({
        schema_version: 1,
        match_id: matchId,
        result_version: 1,
        regular_home_score: 2,
        regular_away_score: 1,
        source: "provider",
        provider_status: "FT",
        admin_id: null,
        reason: null,
        created_at: appliedAt,
      });
      await repo.settlements.insert({
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
      });
      await repo.settlementItems.insert({
        schema_version: 1,
        settlement_id: settlementId,
        prediction_id: predictionId,
        user_id: user.user_id,
        old_score: MatchScoreValue.Miss,
        new_score: MatchScoreValue.ExactHit,
        score_delta: MatchScoreValue.ExactHit,
        old_wdl_hit: false,
        new_wdl_hit: true,
        old_exact_hit: false,
        new_exact_hit: true,
        valid_prediction_delta: 1,
        source_result_version: 1,
        status: SettlementItemStatus.Applied,
        applied_at: appliedAt,
        attempt_count: 1,
        last_error_code: null,
        last_error_message: null,
        created_at: appliedAt,
        updated_at: appliedAt,
      });
    }

    const service = new WeeklyLevelEvalService(repo, firstEval);
    // 2026-06-22 先评一次（Lv.1 -> Lv.2），然后漏掉 06-29（仍在 2025_2026 内）与 07-06（终评）
    await service.run(new Date("2026-06-22T02:10:00.000Z"));
    expect(await repo.userSeasonStats.findByUserAndSeason(user.user_id, "2025_2026"))
      .toMatchObject({ level: 2, is_level_frozen: false });

    // 在新赛季 2026-07-13 恢复运行：应补跑 06-29（不冻结，-> Lv.3）和 07-06（终评，-> Lv.4 并冻结），不能评到 07-13
    await service.run(new Date("2026-07-13T02:10:00.000Z"));
    const stats = (await repo.userSeasonStats.findByUserAndSeason(user.user_id, "2025_2026"))!;
    expect(stats.is_level_frozen).toBe(true);
    expect(stats.level).toBe(4);
    expect(stats.best_level).toBe(4);
    expect(stats.level_state?.last_eval_as_of?.toISOString()).toBe("2026-07-06T02:00:00.000Z");

    const expectedSeason = await replayExpectedScope(
      repo,
      user.user_id,
      LevelScope.Season,
      firstEval,
      seasonFinal,
      "2025_2026",
    );
    expect(stats.level).toBe(expectedSeason.level);
    expect(stats.best_level).toBe(expectedSeason.best_level);
    expect(stats.level_state?.last_eval_as_of).toEqual(expectedSeason.last_eval_as_of);

    const seasonHist = (await repo.levelHistory.findByUser(user.user_id))
      .filter((entry) => entry.scope === LevelScope.Season)
      .map((entry) => entry.eval_as_of.toISOString());
    expect(seasonHist).toEqual([
      "2026-06-22T02:00:00.000Z",
      "2026-06-29T02:00:00.000Z",
      "2026-07-06T02:00:00.000Z",
    ]);
  });

  it("漏周期间存在待补跑订正结算时，先补算对应周期周评估再执行订正重评", async () => {
    const onTimeRepo = new InMemoryRepository();
    const catchUpRepo = new InMemoryRepository();
    const firstEval = new Date("2026-08-03T02:00:00.000Z");

    const setupRepo = async (repo: InMemoryRepository) => {
      await seedUser(repo, 60, {
        user: makeUser({
          user_id: "u-midgap-corr",
          openid: "openid_midgap_corr",
          career_points: 720,
          career_valid_predictions: 60,
          career_wdl_hits: 60,
          career_exact_hits: 60,
        }),
      });
      // 第 0 场做一次周中（08-12 星期三）的订正重评结算
      const correctionSettledAt = new Date("2026-08-12T05:00:00.000Z");
      const m0 = (await repo.matches.findById("m0"))!;
      await repo.matches.update({ ...m0, result_version: 2, settled_result_version: 2 });
      await repo.matchResults.insert({
        schema_version: 1,
        match_id: "m0",
        result_version: 2,
        regular_home_score: 2,
        regular_away_score: 1,
        source: "provider",
        provider_status: "FT",
        admin_id: null,
        reason: null,
        created_at: correctionSettledAt,
      });
      const corrDoc: SettlementDoc = {
        schema_version: 1,
        settlement_id: "s-corr-midgap",
        match_id: "m0",
        result_version: 2,
        rule_version: RULE,
        status: SettlementDocStatus.Settled,
        phase: SettlementPhase.Done,
        is_correction: true,
        level_reeval_status: "pending",
        started_at: correctionSettledAt,
        settled_at: correctionSettledAt,
        attempt_count: 1,
        last_error_code: null,
        last_error_message: null,
        created_at: correctionSettledAt,
        updated_at: correctionSettledAt,
      };
      await repo.settlements.insert(corrDoc);
      await repo.settlementItems.insert({
        schema_version: 1,
        settlement_id: corrDoc.settlement_id,
        prediction_id: "p0",
        user_id: "u-midgap-corr",
        old_score: MatchScoreValue.ExactHit,
        new_score: MatchScoreValue.ExactHit,
        score_delta: 0,
        old_wdl_hit: true,
        new_wdl_hit: true,
        old_exact_hit: true,
        new_exact_hit: true,
        valid_prediction_delta: 0,
        source_result_version: 2,
        status: SettlementItemStatus.Applied,
        applied_at: correctionSettledAt,
        attempt_count: 1,
        last_error_code: null,
        last_error_message: null,
        created_at: correctionSettledAt,
        updated_at: correctionSettledAt,
      });
    };

    await setupRepo(onTimeRepo);
    await setupRepo(catchUpRepo);

    // On-time: 08-03 -> 08-10 -> correction(08-12) -> 08-17
    const onTimeWeekly = new WeeklyLevelEvalService(onTimeRepo, firstEval);
    await onTimeWeekly.run(new Date("2026-08-03T02:10:00.000Z"));
    await onTimeWeekly.run(new Date("2026-08-10T02:10:00.000Z"));
    await new LevelCorrectionReevalService(onTimeRepo, firstEval).runForSettlement(
      "s-corr-midgap",
      new Date("2026-08-12T05:05:00.000Z"),
    );
    await onTimeWeekly.run(new Date("2026-08-17T02:10:00.000Z"));

    // Catch-up: 08-03 -> 漏掉 08-10（且未单独触发 08-12 重评）-> 在 08-17 统一恢复
    const catchUpWeekly = new WeeklyLevelEvalService(catchUpRepo, firstEval);
    await catchUpWeekly.run(new Date("2026-08-03T02:10:00.000Z"));
    await catchUpWeekly.run(new Date("2026-08-17T02:10:00.000Z"));

    const onTimeUser = (await onTimeRepo.users.findById("u-midgap-corr"))!;
    const catchUpUser = (await catchUpRepo.users.findById("u-midgap-corr"))!;
    expect(catchUpUser.career_level).toBe(3);
    expect(catchUpUser.career_level).toBe(onTimeUser.career_level);
    expect(catchUpUser.career_best_level).toBe(onTimeUser.career_best_level);
    expect(catchUpUser.career_level_state).toEqual(onTimeUser.career_level_state);

    const endAsOf = new Date("2026-08-17T02:00:00.000Z");
    const expectedCareer = await replayExpectedScope(
      catchUpRepo,
      "u-midgap-corr",
      LevelScope.Career,
      firstEval,
      endAsOf,
    );
    expect(catchUpUser.career_level).toBe(expectedCareer.level);
    expect(catchUpUser.career_level_state?.last_eval_as_of).toEqual(expectedCareer.last_eval_as_of);
    expect(catchUpUser.career_level_state?.week_base_as_of).toEqual(expectedCareer.week_base_as_of);
  });
});
