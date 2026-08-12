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

function makeItem(): SettlementItem {
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
  };
}

function makeSeasonStats(): UserSeasonStats {
  return {
    schema_version: 1,
    user_id: USER_ID,
    season_id: "2026_2027",
    points: 3,
    valid_predictions: 1,
    wdl_hits: 1,
    exact_hits: 0,
    level: 1,
    best_level: 1,
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
      }),
    });
    expect(snapshot.season_stats).toContainEqual(expect.objectContaining({
      user_id: USER_ID,
      season_id: "2026_2027",
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
        global_rank: null,
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
        periods: [
          { period_type: PeriodType.Week, period_key: "2026-W32" },
          { period_type: PeriodType.Month, period_key: "2026-08" },
        ],
      },
    ]);
  });

  it("事实缺少 period_anchor_at 时 fail closed，不生成排行榜 expected", async () => {
    const repo = await setup({ period_anchor_at: null });
    const source = new RepositoryDailyConsistencySnapshotSource(repo);

    await expect(source.load(NOW)).rejects.toMatchObject({ code: "INVALID_LEDGER" });
  });

  it("expected best_level 保留现有 career/season 的历史最高等级", async () => {
    const repo = await setup();
    const user = await repo.users.findById(USER_ID);
    if (user === null) {
      throw new Error("expected seeded user");
    }
    await repo.users.update({ ...user, career_best_level: 6 });

    const seasonStats = await repo.userSeasonStats?.findByUserAndSeason(USER_ID, "2026_2027");
    if (seasonStats === undefined || seasonStats === null) {
      throw new Error("expected seeded season stats");
    }
    await repo.userSeasonStats?.update({ ...seasonStats, best_level: 5 });

    const snapshot = await new RepositoryDailyConsistencySnapshotSource(repo).load(NOW);

    expect(snapshot.career.find((entry) => entry.user_id === USER_ID)?.expected.career_best_level)
      .toBe(6);
    expect(
      snapshot.season_stats.find(
        (entry) => entry.user_id === USER_ID && entry.season_id === "2026_2027",
      )?.expected.best_level,
    ).toBe(5);
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
});
