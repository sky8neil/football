import { describe, expect, it } from "vitest";
import {
  LevelScope,
  MatchScoreValue,
  MatchStatus,
  PeriodType,
  RankingBoard,
  Result,
  SettlementDocStatus,
  SettlementItemStatus,
  SettlementPhase,
  SettlementStatus,
} from "../domain/enums.js";
import type {
  Match,
  MatchResult,
  Prediction,
  RankingEntry,
  SettlementDoc,
  SettlementItem,
  User,
  UserSeasonStats,
} from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import {
  RebuildUserStatsService,
  userStatsRebuildLockKey,
} from "./stats-rebuild-service.js";
import { defaultLevelState } from "../domain/types.js";
import { buildLevelInputs } from "../domain/levels.js";
import {
  RebuildPeriodRankingsService,
  periodRankingsRebuildLockKey,
} from "./ranking-rebuild-service.js";
import {
  buildReplayFacts,
  loadAppliedSettlementFacts,
} from "./rebuild-service-support.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const WEEK_ANCHOR = new Date("2026-08-05T12:00:00.000Z");

function makeUser(userId: string, overrides: Partial<User> = {}): User {
  return {
    schema_version: 1,
    user_id: userId,
    openid: `openid_${userId}`,
    unionid: null,
    nickname: userId,
    favorite_team_id: null,
    status: "active",
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_level: 1,
    career_best_level: 1,
    career_last_scoring_match_at: null,
    career_level_state: defaultLevelState(),
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeMatch(
  matchId: string,
  anchor: Date | null = WEEK_ANCHOR,
  overrides: Partial<Match> = {},
): Match {
  return {
    schema_version: 1,
    match_id: matchId,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: `home_${matchId}`,
    away_team_id: `away_${matchId}`,
    kickoff_at: anchor ?? WEEK_ANCHOR,
    kickoff_confirmed: true,
    prediction_deadline_at: null,
    prediction_closed_at: NOW,
    period_anchor_at: anchor,
    match_status: MatchStatus.Finished,
    settlement_status: SettlementStatus.Settled,
    regular_home_score: 1,
    regular_away_score: 0,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 1,
    settled_result_version: 1,
    result_source: "provider",
    scoring_rule_version: "scoring_v1",
    finish_detected_at: NOW,
    settled_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makePrediction(
  predictionId: string,
  userId: string,
  matchId: string,
  overrides: Partial<Prediction> = {},
): Prediction {
  return {
    schema_version: 1,
    prediction_id: predictionId,
    user_id: userId,
    match_id: matchId,
    idempotency_key: `${predictionId}-key`,
    pred_home_score: 1,
    pred_away_score: 0,
    derived_result: Result.Home,
    submitted_at: NOW,
    scoring_rule_version: "scoring_v1",
    match_score: null,
    wdl_hit: null,
    exact_hit: null,
    applied_result_version: 0,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeResult(matchId: string, version: number): MatchResult {
  return {
    schema_version: 1,
    match_id: matchId,
    result_version: version,
    regular_home_score: version === 1 ? 1 : 2,
    regular_away_score: 0,
    source: "provider",
    provider_status: "FT",
    admin_id: null,
    reason: null,
    created_at: NOW,
  };
}

function makeSettlement(
  settlementId: string,
  matchId: string,
  resultVersion: number,
): SettlementDoc {
  return {
    schema_version: 1,
    settlement_id: settlementId,
    match_id: matchId,
    result_version: resultVersion,
    rule_version: "scoring_v1",
    status: SettlementDocStatus.Settled,
    phase: SettlementPhase.Done,
    is_correction: resultVersion > 1,
    started_at: NOW,
    settled_at: NOW,
    attempt_count: 1,
    last_error_code: null,
    last_error_message: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeItem(
  settlementId: string,
  predictionId: string,
  userId: string,
  version: number,
  overrides: Partial<SettlementItem> = {},
): SettlementItem {
  return {
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
    source_result_version: version,
    status: SettlementItemStatus.Applied,
    applied_at: NOW,
    attempt_count: 1,
    last_error_code: null,
    last_error_message: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeSeasonStats(
  userId: string,
  seasonId: string,
  overrides: Partial<UserSeasonStats> = {},
): UserSeasonStats {
  return {
    schema_version: 1,
    user_id: userId,
    level_season_id: seasonId,
    points: 99,
    valid_predictions: 20,
    wdl_hits: 10,
    exact_hits: 5,
    last_scoring_match_at: NOW,
    level: 3,
    best_level: 4,
    level_state: defaultLevelState(),
    is_level_frozen: false,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeRanking(
  periodType: PeriodType,
  periodKey: string,
  userId: string,
  overrides: Partial<RankingEntry> = {},
): RankingEntry {
  return {
    schema_version: 1,
    period_type: periodType,
    period_key: periodKey,
    user_id: userId,
    period_score: 999,
    valid_predictions: 99,
    wdl_hits: 99,
    exact_hits: 99,
    last_scoring_match_at: new Date("2026-08-01T00:00:00.000Z"),
    global_rank: 99,
    is_final: false,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

async function insertFact(
  repo: InMemoryRepository,
  match: Match,
  prediction: Prediction,
  resultVersions: number[],
  settlements: Array<{ id: string; version: number; item: SettlementItem }>,
): Promise<void> {
  await repo.matches.insert(match);
  await repo.predictions.insert(prediction);
  for (const version of resultVersions) {
    await repo.matchResults.insert(makeResult(match.match_id, version));
  }
  for (const settlement of settlements) {
    await repo.settlements.insert(
      makeSettlement(settlement.id, match.match_id, settlement.version),
    );
    await repo.settlementItems.insert(settlement.item);
  }
}

describe("RebuildUserStatsService", () => {
  it("无效 server_now 时在获取 maintenance lock 前 Fail Closed", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser("u1"));

    await expect(
      new RebuildUserStatsService(repo).rebuildUserStats(
        "u1",
        new Date("invalid"),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "server_now" },
    });

    await expect(
      repo.jobLocks.acquire(
        userStatsRebuildLockKey("u1"),
        "probe-owner",
        new Date(NOW.getTime() + 60_000),
      ),
    ).resolves.toBe(true);
  });

  it("固定注入评估周后按 replay 重建等级，并按 period_anchor_at 合并赛季", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(
      makeUser("u1", {
        career_points: 999,
        career_valid_predictions: 99,
        career_wdl_hits: 99,
        career_exact_hits: 99,
        career_level: 4,
        career_best_level: 6,
      }),
    );
    await repo.userSeasonStats.insert(
      makeSeasonStats("u1", "2026_2027", { level: 1 }),
    );
    await repo.userSeasonStats.insert(
      makeSeasonStats("u1", "stale_season", {
        level: 1,
        best_level: 4,
      }),
    );
    await repo.levelHistory.insert({
      schema_version: 1,
      level_history_id: "career-history",
      user_id: "u1",
      scope: "career",
      level_season_id: null,
      from_level: 5,
      to_level: 6,
      reason: "weekly_eval",
      eval_as_of: NOW,
      window_n: 80,
      window_score_sum: 50,
      b_points: 0,
      level_rule_version: "level_v3.0",
      settlement_id: null,
      changed_at: NOW,
    });
    await repo.unlocks.insert({
      schema_version: 1,
      unlock_id: "unlock-existing",
      user_id: "u1",
      unlock_code: "profile_card_style_1",
      threshold_points: 30,
      source_version: "unlock_v1",
      unlocked_at: NOW,
    });

    const m1 = makeMatch("m1", WEEK_ANCHOR, {
      result_version: 3,
      settled_result_version: 3,
    });
    const p1 = makePrediction("p1", "u1", "m1");
    await insertFact(repo, m1, p1, [1, 3], [
      {
        id: "s1",
        version: 1,
        item: makeItem("s1", "p1", "u1", 1),
      },
      {
        id: "s2",
        version: 3,
        item: makeItem("s2", "p1", "u1", 3, {
          old_score: MatchScoreValue.ExactHit,
          new_score: MatchScoreValue.WdlHit,
          score_delta: -9,
          old_wdl_hit: true,
          new_wdl_hit: true,
          old_exact_hit: true,
          new_exact_hit: false,
          valid_prediction_delta: 0,
        }),
      },
    ]);

    const m2 = makeMatch("m2", new Date("2026-08-06T12:00:00.000Z"), {
      season_id: "2025_2026",
    });
    const p2 = makePrediction("p2", "u1", "m2", {
      pred_home_score: 0,
      pred_away_score: 1,
      derived_result: Result.Away,
    });
    await insertFact(repo, m2, p2, [1], [
      {
        id: "s3",
        version: 1,
        item: makeItem("s3", "p2", "u1", 1, {
          new_score: MatchScoreValue.Miss,
          score_delta: 0,
          new_wdl_hit: false,
          new_exact_hit: false,
        }),
      },
    ]);

    const outcome = await new RebuildUserStatsService(
      repo,
      new Date("2026-08-03T02:00:00.000Z"),
    ).rebuildUserStats("u1", NOW);

    expect(outcome.user).toMatchObject({
      career_points: 3,
      career_valid_predictions: 2,
      career_wdl_hits: 1,
      career_exact_hits: 0,
      career_last_scoring_match_at: WEEK_ANCHOR,
      career_level: 1,
      career_best_level: 6,
    });
    expect(outcome.season_stats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level_season_id: "2026_2027",
          points: 3,
          valid_predictions: 2,
          wdl_hits: 1,
          exact_hits: 0,
          last_scoring_match_at: WEEK_ANCHOR,
          level: 1,
          best_level: 4,
        }),
        expect.objectContaining({
          level_season_id: "stale_season",
          points: 0,
          valid_predictions: 0,
          wdl_hits: 0,
          exact_hits: 0,
          last_scoring_match_at: null,
          level: 1,
          best_level: 4,
        }),
      ]),
    );
    expect(await repo.unlocks.findByUser("u1")).toHaveLength(1);
    expect((await repo.levelHistory.findByUser("u1")).filter((entry) => entry.reason === "rebuild"))
      .toHaveLength(1);
  });

  it("缺少 applied item 的正式 match_result 时 fail closed 且不写入聚合", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser("u1"));
    const match = makeMatch("missing-result");
    await repo.matches.insert(match);
    await repo.predictions.insert(makePrediction("missing-prediction", "u1", match.match_id));
    await repo.settlements.insert(makeSettlement("missing-settlement", match.match_id, 1));
    await repo.settlementItems.insert(
      makeItem("missing-settlement", "missing-prediction", "u1", 1),
    );

    await expect(new RebuildUserStatsService(repo).rebuildUserStats("u1", NOW)).rejects
      .toMatchObject({ code: "INVALID_LEDGER" });
    expect(await repo.users.findById("u1")).toMatchObject({
      career_points: 0,
      career_valid_predictions: 0,
    });
  });

  it("目标用户存在 settling/correcting match 时返回 SETTLEMENT_ALREADY_RUNNING", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser("u1"));
    const match = makeMatch("active-user-match", WEEK_ANCHOR, {
      settlement_status: SettlementStatus.Settling,
    });
    await repo.matches.insert(match);
    await repo.predictions.insert(makePrediction("active-prediction", "u1", match.match_id));

    await expect(new RebuildUserStatsService(repo).rebuildUserStats("u1", NOW)).rejects
      .toMatchObject({ code: "SETTLEMENT_ALREADY_RUNNING" });
  });

  it("同一用户 rebuild 使用 maintenance lock 串行化", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser("u1"));
    const owner = "existing-owner";
    const key = userStatsRebuildLockKey("u1");
    await repo.jobLocks.acquire(key, owner, new Date(Date.now() + 60 * 60 * 1000));

    await expect(new RebuildUserStatsService(repo).rebuildUserStats("u1", NOW)).rejects
      .toMatchObject({ code: "SETTLEMENT_ALREADY_RUNNING" });
    await repo.jobLocks.release(key, owner);
  });

  it("cancelled 比赛仍带 applied item 时参与 rebuild，不被误杀", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser("u1"));
    const match = makeMatch("cancelled-match", WEEK_ANCHOR, {
      match_status: MatchStatus.Cancelled,
    });
    await insertFact(
      repo,
      match,
      makePrediction("cancelled-prediction", "u1", match.match_id),
      [1],
      [{
        id: "cancelled-settlement",
        version: 1,
        item: makeItem("cancelled-settlement", "cancelled-prediction", "u1", 1),
      }],
    );

    const outcome = await new RebuildUserStatsService(repo).rebuildUserStats("u1", NOW);

    expect(outcome.user).toMatchObject({
      career_points: 12,
      career_valid_predictions: 1,
      career_wdl_hits: 1,
      career_exact_hits: 1,
    });
  });

  it("applied 账本加载对 settling/correcting 比赛纵深防御抛 SETTLEMENT_ALREADY_RUNNING", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch("active-ledger-match", WEEK_ANCHOR, {
      settlement_status: SettlementStatus.Correcting,
    });
    const item = makeItem("active-ledger-settlement", "active-ledger-prediction", "u1", 1);
    await insertFact(
      repo,
      match,
      makePrediction("active-ledger-prediction", "u1", match.match_id),
      [1],
      [{ id: "active-ledger-settlement", version: 1, item }],
    );

    await expect(loadAppliedSettlementFacts(repo, [item])).rejects.toMatchObject({
      code: "SETTLEMENT_ALREADY_RUNNING",
    });
  });
});

