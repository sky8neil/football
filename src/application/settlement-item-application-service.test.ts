import { describe, expect, it, vi } from "vitest";
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
import { newUuid } from "../domain/ids.js";
import { levelSeasonOf } from "../domain/time.js";
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
import { InMemoryRepository, UniqueConstraintError, type AppRepository, type UnitOfWork } from "../infrastructure/repositories.js";
import {
  rankingPeriodLockKey,
  rebuildGlobalRanks,
  rebuildGlobalRanksInTransaction,
  rebuildSettlementWeekRanks,
  SettlementItemApplicationService,
} from "./settlement-item-application-service.js";
import { SettlementOrchestrationService } from "./settlement-orchestration-service.js";
import { defaultLevelState } from "../domain/types.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const ANCHOR = new Date("2026-08-08T14:00:00.000Z");

function makeUser(overrides: Partial<User> = {}): User {
  return {
    schema_version: 1,
    user_id: "u1",
    openid: "openid_u1",
    unionid: null,
    nickname: "User",
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

function makeMatch(overrides: Partial<Match> = {}): Match {
  const canonicalMatchIdentity = overrides.match_id ?? ("m1");
  return {
    schema_version: 1,
    match_id: canonicalMatchIdentity,
    canonical_match_id: overrides.canonical_match_id ?? canonicalMatchIdentity,
    superseded_by: overrides.superseded_by ?? null,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: "team_home",
    away_team_id: "team_away",
    kickoff_at: ANCHOR,
    kickoff_confirmed: true,
    prediction_deadline_at: new Date(ANCHOR.getTime() - 600_000),
    prediction_closed_at: new Date(ANCHOR.getTime() - 600_000),
    period_anchor_at: ANCHOR,
    match_status: MatchStatus.Finished,
    settlement_status: SettlementStatus.Settling,
    regular_home_score: 2,
    regular_away_score: 1,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 1,
    settled_result_version: 0,
    result_source: "provider",
    scoring_rule_version: "scoring_v1",
    finish_detected_at: new Date(NOW.getTime() - 600_000),
    settled_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makePrediction(overrides: Partial<Prediction> = {}): Prediction {
  const canonicalMatchIdentity = overrides.match_id ?? ("m1");
  return {
    schema_version: 1,
    prediction_id: "p1",
    user_id: "u1",
    match_id: canonicalMatchIdentity,
    canonical_match_id: overrides.canonical_match_id ?? canonicalMatchIdentity,
    idempotency_key: newUuid(),
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

function makeResult(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    schema_version: 1,
    match_id: "m1",
    result_version: 1,
    regular_home_score: 2,
    regular_away_score: 1,
    source: "provider",
    provider_status: "FT",
    admin_id: null,
    reason: null,
    created_at: NOW,
    ...overrides,
  };
}

function makeSettlement(overrides: Partial<SettlementDoc> = {}): SettlementDoc {
  return {
    schema_version: 1,
    settlement_id: "s1",
    match_id: "m1",
    result_version: 1,
    rule_version: "scoring_v1",
    status: SettlementDocStatus.Running,
    phase: SettlementPhase.ApplyItems,
    is_correction: false,
    started_at: NOW,
    settled_at: null,
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
    settlement_id: "s1",
    prediction_id: "p1",
    user_id: "u1",
    old_score: MatchScoreValue.Miss,
    new_score: MatchScoreValue.ExactHit,
    score_delta: 12,
    old_wdl_hit: false,
    new_wdl_hit: true,
    old_exact_hit: false,
    new_exact_hit: true,
    valid_prediction_delta: 1,
    source_result_version: 1,
    status: SettlementItemStatus.Pending,
    applied_at: null,
    attempt_count: 0,
    last_error_code: null,
    last_error_message: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

async function setup(overrides: {
  user?: Partial<User>;
  prediction?: Partial<Prediction>;
  match?: Partial<Match>;
  item?: Partial<SettlementItem>;
  settlement?: Partial<SettlementDoc>;
} = {}) {
  const repo = new InMemoryRepository();
  const user = makeUser(overrides.user);
  const match = makeMatch(overrides.match);
  const prediction = makePrediction(overrides.prediction);
  const settlement = makeSettlement(overrides.settlement);
  const item = makeItem(overrides.item);
  await repo.users.insert(user);
  await repo.matches.insert(match);
  await repo.predictions.insert(prediction);
  await repo.matchResults.insert(makeResult({
    match_id: match.match_id,
    result_version: settlement.result_version,
    regular_home_score: match.regular_home_score ?? 2,
    regular_away_score: match.regular_away_score ?? 1,
  }));
  await repo.settlements.insert({ ...settlement, match_id: match.match_id });
  await repo.settlementItems.insert({ ...item, settlement_id: settlement.settlement_id });
  return { repo, user, match, prediction, settlement, item };
}

describe("SettlementItemApplicationService", () => {
  it("无效 server_now 时独立应用入口 Fail Closed，且不写入账本", async () => {
    const { repo, settlement } = await setup();
    const invalidNow = new Date("invalid");

    await expect(
      new SettlementItemApplicationService(repo).apply(
        settlement.settlement_id,
        "p1",
        invalidNow,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "server_now" },
    });
    expect(await repo.predictions.findById("p1")).toMatchObject({
      applied_result_version: 0,
      match_score: null,
    });
    expect(await repo.users.findById("u1")).toMatchObject({
      career_points: 0,
      career_valid_predictions: 0,
    });
    expect(
      await repo.settlementItems.findBySettlementAndPrediction(settlement.settlement_id, "p1"),
    ).toMatchObject({ status: SettlementItemStatus.Pending, attempt_count: 0 });
  });

  it("无效 server_now 时事务内应用入口也 Fail Closed", async () => {
    const { repo, settlement, item, match } = await setup();
    const result = await repo.matchResults.findByMatchAndVersion(
      match.match_id,
      settlement.result_version,
    );
    if (result === null) {
      throw new Error("expected seeded match result");
    }
    const invalidNow = new Date("invalid");

    await expect(
      repo.withTransaction((tx) =>
        new SettlementItemApplicationService(repo).applyInTransaction(
          tx,
          item,
          result,
          invalidNow,
        ),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "server_now" },
    });
    expect(
      await repo.settlementItems.findBySettlementAndPrediction(settlement.settlement_id, "p1"),
    ).toMatchObject({ status: SettlementItemStatus.Pending, attempt_count: 0 });
  });

  it("结算只更新统计与周榜，不即时写等级或月榜", async () => {
    const { repo, user, match, settlement } = await setup({
      user: {
        career_points: 18,
        career_valid_predictions: 20,
        career_wdl_hits: 3,
        career_level: 3,
        career_best_level: 4,
      },
      match: { season_id: "league-season" },
    });
    const service = new SettlementItemApplicationService(repo);
    const levelBefore = await repo.users.findById(user.user_id);

    const outcome = await service.apply(settlement.settlement_id, "p1", NOW);

    expect(outcome.kind).toBe("applied");
    expect(await repo.predictions.findById("p1")).toMatchObject({
      match_score: MatchScoreValue.ExactHit,
      wdl_hit: true,
      exact_hit: true,
      applied_result_version: 1,
    });
    expect(await repo.users.findById(user.user_id)).toMatchObject({
      career_points: 30,
      career_valid_predictions: 21,
      career_wdl_hits: 4,
      career_exact_hits: 1,
      career_level: levelBefore?.career_level,
      career_best_level: levelBefore?.career_best_level,
      career_level_state: levelBefore?.career_level_state,
      career_last_scoring_match_at: ANCHOR,
    });

    const levelSeasonId = levelSeasonOf(match.period_anchor_at as Date);
    const season = await repo.userSeasonStats.findByUserAndSeason(user.user_id, levelSeasonId);
    expect(season).not.toHaveProperty("season_id");
    expect(season).toMatchObject({
      level_season_id: levelSeasonId,
      points: 12,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
      last_scoring_match_at: ANCHOR,
      level: 1,
      best_level: 1,
    } satisfies Partial<UserSeasonStats>);

    const week = await repo.rankings.findByPeriodAndUser(
      PeriodType.Week,
      "2026-W32",
      user.user_id,
    );
    expect(week).toMatchObject({
      period_score: 12,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
      last_scoring_match_at: ANCHOR,
      global_rank: null,
    });
    expect((await repo.rankings.findAll()).some((entry) => entry.period_type === ("month" as PeriodType))).toBe(false);
    expect(await repo.levelHistory.findByUser(user.user_id)).toEqual([]);

    expect((await repo.unlocks.findByUser(user.user_id)).map((unlock) => unlock.unlock_code)).toEqual([
      "profile_card_style_1",
    ]);
    expect(await repo.settlementItems.findBySettlementAndPrediction(settlement.settlement_id, "p1"))
      .toMatchObject({ status: SettlementItemStatus.Applied, attempt_count: 1 });
  });

  it("[J70] [J71] [J72] [J76] correction 更新聚合且保留历史解锁", async () => {
    const { repo, user, match } = await setup({
      user: {
        career_points: 30,
        career_valid_predictions: 7,
        career_wdl_hits: 7,
        career_exact_hits: 1,
      },
      match: {
        result_version: 2,
        regular_home_score: 3,
        regular_away_score: 1,
        settled_result_version: 1,
        settlement_status: SettlementStatus.Correcting,
      },
      prediction: {
        match_score: MatchScoreValue.ExactHit,
        wdl_hit: true,
        exact_hit: true,
        applied_result_version: 1,
      },
      settlement: { settlement_id: "s2", result_version: 2, is_correction: true },
      item: {
        settlement_id: "s2",
        old_score: MatchScoreValue.ExactHit,
        new_score: MatchScoreValue.WdlHit,
        score_delta: -9,
        old_wdl_hit: true,
        new_wdl_hit: true,
        old_exact_hit: true,
        new_exact_hit: false,
        valid_prediction_delta: 0,
        source_result_version: 2,
      },
    });
    const priorUnlock = {
      schema_version: 1,
      unlock_id: newUuid(),
      user_id: user.user_id,
      unlock_code: "profile_card_style_1",
      threshold_points: 30,
      source_version: "unlock_v1",
      unlocked_at: NOW,
    } as const;
    await repo.unlocks.insert(priorUnlock);
    await repo.userSeasonStats.insert({
      schema_version: 1,
      user_id: user.user_id,
      level_season_id: levelSeasonOf(match.period_anchor_at as Date),
      points: 12,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
      last_scoring_match_at: ANCHOR,
      level: 1,
      best_level: 1,
      level_state: defaultLevelState(),
      is_level_frozen: false,
      created_at: NOW,
      updated_at: NOW,
    });
    await repo.rankings.insert({
      schema_version: 1,
      period_type: PeriodType.Week,
      period_key: "2026-W32",
      user_id: user.user_id,
      period_score: 12,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
      last_scoring_match_at: ANCHOR,
      global_rank: null,
      is_final: false,
      created_at: NOW,
      updated_at: NOW,
    } satisfies RankingEntry);

    const outcome = await new SettlementItemApplicationService(repo).apply("s2", "p1", NOW);

    expect(outcome.kind).toBe("applied");
    expect(await repo.users.findById(user.user_id)).toMatchObject({
      career_points: 21,
      career_valid_predictions: 7,
      career_wdl_hits: 7,
      career_exact_hits: 0,
    });
    await expect(repo.unlocks.findByUser(user.user_id)).resolves.toEqual([priorUnlock]);
    await expect(repo.userSeasonStats.findByUserAndSeason(user.user_id, "2026_2027"))
      .resolves.toMatchObject({
        points: 3,
        valid_predictions: 1,
        wdl_hits: 1,
        exact_hits: 0,
      });
    await expect(repo.rankings.findByPeriodAndUser(PeriodType.Week, "2026-W32", user.user_id))
      .resolves.toMatchObject({
        period_score: 3,
        valid_predictions: 1,
        wdl_hits: 1,
        exact_hits: 0,
      });
    expect(await repo.predictions.findById("p1")).toMatchObject({
      match_score: MatchScoreValue.WdlHit,
      applied_result_version: 2,
    });
    expect(await repo.settlementItems.findBySettlementAndPrediction("s2", "p1"))
      .toMatchObject({ status: SettlementItemStatus.Applied, attempt_count: 1 });
  });

  it("零分修正移除赛季最新得分时间后回退到次新场次", async () => {
    const { repo, user, match } = await setup({
      user: {
        career_points: 15,
        career_valid_predictions: 2,
        career_wdl_hits: 2,
        career_exact_hits: 1,
      },
      match: {
        result_version: 2,
        regular_home_score: 0,
        regular_away_score: 0,
        settled_result_version: 1,
        settlement_status: SettlementStatus.Correcting,
      },
      prediction: {
        match_score: MatchScoreValue.ExactHit,
        wdl_hit: true,
        exact_hit: true,
        applied_result_version: 1,
      },
      settlement: { settlement_id: "s2", result_version: 2, is_correction: true },
      item: {
        settlement_id: "s2",
        old_score: MatchScoreValue.ExactHit,
        new_score: MatchScoreValue.Miss,
        score_delta: -12,
        old_wdl_hit: true,
        new_wdl_hit: false,
        old_exact_hit: true,
        new_exact_hit: false,
        valid_prediction_delta: 0,
        source_result_version: 2,
      },
    });
    const earlierAt = new Date(ANCHOR.getTime() - 24 * 60 * 60 * 1000);
    await repo.matches.insert(makeMatch({
      match_id: "m2",
      period_anchor_at: earlierAt,
      settlement_status: SettlementStatus.Settled,
      settled_result_version: 1,
    }));
    await repo.predictions.insert(makePrediction({
      prediction_id: "p2",
      match_id: "m2",
      idempotency_key: newUuid(),
      match_score: MatchScoreValue.WdlHit,
      wdl_hit: true,
      exact_hit: false,
      applied_result_version: 1,
    }));
    await repo.userSeasonStats.insert({
      schema_version: 1,
      user_id: user.user_id,
      level_season_id: levelSeasonOf(match.period_anchor_at as Date),
      points: 15,
      valid_predictions: 2,
      wdl_hits: 2,
      exact_hits: 1,
      last_scoring_match_at: ANCHOR,
      level: 1,
      best_level: 1,
      level_state: defaultLevelState(),
      is_level_frozen: false,
      created_at: NOW,
      updated_at: NOW,
    });
    await repo.rankings.insert({
      schema_version: 1,
      period_type: PeriodType.Week,
      period_key: "2026-W32",
      user_id: user.user_id,
      period_score: 15,
      valid_predictions: 2,
      wdl_hits: 2,
      exact_hits: 1,
      last_scoring_match_at: ANCHOR,
      global_rank: null,
      is_final: false,
      created_at: NOW,
      updated_at: NOW,
    });

    await new SettlementItemApplicationService(repo).apply("s2", "p1", NOW);

    await expect(repo.userSeasonStats.findByUserAndSeason(user.user_id, "2026_2027"))
      .resolves.toMatchObject({ points: 3, last_scoring_match_at: earlierAt });
  });

  it("已 applied 重放不重复改变聚合、历史或解锁", async () => {
    const { repo, settlement } = await setup({
      item: { status: SettlementItemStatus.Applied, applied_at: NOW, attempt_count: 1 },
      prediction: {
        match_score: MatchScoreValue.ExactHit,
        wdl_hit: true,
        exact_hit: true,
        applied_result_version: 1,
      },
      user: { career_points: 12, career_valid_predictions: 1, career_wdl_hits: 1, career_exact_hits: 1 },
    });
    const service = new SettlementItemApplicationService(repo);

    const outcome = await service.apply(settlement.settlement_id, "p1", NOW);

    expect(outcome.kind).toBe("already_applied");
    expect(await repo.users.findById("u1")).toMatchObject({ career_points: 12 });
    expect(await repo.unlocks.findByUser("u1")).toHaveLength(0);
  });

  it("所属 settlement 非 running 时 fail closed，不应用 item", async () => {
    const { repo, settlement } = await setup({
      match: {
        settlement_status: SettlementStatus.Settled,
        settled_result_version: 1,
        settled_at: NOW,
      },
      settlement: {
        status: SettlementDocStatus.Settled,
        phase: SettlementPhase.Done,
        settled_at: NOW,
      },
    });

    await expect(
      new SettlementItemApplicationService(repo).apply(settlement.settlement_id, "p1", NOW),
    ).rejects.toMatchObject({ code: "INVALID_LEDGER" });
    expect(await repo.predictions.findById("p1")).toMatchObject({
      applied_result_version: 0,
      match_score: null,
    });
    expect(await repo.users.findById("u1")).toMatchObject({
      career_points: 0,
      career_valid_predictions: 0,
    });
    expect(
      await repo.settlementItems.findBySettlementAndPrediction(settlement.settlement_id, "p1"),
    ).toMatchObject({ status: SettlementItemStatus.Pending, attempt_count: 0 });
  });

  it("prediction 已写入目标版本但 item 未标记时，只补 applied 状态不重复累加", async () => {
    const { repo, settlement } = await setup({
      user: { career_points: 12, career_valid_predictions: 1, career_wdl_hits: 1, career_exact_hits: 1 },
      prediction: {
        match_score: MatchScoreValue.ExactHit,
        wdl_hit: true,
        exact_hit: true,
        applied_result_version: 1,
      },
    });

    const outcome = await new SettlementItemApplicationService(repo).apply(
      settlement.settlement_id,
      "p1",
      NOW,
    );

    expect(outcome.kind).toBe("applied");
    expect(await repo.users.findById("u1")).toMatchObject({
      career_points: 12,
      career_valid_predictions: 1,
    });
    expect(await repo.settlementItems.findBySettlementAndPrediction(settlement.settlement_id, "p1"))
      .toMatchObject({ status: SettlementItemStatus.Applied, attempt_count: 1 });
  });

  it("ledger 字段不一致时 fail closed，并回滚所有写入", async () => {
    const { repo, settlement } = await setup();
    const storedItem = await repo.settlementItems.findBySettlementAndPrediction(
      settlement.settlement_id,
      "p1",
    );
    if (storedItem === null) {
      throw new Error("expected seeded settlement item");
    }
    // 模拟已落盘但损坏的事实数据，绕过 repository 写入校验以测试应用层防线。
    storedItem.score_delta = 3;

    await expect(new SettlementItemApplicationService(repo).apply(settlement.settlement_id, "p1", NOW))
      .rejects.toMatchObject({ code: "INVALID_LEDGER" });
    expect(await repo.predictions.findById("p1")).toMatchObject({ applied_result_version: 0, match_score: null });
    expect(await repo.users.findById("u1")).toMatchObject({ career_points: 0, career_valid_predictions: 0 });
    expect(await repo.settlementItems.findBySettlementAndPrediction(settlement.settlement_id, "p1"))
      .toMatchObject({ status: SettlementItemStatus.Pending, attempt_count: 0 });
  });

  it("FirstSettlementService 使用 atomic worker 时实际应用 item 聚合", async () => {
    const { repo, user, match, settlement } = await setup({
      match: { settlement_status: SettlementStatus.Waiting },
      settlement: { status: SettlementDocStatus.Pending },
    });
    const service = new SettlementOrchestrationService(repo);

    const outcome = await service.startFirst(match.match_id, NOW, false);

    expect(outcome).toMatchObject({ kind: "started", processed_count: 1 });
    expect(await repo.users.findById(user.user_id)).toMatchObject({ career_points: 12 });
    expect(await repo.settlementItems.findBySettlementAndPrediction(settlement.settlement_id, "p1"))
      .toMatchObject({ status: SettlementItemStatus.Applied });
    expect((await repo.settlements.findById(settlement.settlement_id))?.status)
      .toBe(SettlementDocStatus.Settled);
  });

  it("§15.2 首次 0 -> v3 真实 apply：prediction applied_result_version=3，不抛 RESULT_VERSION_SKIPPED", async () => {
    const { repo, user, match, settlement } = await setup({
      match: {
        result_version: 3,
        regular_home_score: 3,
        regular_away_score: 1,
        settlement_status: SettlementStatus.Settling,
      },
      settlement: { result_version: 3, is_correction: false },
      item: {
        old_score: MatchScoreValue.Miss,
        new_score: MatchScoreValue.WdlHit,
        score_delta: 3,
        old_wdl_hit: false,
        new_wdl_hit: true,
        old_exact_hit: false,
        new_exact_hit: false,
        valid_prediction_delta: 1,
        source_result_version: 3,
      },
    });

    const outcome = await new SettlementItemApplicationService(repo).apply(
      settlement.settlement_id,
      "p1",
      NOW,
    );

    expect(outcome.kind).toBe("applied");
    expect(await repo.predictions.findById("p1")).toMatchObject({
      match_score: MatchScoreValue.WdlHit,
      wdl_hit: true,
      exact_hit: false,
      applied_result_version: 3,
    });
    expect(await repo.users.findById(user.user_id)).toMatchObject({
      career_points: 3,
      career_valid_predictions: 1,
    });
    expect(await repo.settlementItems.findBySettlementAndPrediction(settlement.settlement_id, "p1"))
      .toMatchObject({ status: SettlementItemStatus.Applied });
  });
});

  it("item 应用不受全局 ranking 周期锁影响", async () => {
    const { repo, settlement } = await setup();
    // jobLocks 用真实时钟判断 lease；必须使用相对当前时间的未来 lease。
    const leaseUntil = new Date(Date.now() + 60_000);
    expect(
      await repo.jobLocks.acquire("ranking:week:2026-W32", "other-owner", leaseUntil),
    ).toBe(true);

    await expect(
      new SettlementItemApplicationService(repo).apply(settlement.settlement_id, "p1", NOW),
    ).resolves.toMatchObject({ kind: "applied" });

    expect(await repo.predictions.findById("p1")).toMatchObject({
      applied_result_version: 1,
      match_score: MatchScoreValue.ExactHit,
    });
    expect(await repo.users.findById("u1")).toMatchObject({
      career_points: 12,
      career_valid_predictions: 1,
    });
    expect(
      await repo.settlementItems.findBySettlementAndPrediction(settlement.settlement_id, "p1"),
    ).toMatchObject({ status: SettlementItemStatus.Applied, attempt_count: 1 });
    expect(await repo.rankings.findByPeriodAndUser(PeriodType.Week, "2026-W32", "u1"))
      .toMatchObject({ global_rank: null });
  });

  it("item 应用只更新用户周榜聚合，不重排 global_rank", async () => {
    const { repo, settlement, user } = await setup({
      user: {
        career_points: 0,
        career_valid_predictions: 2,
        career_wdl_hits: 1,
      },
    });
    // 本用户已有 2 场周期统计，item 再 +1 后达到入榜门槛 3。
    await repo.rankings.insert({
      schema_version: 1,
      period_type: PeriodType.Week,
      period_key: "2026-W32",
      user_id: user.user_id,
      period_score: 0,
      valid_predictions: 2,
      wdl_hits: 0,
      exact_hits: 0,
      last_scoring_match_at: null,
      global_rank: null,
      is_final: false,
      created_at: NOW,
      updated_at: NOW,
    } satisfies RankingEntry);
    // 另两名用户已有 3 场，验证 item 应用不改写其他用户名次。
    for (const [userId, score, rank] of [
      ["u2", 30, 1],
      ["u3", 20, 2],
    ] as const) {
      await repo.users.insert(makeUser({ user_id: userId, openid: `openid_${userId}` }));
      await repo.rankings.insert({
        schema_version: 1,
        period_type: PeriodType.Week,
        period_key: "2026-W32",
        user_id: userId,
        period_score: score,
        valid_predictions: 3,
        wdl_hits: 2,
        exact_hits: 1,
        last_scoring_match_at: ANCHOR,
        global_rank: rank,
        is_final: false,
        created_at: NOW,
        updated_at: NOW,
      } satisfies RankingEntry);
    }

    await new SettlementItemApplicationService(repo).apply(settlement.settlement_id, "p1", NOW);

    const week = await repo.rankings.findByPeriodAndUser(PeriodType.Week, "2026-W32", user.user_id);
    expect(week).toMatchObject({
      period_score: 12,
      valid_predictions: 3,
      global_rank: null,
    });
    expect(await repo.rankings.findByPeriodAndUser(PeriodType.Week, "2026-W32", "u2"))
      .toMatchObject({ global_rank: 1 });
    expect(await repo.rankings.findByPeriodAndUser(PeriodType.Week, "2026-W32", "u3"))
      .toMatchObject({ global_rank: 2 });
    expect(
      await repo.jobLocks.acquire(
        "ranking:week:2026-W32",
        "post-success-owner",
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
    expect(
      await repo.jobLocks.acquire(
        "ranking:month:2026-08",
        "post-success-owner",
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
  });

  it("rankingPeriodLockKey 使用规范 15.8 冻结格式", () => {
    expect(rankingPeriodLockKey(PeriodType.Week, "2026-W32")).toBe("ranking:week:2026-W32");
  });

  it("[Slice 1] 排名重算原子局部更新，不覆盖并发新增的积分/有效场次/精确命中", async () => {
    const repo = new InMemoryRepository();
    const ranking = (userId: string, overrides: Partial<RankingEntry> = {}): RankingEntry => ({
      schema_version: 1,
      period_type: PeriodType.Week,
      period_key: "2026-W32",
      user_id: userId,
      period_score: 0,
      valid_predictions: 1,
      wdl_hits: 0,
      exact_hits: 0,
      last_scoring_match_at: null,
      global_rank: null,
      is_final: false,
      created_at: NOW,
      updated_at: NOW,
      ...overrides,
    });
    await repo.rankings.insert(ranking("u1"));
    await repo.rankings.insert(ranking("u2", {
      period_score: 12,
      valid_predictions: 3,
      wdl_hits: 1,
      exact_hits: 1,
    }));
    const staleSnapshot = structuredClone(
      await repo.rankings.findByPeriod(PeriodType.Week, "2026-W32"),
    );
    const u1 = await repo.rankings.findByPeriodAndUser(PeriodType.Week, "2026-W32", "u1");
    await repo.rankings.update({
      ...u1!,
      period_score: 12,
      valid_predictions: 3,
      wdl_hits: 1,
      exact_hits: 1,
    });

    await repo.withTransaction(async (tx) => {
      const staleTx = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop === "rankings") {
            return {
              ...Reflect.get(target, prop, receiver),
              findByPeriod: async () => staleSnapshot,
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      await rebuildGlobalRanksInTransaction(staleTx, PeriodType.Week, "2026-W32", NOW);
    });

    expect(await repo.rankings.findByPeriodAndUser(PeriodType.Week, "2026-W32", "u1"))
      .toMatchObject({
        period_score: 12,
        valid_predictions: 3,
        wdl_hits: 1,
        exact_hits: 1,
        global_rank: 2,
      });
    expect(await repo.rankings.findByPeriodAndUser(PeriodType.Week, "2026-W32", "u2"))
      .toMatchObject({ global_rank: 1 });
  });

  it("[A-S4-04] 增量重排保留注销用户周统计，仅清空 global_rank 且不占名次", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser({
      user_id: "u-deleted",
      openid: "openid_u_deleted",
      status: "deleted",
      deleted_at: new Date("2026-08-01T00:00:00.000Z"),
    }));
    await repo.users.insert(makeUser({ user_id: "u-active", openid: "openid_u_active" }));
    const ranking = (userId: string, score: number, rank: number): RankingEntry => ({
      schema_version: 1,
      period_type: PeriodType.Week,
      period_key: "2026-W32",
      user_id: userId,
      period_score: score,
      valid_predictions: 3,
      wdl_hits: 2,
      exact_hits: 1,
      last_scoring_match_at: ANCHOR,
      global_rank: rank,
      is_final: false,
      created_at: NOW,
      updated_at: NOW,
    });
    await repo.rankings.insert(ranking("u-deleted", 30, 1));
    await repo.rankings.insert(ranking("u-active", 12, 2));

    await repo.withTransaction((tx) =>
      rebuildGlobalRanksInTransaction(tx, PeriodType.Week, "2026-W32", NOW),
    );

    expect(await repo.rankings.findByPeriodAndUser(PeriodType.Week, "2026-W32", "u-deleted"))
      .toMatchObject({
        period_score: 30,
        valid_predictions: 3,
        wdl_hits: 2,
        exact_hits: 1,
        global_rank: null,
      });
    expect(await repo.rankings.findByPeriodAndUser(PeriodType.Week, "2026-W32", "u-active"))
      .toMatchObject({ period_score: 12, global_rank: 1 });
  });

  it("[Slice 1] 周榜重算在 repo.withTransaction 外持锁并在完成后释放", async () => {
    const repo = new InMemoryRepository();
    await repo.rankings.insert({
      schema_version: 1,
      period_type: PeriodType.Week,
      period_key: "2026-W32",
      user_id: "u1",
      period_score: 12,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
      last_scoring_match_at: ANCHOR,
      global_rank: null,
      is_final: false,
      created_at: NOW,
      updated_at: NOW,
    });
    const lockKey = rankingPeriodLockKey(PeriodType.Week, "2026-W32");
    let lockHeldInsideTransaction = false;
    const repoProxy = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "withTransaction") {
          return async (fn: Parameters<AppRepository["withTransaction"]>[0]) =>
            target.withTransaction(async (tx) => {
              lockHeldInsideTransaction = await target.jobLocks.isHeld(lockKey, new Date());
              return fn(tx);
            });
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    await rebuildSettlementWeekRanks(
      repoProxy as unknown as AppRepository,
      ANCHOR,
      new Date(),
    );

    expect(lockHeldInsideTransaction).toBe(true);
    expect(
      await repo.jobLocks.acquire(lockKey, "after-rebuild", new Date(Date.now() + 60_000)),
    ).toBe(true);
  });

  it("[Slice 1] ranking 锁释放失败不掩盖事务原始异常", async () => {
    const repo = new InMemoryRepository();
    await repo.rankings.insert({
      schema_version: 1,
      period_type: PeriodType.Week,
      period_key: "2026-W32",
      user_id: "u1",
      period_score: 12,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
      last_scoring_match_at: ANCHOR,
      global_rank: null,
      is_final: false,
      created_at: NOW,
      updated_at: NOW,
    });
    const rankBoom = new Error("rank transaction boom");
    const repoProxy = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "jobLocks") {
          return {
            ...target.jobLocks,
            release: async () => {
              throw new Error("release boom");
            },
          };
        }
        if (prop === "withTransaction") {
          return async (fn: Parameters<AppRepository["withTransaction"]>[0]) =>
            target.withTransaction((tx) => {
              const failingTx = new Proxy(tx, {
                get(txTarget, txProp, txReceiver) {
                  if (txProp === "rankings") {
                    return {
                      ...Reflect.get(txTarget, txProp, txReceiver),
                      updateGlobalRank: async () => {
                        throw rankBoom;
                      },
                    };
                  }
                  return Reflect.get(txTarget, txProp, txReceiver);
                },
              });
              return fn(failingTx);
            });
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    await expect(
      rebuildSettlementWeekRanks(
        repoProxy as unknown as AppRepository,
        ANCHOR,
        new Date(),
      ),
    ).rejects.toBe(rankBoom);
  });

  it("[Slice 2] 落后墙钟的 now 仍按 Date.now() 计算 leaseUntil", async () => {
    const repo = new InMemoryRepository();
    await repo.rankings.insert({
      schema_version: 1,
      period_type: PeriodType.Week,
      period_key: "2026-W32",
      user_id: "u1",
      period_score: 12,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
      last_scoring_match_at: ANCHOR,
      global_rank: null,
      is_final: false,
      created_at: NOW,
      updated_at: NOW,
    });
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

    await rebuildGlobalRanks(
      repoProxy as unknown as AppRepository,
      PeriodType.Week,
      "2026-W32",
      staleNow,
      { retryDelaysMs: [] },
    );

    expect(acquireSpy).toHaveBeenCalled();
    const leaseUntil = acquireSpy.mock.calls[0]![2] as Date;
    expect(leaseUntil.getTime()).toBeGreaterThan(wallClockBefore);
    expect(leaseUntil.getTime()).toBeGreaterThan(Date.now());
  });

  it("[Slice 2] acquire 短退避：第二次成功则完成并释放，全部失败则抛 RANKING_REBUILD_ALREADY_RUNNING", async () => {
    const ranking = {
      schema_version: 1,
      period_type: PeriodType.Week,
      period_key: "2026-W32",
      user_id: "u1",
      period_score: 12,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
      last_scoring_match_at: ANCHOR,
      global_rank: null,
      is_final: false,
      created_at: NOW,
      updated_at: NOW,
    };
    const lockKey = rankingPeriodLockKey(PeriodType.Week, "2026-W32");

    const successRepo = new InMemoryRepository();
    await successRepo.rankings.insert({ ...ranking });
    const successLocks = successRepo.jobLocks;
    const originalAcquire = successLocks.acquire.bind(successLocks);
    let acquireCalls = 0;
    vi.spyOn(successLocks, "acquire").mockImplementation(async (key, ownerId, leaseUntil) => {
      acquireCalls += 1;
      if (acquireCalls === 1) return false;
      return originalAcquire(key, ownerId, leaseUntil);
    });
    const successProxy = new Proxy(successRepo, {
      get(target, prop, receiver) {
        if (prop === "jobLocks") return successLocks;
        return Reflect.get(target, prop, receiver);
      },
    });

    await rebuildGlobalRanks(
      successProxy as unknown as AppRepository,
      PeriodType.Week,
      "2026-W32",
      new Date(),
      { retryDelaysMs: [0, 0] },
    );
    expect(acquireCalls).toBe(2);
    expect(await successRepo.rankings.findByPeriodAndUser(PeriodType.Week, "2026-W32", "u1"))
      .toMatchObject({ global_rank: 1 });
    expect(
      await successRepo.jobLocks.acquire(lockKey, "after-retry", new Date(Date.now() + 60_000)),
    ).toBe(true);

    const failRepo = new InMemoryRepository();
    await failRepo.rankings.insert({ ...ranking });
    const failLocks = failRepo.jobLocks;
    vi.spyOn(failLocks, "acquire").mockResolvedValue(false);
    const failProxy = new Proxy(failRepo, {
      get(target, prop, receiver) {
        if (prop === "jobLocks") return failLocks;
        return Reflect.get(target, prop, receiver);
      },
    });

    await expect(
      rebuildGlobalRanks(
        failProxy as unknown as AppRepository,
        PeriodType.Week,
        "2026-W32",
        new Date(),
        { retryDelaysMs: [0, 0] },
      ),
    ).rejects.toMatchObject({ code: "RANKING_REBUILD_ALREADY_RUNNING" });
    expect(
      await failRepo.jobLocks.acquire(lockKey, "after-fail", new Date(Date.now() + 60_000)),
    ).toBe(true);
  });

  it("[A-S4-01] 同用户结算按 users → season → rankings 加锁，并只局部更新计分字段", async () => {
    const { repo, user, match, settlement } = await setup({
      user: {
        nickname: "Keeper",
        favorite_team_id: null,
        career_points: 18,
        career_valid_predictions: 20,
        career_wdl_hits: 3,
        career_exact_hits: 1,
        career_level: 3,
        career_best_level: 4,
      },
    });
    const seasonId = levelSeasonOf(match.period_anchor_at as Date);
    const seasonState = { ...defaultLevelState(), below_count: 1, last_eval_n: 1, last_eval_score_sum: 3, last_eval_b_points: 3 };
    await repo.userSeasonStats.insert({
      schema_version: 1,
      user_id: user.user_id,
      level_season_id: seasonId,
      points: 9,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
      last_scoring_match_at: ANCHOR,
      level: 1,
      best_level: 2,
      level_state: seasonState,
      is_level_frozen: true,
      created_at: NOW,
      updated_at: NOW,
    });
    await repo.rankings.insert({
      schema_version: 1,
      period_type: PeriodType.Week,
      period_key: "2026-W32",
      user_id: user.user_id,
      period_score: 9,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
      last_scoring_match_at: ANCHOR,
      global_rank: 4,
      is_final: true,
      created_at: NOW,
      updated_at: NOW,
    });
    const calls: string[] = [];
    const userPatches: Array<Partial<User>> = [];
    const seasonPatches: Array<Partial<UserSeasonStats>> = [];
    const rankingPatches: Array<Partial<RankingEntry>> = [];
    const original = repo.withTransaction.bind(repo);
    repo.withTransaction = (async (fn) => original(async (tx) => {
      const users = tx.users;
      const seasons = tx.userSeasonStats;
      const rankings = tx.rankings;
      if (seasons === undefined || rankings === undefined) throw new Error("missing ports");
      const wrapped = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop === "users") {
            return {
              ...users,
              findByIdForUpdate: async (id: string) => {
                calls.push("users.lock");
                return users.findByIdForUpdate!(id);
              },
              update: async (next: User) => {
                calls.push("users.update");
                return users.update(next);
              },
              patchFields: async (id: string, fields: Partial<User>) => {
                calls.push("users.patch");
                userPatches.push(fields);
                return users.patchFields!(id, fields);
              },
            };
          }
          if (prop === "userSeasonStats") {
            return {
              ...seasons,
              findByUserAndSeasonForUpdate: async (userId: string, levelSeasonId: string) => {
                calls.push("season.lock");
                return seasons.findByUserAndSeasonForUpdate!(userId, levelSeasonId);
              },
              update: async (next: UserSeasonStats) => {
                calls.push("season.update");
                return seasons.update(next);
              },
              patchFields: async (userId: string, levelSeasonId: string, fields: Partial<UserSeasonStats>) => {
                calls.push("season.patch");
                seasonPatches.push(fields);
                return seasons.patchFields!(userId, levelSeasonId, fields);
              },
            };
          }
          if (prop === "rankings") {
            return {
              ...rankings,
              findByPeriodAndUserForUpdate: async (...args: Parameters<NonNullable<typeof rankings.findByPeriodAndUserForUpdate>>) => {
                calls.push("ranking.lock");
                return rankings.findByPeriodAndUserForUpdate!(...args);
              },
              update: async (next: RankingEntry) => {
                calls.push("ranking.update");
                return rankings.update(next);
              },
              patchFields: async (...args: Parameters<NonNullable<typeof rankings.patchFields>>) => {
                calls.push("ranking.patch");
                rankingPatches.push(args[3]);
                return rankings.patchFields!(...args);
              },
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      return fn(wrapped);
    })) as AppRepository["withTransaction"];

    await new SettlementItemApplicationService(repo).apply(settlement.settlement_id, "p1", NOW);

    expect(calls.indexOf("users.lock")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("users.lock")).toBeLessThan(calls.indexOf("season.lock"));
    expect(calls.indexOf("season.lock")).toBeLessThan(calls.indexOf("ranking.lock"));
    expect(calls.indexOf("ranking.lock")).toBeLessThan(calls.indexOf("users.patch"));
    expect(calls).not.toContain("users.update");
    expect(calls).not.toContain("season.update");
    expect(calls).not.toContain("ranking.update");
    expect(Object.keys(userPatches[0] ?? {}).sort()).toEqual([
      "career_exact_hits",
      "career_last_scoring_match_at",
      "career_points",
      "career_valid_predictions",
      "career_wdl_hits",
      "updated_at",
    ]);
    expect(Object.keys(seasonPatches[0] ?? {}).sort()).toEqual([
      "exact_hits",
      "last_scoring_match_at",
      "points",
      "updated_at",
      "valid_predictions",
      "wdl_hits",
    ]);
    expect(Object.keys(rankingPatches[0] ?? {}).sort()).toEqual([
      "exact_hits",
      "last_scoring_match_at",
      "period_score",
      "updated_at",
      "valid_predictions",
      "wdl_hits",
    ]);
    expect(await repo.users.findById(user.user_id)).toMatchObject({
      nickname: "Keeper",
      career_points: 30,
      career_level: 3,
      career_best_level: 4,
      career_level_state: user.career_level_state,
    });
    expect(await repo.userSeasonStats.findByUserAndSeason(user.user_id, seasonId)).toMatchObject({
      points: 21,
      valid_predictions: 2,
      level: 1,
      best_level: 2,
      is_level_frozen: true,
      level_state: seasonState,
    });
    expect(await repo.rankings.findByPeriodAndUser(PeriodType.Week, "2026-W32", user.user_id)).toMatchObject({
      period_score: 21,
      valid_predictions: 2,
      global_rank: 4,
      is_final: true,
    });
  });

  it("[A-S4-01] 持锁未见 season/ranking 时 insert 计分行，不 patch", async () => {
    const { repo, user, match, settlement } = await setup({
      user: { nickname: "Keeper", career_level: 1, career_best_level: 1 },
    });
    const seasonId = levelSeasonOf(match.period_anchor_at as Date);
    const calls: string[] = [];
    const original = repo.withTransaction.bind(repo);
    repo.withTransaction = (async (fn: (tx: UnitOfWork) => Promise<unknown>) => original(async (tx) => {
      const seasons = tx.userSeasonStats;
      const rankings = tx.rankings;
      if (seasons === undefined || rankings === undefined) throw new Error("missing ports");
      const wrapped = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop === "users") {
            const users = target.users;
            return {
              ...users,
              findByIdForUpdate: async (id: string) => {
                calls.push("users.lock");
                return users.findByIdForUpdate!(id);
              },
            };
          }
          if (prop === "userSeasonStats") {
            return {
              ...seasons,
              findByUserAndSeasonForUpdate: async (userId: string, levelSeasonId: string) => {
                calls.push("season.lock");
                return seasons.findByUserAndSeasonForUpdate!(userId, levelSeasonId);
              },
              insert: async (row: UserSeasonStats) => {
                calls.push("season.insert");
                return seasons.insert(row);
              },
              patchFields: async () => {
                calls.push("season.patch");
                throw new Error("absent season must insert");
              },
            };
          }
          if (prop === "rankings") {
            return {
              ...rankings,
              findByPeriodAndUserForUpdate: async (...args: Parameters<NonNullable<typeof rankings.findByPeriodAndUserForUpdate>>) => {
                calls.push("ranking.lock");
                return rankings.findByPeriodAndUserForUpdate!(...args);
              },
              insert: async (row: RankingEntry) => {
                calls.push("ranking.insert");
                return rankings.insert(row);
              },
              patchFields: async () => {
                calls.push("ranking.patch");
                throw new Error("absent ranking must insert");
              },
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      return fn(wrapped);
    })) as AppRepository["withTransaction"];

    await new SettlementItemApplicationService(repo).apply(settlement.settlement_id, "p1", NOW);

    expect(calls).toEqual([
      "users.lock",
      "season.lock",
      "ranking.lock",
      "season.insert",
      "ranking.insert",
    ]);
    expect(await repo.users.findById(user.user_id)).toMatchObject({ nickname: "Keeper", career_points: 12 });
    expect(await repo.userSeasonStats.findByUserAndSeason(user.user_id, seasonId)).toMatchObject({
      points: 12,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
      level: 1,
      best_level: 1,
      is_level_frozen: false,
      last_scoring_match_at: ANCHOR,
    });
    expect(await repo.rankings.findByPeriodAndUser(PeriodType.Week, "2026-W32", user.user_id)).toMatchObject({
      period_score: 12,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
      global_rank: null,
      is_final: false,
      last_scoring_match_at: ANCHOR,
    });
  });

  it("[A-S4-01] season/ranking 唯一冲突直接失败，不在已中止事务内重锁", async () => {
    const { repo, user, match, settlement } = await setup({
      user: { nickname: "Keeper", career_level: 1, career_best_level: 1 },
    });
    const seasonId = levelSeasonOf(match.period_anchor_at as Date);
    const calls: string[] = [];
    const original = repo.withTransaction.bind(repo);
    repo.withTransaction = (async (fn: (tx: UnitOfWork) => Promise<unknown>) => original(async (tx) => {
      const seasons = tx.userSeasonStats;
      const rankings = tx.rankings;
      if (seasons === undefined || rankings === undefined) throw new Error("missing ports");
      const wrapped = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop === "users") {
            const users = target.users;
            return {
              ...users,
              findByIdForUpdate: async (id: string) => {
                calls.push("users.lock");
                return users.findByIdForUpdate!(id);
              },
            };
          }
          if (prop === "userSeasonStats") {
            return {
              ...seasons,
              findByUserAndSeasonForUpdate: async (userId: string, levelSeasonId: string) => {
                calls.push("season.lock");
                return seasons.findByUserAndSeasonForUpdate!(userId, levelSeasonId);
              },
              insert: async (row: UserSeasonStats) => {
                calls.push("season.insert");
                throw new UniqueConstraintError("user_season_stats", "uk_user_season", {
                  user_id: row.user_id,
                  level_season_id: row.level_season_id,
                });
              },
              patchFields: async () => {
                calls.push("season.patch");
                throw new Error("unique conflict must not patch");
              },
            };
          }
          if (prop === "rankings") {
            return {
              ...rankings,
              findByPeriodAndUserForUpdate: async (...args: Parameters<NonNullable<typeof rankings.findByPeriodAndUserForUpdate>>) => {
                calls.push("ranking.lock");
                return rankings.findByPeriodAndUserForUpdate!(...args);
              },
              insert: async (row: RankingEntry) => {
                calls.push("ranking.insert");
                throw new UniqueConstraintError("rankings", "uk_period_user", {
                  period_type: row.period_type,
                  period_key: row.period_key,
                  user_id: row.user_id,
                });
              },
              patchFields: async () => {
                calls.push("ranking.patch");
                throw new Error("unique conflict must not patch");
              },
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      return fn(wrapped);
    })) as AppRepository["withTransaction"];

    await expect(
      new SettlementItemApplicationService(repo).apply(settlement.settlement_id, "p1", NOW),
    ).rejects.toBeInstanceOf(UniqueConstraintError);

    expect(calls).toEqual([
      "users.lock",
      "season.lock",
      "ranking.lock",
      "season.insert",
    ]);
    expect(await repo.users.findById(user.user_id)).toMatchObject({ career_points: 0 });
    expect(await repo.userSeasonStats.findByUserAndSeason(user.user_id, seasonId)).toBeNull();
    expect(await repo.rankings.findByPeriodAndUser(PeriodType.Week, "2026-W32", user.user_id)).toBeNull();
    expect(await repo.settlementItems.findBySettlementAndPrediction(settlement.settlement_id, "p1"))
      .toMatchObject({ status: SettlementItemStatus.Pending, attempt_count: 0 });
  });
