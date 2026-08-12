import { describe, expect, it } from "vitest";
import {
  MatchScoreValue,
  PeriodType,
  SettlementItemStatus,
} from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { SettlementItem } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import {
  rebuildPeriodRankings,
  type PeriodRef,
} from "./ranking-rebuild.js";
import { RebuildPeriodRankingsService } from "./ranking-rebuild-service.js";

const { Miss, WdlHit, ExactHit } = MatchScoreValue;

const WEEK: PeriodRef = {
  period_type: PeriodType.Week,
  period_key: "2026_W32",
};
const MONTH: PeriodRef = {
  period_type: PeriodType.Month,
  period_key: "2026_08",
};
const OTHER_WEEK: PeriodRef = {
  period_type: PeriodType.Week,
  period_key: "2026_W33",
};

const t = (iso: string): Date => new Date(iso);

function makeItem(overrides: Partial<SettlementItem> = {}): SettlementItem {
  return {
    schema_version: 1,
    settlement_id: newUuid(),
    prediction_id: newUuid(),
    user_id: "u1",
    old_score: Miss,
    new_score: ExactHit,
    score_delta: 12,
    old_wdl_hit: false,
    new_wdl_hit: true,
    old_exact_hit: false,
    new_exact_hit: true,
    valid_prediction_delta: 1,
    source_result_version: 1,
    status: SettlementItemStatus.Applied,
    applied_at: t("2026-08-01T00:00:00Z"),
    attempt_count: 1,
    last_error_code: null,
    last_error_message: null,
    created_at: t("2026-08-01T00:00:00Z"),
    updated_at: t("2026-08-01T00:00:00Z"),
    ...overrides,
  } as SettlementItem;
}

/** 未命中的 prediction 仍有 applied item（0 分 / valid+1）。 */
function missItem(predictionId: string, userId = "u1"): SettlementItem {
  return makeItem({
    prediction_id: predictionId,
    user_id: userId,
    old_score: Miss,
    new_score: Miss,
    score_delta: 0,
    old_wdl_hit: false,
    new_wdl_hit: false,
    old_exact_hit: false,
    new_exact_hit: false,
    valid_prediction_delta: 1,
  });
}

/** wdl 命中（3 分）。 */
function wdlItem(predictionId: string, userId = "u1"): SettlementItem {
  return makeItem({
    prediction_id: predictionId,
    user_id: userId,
    old_score: Miss,
    new_score: WdlHit,
    score_delta: 3,
    old_wdl_hit: false,
    new_wdl_hit: true,
    old_exact_hit: false,
    new_exact_hit: false,
    valid_prediction_delta: 1,
  });
}

/** exact 命中（12 分）。 */
function exactItem(predictionId: string, userId = "u1"): SettlementItem {
  return makeItem({
    prediction_id: predictionId,
    user_id: userId,
    old_score: Miss,
    new_score: ExactHit,
    score_delta: 12,
    old_wdl_hit: false,
    new_wdl_hit: true,
    old_exact_hit: false,
    new_exact_hit: true,
    valid_prediction_delta: 1,
  });
}

function periodMap(
  pairs: Array<[string, PeriodRef]>,
): ReadonlyMap<string, PeriodRef> {
  return new Map(pairs);
}

