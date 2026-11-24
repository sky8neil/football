import { calculatePeriodKey } from "../domain/time.js";
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MatchStatus,
  PeriodType,
  SettlementDocStatus,
  SettlementPhase,
  SettlementStatus,
} from "../domain/enums.js";
import type {
  Match,
  BoardSnapshot,
  MatchResult,
  Prediction,
  RankingEntry,
  SettlementDoc,
  SettlementItem,
  User,
  UserSeasonStats,
} from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { checkDailyConsistency } from "./daily-consistency.js";
import {
  loadDailyConsistencySnapshot,
  RepositoryDailyConsistencySnapshotSource,
} from "./daily-consistency-snapshot.js";
import { defaultLevelState } from "../domain/types.js";

const ORIGINAL_FIRST_EVAL = FIXED_CONFIG_V1.LEVEL_FIRST_EVAL_AS_OF;
afterEach(() => Object.defineProperty(FIXED_CONFIG_V1, "LEVEL_FIRST_EVAL_AS_OF", { value: ORIGINAL_FIRST_EVAL, configurable: true }));

const NOW = new Date("2026-08-09T00:00:00.000Z");
const USER_ID = "user-1";
const MATCH_ID = "match-1";
const PREDICTION_ID = "prediction-1";
const SETTLEMENT_ID = "settlement-1";

