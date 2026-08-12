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
import { newUuid } from "../domain/ids.js";
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
  rankingPeriodLockKey,
  SettlementItemApplicationService,
} from "./settlement-item-application-service.js";
import { SettlementOrchestrationService } from "./settlement-orchestration-service.js";

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
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    schema_version: 1,
    match_id: "m1",
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
  return {
    schema_version: 1,
    prediction_id: "p1",
    user_id: "u1",
    match_id: "m1",
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

  it("在一个事务中应用 item 到 prediction、career/season、week/month、level_history、unlock", async () => {
    const { repo, user, match, settlement } = await setup({
      user: {
        career_points: 18,
        career_valid_predictions: 6,
        career_wdl_hits: 3,
      },
    });
    const service = new SettlementItemApplicationService(repo);

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
      career_valid_predictions: 7,
      career_wdl_hits: 4,
      career_exact_hits: 1,
    });

    const season = await repo.userSeasonStats.findByUserAndSeason(user.user_id, match.season_id);
    expect(season).toMatchObject({
      points: 12,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
      level: 1,
      best_level: 1,
    } satisfies Partial<UserSeasonStats>);

    for (const periodType of [PeriodType.Week, PeriodType.Month]) {
      const ranking = await repo.rankings.findByPeriodAndUser(
        periodType,
        periodType === PeriodType.Week ? "2026-W32" : "2026-08",
        user.user_id,
      );
      expect(ranking).toMatchObject({
        period_score: 12,
        valid_predictions: 1,
        wdl_hits: 1,
        exact_hits: 1,
        last_scoring_match_at: ANCHOR,
        global_rank: null,
      });
    }

    expect((await repo.unlocks.findByUser(user.user_id)).map((unlock) => unlock.unlock_code)).toEqual([
      "profile_card_style_1",
    ]);
    expect(await repo.settlementItems.findBySettlementAndPrediction(settlement.settlement_id, "p1"))
      .toMatchObject({ status: SettlementItemStatus.Applied, attempt_count: 1 });
  });

  it("应用修正使用当前 prediction 作为 old 值，更新 delta 且不重复有效场次", async () => {
    const { repo, user, match } = await setup({
      user: {
        career_points: 12,
        career_valid_predictions: 1,
        career_wdl_hits: 1,
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
    await repo.userSeasonStats.insert({
      schema_version: 1,
      user_id: user.user_id,
      season_id: match.season_id,
      points: 12,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
      level: 1,
      best_level: 1,
      created_at: NOW,
      updated_at: NOW,
    });
    for (const periodType of [PeriodType.Week, PeriodType.Month]) {
      await repo.rankings.insert({
        schema_version: 1,
        period_type: periodType,
        period_key: periodType === PeriodType.Week ? "2026-W32" : "2026-08",
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
    }

    const outcome = await new SettlementItemApplicationService(repo).apply("s2", "p1", NOW);

    expect(outcome.kind).toBe("applied");
    expect(await repo.users.findById(user.user_id)).toMatchObject({
      career_points: 3,
      career_valid_predictions: 1,
      career_wdl_hits: 1,
      career_exact_hits: 0,
    });
    expect(await repo.predictions.findById("p1")).toMatchObject({
      match_score: MatchScoreValue.WdlHit,
      applied_result_version: 2,
    });
    expect(await repo.settlementItems.findBySettlementAndPrediction("s2", "p1"))
      .toMatchObject({ status: SettlementItemStatus.Applied, attempt_count: 1 });
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
});

  it("第 15.8 节 ranking 周期锁被占用时 Fail Closed，不写入账本", async () => {
    const { repo, settlement } = await setup();
    // jobLocks 用真实时钟判断 lease；必须使用相对当前时间的未来 lease。
    const leaseUntil = new Date(Date.now() + 60_000);
    expect(
      await repo.jobLocks.acquire("ranking:week:2026-W32", "other-owner", leaseUntil),
    ).toBe(true);

    await expect(
      new SettlementItemApplicationService(repo).apply(settlement.settlement_id, "p1", NOW),
    ).rejects.toMatchObject({ code: "SETTLEMENT_ALREADY_RUNNING" });

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
    expect(await repo.rankings.findByPeriodAndUser(PeriodType.Week, "2026-W32", "u1")).toBeNull();
  });

  it("成功应用后释放 week/month ranking 周期锁，并写入 global_rank", async () => {
    const { repo, settlement, user } = await setup({
      user: {
        career_points: 0,
        career_valid_predictions: 2,
        career_wdl_hits: 1,
      },
    });
    // 本用户已有 2 场周期统计，item 再 +1 后达到入榜门槛 3。
    for (const periodType of [PeriodType.Week, PeriodType.Month]) {
      await repo.rankings.insert({
        schema_version: 1,
        period_type: periodType,
        period_key: periodType === PeriodType.Week ? "2026-W32" : "2026-08",
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
    }
    // 另两名用户已有 3 场，确保排序后本用户 global_rank=3。
    for (const [userId, score, rank] of [
      ["u2", 30, 1],
      ["u3", 20, 2],
    ] as const) {
      await repo.users.insert(makeUser({ user_id: userId, openid: `openid_${userId}` }));
      for (const periodType of [PeriodType.Week, PeriodType.Month]) {
        await repo.rankings.insert({
          schema_version: 1,
          period_type: periodType,
          period_key: periodType === PeriodType.Week ? "2026-W32" : "2026-08",
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
    }

    await new SettlementItemApplicationService(repo).apply(settlement.settlement_id, "p1", NOW);

    const week = await repo.rankings.findByPeriodAndUser(PeriodType.Week, "2026-W32", user.user_id);
    const month = await repo.rankings.findByPeriodAndUser(PeriodType.Month, "2026-08", user.user_id);
    expect(week).toMatchObject({
      period_score: 12,
      valid_predictions: 3,
      global_rank: 3,
    });
    expect(month).toMatchObject({
      period_score: 12,
      valid_predictions: 3,
      global_rank: 3,
    });

    // 锁应已释放，其他 owner 可再次获取。
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
    expect(rankingPeriodLockKey(PeriodType.Month, "2026-08")).toBe("ranking:month:2026-08");
  });