function anchorMap(pairs: Array<[string, Date]>): ReadonlyMap<string, Date> {
  return new Map(pairs);
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

describe("rebuildPeriodRankings - 聚合", () => {
  it("空 ledger 返回空数组", () => {
    expect(rebuildPeriodRankings([], new Map(), new Map())).toEqual([]);
  });

  it("单用户单场精确命中：period_score=12 / valid=1 / wdl=1 / exact=1", () => {
    const result = rebuildPeriodRankings(
      [exactItem("p1")],
      periodMap([["p1", WEEK]]),
      anchorMap([["p1", t("2026-08-05T20:00:00Z")]]),
    );
    expect(result).toEqual([
      {
        period_type: "week",
        period_key: "2026_W32",
        user_id: "u1",
        period_score: 12,
        valid_predictions: 1,
        wdl_hits: 1,
        exact_hits: 1,
        last_scoring_match_at: t("2026-08-05T20:00:00Z"),
        global_rank: null,
      },
    ]);
  });

  it("仅 wdl 命中：period_score=3 / valid=1 / wdl=1 / exact=0", () => {
    const result = rebuildPeriodRankings(
      [wdlItem("p1")],
      periodMap([["p1", MONTH]]),
      anchorMap([["p1", t("2026-08-05T20:00:00Z")]]),
    );
    expect(result).toEqual([
      {
        period_type: "month",
        period_key: "2026_08",
        user_id: "u1",
        period_score: 3,
        valid_predictions: 1,
        wdl_hits: 1,
        exact_hits: 0,
        last_scoring_match_at: t("2026-08-05T20:00:00Z"),
        global_rank: null,
      },
    ]);
  });

  it("同一用户多场累计 + 修正链 0->12 再 12->3：points=6 / valid=2 / wdl=2 / exact=0", () => {
    const correction = makeItem({
      prediction_id: "p1",
      old_score: ExactHit,
      new_score: WdlHit,
      score_delta: -9,
      old_wdl_hit: true,
      new_wdl_hit: true,
      old_exact_hit: true,
      new_exact_hit: false,
      valid_prediction_delta: 0,
      source_result_version: 2,
    });
    const result = rebuildPeriodRankings(
      [exactItem("p1"), wdlItem("p2"), correction],
      periodMap([
        ["p1", WEEK],
        ["p2", WEEK],
      ]),
      anchorMap([
        ["p1", t("2026-08-05T20:00:00Z")],
        ["p2", t("2026-08-06T20:00:00Z")],
      ]),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      user_id: "u1",
      period_score: 6,
      valid_predictions: 2,
      wdl_hits: 2,
      exact_hits: 0,
    });
  });

  it("多用户按 user 分组聚合", () => {
    const result = rebuildPeriodRankings(
      [exactItem("p1", "u1"), wdlItem("p2", "u2")],
      periodMap([
        ["p1", WEEK],
        ["p2", WEEK],
      ]),
      anchorMap([
        ["p1", t("2026-08-05T20:00:00Z")],
        ["p2", t("2026-08-06T20:00:00Z")],
      ]),
    );
    expect(result).toHaveLength(2);
    const byUser = Object.fromEntries(result.map((e) => [e.user_id, e]));
    expect(byUser["u1"]).toMatchObject({
      period_score: 12,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
    });
    expect(byUser["u2"]).toMatchObject({
      period_score: 3,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 0,
    });
  });
});

describe("RebuildPeriodRankingsService", () => {
  it("无效 server_now 在获取 maintenance lock 前 Fail Closed", async () => {
    const repo = new InMemoryRepository();

    await expect(
      new RebuildPeriodRankingsService(repo).rebuildPeriodRankings(
        PeriodType.Week,
        "2026-W32",
        new Date("invalid"),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "server_now" },
    });

    await expect(repo.rankings.findByPeriod(PeriodType.Week, "2026-W32")).resolves.toEqual([]);
  });

  it("第 15.8 节 ranking 周期锁被占用时 Fail Closed，不写 rankings", async () => {
    const repo = new InMemoryRepository();
    const rankingLockKey = "ranking:week:2026-W32";
    const leaseUntil = new Date(Date.now() + 60 * 60 * 1000);
    await expect(
      repo.jobLocks.acquire(rankingLockKey, "other-owner", leaseUntil),
    ).resolves.toBe(true);

    await expect(
      new RebuildPeriodRankingsService(repo).rebuildPeriodRankings(
        PeriodType.Week,
        "2026-W32",
        new Date("2026-08-09T00:00:00.000Z"),
      ),
    ).rejects.toMatchObject({
      code: "SETTLEMENT_ALREADY_RUNNING",
      details: { lock_key: rankingLockKey },
    });

    await expect(repo.rankings.findByPeriod(PeriodType.Week, "2026-W32")).resolves.toEqual([]);
  });

  it("成功 rebuild 后释放 ranking 周期锁", async () => {
    const repo = new InMemoryRepository();
    const rankingLockKey = "ranking:week:2026-W32";

    await expect(
      new RebuildPeriodRankingsService(repo).rebuildPeriodRankings(
        PeriodType.Week,
        "2026-W32",
        new Date("2026-08-09T00:00:00.000Z"),
      ),
    ).resolves.toMatchObject({
      rankings: [],
      created_count: 0,
      updated_count: 0,
    });

    await expect(
      repo.jobLocks.acquire(
        rankingLockKey,
        "after-rebuild-owner",
        new Date(Date.now() + 60 * 60 * 1000),
      ),
    ).resolves.toBe(true);
  });
});