describe("loadAppliedSettlementFacts 回放输入排序", () => {
  it("同一 prediction 多版本纠错乱序输入与顺序输入窗口 n/S/B 一致", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch("order-match", WEEK_ANCHOR, {
      result_version: 2,
      settled_result_version: 2,
    });
    const prediction = makePrediction("order-prediction", "u1", match.match_id);
    const v1 = makeItem("order-settlement-v1", "order-prediction", "u1", 1);
    const v2 = makeItem("order-settlement-v2", "order-prediction", "u1", 2, {
      old_score: MatchScoreValue.ExactHit,
      new_score: MatchScoreValue.WdlHit,
      score_delta: -9,
      old_wdl_hit: true,
      new_wdl_hit: true,
      old_exact_hit: true,
      new_exact_hit: false,
      valid_prediction_delta: 0,
    });
    await repo.matches.insert(match);
    await repo.predictions.insert(prediction);
    await repo.matchResults.insert(makeResult(match.match_id, 1));
    await repo.matchResults.insert(makeResult(match.match_id, 2));
    await repo.settlements.insert(makeSettlement(v1.settlement_id, match.match_id, 1));
    await repo.settlements.insert(makeSettlement(v2.settlement_id, match.match_id, 2));
    await repo.settlementItems.insert(v1);
    await repo.settlementItems.insert(v2);

    const asOf = new Date(NOW.getTime() + 1000);
    const sequential = buildLevelInputs(
      buildReplayFacts(await loadAppliedSettlementFacts(repo, [v1, v2])).facts,
      LevelScope.Career,
      asOf,
    );
    const shuffled = buildLevelInputs(
      buildReplayFacts(await loadAppliedSettlementFacts(repo, [v2, v1])).facts,
      LevelScope.Career,
      asOf,
    );

    expect(sequential).toEqual(shuffled);
    expect(sequential).toEqual({ n: 1, S: 3, b_points: 3, valid_total: 1 });
  });
});

