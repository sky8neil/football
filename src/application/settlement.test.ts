import { describe, expect, it } from "vitest";
import { MatchScoreValue, Result, ScoringRuleVersion } from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { Prediction } from "../domain/types.js";
import {
  applySettlementItemDelta,
  assertResultVersionOrder,
  computeSettlementItemDelta,
  type SettlementItemDelta,
} from "./settlement.js";

const V1 = ScoringRuleVersion.ScoringV1;

type FinalScoreStub = { regular_home_score: number; regular_away_score: number };

const result: FinalScoreStub = { regular_home_score: 2, regular_away_score: 1 };

function makePrediction(overrides: Partial<Prediction> = {}): Prediction {
  return {
    schema_version: 1,
    prediction_id: newUuid(),
    user_id: newUuid(),
    match_id: newUuid(),
    idempotency_key: newUuid(),
    pred_home_score: 2,
    pred_away_score: 1,
    derived_result: Result.Home,
    submitted_at: new Date("2026-08-01T00:00:00Z"),
    scoring_rule_version: V1,
    match_score: null,
    wdl_hit: null,
    exact_hit: null,
    applied_result_version: 0,
    created_at: new Date("2026-08-01T00:00:00Z"),
    updated_at: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  } as Prediction;
}

function appliedExact(version: number): Partial<Prediction> {
  return {
    match_score: MatchScoreValue.ExactHit,
    wdl_hit: true,
    exact_hit: true,
    applied_result_version: version,
  };
}

function appliedWdl(version: number): Partial<Prediction> {
  return {
    match_score: MatchScoreValue.WdlHit,
    wdl_hit: true,
    exact_hit: false,
    applied_result_version: version,
  };
}

describe("computeSettlementItemDelta - 结算 item delta 计算", () => {
  it("0 -> 12：未结算预测精确命中，score_delta = +12", () => {
    const delta = computeSettlementItemDelta(makePrediction(), result, V1);
    expect(delta).toEqual({
      old_score: MatchScoreValue.Miss,
      new_score: MatchScoreValue.ExactHit,
      score_delta: 12,
      old_wdl_hit: false,
      new_wdl_hit: true,
      old_exact_hit: false,
      new_exact_hit: true,
      valid_prediction_delta: 1,
    } satisfies SettlementItemDelta);
  });

  it("12 -> 3：exact 命中被修正为仅 wdl 命中，score_delta = -9", () => {
    const delta = computeSettlementItemDelta(
      makePrediction(appliedExact(1)),
      { regular_home_score: 3, regular_away_score: 1 },
      V1,
    );
    expect(delta).toEqual({
      old_score: MatchScoreValue.ExactHit,
      new_score: MatchScoreValue.WdlHit,
      score_delta: -9,
      old_wdl_hit: true,
      new_wdl_hit: true,
      old_exact_hit: true,
      new_exact_hit: false,
      valid_prediction_delta: 0,
    } satisfies SettlementItemDelta);
  });

  it("3 -> 0：wdl 命中被修正为 miss，score_delta = -3", () => {
    const delta = computeSettlementItemDelta(
      makePrediction(appliedWdl(1)),
      { regular_home_score: 1, regular_away_score: 1 },
      V1,
    );
    expect(delta).toEqual({
      old_score: MatchScoreValue.WdlHit,
      new_score: MatchScoreValue.Miss,
      score_delta: -3,
      old_wdl_hit: true,
      new_wdl_hit: false,
      old_exact_hit: false,
      new_exact_hit: false,
      valid_prediction_delta: 0,
    } satisfies SettlementItemDelta);
  });

  it("同分重算为 0 delta：miss 修正后仍 miss，score_delta = 0", () => {
    const delta = computeSettlementItemDelta(
      makePrediction({
        match_score: MatchScoreValue.Miss,
        wdl_hit: false,
        exact_hit: false,
        applied_result_version: 1,
      }),
      { regular_home_score: 0, regular_away_score: 0 },
      V1,
    );
    expect(delta.score_delta).toBe(0);
    expect(delta.new_score).toBe(MatchScoreValue.Miss);
  });
});