describe("rebuildPeriodRankings - last_scoring_match_at", () => {
  it("取最新 source result 且 new_score>0 的 match anchor 最大值", () => {
    const result = rebuildPeriodRankings(
      [exactItem("p1"), wdlItem("p2")],
      periodMap([
        ["p1", WEEK],
        ["p2", WEEK],
      ]),
      anchorMap([
        ["p1", t("2026-08-05T20:00:00Z")],
        ["p2", t("2026-08-07T20:00:00Z")],
      ]),
    );
    expect(result[0]!.last_scoring_match_at).toEqual(t("2026-08-07T20:00:00Z"));
  });

  it("修正到 0 的 prediction 不再计入 last_scoring（按最高 source result）", () => {
    const first = exactItem("p1");
    const toZero = makeItem({
      prediction_id: "p1",
      old_score: ExactHit,
      new_score: Miss,
      score_delta: -12,
      old_wdl_hit: true,
      new_wdl_hit: false,
      old_exact_hit: true,
      new_exact_hit: false,
      valid_prediction_delta: 0,
      source_result_version: 2,
    });
    const result = rebuildPeriodRankings(
      [first, toZero, wdlItem("p2")],
      periodMap([
        ["p1", WEEK],
        ["p2", WEEK],
      ]),
      anchorMap([
        ["p1", t("2026-08-05T20:00:00Z")],
        ["p2", t("2026-08-06T20:00:00Z")],
      ]),
    );
    expect(result[0]).toMatchObject({
      period_score: 3,
      valid_predictions: 2,
      wdl_hits: 1,
      exact_hits: 0,
      last_scoring_match_at: t("2026-08-06T20:00:00Z"),
    });
  });

  it("period_score=0 时 last_scoring_match_at 强制 null（即使存在计分 candidate）", () => {
    const a = wdlItem("a");
    const b = makeItem({
      prediction_id: "b",
      old_score: WdlHit,
      new_score: ExactHit,
      score_delta: 9,
      old_wdl_hit: true,
      new_wdl_hit: true,
      old_exact_hit: false,
      new_exact_hit: true,
      valid_prediction_delta: 0,
      source_result_version: 2,
    });
    const c = makeItem({
      prediction_id: "c",
      old_score: ExactHit,
      new_score: Miss,
      score_delta: -12,
      old_wdl_hit: true,
      new_wdl_hit: false,
      old_exact_hit: true,
      new_exact_hit: false,
      valid_prediction_delta: 0,
      source_result_version: 2,
    });
    const result = rebuildPeriodRankings(
      [a, b, c],
      periodMap([
        ["a", WEEK],
        ["b", WEEK],
        ["c", WEEK],
      ]),
      anchorMap([
        ["a", t("2026-08-01T20:00:00Z")],
        ["b", t("2026-08-02T20:00:00Z")],
        ["c", t("2026-08-03T20:00:00Z")],
      ]),
    );
    expect(result[0]).toMatchObject({
      period_score: 0,
      valid_predictions: 1,
      last_scoring_match_at: null,
    });
  });
});

