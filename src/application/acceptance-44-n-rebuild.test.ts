/**
 * 第 44 节 N. Rebuild 与一致性验收矩阵（N108-N113），按 49.5 修订。
 *
 * 唯一事实源 = status=applied 的 settlement_items + match.period_anchor_at 归属
 *   + unlock/level_history 只增不减规则；不得以 prediction 缓存命中字段为唯一输入。
 * - N108 rebuild_user_stats 后与 applied ledger 完全一致（非未结算 prediction 猜测）
 * - N109 rebuild_period_rankings 后与 applied items + period 归属完全一致
 * - N110 daily consistency 发现差异只报警，不自动修改
 * - N111 unlock 不因普通 rebuild 删除
 */
import { describe, expect, it } from "vitest";
import {
  MatchScoreValue,
  MatchStatus,
  PeriodType,
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
} from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { checkDailyConsistency } from "./daily-consistency.js";
import { RepositoryDailyConsistencySnapshotSource } from "./daily-consistency-snapshot.js";
import { RebuildPeriodRankingsService } from "./ranking-rebuild-service.js";
import { RebuildUserStatsService } from "./stats-rebuild-service.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const ANCHOR = new Date("2026-08-05T12:00:00.000Z");
const WEEK_KEY = "2026-W32";

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
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeMatch(matchId: string, overrides: Partial<Match> = {}): Match {
  return {
    schema_version: 1,
    match_id: matchId,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: `home_${matchId}`,
    away_team_id: `away_${matchId}`,
    kickoff_at: ANCHOR,
    kickoff_confirmed: true,
    prediction_deadline_at: null,
    prediction_closed_at: NOW,
    period_anchor_at: ANCHOR,
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
    pred_home_score: 2,
    pred_away_score: 1,
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
    regular_home_score: version === 1 ? 2 : 1,
    regular_away_score: version === 1 ? 1 : 0,
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

function makeRanking(overrides: Partial<RankingEntry> = {}): RankingEntry {
  return {
    schema_version: 1,
    period_type: PeriodType.Week,
    period_key: WEEK_KEY,
    user_id: "u1",
    period_score: 999,
    valid_predictions: 99,
    wdl_hits: 99,
    exact_hits: 99,
    last_scoring_match_at: new Date("2026-08-01T00:00:00.000Z"),
    global_rank: 1,
    is_final: false,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

async function insertAppliedFact(
  repo: InMemoryRepository,
  match: Match,
  prediction: Prediction,
  item: SettlementItem,
): Promise<void> {
  await repo.matches.insert(match);
  await repo.predictions.insert(prediction);
  await repo.matchResults.insert(makeResult(match.match_id, item.source_result_version));
  await repo.settlements.insert(
    makeSettlement(item.settlement_id, match.match_id, item.source_result_version),
  );
  await repo.settlementItems.insert(item);
}

describe("N. Rebuild 与一致性（规范 44-N / 49.5）", () => {
  it("N108 rebuild_user_stats 后与 applied ledger 完全一致，污染 prediction 缓存命中字段不影响结果", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser("u1"));

    // 故意污染 prediction 缓存命中字段：缓存说 wdl 命中 3 分，账本 item 是 exact 12 分。
    const polluted = makePrediction("p1", "u1", "m1", {
      match_score: MatchScoreValue.WdlHit,
      wdl_hit: true,
      exact_hit: false,
      applied_result_version: 0,
    });
    const item = makeItem("s1", "p1", "u1", 1);
    await insertAppliedFact(repo, makeMatch("m1"), polluted, item);

    const outcome = await new RebuildUserStatsService(repo).rebuildUserStats("u1", NOW);

    // 以 applied item 为准：12 分 / valid 1 / wdl 1 / exact 1，与 prediction 缓存无关。
    expect(outcome.user).toMatchObject({
      career_points: 12,
      career_valid_predictions: 1,
      career_wdl_hits: 1,
      career_exact_hits: 1,
    });
    expect(outcome.season_stats).toEqual([
      expect.objectContaining({
        season_id: "2026_2027",
        points: 12,
        valid_predictions: 1,
        wdl_hits: 1,
        exact_hits: 1,
      }),
    ]);
  });

  it("N109 rebuild_period_rankings 后与 applied items + period 归属完全一致，不读 prediction 缓存", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser("u1"));
    await repo.users.insert(makeUser("u2"));

    const m1 = makeMatch("r1", { period_anchor_at: new Date("2026-08-03T12:00:00.000Z") });
    const m2 = makeMatch("r2", { period_anchor_at: new Date("2026-08-04T12:00:00.000Z") });
    // u1 缓存污染为 wdl 3 分；u2 缓存污染为 exact 12 分（item 实际是 0 分 miss）。
    const pollutedU1 = makePrediction("rp1", "u1", "r1", {
      match_score: MatchScoreValue.WdlHit,
      wdl_hit: true,
      exact_hit: false,
    });
    const pollutedU2 = makePrediction("rp2", "u2", "r2", {
      pred_home_score: 0,
      pred_away_score: 1,
      derived_result: Result.Away,
      match_score: MatchScoreValue.ExactHit,
      wdl_hit: true,
      exact_hit: true,
    });
    await insertAppliedFact(
      repo,
      m1,
      pollutedU1,
      makeItem("rs1", "rp1", "u1", 1),
    );
    await insertAppliedFact(
      repo,
      m2,
      pollutedU2,
      makeItem("rs2", "rp2", "u2", 1, {
        new_score: MatchScoreValue.Miss,
        score_delta: 0,
        new_wdl_hit: false,
        new_exact_hit: false,
      }),
    );

    await repo.rankings.insert(makeRanking());

    const outcome = await new RebuildPeriodRankingsService(repo).rebuildPeriodRankings(
      PeriodType.Week,
      WEEK_KEY,
      NOW,
    );

    const byUser = Object.fromEntries(outcome.rankings.map((entry) => [entry.user_id, entry]));
    // u1 按 applied item 为 12 分；u2 按 applied item 为 0 分（非缓存 exact）。
    expect(byUser["u1"]).toMatchObject({
      period_score: 12,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
      global_rank: null,
    });
    expect(byUser["u2"]).toMatchObject({
      period_score: 0,
      valid_predictions: 1,
      wdl_hits: 0,
      exact_hits: 0,
      global_rank: null,
    });
  });

  it("N110 daily consistency 发现差异只报警，不自动修改账本", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser("u1", { career_points: 3 }));
    const match = makeMatch("d1");
    const prediction = makePrediction("dp1", "u1", "d1", {
      match_score: MatchScoreValue.WdlHit,
      wdl_hit: true,
      exact_hit: false,
    });
    await insertAppliedFact(repo, match, prediction, makeItem("ds1", "dp1", "u1", 1));

    const snapshot = await new RepositoryDailyConsistencySnapshotSource(repo).load(NOW);
    const result = checkDailyConsistency(snapshot);

    // 缓存（career_points=3）与账本（12 分）不一致 → 报警差异。
    expect(result.differences).toContainEqual(
      expect.objectContaining({
        scope: "career",
        key: "u1",
        fields: expect.arrayContaining(["career_points"]),
      }),
    );
    // 只报警不修改：用户文档保持不变。
    await expect(repo.users.findById("u1")).resolves.toMatchObject({ career_points: 3 });
  });

  it("N111 unlock 不因普通 rebuild 删除", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser("u1"));
    await repo.unlocks.insert({
      schema_version: 1,
      unlock_id: "unlock-1",
      user_id: "u1",
      unlock_code: "profile_card_style_1",
      threshold_points: 30,
      source_version: "unlock_v1",
      unlocked_at: NOW,
    });
    const prediction = makePrediction("up1", "u1", "um1");
    await insertAppliedFact(repo, makeMatch("um1"), prediction, makeItem("us1", "up1", "u1", 1));

    await new RebuildUserStatsService(repo).rebuildUserStats("u1", NOW);

    await expect(repo.unlocks.findByUser("u1")).resolves.toEqual([
      expect.objectContaining({
        unlock_code: "profile_card_style_1",
        threshold_points: 30,
      }),
    ]);
  });
});
