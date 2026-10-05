import { describe, expect, it } from "vitest";
import { RankingBoard } from "./enums.js";
import { LEVEL_PRIOR_K, LEVEL_PRIOR_P0 } from "./levels.js";
import {
  compareRankingEntry,
  compareWeekCareerEntry,
  isRankEligible,
  isStrengthRankEligible,
  lastScoringForPeriodScore,
  rankForPosition,
  type RankingComparable,
  type StrengthRankingComparable,
} from "./ranking.js";

function entry(overrides: Partial<RankingComparable> = {}): RankingComparable {
  return {
    period_score: 0,
    valid_predictions: 1,
    wdl_hits: 0,
    exact_hits: 0,
    last_scoring_match_at: null,
    user_id: "u",
    ...overrides,
  };
}

function strength(
  overrides: Partial<StrengthRankingComparable> = {},
): StrengthRankingComparable {
  return {
    window_score_sum: 0,
    window_n: 50,
    user_id: "u",
    ...overrides,
  };
}

const t = (iso: string): Date => new Date(iso);

describe("K. 排行榜（规范 44-K / 19.5）", () => {
  it("K78 本周 1 场有效预测即入榜且有名次", () => {
    expect(isRankEligible(1)).toBe(true);
    expect(rankForPosition(1, 1)).toBe(1);
    expect(rankForPosition(1, 7)).toBe(7);
    expect(isRankEligible(0)).toBe(false);
    expect(rankForPosition(0, 1)).toBeNull();
  });

  it("K79 完整并列链 score DESC → exact DESC → valid ASC → last_scoring ASC → user_id ASC", () => {
    const highScore = entry({ user_id: "a", period_score: 12, valid_predictions: 1, wdl_hits: 1, exact_hits: 1 });
    const lowScore = entry({ user_id: "b", period_score: 3, valid_predictions: 1, wdl_hits: 1, exact_hits: 0 });
    expect(compareRankingEntry(RankingBoard.Week, highScore, lowScore)).toBeLessThan(0);
    expect(compareRankingEntry(RankingBoard.Career, lowScore, highScore)).toBeGreaterThan(0);

    const moreExact = entry({
      period_score: 12,
      valid_predictions: 2,
      wdl_hits: 2,
      exact_hits: 2,
      user_id: "a",
    });
    const fewerExact = entry({
      period_score: 12,
      valid_predictions: 2,
      wdl_hits: 2,
      exact_hits: 1,
      user_id: "b",
    });
    expect(compareRankingEntry(RankingBoard.Week, moreExact, fewerExact)).toBeLessThan(0);

    const fewerValid = entry({
      period_score: 12,
      valid_predictions: 2,
      wdl_hits: 2,
      exact_hits: 1,
      user_id: "z",
    });
    const moreValid = entry({
      period_score: 12,
      valid_predictions: 3,
      wdl_hits: 3,
      exact_hits: 1,
      user_id: "a",
    });
    expect(compareRankingEntry(RankingBoard.Week, fewerValid, moreValid)).toBeLessThan(0);

    const earlier = entry({
      period_score: 3,
      valid_predictions: 2,
      wdl_hits: 1,
      exact_hits: 0,
      last_scoring_match_at: t("2026-08-08T18:00:00Z"),
      user_id: "z",
    });
    const later = entry({
      period_score: 3,
      valid_predictions: 2,
      wdl_hits: 1,
      exact_hits: 0,
      last_scoring_match_at: t("2026-08-08T19:00:00Z"),
      user_id: "a",
    });
    expect(compareRankingEntry(RankingBoard.Week, earlier, later)).toBeLessThan(0);

    const scored = entry({
      period_score: 3,
      valid_predictions: 1,
      wdl_hits: 1,
      last_scoring_match_at: t("2026-08-08T18:00:00Z"),
      user_id: "z",
    });
    const zeroScore = entry({
      period_score: 0,
      valid_predictions: 1,
      last_scoring_match_at: null,
      user_id: "a",
    });
    expect(compareRankingEntry(RankingBoard.Week, scored, zeroScore)).toBeLessThan(0);

    const nonNull = entry({
      period_score: 3,
      valid_predictions: 1,
      wdl_hits: 1,
      last_scoring_match_at: t("2026-08-08T18:00:00Z"),
      user_id: "z",
    });
    const nullScoring = entry({
      period_score: 3,
      valid_predictions: 1,
      wdl_hits: 1,
      last_scoring_match_at: null,
      user_id: "a",
    });
    expect(compareRankingEntry(RankingBoard.Week, nonNull, nullScoring)).toBeLessThan(0);

    const alice = entry({
      period_score: 3,
      valid_predictions: 2,
      wdl_hits: 1,
      exact_hits: 0,
      last_scoring_match_at: t("2026-08-08T18:00:00Z"),
      user_id: "aaaa",
    });
    const bob = entry({
      period_score: 3,
      valid_predictions: 2,
      wdl_hits: 1,
      exact_hits: 0,
      last_scoring_match_at: t("2026-08-08T18:00:00Z"),
      user_id: "bbbb",
    });
    expect(compareRankingEntry(RankingBoard.Week, alice, bob)).toBeLessThan(0);
    expect(compareRankingEntry(RankingBoard.Career, bob, alice)).toBeGreaterThan(0);

    const highAcc = entry({
      period_score: 12,
      valid_predictions: 3,
      wdl_hits: 3,
      exact_hits: 1,
      user_id: "zzzz",
    });
    const lowAcc = entry({
      period_score: 12,
      valid_predictions: 3,
      wdl_hits: 1,
      exact_hits: 1,
      user_id: "aaaa",
    });
    expect(compareRankingEntry(RankingBoard.Week, lowAcc, highAcc)).toBeLessThan(0);
  });

  it("K80 实力榜窗口 n=49 不上榜（domain 资格判定）", () => {
    expect(isStrengthRankEligible(49)).toBe(false);
    expect(isStrengthRankEligible(50)).toBe(true);
    expect(isStrengthRankEligible(0)).toBe(false);
  });

  it("K81 实力榜 s 相同（交叉乘法相等）则窗口 n 多者优先", () => {
    const fewerN = strength({ window_score_sum: 4, window_n: 50, user_id: "a" });
    const moreN = strength({ window_score_sum: 44, window_n: 100, user_id: "b" });
    const lhs = (fewerN.window_score_sum + LEVEL_PRIOR_P0) * (moreN.window_n + LEVEL_PRIOR_K);
    const rhs = (moreN.window_score_sum + LEVEL_PRIOR_P0) * (fewerN.window_n + LEVEL_PRIOR_K);
    expect(lhs).toBe(rhs);
    expect(compareRankingEntry(RankingBoard.Strength, moreN, fewerN)).toBeLessThan(0);
    expect(compareRankingEntry(RankingBoard.Strength, fewerN, moreN)).toBeGreaterThan(0);

    const higherS = strength({ window_score_sum: 200, window_n: 50, user_id: "z" });
    const lowerS = strength({ window_score_sum: 50, window_n: 50, user_id: "a" });
    expect(compareRankingEntry(RankingBoard.Strength, higherS, lowerS)).toBeLessThan(0);

    const same = strength({ window_score_sum: 80, window_n: 60, user_id: "aaaa" });
    const sameLaterId = strength({ window_score_sum: 80, window_n: 60, user_id: "bbbb" });
    expect(compareRankingEntry(RankingBoard.Strength, same, sameLaterId)).toBeLessThan(0);
  });

  it("K85 domain 侧预备：month 或未知 board → VALIDATION_ERROR", () => {
    const a = entry({ user_id: "a" });
    const b = entry({ user_id: "b" });
    expect(() => compareRankingEntry("month", a, b)).toThrow(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
    expect(() => compareRankingEntry("unknown", a, b)).toThrow(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
  });

  it("month 已废弃的 week/career 子比较器仍可排序（S4 拆除）", () => {
    const a = entry({ period_score: 12, user_id: "a" });
    const b = entry({ period_score: 3, user_id: "b" });
    expect(compareWeekCareerEntry(a, b)).toBeLessThan(0);
  });

  it("last_scoring_for_period_score：非 0 分返回原值；0 分强制 null", () => {
    const d = t("2026-08-08T18:00:00Z");
    expect(lastScoringForPeriodScore(3, d)).toBe(d);
    expect(lastScoringForPeriodScore(0, d)).toBeNull();
  });
});