describe("computeSettlementItemDelta - valid_prediction_delta", () => {
  it("首次结算 valid_prediction_delta = 1", () => {
    const delta = computeSettlementItemDelta(
      makePrediction(),
      { regular_home_score: 3, regular_away_score: 1 },
      V1,
    );
    expect(delta.valid_prediction_delta).toBe(1);
  });

  it("已结算（修正）valid_prediction_delta = 0，不重复计数", () => {
    const first = computeSettlementItemDelta(
      makePrediction(appliedWdl(1)),
      { regular_home_score: 3, regular_away_score: 1 },
      V1,
    );
    expect(first.valid_prediction_delta).toBe(0);
  });
});

describe("applySettlementItemDelta - apply 状态幂等", () => {
  it("首次 apply v1 写入 new_score / hits / applied_result_version", () => {
    const prediction = makePrediction();
    const delta = computeSettlementItemDelta(prediction, result, V1);
    const applied = applySettlementItemDelta(prediction, 1, delta);
    expect(applied.match_score).toBe(MatchScoreValue.ExactHit);
    expect(applied.wdl_hit).toBe(true);
    expect(applied.exact_hit).toBe(true);
    expect(applied.applied_result_version).toBe(1);
    expect(applied.prediction_id).toBe(prediction.prediction_id);
  });

  it("同一版本重复 apply 返回原对象、无任何变化", () => {
    const prediction = makePrediction();
    const delta = computeSettlementItemDelta(prediction, result, V1);
    const first = applySettlementItemDelta(prediction, 1, delta);
    const second = applySettlementItemDelta(first, 1, delta);
    expect(second).toBe(first);
    expect(second.applied_result_version).toBe(1);
    expect(second.match_score).toBe(MatchScoreValue.ExactHit);
  });

  it("完整链：0->12（v1），12->3（v2），重复 v2 无变化", () => {
    const prediction = makePrediction();
    const d1 = computeSettlementItemDelta(prediction, result, V1);
    const applied = applySettlementItemDelta(prediction, 1, d1);
    expect(applied.match_score).toBe(MatchScoreValue.ExactHit);

    const d2 = computeSettlementItemDelta(
      applied,
      { regular_home_score: 3, regular_away_score: 1 },
      V1,
    );
    expect(d2.score_delta).toBe(-9);
    const corrected = applySettlementItemDelta(applied, 2, d2);
    expect(corrected.match_score).toBe(MatchScoreValue.WdlHit);
    expect(corrected.exact_hit).toBe(false);
    expect(corrected.applied_result_version).toBe(2);

    const replay = applySettlementItemDelta(corrected, 2, d2);
    expect(replay).toBe(corrected);
  });
});

describe("assertResultVersionOrder - 版本顺序校验", () => {
  function captureError(fn: () => void): unknown {
    try {
      fn();
      return null;
    } catch (err) {
      return err;
    }
  }

  it("applied=0 首次 apply v1 通过", () => {
    expect(() => assertResultVersionOrder(0, 1)).not.toThrow();
  });

  it("applied=v1 顺序 apply v2 通过", () => {
    expect(() => assertResultVersionOrder(1, 2)).not.toThrow();
  });

  it("applied=0 直接 apply v2 抛 RESULT_VERSION_SKIPPED（不得跳过 v1）", () => {
    expect(captureError(() => assertResultVersionOrder(0, 2))).toMatchObject({
      code: "RESULT_VERSION_SKIPPED",
    });
  });

  it("applied=1 直接 apply v3 抛 RESULT_VERSION_SKIPPED（不得跳过 v2）", () => {
    expect(captureError(() => assertResultVersionOrder(1, 3))).toMatchObject({
      code: "RESULT_VERSION_SKIPPED",
    });
  });

  it("回退 apply 旧版本（applied=2 apply v1）抛 RESULT_VERSION_STALE", () => {
    expect(captureError(() => assertResultVersionOrder(2, 1))).toMatchObject({
      code: "RESULT_VERSION_STALE",
    });
  });

  it("apply 时顺序校验：跳过 v1 抛 RESULT_VERSION_SKIPPED", () => {
    const prediction = makePrediction();
    const delta = computeSettlementItemDelta(prediction, result, V1);
    expect(
      captureError(() => applySettlementItemDelta(prediction, 2, delta)),
    ).toMatchObject({
      code: "RESULT_VERSION_SKIPPED",
    });
  });
});
