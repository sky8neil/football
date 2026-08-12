import { describe, expect, it } from "vitest";
import { MatchScoreValue, Result, ScoringRuleVersion } from "./enums.js";
import { assertHitInvariant, calculateMatchScore, deriveResult } from "./scoring.js";

const V1 = ScoringRuleVersion.ScoringV1;

describe("A. 预测与比分（规范 44-A）", () => {
  it("A1 预测 2:1，实际 2:1 => 12", () => {
    const outcome = calculateMatchScore(
      { pred_home_score: 2, pred_away_score: 1 },
      { regular_home_score: 2, regular_away_score: 1 },
      V1,
    );
    expect(outcome.match_score).toBe(MatchScoreValue.ExactHit);
    expect(outcome.wdl_hit).toBe(true);
    expect(outcome.exact_hit).toBe(true);
  });

  it("A2 预测 2:1，实际 3:1 => 3", () => {
    const outcome = calculateMatchScore(
      { pred_home_score: 2, pred_away_score: 1 },
      { regular_home_score: 3, regular_away_score: 1 },
      V1,
    );
    expect(outcome.match_score).toBe(MatchScoreValue.WdlHit);
    expect(outcome.wdl_hit).toBe(true);
    expect(outcome.exact_hit).toBe(false);
  });

  it("A3 预测 2:1，实际 1:1 => 0", () => {
    const outcome = calculateMatchScore(
      { pred_home_score: 2, pred_away_score: 1 },
      { regular_home_score: 1, regular_away_score: 1 },
      V1,
    );
    expect(outcome.match_score).toBe(MatchScoreValue.Miss);
    expect(outcome.wdl_hit).toBe(false);
    expect(outcome.exact_hit).toBe(false);
  });

  it("A4 预测 0:0，实际 0:0 => 12", () => {
    const outcome = calculateMatchScore(
      { pred_home_score: 0, pred_away_score: 0 },
      { regular_home_score: 0, regular_away_score: 0 },
      V1,
    );
    expect(outcome.match_score).toBe(MatchScoreValue.ExactHit);
  });

  it("A5 exact_hit=true 时 wdl_hit 必须 true（invariant）", () => {
    const outcome = calculateMatchScore(
      { pred_home_score: 2, pred_away_score: 1 },
      { regular_home_score: 2, regular_away_score: 1 },
      V1,
    );
    expect(outcome.exact_hit).toBe(true);
    expect(outcome.wdl_hit).toBe(true);
    expect(() => assertHitInvariant(outcome)).not.toThrow();
    expect(() =>
      assertHitInvariant({ match_score: 12, wdl_hit: false, exact_hit: true }),
    ).toThrow();
  });

  it("derive_result：2:1 => HOME，1:1 => DRAW，1:2 => AWAY", () => {
    expect(deriveResult(2, 1)).toBe(Result.Home);
    expect(deriveResult(1, 1)).toBe(Result.Draw);
    expect(deriveResult(1, 2)).toBe(Result.Away);
  });

  it("未知计分规则版本失败关闭", () => {
    expect(() =>
      calculateMatchScore(
        { pred_home_score: 1, pred_away_score: 0 },
        { regular_home_score: 1, regular_away_score: 0 },
        "scoring_v2" as ScoringRuleVersion,
      ),
    ).toThrow(/未知计分规则版本/);
  });
});