describe("rebuildPeriodRankings - 排序与 global_rank", () => {
  it("多用户按 domain 比较器排序并分配 global_rank", () => {
    const result = rebuildPeriodRankings(
      [wdlItem("a", "u1"), exactItem("b1", "u2"), wdlItem("b2", "u2"), wdlItem("b3", "u2"), wdlItem("c", "u3")],
      periodMap([
        ["a", WEEK],
        ["b1", WEEK],
        ["b2", WEEK],
        ["b3", WEEK],
        ["c", WEEK],
      ]),
      anchorMap([
        ["a", t("2026-08-01T20:00:00Z")],
        ["b1", t("2026-08-02T20:00:00Z")],
        ["b2", t("2026-08-03T20:00:00Z")],
        ["b3", t("2026-08-04T20:00:00Z")],
        ["c", t("2026-08-05T20:00:00Z")],
      ]),
    );
    expect(result.map((e) => e.user_id)).toEqual(["u2", "u1", "u3"]);
    expect(result[0]!.global_rank).toBe(1);
    expect(result[1]!.global_rank).toBeNull();
    expect(result[2]!.global_rank).toBeNull();
  });

  it("valid_predictions>=3 全部入榜，按排序位置分配 rank", () => {
    // u1: 3 场 3 分（1 wdl，last_scoring 早）
    // u2: 3 场 9 分（3 wdl）
    // u3: 3 场 3 分（1 wdl，last_scoring 晚）
    const result = rebuildPeriodRankings(
      [
        wdlItem("a1", "u1"), missItem("a2", "u1"), missItem("a3", "u1"),
        wdlItem("b1", "u2"), wdlItem("b2", "u2"), wdlItem("b3", "u2"),
        wdlItem("c1", "u3"), missItem("c2", "u3"), missItem("c3", "u3"),
      ],
      periodMap([
        ["a1", WEEK], ["a2", WEEK], ["a3", WEEK],
        ["b1", WEEK], ["b2", WEEK], ["b3", WEEK],
        ["c1", WEEK], ["c2", WEEK], ["c3", WEEK],
      ]),
      anchorMap([
        ["a1", t("2026-08-01T20:00:00Z")],
        ["a2", t("2026-08-02T20:00:00Z")],
        ["a3", t("2026-08-03T20:00:00Z")],
        ["b1", t("2026-08-04T20:00:00Z")],
        ["b2", t("2026-08-05T20:00:00Z")],
        ["b3", t("2026-08-06T20:00:00Z")],
        ["c1", t("2026-08-07T20:00:00Z")],
        ["c2", t("2026-08-08T20:00:00Z")],
        ["c3", t("2026-08-09T20:00:00Z")],
      ]),
    );
    expect(result.map((e) => [e.user_id, e.global_rank])).toEqual([
      ["u2", 1],
      ["u1", 2],
      ["u3", 3],
    ]);
  });

  it("入榜位置按全量排序位置计算（含未入榜用户）", () => {
    // u_high: 1 场 12 分（exact）排最前但未入榜（valid 1）
    // u_eligible: 3 场 3 分 -> 排序位置 2 => rank 2
    const result = rebuildPeriodRankings(
      [exactItem("h", "u_high"), wdlItem("e1", "u_eligible"), missItem("e2", "u_eligible"), missItem("e3", "u_eligible")],
      periodMap([
        ["h", WEEK],
        ["e1", WEEK],
        ["e2", WEEK],
        ["e3", WEEK],
      ]),
      anchorMap([
        ["h", t("2026-08-01T20:00:00Z")],
        ["e1", t("2026-08-02T20:00:00Z")],
        ["e2", t("2026-08-03T20:00:00Z")],
        ["e3", t("2026-08-04T20:00:00Z")],
      ]),
    );
    expect(result.map((e) => [e.user_id, e.global_rank])).toEqual([
      ["u_high", null],
      ["u_eligible", 2],
    ]);
  });

  it("同分用户按精确准确率交叉乘法排序，不受显示四舍五入影响", () => {
    // u_a: 12 分 / valid 2 / wdl 1 / exact 1（50%）
    // u_b: 12 分 / valid 3 / wdl 1 / exact 1（33.3%）
    const result = rebuildPeriodRankings(
      [exactItem("a1", "u_a"), missItem("a2", "u_a"), exactItem("b1", "u_b"), missItem("b2", "u_b"), missItem("b3", "u_b")],
      periodMap([
        ["a1", WEEK],
        ["a2", WEEK],
        ["b1", WEEK],
        ["b2", WEEK],
        ["b3", WEEK],
      ]),
      anchorMap([
        ["a1", t("2026-08-01T20:00:00Z")],
        ["a2", t("2026-08-02T20:00:00Z")],
        ["b1", t("2026-08-03T20:00:00Z")],
        ["b2", t("2026-08-04T20:00:00Z")],
        ["b3", t("2026-08-05T20:00:00Z")],
      ]),
    );
    expect(result.map((e) => e.user_id)).toEqual(["u_a", "u_b"]);
  });

  it("correction 修正后按最新账本重排，不依赖旧 rankings 缓存", () => {
    // alice: 0->12 后修正 12->0 => 0 分；bob: 3 场 wdl => 9 分
    const aliceToZero = makeItem({
      prediction_id: "a1",
      user_id: "alice",
      old_score: ExactHit,
      new_score: Miss,
      score_delta: -12,
      old_wdl_hit: true,
      new_wdl_hit: false,
      old_exact_hit: true,
      new_exact_hit: false,
      valid_prediction_delta: 0,
      source_result_version: 2,
    });
    const result = rebuildPeriodRankings(
      [exactItem("a1", "alice"), aliceToZero, wdlItem("b1", "bob"), wdlItem("b2", "bob"), wdlItem("b3", "bob")],
      periodMap([
        ["a1", WEEK],
        ["b1", WEEK],
        ["b2", WEEK],
        ["b3", WEEK],
      ]),
      anchorMap([
        ["a1", t("2026-08-01T20:00:00Z")],
        ["b1", t("2026-08-02T20:00:00Z")],
        ["b2", t("2026-08-03T20:00:00Z")],
        ["b3", t("2026-08-04T20:00:00Z")],
      ]),
    );
    expect(result.map((e) => e.user_id)).toEqual(["bob", "alice"]);
    expect(result[0]!.global_rank).toBe(1);
    expect(result[1]!.global_rank).toBeNull();
  });
});

