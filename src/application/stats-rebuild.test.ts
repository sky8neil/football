import { describe, expect, it } from "vitest";
import { MatchScoreValue, SettlementItemStatus } from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { SettlementItem } from "../domain/types.js";
import { rebuildStatsFromLedger } from "./stats-rebuild.js";

const { Miss, WdlHit, ExactHit } = MatchScoreValue;

const SEASON_A = "2025_2026";
const SEASON_B = "2026_2027";

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
    applied_at: new Date("2026-08-01T00:00:00Z"),
    attempt_count: 1,
    last_error_code: null,
    last_error_message: null,
    created_at: new Date("2026-08-01T00:00:00Z"),
    updated_at: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  } as SettlementItem;
}

function seasonMap(pairs: Array<[string, string]>): ReadonlyMap<string, string> {
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

describe("rebuildStatsFromLedger - 空 ledger", () => {
  it("空 ledger 返回全零 career 与空 seasons", () => {
    const stats = rebuildStatsFromLedger([], new Map());
    expect(stats).toEqual({
      career: {
        user_id: "",
        career_points: 0,
        career_valid_predictions: 0,
        career_wdl_hits: 0,
        career_exact_hits: 0,
      },
      seasons: [],
    });
  });
});

describe("rebuildStatsFromLedger - career 聚合", () => {
  it("首次结算精确命中：score_delta=+12 / valid=1 / wdl=1 / exact=1", () => {
    const item = makeItem({ prediction_id: "p1" });
    const stats = rebuildStatsFromLedger([item], seasonMap([["p1", SEASON_B]]));
    expect(stats.career).toEqual({
      user_id: "u1",
      career_points: 12,
      career_valid_predictions: 1,
      career_wdl_hits: 1,
      career_exact_hits: 1,
    });
  });

  it("首次结算仅 wdl 命中：score_delta=+3 / wdl=1 / exact=0", () => {
    const item = makeItem({
      prediction_id: "p1",
      old_score: Miss,
      new_score: WdlHit,
      score_delta: 3,
      new_wdl_hit: true,
      new_exact_hit: false,
    });
    const stats = rebuildStatsFromLedger([item], seasonMap([["p1", SEASON_B]]));
    expect(stats.career).toEqual({
      user_id: "u1",
      career_points: 3,
      career_valid_predictions: 1,
      career_wdl_hits: 1,
      career_exact_hits: 0,
    });
  });

  it("完整链 0->12 再修正 12->3：points=3、valid=1、wdl=1、exact=0", () => {
    const first = makeItem({ prediction_id: "p1" });
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
    });
    const stats = rebuildStatsFromLedger(
      [first, correction],
      seasonMap([
        ["p1", SEASON_B],
        ["p1", SEASON_B],
      ]),
    );
    expect(stats.career).toEqual({
      user_id: "u1",
      career_points: 3,
      career_valid_predictions: 1,
      career_wdl_hits: 1,
      career_exact_hits: 0,
    });
  });

  it("多场次累计：exact 命中不重复计入 wdl 之外的额外计数", () => {
    const p1 = makeItem({
      prediction_id: "p1",
      old_score: Miss,
      new_score: WdlHit,
      score_delta: 3,
      new_wdl_hit: true,
      new_exact_hit: false,
    });
    const p2 = makeItem({ prediction_id: "p2" });
    const stats = rebuildStatsFromLedger(
      [p1, p2],
      seasonMap([
        ["p1", SEASON_B],
        ["p2", SEASON_B],
      ]),
    );
    expect(stats.career).toEqual({
      user_id: "u1",
      career_points: 15,
      career_valid_predictions: 2,
      career_wdl_hits: 2,
      career_exact_hits: 1,
    });
  });
});

describe("rebuildStatsFromLedger - season 分组", () => {
  it("按 prediction->season 映射分组生成 season stats", () => {
    const p1 = makeItem({
      prediction_id: "p1",
      old_score: Miss,
      new_score: WdlHit,
      score_delta: 3,
      new_wdl_hit: true,
      new_exact_hit: false,
    });
    const p2 = makeItem({ prediction_id: "p2" });
    const p3 = makeItem({
      prediction_id: "p3",
      old_score: Miss,
      new_score: WdlHit,
      score_delta: 3,
      new_wdl_hit: true,
      new_exact_hit: false,
    });
    const stats = rebuildStatsFromLedger(
      [p1, p2, p3],
      seasonMap([
        ["p1", SEASON_B],
        ["p2", SEASON_A],
        ["p3", SEASON_B],
      ]),
    );
    expect(stats.career).toEqual({
      user_id: "u1",
      career_points: 18,
      career_valid_predictions: 3,
      career_wdl_hits: 3,
      career_exact_hits: 1,
    });
    expect(stats.seasons).toEqual([
      {
        user_id: "u1",
        season_id: SEASON_A,
        points: 12,
        valid_predictions: 1,
        wdl_hits: 1,
        exact_hits: 1,
      },
      {
        user_id: "u1",
        season_id: SEASON_B,
        points: 6,
        valid_predictions: 2,
        wdl_hits: 2,
        exact_hits: 0,
      },
    ]);
  });

  it("同一 prediction 的多次结算修正计入同一 season", () => {
    const first = makeItem({ prediction_id: "p1" });
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
    });
    const stats = rebuildStatsFromLedger(
      [first, correction],
      seasonMap([
        ["p1", SEASON_B],
        ["p1", SEASON_B],
      ]),
    );
    expect(stats.seasons).toEqual([
      {
        user_id: "u1",
        season_id: SEASON_B,
        points: 3,
        valid_predictions: 1,
        wdl_hits: 1,
        exact_hits: 0,
      },
    ]);
  });
});

