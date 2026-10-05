import { describe, expect, it } from "vitest";
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
import { RepositoryDailyConsistencySnapshotSource } from "./daily-consistency-snapshot.js";
import { defaultLevelState } from "../domain/types.js";

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
  return {
    schema_version: 1,
    match_id: MATCH_ID,
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

function makeSeasonStats(): UserSeasonStats {
  return {
    schema_version: 1,
    user_id: USER_ID,
    level_season_id: "2026_2027",
    points: 3,
    valid_predictions: 1,
    wdl_hits: 1,
    exact_hits: 0,
    level: 1,
    best_level: 1,
    level_state: defaultLevelState(),
    is_level_frozen: false,
    created_at: NOW,
    updated_at: NOW,
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

  it("没有评估起点时保留等级缓存，不按当前账本制造等级差异", async () => {
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
      career_level: 3,
      career_best_level: 3,
    });
    expect(snapshot.season_stats[0]?.expected).toMatchObject({
      level: 4,
      best_level: 4,
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
      user_id: USER_ID,
      rank: 2,
      career_points: 9,
      career_exact_hits: 0,
      career_valid_predictions: 1,
      career_last_scoring_match_at: null,
      window_score_sum: null,
      window_n: null,
      created_at: NOW,
    };
    const strengthSnapshot: BoardSnapshot = {
      schema_version: 1,
      snapshot_id: "strength-snapshot-1",
      board: "strength",
      snapshot_at: NOW,
      user_id: USER_ID,
      rank: 1,
      career_points: null,
      career_exact_hits: null,
      career_valid_predictions: null,
      career_last_scoring_match_at: null,
      window_score_sum: 240,
      window_n: 50,
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
});