describe("rebuildPeriodRankings - 49.5 事实源", () => {
  it("仅以 applied items 聚合；period 归属只来自 period/anchor 映射（非 prediction 缓存字段）", () => {
    const result = rebuildPeriodRankings(
      [exactItem("p1"), missItem("p2")],
      periodMap([
        ["p1", WEEK],
        ["p2", WEEK],
      ]),
      anchorMap([
        ["p1", t("2026-08-05T20:00:00Z")],
        ["p2", t("2026-08-06T20:00:00Z")],
      ]),
    );
    expect(result[0]).toMatchObject({
      period_score: 12,
      valid_predictions: 2,
      wdl_hits: 1,
      exact_hits: 1,
    });
  });
});

describe("rebuildPeriodRankings - 周期校验", () => {
  it("支持 month 周期类型", () => {
    const result = rebuildPeriodRankings(
      [exactItem("p1")],
      periodMap([["p1", MONTH]]),
      anchorMap([["p1", t("2026-08-05T20:00:00Z")]]),
    );
    expect(result[0]).toMatchObject({
      period_type: "month",
      period_key: "2026_08",
    });
  });

  it("非法 period_type 抛 INVALID_PERIOD_TYPE", () => {
    const item = exactItem("p1");
    const err = captureError(() =>
      rebuildPeriodRankings(
        [item],
        periodMap([["p1", { period_type: "year" as PeriodType, period_key: "2026" }]]),
        anchorMap([["p1", t("2026-08-05T20:00:00Z")]]),
      ),
    );
    expect(err).toMatchObject({ code: "INVALID_PERIOD_TYPE" });
  });

  it("ledger 混入多个周期抛 INVALID_LEDGER", () => {
    const err = captureError(() =>
      rebuildPeriodRankings(
        [exactItem("p1"), wdlItem("p2")],
        periodMap([
          ["p1", WEEK],
          ["p2", OTHER_WEEK],
        ]),
        anchorMap([
          ["p1", t("2026-08-05T20:00:00Z")],
          ["p2", t("2026-08-06T20:00:00Z")],
        ]),
      ),
    );
    expect(err).toMatchObject({ code: "INVALID_LEDGER" });
  });
});