describe("rebuildStatsFromLedger - 49.5 事实源", () => {
  it("仅以 applied items 为输入；prediction 缓存命中字段被污染时结果仍与 items 一致", () => {
    const item = makeItem({
      prediction_id: "p1",
      old_score: Miss,
      new_score: ExactHit,
      score_delta: 12,
      old_wdl_hit: false,
      new_wdl_hit: true,
      old_exact_hit: false,
      new_exact_hit: true,
      valid_prediction_delta: 1,
    });
    const stats = rebuildStatsFromLedger([item], seasonMap([["p1", SEASON_B]]));
    expect(stats.career).toEqual({
      user_id: "u1",
      career_points: 12,
      career_valid_predictions: 1,
      career_wdl_hits: 1,
      career_exact_hits: 1,
    });
  });
});

describe("rebuildStatsFromLedger - ledger 完整性校验", () => {
  it("只含修正 item（12->3，缺首次结算）导致 exact_hits 为负，抛 INVALID_LEDGER", () => {
    const correction = makeItem({
      old_score: ExactHit,
      new_score: WdlHit,
      score_delta: -9,
      old_wdl_hit: true,
      new_wdl_hit: true,
      old_exact_hit: true,
      new_exact_hit: false,
      valid_prediction_delta: 0,
    });
    expect(captureError(() => rebuildStatsFromLedger([correction], seasonMap([["p1", SEASON_B]])))).toMatchObject({
      code: "INVALID_LEDGER",
    });
  });

  it("points 为负（12->0 修正缺失）抛 INVALID_LEDGER", () => {
    const item = makeItem({
      old_score: ExactHit,
      new_score: Miss,
      score_delta: -12,
      old_wdl_hit: true,
      new_wdl_hit: false,
      old_exact_hit: true,
      new_exact_hit: false,
      valid_prediction_delta: 0,
    });
    expect(captureError(() => rebuildStatsFromLedger([item], seasonMap([["p1", SEASON_B]])))).toMatchObject({
      code: "INVALID_LEDGER",
    });
  });

  it("wdl_hits > valid_predictions 抛 INVALID_LEDGER", () => {
    const item = makeItem({
      old_score: Miss,
      new_score: WdlHit,
      score_delta: 3,
      new_wdl_hit: true,
      new_exact_hit: false,
      valid_prediction_delta: 0,
    });
    expect(captureError(() => rebuildStatsFromLedger([item], seasonMap([["p1", SEASON_B]])))).toMatchObject({
      code: "INVALID_LEDGER",
    });
  });

  it("exact_hit 未同时命中 wdl（new_exact 而无 new_wdl）抛 INVALID_LEDGER", () => {
    const item = makeItem({
      old_score: Miss,
      new_score: ExactHit,
      score_delta: 12,
      new_wdl_hit: false,
      new_exact_hit: true,
    });
    expect(captureError(() => rebuildStatsFromLedger([item], seasonMap([["p1", SEASON_B]])))).toMatchObject({
      code: "INVALID_LEDGER",
    });
  });

  it("缺少 prediction->season 映射抛 INVALID_LEDGER", () => {
    const item = makeItem({ prediction_id: "p1" });
    expect(captureError(() => rebuildStatsFromLedger([item], new Map()))).toMatchObject({
      code: "INVALID_LEDGER",
    });
  });

  it("非 applied 的 item 抛 INVALID_LEDGER", () => {
    const item = makeItem({ prediction_id: "p1", status: SettlementItemStatus.Pending });
    expect(captureError(() => rebuildStatsFromLedger([item], seasonMap([["p1", SEASON_B]])))).toMatchObject({
      code: "INVALID_LEDGER",
    });
  });

  it("ledger 混入多个 user 抛 INVALID_LEDGER", () => {
    const a = makeItem({ prediction_id: "p1", user_id: "u1" });
    const b = makeItem({ prediction_id: "p2", user_id: "u2" });
    expect(captureError(() => rebuildStatsFromLedger([a, b], seasonMap([["p1", SEASON_B], ["p2", SEASON_B]])))).toMatchObject({
      code: "INVALID_LEDGER",
    });
  });

  it("score_delta 与 (new_score - old_score) 不一致抛 INVALID_LEDGER", () => {
    const item = makeItem({ prediction_id: "p1", score_delta: 5 });
    expect(captureError(() => rebuildStatsFromLedger([item], seasonMap([["p1", SEASON_B]])))).toMatchObject({
      code: "INVALID_LEDGER",
    });
  });

  it("valid_prediction_delta 非法值（非 0/1）抛 INVALID_LEDGER", () => {
    const item = makeItem({ prediction_id: "p1", valid_prediction_delta: 2 });
    expect(captureError(() => rebuildStatsFromLedger([item], seasonMap([["p1", SEASON_B]])))).toMatchObject({
      code: "INVALID_LEDGER",
    });
  });
});