function makeUser(overrides: Partial<User> = {}): User {
  return {
    schema_version: 1,
    user_id: USER_ID,
    openid: "openid-1",
    unionid: null,
    nickname: "User",
    favorite_team_id: null,
    status: "active",
    career_points: 3,
    career_valid_predictions: 1,
    career_wdl_hits: 1,
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

function makeMatch(overrides: Partial<Match> = {}): Match {
  const canonicalMatchIdentity = overrides.match_id ?? (MATCH_ID);
  return {
    schema_version: 1,
    match_id: canonicalMatchIdentity,
    canonical_match_id: overrides.canonical_match_id ?? canonicalMatchIdentity,
    superseded_by: overrides.superseded_by ?? null,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: "home-team",
    away_team_id: "away-team",
    kickoff_at: new Date("2026-08-08T06:00:00.000Z"),
    kickoff_confirmed: true,
    prediction_deadline_at: new Date("2026-08-08T05:50:00.000Z"),
    prediction_closed_at: new Date("2026-08-08T05:50:00.000Z"),
    period_anchor_at: new Date("2026-08-08T06:00:00.000Z"),
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
    scoring_rule_version: "scoring_v1",
    finish_detected_at: new Date("2026-08-08T07:00:00.000Z"),
    settled_at: new Date("2026-08-08T07:20:00.000Z"),
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makePrediction(): Prediction {
  return {
    schema_version: 1,
    prediction_id: PREDICTION_ID,
    user_id: USER_ID,
    match_id: MATCH_ID,
    canonical_match_id: MATCH_ID,
    idempotency_key: "idempotency-1",
    pred_home_score: 2,
    pred_away_score: 1,
    derived_result: "HOME",
    submitted_at: new Date("2026-08-08T05:00:00.000Z"),
    scoring_rule_version: "scoring_v1",
    match_score: 3,
    wdl_hit: true,
    exact_hit: false,
    applied_result_version: 1,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeResult(): MatchResult {
  return {
    schema_version: 1,
    match_id: MATCH_ID,
    result_version: 1,
    regular_home_score: 2,
    regular_away_score: 1,
    source: "provider",
    provider_status: "FT",
    admin_id: null,
    reason: null,
    created_at: NOW,
  };
}

function makeSettlement(overrides: Partial<SettlementDoc> = {}): SettlementDoc {
  return {
    schema_version: 1,
    settlement_id: SETTLEMENT_ID,
    match_id: MATCH_ID,
    result_version: 1,
    rule_version: "scoring_v1",
    status: SettlementDocStatus.Settled,
    phase: SettlementPhase.Done,
    is_correction: false,
    started_at: NOW,
    settled_at: NOW,
    attempt_count: 1,
    last_error_code: null,
    last_error_message: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeItem(overrides: Partial<SettlementItem> = {}): SettlementItem {
  return {
    schema_version: 1,
    settlement_id: SETTLEMENT_ID,
    prediction_id: PREDICTION_ID,
    user_id: USER_ID,
    old_score: 0,
    new_score: 12,
    score_delta: 12,
    old_wdl_hit: false,
    new_wdl_hit: true,
    old_exact_hit: false,
    new_exact_hit: true,
    valid_prediction_delta: 1,
    source_result_version: 1,
    status: "applied",
    applied_at: NOW,
    attempt_count: 1,
    last_error_code: null,
    last_error_message: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeSeasonStats(overrides: Partial<UserSeasonStats> = {}): UserSeasonStats {
  return {
    schema_version: 1,
    user_id: USER_ID,
    level_season_id: "2026_2027",
    points: 3,
    valid_predictions: 1,
    wdl_hits: 1,
    exact_hits: 0,
    last_scoring_match_at: new Date("2026-08-08T06:00:00.000Z"),
    level: 1,
    best_level: 1,
    level_state: defaultLevelState(),
    is_level_frozen: false,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeRanking(): RankingEntry {
  return {
    schema_version: 1,
    period_type: PeriodType.Week,
    period_key: "2026-W32",
    user_id: USER_ID,
    period_score: 3,
    valid_predictions: 1,
    wdl_hits: 1,
    exact_hits: 0,
    last_scoring_match_at: null,
    global_rank: null,
    is_final: false,
    created_at: NOW,
    updated_at: NOW,
  };
}

async function setup(matchOverrides: Partial<Match> = {}) {
  const repo = new InMemoryRepository();
  await repo.users.insert(makeUser());
  await repo.matches.insert(makeMatch(matchOverrides));
  await repo.predictions.insert(makePrediction());
  await repo.matchResults.insert(makeResult());
  await repo.settlements.insert(makeSettlement());
  await repo.settlementItems.insert(makeItem());
  await repo.userSeasonStats?.insert(makeSeasonStats());
  await repo.rankings?.insert(makeRanking());
  return repo;
}

describe("RepositoryDailyConsistencySnapshotSource", () => {
  it("按传入时间动态读取活跃赛季（当前与上一赛季）；省略时间时也按当前时间动态解析", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser());
    await repo.matches.insert(makeMatch({
      season_id: "2025_2026",
      settlement_status: SettlementStatus.Settling,
    }));
    await repo.predictions.insert(makePrediction());

    // 省略时间时也使用 activeSeasonIds(league, new Date()) 而非静态 league.season_id
    const defaultNowSnapshot = await repo.withTransaction((tx) => loadDailyConsistencySnapshot(tx));
    expect(defaultNowSnapshot.active_settlements).toContainEqual(expect.objectContaining({
      match_id: MATCH_ID,
      season_id: "2026_2027",
      periods: [{ period_type: PeriodType.Week, period_key: "2026-W32" }],
    }));

    const dynamicSnapshot = await new RepositoryDailyConsistencySnapshotSource(repo).load(NOW);
    expect(dynamicSnapshot.active_settlements).toContainEqual(expect.objectContaining({
      match_id: MATCH_ID,
      season_id: "2026_2027",
      periods: [{ period_type: PeriodType.Week, period_key: "2026-W32" }],
    }));

    // 跨入 2027_2028 后，2025_2026 不再属于活跃赛季窗口，而 2027_2028 比赛可被读取
    const nextSeasonMatchId = "22222222-2222-4222-8222-222222222222";
    await repo.matches.insert(makeMatch({
      match_id: nextSeasonMatchId,
      canonical_match_id: nextSeasonMatchId,
      season_id: "2027_2028",
      kickoff_at: new Date("2027-08-16T14:00:00.000Z"),
      period_anchor_at: new Date("2027-08-16T14:00:00.000Z"),
      settlement_status: SettlementStatus.Settling,
    }));
    const futureSnapshot = await new RepositoryDailyConsistencySnapshotSource(repo).load(
      new Date("2027-08-15T12:00:00.000Z"),
    );
    expect(futureSnapshot.active_settlements.map((s) => s.match_id)).toEqual([nextSeasonMatchId]);
  });

  it("从 applied ledger 重建 career、season 与 week ranking 的 expected 快照", async () => {
    const repo = await setup();
    const source = new RepositoryDailyConsistencySnapshotSource(repo);

    const snapshot = await source.load(NOW);

    expect(snapshot.career).toContainEqual({
      user_id: USER_ID,
      actual: expect.objectContaining({ career_points: 3 }),
      expected: expect.objectContaining({
        career_points: 12,
        career_valid_predictions: 1,
        career_wdl_hits: 1,
        career_exact_hits: 1,
        career_level: 1,
        career_best_level: 1,
        career_last_scoring_match_at: new Date("2026-08-08T06:00:00.000Z"),
      }),
    });
    expect(snapshot.season_stats).toContainEqual(expect.objectContaining({
      user_id: USER_ID,
      level_season_id: "2026_2027",
      actual: expect.objectContaining({ points: 3 }),
      expected: expect.objectContaining({ points: 12, exact_hits: 1 }),
    }));
    expect(snapshot.rankings).toContainEqual(expect.objectContaining({
      period_type: PeriodType.Week,
      period_key: "2026-W32",
      user_id: USER_ID,
      actual: expect.objectContaining({ period_score: 3 }),
      expected: expect.objectContaining({
        period_score: 12,
        valid_predictions: 1,
        exact_hits: 1,
        last_scoring_match_at: new Date("2026-08-08T06:00:00.000Z"),
        global_rank: 1,
      }),
    }));
  });

  it("[Slice 2] 优先用 findWeekEntriesSince 读取周榜而非全表 findAll", async () => {
    const repo = await setup();
    const baseRankings = repo.rankings;
    const calls: Array<{ minPeriodKey: string; includeUnfinalized: boolean | undefined }> = [];
    Object.defineProperty(repo, "rankings", {
      configurable: true,
      value: {
        ...baseRankings,
        findWeekEntriesSince: async (
          minPeriodKey: string,
          includeUnfinalized?: boolean,
        ) => {
          calls.push({ minPeriodKey, includeUnfinalized });
          return baseRankings.findWeekEntriesSince!(minPeriodKey, includeUnfinalized);
        },
      },
    });

    const snapshot = await loadDailyConsistencySnapshot(repo, NOW);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.includeUnfinalized).toBe(true);
    expect(calls[0]?.minPeriodKey).toMatch(/^\d{4}-W\d{2}$/);
    expect(snapshot.rankings).toContainEqual(expect.objectContaining({
      period_key: "2026-W32",
      user_id: USER_ID,
    }));
  });

  it("active settling/correcting match 仍出现在 scope，比较器会跳过受影响缓存", async () => {
    const repo = await setup({ settlement_status: SettlementStatus.Settling });
    const source = new RepositoryDailyConsistencySnapshotSource(repo);

    const result = checkDailyConsistency(await source.load(NOW));

    expect(result.differences).toEqual([]);
    expect(result.skipped_active_settlement).toEqual([
      {
        kind: "skipped_active_settlement",
        match_id: MATCH_ID,
        user_ids: [USER_ID],
        season_id: "2026_2027",
        periods: [{ period_type: PeriodType.Week, period_key: "2026-W32" }],
      },
    ]);
  });

  it("active match 缺少 period_anchor_at 时按 kickoff 定位受影响周", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser());
    await repo.matches.insert(makeMatch({
      period_anchor_at: null,
      settlement_status: SettlementStatus.Settling,
    }));
    await repo.predictions.insert(makePrediction());

    const snapshot = await new RepositoryDailyConsistencySnapshotSource(repo).load(NOW);

    expect(snapshot.active_settlements[0]).toMatchObject({
      match_id: MATCH_ID,
      user_ids: [USER_ID],
      periods: [{ period_type: PeriodType.Week, period_key: "2026-W32" }],
    });
  });

  it("事实缺少 period_anchor_at 时 fail closed，不生成排行榜 expected", async () => {
    const repo = await setup({ period_anchor_at: null });
    const source = new RepositoryDailyConsistencySnapshotSource(repo);

    await expect(source.load(NOW)).rejects.toMatchObject({ code: "INVALID_LEDGER" });
  });

  it("以 last_inputs 截面重算 career/season，不按当前总量即时定级", async () => {
    Object.defineProperty(FIXED_CONFIG_V1, "LEVEL_FIRST_EVAL_AS_OF", { value: new Date("2026-08-03T02:00:00.000Z"), configurable: true });
    const repo = await setup();
    const evalAt = new Date("2026-08-10T02:00:00.000Z");
    const cachedState = {
      ...defaultLevelState(),
      week_base_level: 1,
      week_base_below_count: 0,
      week_base_as_of: evalAt,
      last_eval_as_of: evalAt,
      last_eval_n: 0,
      last_eval_score_sum: 0,
      last_eval_b_points: 0,
      last_eval_rule_version: "level_v3.0",
    };
    const user = await repo.users.findById(USER_ID);
    if (user === null) {
      throw new Error("expected seeded user");
    }
    await repo.users.update({ ...user, career_level_state: cachedState });
    const seasonStats = await repo.userSeasonStats?.findByUserAndSeason(USER_ID, "2026_2027");
    if (seasonStats === undefined || seasonStats === null) {
      throw new Error("expected seeded season stats");
    }
    await repo.userSeasonStats?.update({ ...seasonStats, level_state: cachedState });

    const snapshot = await new RepositoryDailyConsistencySnapshotSource(repo).load(evalAt);

    expect(snapshot.career[0]?.expected).toMatchObject({
      career_level: 1,
      career_last_eval_n: 1,
      career_last_eval_score_sum: 12,
      career_last_eval_b_points: 12,
    });
    expect(snapshot.season_stats[0]?.expected).toMatchObject({
      level: 1,
      last_eval_n: 1,
      last_eval_score_sum: 12,
      last_eval_b_points: 12,
    });
  });

  it("last_eval 之后窗口内修正不产生等级差异（截面按 applied_at 过滤）", async () => {
    Object.defineProperty(FIXED_CONFIG_V1, "LEVEL_FIRST_EVAL_AS_OF", { value: new Date("2026-08-03T02:00:00.000Z"), configurable: true });
    const repo = new InMemoryRepository();
    const evalAt = new Date("2026-08-10T02:00:00.000Z");
    const firstAppliedAt = new Date("2026-08-08T07:30:00.000Z");
    const correctionAt = new Date("2026-08-12T02:00:00.000Z");
    await repo.users.insert(makeUser());
    await repo.matches.insert(makeMatch({ result_version: 2, settled_result_version: 2 }));
    await repo.predictions.insert(makePrediction());
    await repo.matchResults.insert(makeResult());
    await repo.matchResults.insert({
      ...makeResult(),
      result_version: 2,
      regular_home_score: 0,
      regular_away_score: 0,
    });
    await repo.settlements.insert(makeSettlement());
    await repo.settlements.insert(makeSettlement({
      settlement_id: "settlement-2",
      result_version: 2,
      is_correction: true,
      settled_at: correctionAt,
    }));
    await repo.settlementItems.insert({ ...makeItem(), applied_at: firstAppliedAt });
    await repo.settlementItems.insert(makeItem({
      settlement_id: "settlement-2",
      source_result_version: 2,
      applied_at: correctionAt,
      old_score: 12,
      new_score: 0,
      score_delta: -12,
      old_wdl_hit: true,
      new_wdl_hit: false,
      old_exact_hit: true,
      new_exact_hit: false,
      valid_prediction_delta: 0,
    }));
    await repo.userSeasonStats?.insert(makeSeasonStats());
    await repo.rankings?.insert(makeRanking());

    const cachedState = {
      ...defaultLevelState(),
      week_base_level: 1,
      week_base_below_count: 0,
      week_base_as_of: evalAt,
      last_eval_as_of: evalAt,
      last_eval_n: 1,
      last_eval_score_sum: 12,
      last_eval_b_points: 12,
      last_eval_rule_version: "level_v3.0",
    };
    const user = await repo.users.findById(USER_ID);
    if (user === null) {
      throw new Error("expected seeded user");
    }
    await repo.users.update({
      ...user,
      career_level: 1,
      career_best_level: 1,
      career_level_state: cachedState,
    });

    const result = checkDailyConsistency(
      await new RepositoryDailyConsistencySnapshotSource(repo).load(NOW),
    );
    const careerDifference = result.differences.find(
      (difference) => difference.scope === "career" && difference.key === USER_ID,
    );

    expect(careerDifference?.fields ?? []).not.toContain("career_level");
    expect(careerDifference?.fields ?? []).not.toContain("career_below_count");
    expect(careerDifference?.fields ?? []).not.toContain("career_last_eval_n");
    expect(careerDifference?.fields ?? []).not.toContain("career_last_eval_score_sum");
  });

  it("没有评估起点时纠正错误等级缓存为未定级基线", async () => {
    const repo = await setup();
    const user = await repo.users.findById(USER_ID);
    if (user === null) {
      throw new Error("expected seeded user");
    }
    await repo.users.update({
      ...user,
      career_valid_predictions: 20,
      career_level: 3,
      career_best_level: 4,
    });

    const seasonStats = await repo.userSeasonStats?.findByUserAndSeason(USER_ID, "2026_2027");
    if (seasonStats === undefined || seasonStats === null) {
      throw new Error("expected seeded season stats");
    }
    await repo.userSeasonStats?.update({
      ...seasonStats,
      valid_predictions: 20,
      level: 4,
      best_level: 4,
    });

    const snapshot = await new RepositoryDailyConsistencySnapshotSource(repo).load(NOW);

    expect(snapshot.career[0]?.expected).toMatchObject({
      career_level: 1,
      career_best_level: 1,
    });
    expect(snapshot.season_stats[0]?.expected).toMatchObject({
      level: 1,
      best_level: 1,
    });
  });

  it("expected best_level 采用事实下界（level 与 history 最大值），可检出低于下界", async () => {
    const repo = await setup();
    await repo.levelHistory.insert({
      schema_version: 1,
      level_history_id: "career-history-max",
      user_id: USER_ID,
      scope: "career",
      level_season_id: null,
      from_level: 3,
      to_level: 4,
      reason: "weekly_eval",
      eval_as_of: NOW,
      window_n: 0,
      window_score_sum: 0,
      b_points: 0,
      level_rule_version: "level_v3.0",
      settlement_id: null,
      changed_at: NOW,
    });
    const user = await repo.users.findById(USER_ID);
    if (user === null) {
      throw new Error("expected seeded user");
    }
    await repo.users.update({ ...user, career_best_level: 2 });

    const snapshot = await new RepositoryDailyConsistencySnapshotSource(repo).load(NOW);
    const result = checkDailyConsistency(snapshot);

    expect(snapshot.career.find((entry) => entry.user_id === USER_ID)?.expected.career_best_level)
      .toBe(4);
    expect(result.differences).toContainEqual(
      expect.objectContaining({
        scope: "career",
        key: USER_ID,
        fields: expect.arrayContaining(["career_best_level"]),
      }),
    );
  });

  it("expected best_level 等于事实下界时正常场景不误报 best_level", async () => {
    const repo = await setup();
    await repo.levelHistory.insert({
      schema_version: 1,
      level_history_id: "career-history-max",
      user_id: USER_ID,
      scope: "career",
      level_season_id: null,
      from_level: 3,
      to_level: 4,
      reason: "weekly_eval",
      eval_as_of: NOW,
      window_n: 0,
      window_score_sum: 0,
      b_points: 0,
      level_rule_version: "level_v3.0",
      settlement_id: null,
      changed_at: NOW,
    });
    const user = await repo.users.findById(USER_ID);
    if (user === null) {
      throw new Error("expected seeded user");
    }
    await repo.users.update({ ...user, career_best_level: 4 });

    const snapshot = await new RepositoryDailyConsistencySnapshotSource(repo).load(NOW);
    const result = checkDailyConsistency(snapshot);

    expect(snapshot.career.find((entry) => entry.user_id === USER_ID)?.expected.career_best_level)
      .toBe(4);
    expect(
      result.differences.flatMap((difference) => difference.fields),
    ).not.toContain("career_best_level");
  });

  it("prediction 缓存命中字段与 applied item 冲突时以 item 为准，只报警不改账本", async () => {
    const repo = await setup();
    const prediction = await repo.predictions.findById(PREDICTION_ID);
    if (prediction === null) {
      throw new Error("expected seeded prediction");
    }
    await repo.predictions.update({
      ...prediction,
      match_score: 3,
      wdl_hit: true,
      exact_hit: false,
      applied_result_version: 1,
    });

    const source = new RepositoryDailyConsistencySnapshotSource(repo);
    const snapshot = await source.load(NOW);

    const career = snapshot.career.find((entry) => entry.user_id === USER_ID);
    expect(career?.expected.career_points).toBe(12);
    expect(career?.expected.career_exact_hits).toBe(1);
    const ranking = snapshot.rankings.find(
      (entry) =>
        entry.period_type === PeriodType.Week &&
        entry.period_key === "2026-W32" &&
        entry.user_id === USER_ID,
    );
    expect(ranking?.expected.period_score).toBe(12);
    expect(ranking?.expected.exact_hits).toBe(1);

    const after = await repo.predictions.findById(PREDICTION_ID);
    expect(after).toMatchObject({
      match_score: 3,
      wdl_hit: true,
      exact_hit: false,
      applied_result_version: 1,
    });
  });

  it("daily consistency 抽样比较 career/strength 最新快照", async () => {
    const repo = await setup();
    const user = await repo.users.findById(USER_ID);
    if (user === null) {
      throw new Error("expected seeded user");
    }
    await repo.users.update({
      ...user,
      career_level_state: {
        ...defaultLevelState(),
        last_eval_n: 50,
        last_eval_score_sum: 300,
      },
    });
    await repo.users.insert(makeUser({
      user_id: "user-2",
      openid: "openid-2",
      nickname: "Changed",
      career_points: 0,
      career_valid_predictions: 1,
      career_wdl_hits: 0,
      career_exact_hits: 0,
      career_level_state: {
        ...defaultLevelState(),
        last_eval_n: 50,
        last_eval_score_sum: 600,
      },
      updated_at: new Date(NOW.getTime() + 60_000),
    }));
    const careerSnapshot: BoardSnapshot = {
      schema_version: 1,
      snapshot_id: "career-snapshot-1",
      board: "career",
      snapshot_at: NOW,
      level_season_id: null,
      is_final: false,
      user_id: USER_ID,
      rank: 2,
      career_points: 9,
      career_exact_hits: 0,
      career_valid_predictions: 1,
      career_last_scoring_match_at: null,
      window_score_sum: null,
      window_n: null,
      season_points: null,
      season_exact_hits: null,
      season_valid_predictions: null,
      season_last_scoring_match_at: null,
      created_at: NOW,
    };
    const strengthSnapshot: BoardSnapshot = {
      schema_version: 1,
      snapshot_id: "strength-snapshot-1",
      board: "strength",
      snapshot_at: NOW,
      level_season_id: null,
      is_final: false,
      user_id: USER_ID,
      rank: 1,
      career_points: null,
      career_exact_hits: null,
      career_valid_predictions: null,
      career_last_scoring_match_at: null,
      window_score_sum: 240,
      window_n: 50,
      season_points: null,
      season_exact_hits: null,
      season_valid_predictions: null,
      season_last_scoring_match_at: null,
      created_at: NOW,
    };
    await repo.boardSnapshots.insert(careerSnapshot);
    await repo.boardSnapshots.insert(strengthSnapshot);

    const snapshot = await new RepositoryDailyConsistencySnapshotSource(repo).load(NOW);
    const result = checkDailyConsistency(snapshot);

    expect(snapshot.board_snapshots).toContainEqual(expect.objectContaining({
      board: "career",
      user_id: USER_ID,
      rank_check_skipped: true,
      actual: expect.objectContaining({ rank: 2, career_points: 9 }),
      expected: expect.objectContaining({ rank: 1, career_points: 3 }),
    }));
    expect(snapshot.board_snapshots).toContainEqual(expect.objectContaining({
      board: "strength",
      user_id: USER_ID,
      rank_check_skipped: true,
      actual: expect.objectContaining({ rank: 1, window_score_sum: 240, window_n: 50 }),
      expected: expect.objectContaining({ rank: 2, window_score_sum: 300, window_n: 50 }),
    }));
    const snapshotDifferences = result.differences.filter(
      (difference) => difference.scope === "board_snapshot",
    );
    expect(snapshotDifferences).toHaveLength(2);
    expect(snapshotDifferences.flatMap((difference) => difference.fields)).not.toContain("rank");
    await expect(repo.boardSnapshots.findLatestByBoard("career")).resolves.toEqual([
      careerSnapshot,
    ]);
  });

  it("season snapshot skips rank checks when season stats changed after the snapshot", async () => {
    const repo = await setup();
    const secondUserId = "user-2";
    const secondUser = makeUser({
      user_id: secondUserId,
      openid: "openid-2",
      nickname: "Second",
      updated_at: NOW,
    });
    await repo.users.insert(secondUser);
    await repo.userSeasonStats?.insert(makeSeasonStats({
      user_id: secondUserId,
      points: 6,
      valid_predictions: 1,
      wdl_hits: 1,
      updated_at: NOW,
    }));

    const firstStats = await repo.userSeasonStats?.findByUserAndSeason(USER_ID, "2026_2027");
    if (firstStats === undefined || firstStats === null) {
      throw new Error("expected seeded season stats");
    }
    await repo.userSeasonStats?.update({
      ...firstStats,
      points: 12,
      exact_hits: 1,
      updated_at: new Date(NOW.getTime() + 60_000),
    });
    const seasonSnapshot = (userId: string, rank: number, points: number): BoardSnapshot => ({
      schema_version: 1,
      snapshot_id: `season-snapshot-${userId}`,
      board: "season",
      snapshot_at: NOW,
      level_season_id: "2026_2027",
      is_final: false,
      user_id: userId,
      rank,
      career_points: null,
      career_exact_hits: null,
      career_valid_predictions: null,
      career_last_scoring_match_at: null,
      window_score_sum: null,
      window_n: null,
      season_points: points,
      season_exact_hits: 0,
      season_valid_predictions: 1,
      season_last_scoring_match_at: new Date("2026-08-08T06:00:00.000Z"),
      created_at: NOW,
    });
    await repo.boardSnapshots.insert(seasonSnapshot(USER_ID, 2, 3));
    await repo.boardSnapshots.insert(seasonSnapshot(secondUserId, 1, 6));

    const snapshot = await new RepositoryDailyConsistencySnapshotSource(repo).load(NOW);
    const unchangedUser = snapshot.board_snapshots.find(
      (entry) => entry.board === "season" && entry.user_id === secondUserId,
    );

    expect(unchangedUser).toMatchObject({
      rank_check_skipped: true,
      actual: { rank: 1, season_points: 6 },
      expected: { rank: 2, season_points: 6 },
    });
    expect(checkDailyConsistency(snapshot).differences.filter(
      (difference) => difference.scope === "board_snapshot",
    )).toEqual([]);
  });

  it("[Slice 5.2] 不再全量调用 settlementItems.findByStatus，且非活跃旧赛季历史不误报差异", async () => {
    const repo = await setup();
    const user = await repo.users.findById(USER_ID);
    await repo.users.update({
      ...user!,
      career_points: 15,
      career_valid_predictions: 2,
      career_wdl_hits: 2,
      career_exact_hits: 1,
      career_last_scoring_match_at: new Date("2026-08-08T06:00:00.000Z"),
    });
    await repo.userSeasonStats.update(makeSeasonStats({
      points: 12,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
    }));
    await repo.rankings.update({
      ...makeRanking(),
      period_score: 12,
      exact_hits: 1,
      last_scoring_match_at: new Date("2026-08-08T06:00:00.000Z"),
      global_rank: 1,
    });

    const oldAnchor = new Date("2023-08-12T12:00:00.000Z");
    const oldMatchId = "old-match-2023";
    const oldPredictionId = "old-prediction-2023";
    const oldSettlementId = "old-settlement-2023";
    await repo.matches.insert(makeMatch({
      match_id: oldMatchId,
      canonical_match_id: oldMatchId,
      season_id: "2023_2024",
      kickoff_at: oldAnchor,
      period_anchor_at: oldAnchor,
      prediction_deadline_at: new Date(oldAnchor.getTime() - 600_000),
      prediction_closed_at: new Date(oldAnchor.getTime() - 600_000),
    }));
    await repo.predictions.insert({
      ...makePrediction(),
      prediction_id: oldPredictionId,
      match_id: oldMatchId,
      canonical_match_id: oldMatchId,
      idempotency_key: "idempotency-old-2023",
      match_score: 3,
      exact_hit: false,
      submitted_at: new Date(oldAnchor.getTime() - 3600_000),
    });
    await repo.matchResults.insert({
      ...makeResult(),
      match_id: oldMatchId,
    });
    await repo.settlements.insert(makeSettlement({
      settlement_id: oldSettlementId,
      match_id: oldMatchId,
    }));
    await repo.settlementItems.insert(makeItem({
      settlement_id: oldSettlementId,
      prediction_id: oldPredictionId,
      new_score: 3,
      score_delta: 3,
      new_exact_hit: false,
      applied_at: oldAnchor,
    }));
    await repo.userSeasonStats.insert(makeSeasonStats({
      level_season_id: "2023_2024",
      points: 3,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 0,
      last_scoring_match_at: oldAnchor,
      is_level_frozen: true,
    }));
    await repo.rankings.insert({
      schema_version: 1,
      period_type: PeriodType.Week,
      period_key: "2023-W32",
      user_id: USER_ID,
      period_score: 3,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 0,
      last_scoring_match_at: oldAnchor,
      global_rank: 1,
      is_final: true,
      created_at: oldAnchor,
      updated_at: oldAnchor,
    });

    const settlementItems = repo.settlementItems;
    const findByStatusSpy = vi.spyOn(settlementItems, "findByStatus");
    const repoProxy = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "settlementItems") return settlementItems;
        return Reflect.get(target, prop, receiver);
      },
    });
    const snapshot = await loadDailyConsistencySnapshot(repoProxy, NOW, null);
    const result = checkDailyConsistency(snapshot);

    expect(findByStatusSpy).not.toHaveBeenCalled();
    expect(result.differences).toEqual([]);
  });

  it("[Slice 2] 跨制式错位期 2028-02-15 与 2028-08-15 不误报差异，同时继续核查完整覆盖的 2027_2028", async () => {
    const repo = new InMemoryRepository();
    // 同周同等级赛季的多联赛交叉预测：
    // - 2026 H2 CSL (2026-10-03, score=3, season="2026", level_season="2026_2027")
    // - 2026-2027 Europe (2026-10-04, score=12, season="2026_2027", level_season="2026_2027")
    // - 2027 H1 CSL (2027-04-10, score=3, season="2027", level_season="2026_2027")
    // - 2026-2027 Europe spring (2027-04-11, score=12, season="2026_2027", level_season="2026_2027")
    // - 2027-2028 Europe (2027-10-03, score=12, season="2027_2028", level_season="2027_2028")
    const entries: ReadonlyArray<{
      id: string;
      league_id: "chinese_super_league" | "premier_league";
      season_id: string;
      anchor: Date;
      score: 3 | 12;
    }> = [
      {
        id: "csl-2026-h2",
        league_id: "chinese_super_league" as const,
        season_id: "2026",
        anchor: new Date("2026-10-03T11:30:00.000Z"),
        score: 3,
      },
      {
        id: "epl-2026-autumn",
        league_id: "premier_league" as const,
        season_id: "2026_2027",
        anchor: new Date("2026-10-04T14:00:00.000Z"),
        score: 12,
      },
      {
        id: "csl-2027-h1",
        league_id: "chinese_super_league" as const,
        season_id: "2027",
        anchor: new Date("2027-04-10T11:30:00.000Z"),
        score: 3,
      },
      {
        id: "epl-2026-spring",
        league_id: "premier_league" as const,
        season_id: "2026_2027",
        anchor: new Date("2027-04-11T14:00:00.000Z"),
        score: 12,
      },
      {
        id: "epl-2027-autumn",
        league_id: "premier_league" as const,
        season_id: "2027_2028",
        anchor: new Date("2027-10-03T14:00:00.000Z"),
        score: 12,
      },
    ];

    const weekTotals = new Map<string, {
      score: number;
      valid: number;
      wdl: number;
      exact: number;
      last: Date;
    }>();
    await repo.users.insert(makeUser({
      career_points: 42,
      career_valid_predictions: 5,
      career_wdl_hits: 5,
      career_exact_hits: 3,
      career_last_scoring_match_at: new Date("2027-10-03T14:00:00.000Z"),
    }));
    await repo.userSeasonStats.insert(makeSeasonStats({
      level_season_id: "2026_2027",
      points: 30,
      valid_predictions: 4,
      wdl_hits: 4,
      exact_hits: 2,
      last_scoring_match_at: new Date("2027-04-11T14:00:00.000Z"),
      is_level_frozen: true,
    }));
    await repo.userSeasonStats.insert(makeSeasonStats({
      level_season_id: "2027_2028",
      points: 12,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
      last_scoring_match_at: new Date("2027-10-03T14:00:00.000Z"),
      is_level_frozen: false,
    }));

    for (const item of entries) {
      const matchId = `m-${item.id}`;
      const predId = `p-${item.id}`;
      const settId = `s-${item.id}`;
      const exact = item.score === 12;
      await repo.matches.insert(makeMatch({
        match_id: matchId,
        canonical_match_id: matchId,
        league_id: item.league_id,
        season_id: item.season_id,
        kickoff_at: item.anchor,
        period_anchor_at: item.anchor,
        prediction_deadline_at: new Date(item.anchor.getTime() - 600_000),
        prediction_closed_at: new Date(item.anchor.getTime() - 600_000),
        regular_home_score: exact ? 2 : 1,
        regular_away_score: exact ? 1 : 0,
      }));
      await repo.predictions.insert({
        ...makePrediction(),
        prediction_id: predId,
        match_id: matchId,
        canonical_match_id: matchId,
        idempotency_key: `idem-${item.id}`,
        match_score: item.score,
        wdl_hit: true,
        exact_hit: exact,
        submitted_at: new Date(item.anchor.getTime() - 3600_000),
      });
      await repo.matchResults.insert({
        ...makeResult(),
        match_id: matchId,
        regular_home_score: exact ? 2 : 1,
        regular_away_score: exact ? 1 : 0,
      });
      await repo.settlements.insert(makeSettlement({
        settlement_id: settId,
        match_id: matchId,
        settled_at: item.anchor,
      }));
      await repo.settlementItems.insert(makeItem({
        settlement_id: settId,
        prediction_id: predId,
        new_score: item.score,
        score_delta: item.score,
        new_exact_hit: exact,
        applied_at: item.anchor,
      }));
      const weekKey = calculatePeriodKey(PeriodType.Week, item.anchor);
      const current = weekTotals.get(weekKey) ?? {
        score: 0,
        valid: 0,
        wdl: 0,
        exact: 0,
        last: item.anchor,
      };
      current.score += item.score;
      current.valid += 1;
      current.wdl += 1;
      current.exact += exact ? 1 : 0;
      if (item.anchor > current.last) current.last = item.anchor;
      weekTotals.set(weekKey, current);
    }
    for (const [periodKey, agg] of weekTotals) {
      await repo.rankings.insert({
        ...makeRanking(),
        period_key: periodKey,
        period_score: agg.score,
        valid_predictions: agg.valid,
        wdl_hits: agg.wdl,
        exact_hits: agg.exact,
        last_scoring_match_at: agg.last,
        global_rank: 1,
        is_final: true,
      });
    }

    const feb2028 = await loadDailyConsistencySnapshot(repo, new Date("2028-02-15T12:00:00.000Z"), null);
    expect(checkDailyConsistency(feb2028).differences).toEqual([]);
    expect(feb2028.season_stats.map((row) => row.level_season_id)).toEqual(["2027_2028"]);

    const aug2028 = await loadDailyConsistencySnapshot(repo, new Date("2028-08-15T12:00:00.000Z"), null);
    expect(checkDailyConsistency(aug2028).differences).toEqual([]);
    expect(aug2028.season_stats.map((row) => row.level_season_id)).toEqual(["2027_2028"]);

    // 验证完整覆盖的 2027_2028 若真实存在缓存偏差仍可被检出
    const s2027 = await repo.userSeasonStats.findByUserAndSeason(USER_ID, "2027_2028");
    await repo.userSeasonStats.update({ ...s2027!, points: 99 });
    const realDrift = await loadDailyConsistencySnapshot(repo, new Date("2028-08-15T12:00:00.000Z"), null);
    expect(checkDailyConsistency(realDrift).differences).toContainEqual(
      expect.objectContaining({
        scope: "season_stats",
        key: `${USER_ID}:2027_2028`,
        fields: ["points"],
      }),
    );
  });

  it("[Slice 3.3] batches per-match/per-user queries and aborts immediately when assertHealthy fails mid-scan", async () => {
    const repo = new InMemoryRepository();
    const service = repo;
    await repo.users.insert(makeUser({ user_id: USER_ID }));
    const m1 = makeMatch({ match_id: "m-batch-1", kickoff_at: NOW, period_anchor_at: NOW });
    const m2 = makeMatch({ match_id: "m-batch-2", kickoff_at: NOW, period_anchor_at: NOW });
    await repo.matches.insert(m1);
    await repo.matches.insert(m2);
    const s1: SettlementDoc = {
      schema_version: 1,
      settlement_id: "st-batch-1",
      match_id: m1.match_id,
      result_version: 1,
      rule_version: "1.0.0",
      is_correction: false,
      status: SettlementDocStatus.Settled,
      phase: SettlementPhase.Done,
      started_at: NOW,
      settled_at: NOW,
      attempt_count: 1,
      last_error_code: null,
      last_error_message: null,
      created_at: NOW,
      updated_at: NOW,
    };
    await repo.settlements.insert(s1);

    const settlements = repo.settlements;
    const levelHistory = repo.levelHistory;
    const userSeasonStats = repo.userSeasonStats;
    const findByMatchIdsSpy = vi.fn(settlements.findByMatchIds!);
    settlements.findByMatchIds = findByMatchIdsSpy;
    const findByMatchSpy = vi.spyOn(settlements, "findByMatch");
    const findByUserIdsHistSpy = vi.fn(levelHistory.findByUserIds!);
    levelHistory.findByUserIds = findByUserIdsHistSpy;
    const findByUserHistSpy = vi.spyOn(levelHistory, "findByUser");
    const findByUserIdsStatsSpy = vi.fn(userSeasonStats.findByUserIds!);
    userSeasonStats.findByUserIds = findByUserIdsStatsSpy;
    const findByUserStatsSpy = vi.spyOn(userSeasonStats, "findByUser");
    const repoProxy = new Proxy(service, {
      get(target, prop, receiver) {
        if (prop === "settlements") return settlements;
        if (prop === "levelHistory") return levelHistory;
        if (prop === "userSeasonStats") return userSeasonStats;
        return Reflect.get(target, prop, receiver);
      },
    });

    await loadDailyConsistencySnapshot(repoProxy, NOW, null);
    expect(findByMatchIdsSpy).toHaveBeenCalledTimes(1);
    expect(findByMatchSpy).not.toHaveBeenCalled();
    expect(findByUserIdsHistSpy).toHaveBeenCalledTimes(1);
    expect(findByUserHistSpy).not.toHaveBeenCalled();
    expect(findByUserIdsStatsSpy).toHaveBeenCalledTimes(1);
    expect(findByUserStatsSpy).not.toHaveBeenCalled();

    let calls = 0;
    await expect(loadDailyConsistencySnapshot(repoProxy, NOW, null, () => {
      calls += 1;
      if (calls >= 2) throw new Error("lost lock renewal");
    })).rejects.toThrow("lost lock renewal");
  });
});