describe("rebuildPeriodRankings - ledger 完整性校验", () => {
  it("非 applied item 抛 INVALID_LEDGER", () => {
    const item = exactItem("p1");
    item.status = SettlementItemStatus.Pending;
    const err = captureError(() =>
      rebuildPeriodRankings(
        [item],
        periodMap([["p1", WEEK]]),
        anchorMap([["p1", t("2026-08-05T20:00:00Z")]]),
      ),
    );
    expect(err).toMatchObject({ code: "INVALID_LEDGER" });
  });

  it("score_delta 与 (new_score - old_score) 不一致抛 INVALID_LEDGER", () => {
    const item = exactItem("p1");
    item.score_delta = 5;
    const err = captureError(() =>
      rebuildPeriodRankings(
        [item],
        periodMap([["p1", WEEK]]),
        anchorMap([["p1", t("2026-08-05T20:00:00Z")]]),
      ),
    );
    expect(err).toMatchObject({ code: "INVALID_LEDGER" });
  });

  it("valid_prediction_delta 非法值（非 0/1）抛 INVALID_LEDGER", () => {
    const item = exactItem("p1");
    item.valid_prediction_delta = 2;
    const err = captureError(() =>
      rebuildPeriodRankings(
        [item],
        periodMap([["p1", WEEK]]),
        anchorMap([["p1", t("2026-08-05T20:00:00Z")]]),
      ),
    );
    expect(err).toMatchObject({ code: "INVALID_LEDGER" });
  });

  it("new exact_hit 未同时命中 wdl 抛 INVALID_LEDGER", () => {
    const item = makeItem({
      prediction_id: "p1",
      new_wdl_hit: false,
      new_exact_hit: true,
    });
    const err = captureError(() =>
      rebuildPeriodRankings(
        [item],
        periodMap([["p1", WEEK]]),
        anchorMap([["p1", t("2026-08-05T20:00:00Z")]]),
      ),
    );
    expect(err).toMatchObject({ code: "INVALID_LEDGER" });
  });

  it("old exact_hit 未同时命中 wdl 抛 INVALID_LEDGER", () => {
    const item = makeItem({
      prediction_id: "p1",
      old_score: ExactHit,
      new_score: WdlHit,
      score_delta: -9,
      old_wdl_hit: false,
      old_exact_hit: true,
      new_wdl_hit: true,
      new_exact_hit: false,
      valid_prediction_delta: 0,
    });
    const err = captureError(() =>
      rebuildPeriodRankings(
        [item],
        periodMap([["p1", WEEK]]),
        anchorMap([["p1", t("2026-08-05T20:00:00Z")]]),
      ),
    );
    expect(err).toMatchObject({ code: "INVALID_LEDGER" });
  });

  it("缺少 prediction->period 映射抛 INVALID_LEDGER", () => {
    const item = exactItem("p1");
    const err = captureError(() =>
      rebuildPeriodRankings(
        [item],
        new Map(),
        anchorMap([["p1", t("2026-08-05T20:00:00Z")]]),
      ),
    );
    expect(err).toMatchObject({ code: "INVALID_LEDGER" });
  });

  it("缺少 prediction->anchor 映射抛 INVALID_LEDGER", () => {
    const item = exactItem("p1");
    const err = captureError(() =>
      rebuildPeriodRankings(
        [item],
        periodMap([["p1", WEEK]]),
        new Map(),
      ),
    );
    expect(err).toMatchObject({ code: "INVALID_LEDGER" });
  });

  it("聚合 period_score 为负抛 INVALID_LEDGER", () => {
    const item = makeItem({
      prediction_id: "p1",
      old_score: ExactHit,
      new_score: Miss,
      score_delta: -12,
      old_wdl_hit: true,
      new_wdl_hit: false,
      old_exact_hit: true,
      new_exact_hit: false,
      valid_prediction_delta: 0,
    });
    const err = captureError(() =>
      rebuildPeriodRankings(
        [item],
        periodMap([["p1", WEEK]]),
        anchorMap([["p1", t("2026-08-05T20:00:00Z")]]),
      ),
    );
    expect(err).toMatchObject({ code: "INVALID_LEDGER" });
  });

  it("聚合 exact_hits > wdl_hits 抛 INVALID_LEDGER", () => {
    // 3->12 修正：exact 净 +1 而 wdl 净 0
    const item = makeItem({
      prediction_id: "p1",
      old_score: WdlHit,
      new_score: ExactHit,
      score_delta: 9,
      old_wdl_hit: true,
      new_wdl_hit: true,
      old_exact_hit: false,
      new_exact_hit: true,
      valid_prediction_delta: 0,
    });
    const err = captureError(() =>
      rebuildPeriodRankings(
        [item],
        periodMap([["p1", WEEK]]),
        anchorMap([["p1", t("2026-08-05T20:00:00Z")]]),
      ),
    );
    expect(err).toMatchObject({ code: "INVALID_LEDGER" });
  });

  it("聚合 wdl_hits > valid_predictions 抛 INVALID_LEDGER", () => {
    // valid 0 但 wdl 净 +1
    const item = makeItem({
      prediction_id: "p1",
      old_score: Miss,
      new_score: WdlHit,
      score_delta: 3,
      old_wdl_hit: false,
      new_wdl_hit: true,
      old_exact_hit: false,
      new_exact_hit: false,
      valid_prediction_delta: 0,
    });
    const err = captureError(() =>
      rebuildPeriodRankings(
        [item],
        periodMap([["p1", WEEK]]),
        anchorMap([["p1", t("2026-08-05T20:00:00Z")]]),
      ),
    );
    expect(err).toMatchObject({ code: "INVALID_LEDGER" });
  });
});