describe("RebuildPeriodRankingsService", () => {
  it("K88 保留历史周榜 is_final，按 applied ledger 重建 correction 后 rank", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser("u1"));
    await repo.users.insert(makeUser("u2"));

    const facts = [
      {
        match: makeMatch("r1", new Date("2026-08-03T12:00:00.000Z"), {
          result_version: 2,
          settled_result_version: 2,
          regular_home_score: 2,
        }),
        prediction: makePrediction("rp1", "u1", "r1", {
          match_score: MatchScoreValue.WdlHit,
          wdl_hit: true,
          exact_hit: false,
          applied_result_version: 2,
        }),
        item: makeItem("rs1", "rp1", "u1", 1),
      },
      {
        match: makeMatch("r2", new Date("2026-08-04T12:00:00.000Z")),
        prediction: makePrediction("rp2", "u1", "r2", { pred_home_score: 2 }),
        item: makeItem("rs2", "rp2", "u1", 1, {
          new_score: MatchScoreValue.WdlHit,
          score_delta: 3,
          new_exact_hit: false,
        }),
      },
      {
        match: makeMatch("r3", new Date("2026-08-05T12:00:00.000Z")),
        prediction: makePrediction("rp3", "u1", "r3", {
          pred_home_score: 0,
          pred_away_score: 1,
          derived_result: Result.Away,
        }),
        item: makeItem("rs3", "rp3", "u1", 1, {
          new_score: MatchScoreValue.Miss,
          score_delta: 0,
          new_wdl_hit: false,
          new_exact_hit: false,
        }),
      },
      {
        match: makeMatch("r4", new Date("2026-08-06T12:00:00.000Z")),
        prediction: makePrediction("rp4", "u2", "r4"),
        item: makeItem("rs4", "rp4", "u2", 1),
      },
      {
        match: makeMatch("r5", new Date("2026-08-07T12:00:00.000Z")),
        prediction: makePrediction("rp5", "u2", "r5", {
          pred_home_score: 0,
          pred_away_score: 1,
          derived_result: Result.Away,
        }),
        item: makeItem("rs5", "rp5", "u2", 1, {
          new_score: MatchScoreValue.Miss,
          score_delta: 0,
          new_wdl_hit: false,
          new_exact_hit: false,
        }),
      },
      {
        match: makeMatch("r6", new Date("2026-08-08T12:00:00.000Z")),
        prediction: makePrediction("rp6", "u2", "r6", {
          pred_home_score: 0,
          pred_away_score: 1,
          derived_result: Result.Away,
        }),
        item: makeItem("rs6", "rp6", "u2", 1, {
          new_score: MatchScoreValue.Miss,
          score_delta: 0,
          new_wdl_hit: false,
          new_exact_hit: false,
        }),
      },
    ];
    for (const fact of facts) {
      if (fact.match.match_id === "r1") {
        const correction = makeItem("rs1-correction", "rp1", "u1", 2, {
          old_score: MatchScoreValue.ExactHit,
          new_score: MatchScoreValue.WdlHit,
          score_delta: -9,
          old_wdl_hit: true,
          new_wdl_hit: true,
          old_exact_hit: true,
          new_exact_hit: false,
          valid_prediction_delta: 0,
        });
        await insertFact(repo, fact.match, fact.prediction, [1, 2], [
          { id: fact.item.settlement_id, version: 1, item: fact.item },
          { id: correction.settlement_id, version: 2, item: correction },
        ]);
        continue;
      }
      await insertFact(repo, fact.match, fact.prediction, [1], [
        { id: fact.item.settlement_id, version: 1, item: fact.item },
      ]);
    }

    await repo.rankings.insert(
      makeRanking(PeriodType.Week, "2026-W32", "u1", { is_final: true }),
    );
    await repo.rankings.insert(makeRanking(PeriodType.Week, "2026-W32", "u2"));

    const outcome = await new RebuildPeriodRankingsService(repo).rebuildPeriodRankings(
      PeriodType.Week,
      "2026-W32",
      NOW,
    );

    expect(outcome.rankings).toEqual([
      expect.objectContaining({
        user_id: "u2",
        period_score: 12,
        valid_predictions: 3,
        wdl_hits: 1,
        exact_hits: 1,
        last_scoring_match_at: new Date("2026-08-06T12:00:00.000Z"),
        global_rank: 1,
      }),
      expect.objectContaining({
        user_id: "u1",
        period_score: 6,
        valid_predictions: 3,
        wdl_hits: 2,
        exact_hits: 0,
        last_scoring_match_at: new Date("2026-08-04T12:00:00.000Z"),
        global_rank: 2,
        is_final: true,
      }),
    ]);
    expect(await repo.rankings.findByPeriodAndUser(PeriodType.Week, "2026-W32", "u1"))
      .toMatchObject({ period_score: 6, global_rank: 2, is_final: true });
  });

  it("目标周期存在 settling/correcting match 时返回 SETTLEMENT_ALREADY_RUNNING", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch("active-ranking-match", WEEK_ANCHOR, {
      settlement_status: SettlementStatus.Correcting,
    });
    await repo.matches.insert(match);

    await expect(
      new RebuildPeriodRankingsService(repo).rebuildPeriodRankings(
        PeriodType.Week,
        "2026-W32",
        NOW,
      ),
    ).rejects.toMatchObject({ code: "SETTLEMENT_ALREADY_RUNNING" });
  });

  it("周期 rebuild 使用对应 maintenance lock", async () => {
    const repo = new InMemoryRepository();
    const key = periodRankingsRebuildLockKey(PeriodType.Week, "2026-W32");
    await repo.jobLocks.acquire(
      key,
      "existing-owner",
      new Date(Date.now() + 60 * 60 * 1000),
    );

    await expect(
      new RebuildPeriodRankingsService(repo).rebuildPeriodRankings(
        PeriodType.Week,
        "2026-W32",
        NOW,
      ),
    ).rejects.toMatchObject({ code: "SETTLEMENT_ALREADY_RUNNING" });
  });

  it("非法 period_type 失败关闭", async () => {
    const repo = new InMemoryRepository();

    await expect(
      new RebuildPeriodRankingsService(repo).rebuildPeriodRankings(
        "quarter" as PeriodType,
        "2026-Q3",
        NOW,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("只允许 week period_type", async () => {
    const repo = new InMemoryRepository();

    await expect(
      new RebuildPeriodRankingsService(repo).rebuildPeriodRankings(
        PeriodType.Month,
        "2026-08",
        NOW,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("week rebuild 跨六联赛装载不同 season_id 的比赛", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser("u1"));
    const chineseMatch = makeMatch("chinese-match", WEEK_ANCHOR, {
      league_id: "chinese_super_league",
      season_id: "2026",
    });
    await insertFact(
      repo,
      chineseMatch,
      makePrediction("chinese-prediction", "u1", "chinese-match"),
      [1],
      [{
        id: "chinese-settlement",
        version: 1,
        item: makeItem("chinese-settlement", "chinese-prediction", "u1", 1),
      }],
    );

    const outcome = await new RebuildPeriodRankingsService(repo).rebuildPeriodRankings(
      PeriodType.Week,
      "2026-W32",
      NOW,
    );

    expect(outcome.rankings).toEqual([
      expect.objectContaining({ user_id: "u1", period_score: 12, global_rank: 1 }),
    ]);
  });

  it("rebuildBoardSnapshot writes a new career snapshot version", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser("u1", {
      career_points: 24,
      career_wdl_hits: 2,
      career_exact_hits: 2,
      career_valid_predictions: 3,
    }));

    const outcome = await new RebuildPeriodRankingsService(repo).rebuildBoardSnapshot(
      RankingBoard.Career,
      NOW,
    );

    expect(outcome.snapshots).toEqual([
      expect.objectContaining({ board: RankingBoard.Career, user_id: "u1", rank: 1 }),
    ]);
    await expect(repo.boardSnapshots.findByBoardAndSnapshotAt(RankingBoard.Career, NOW))
      .resolves.toHaveLength(1);
  });

  it("rebuildBoardSnapshot writes a new season snapshot version", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser("u1"));
    await repo.userSeasonStats.insert(makeSeasonStats("u1", "2026_2027"));

    const outcome = await new RebuildPeriodRankingsService(repo).rebuildBoardSnapshot(
      RankingBoard.Season,
      NOW,
    );

    expect(outcome.snapshots).toEqual([
      expect.objectContaining({
        board: RankingBoard.Season,
        level_season_id: "2026_2027",
        user_id: "u1",
        rank: 1,
      }),
    ]);
    await expect(repo.boardSnapshots.findByBoardAndSnapshotAt(RankingBoard.Season, NOW))
      .resolves.toHaveLength(1);
  });
});
