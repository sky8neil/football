/**
 * 比分推导与单场计分（规范 8.3、9.2）。
 *
 * 唯一实现入口（规范 0.4）：
 * - derive_result(home_score, away_score)
 * - calculate_match_score(prediction, result, scoring_rule_version)
 */
import { FIXED_CONFIG_V1 } from "./config.js";
import {
  MatchScoreValue,
  Result,
  type MatchScoreValue as MatchScoreValueType,
  type Result as ResultType,
  type ScoringRuleVersion as ScoringRuleVersionType,
} from "./enums.js";
import { internalError, validationError } from "./errors.js";

export interface ScorePredictionInput {
  pred_home_score: number;
  pred_away_score: number;
}

export interface FinalScore {
  regular_home_score: number;
  regular_away_score: number;
}

export interface MatchScoreOutcome {
  match_score: MatchScoreValueType;
  wdl_hit: boolean;
  exact_hit: boolean;
}

function assertNonNegativeInt(score: number, field: string): void {
  if (!Number.isInteger(score) || score < 0) {
    throw validationError(`比分必须为非负整数`, { field });
  }
}

/** 唯一实现入口：derive_result(home_score, away_score)。 */
export function deriveResult(homeScore: number, awayScore: number): ResultType {
  assertNonNegativeInt(homeScore, "home_score");
  assertNonNegativeInt(awayScore, "away_score");
  if (homeScore > awayScore) {
    return Result.Home;
  }
  if (homeScore === awayScore) {
    return Result.Draw;
  }
  return Result.Away;
}

/**
 * 唯一实现入口：calculate_match_score(prediction, result, scoring_rule_version)。
 *
 * scoring_v1：
 *   exact_score_correct => 12
 *   else wdl_correct    => 3
 *   else                => 0
 * 精确命中总计 12 分，不是 3 + 12（规范 9.2）。
 */
export function calculateMatchScore(
  prediction: ScorePredictionInput,
  result: FinalScore,
  scoringRuleVersion: ScoringRuleVersionType,
): MatchScoreOutcome {
  assertNonNegativeInt(prediction.pred_home_score, "pred_home_score");
  assertNonNegativeInt(prediction.pred_away_score, "pred_away_score");
  assertNonNegativeInt(result.regular_home_score, "regular_home_score");
  assertNonNegativeInt(result.regular_away_score, "regular_away_score");

  if (scoringRuleVersion !== FIXED_CONFIG_V1.SCORING_RULE_VERSION) {
    throw internalError(`未知计分规则版本`);
  }

  const exactHit =
    prediction.pred_home_score === result.regular_home_score &&
    prediction.pred_away_score === result.regular_away_score;

  if (exactHit) {
    return {
      match_score: MatchScoreValue.ExactHit,
      wdl_hit: true,
      exact_hit: true,
    };
  }
  if (compareResult(prediction, result)) {
    return {
      match_score: MatchScoreValue.WdlHit,
      wdl_hit: true,
      exact_hit: false,
    };
  }
  return {
    match_score: MatchScoreValue.Miss,
    wdl_hit: false,
    exact_hit: false,
  };
}

function compareResult(
  prediction: ScorePredictionInput,
  result: FinalScore,
): boolean {
  return (
    deriveResult(prediction.pred_home_score, prediction.pred_away_score) ===
    deriveResult(result.regular_home_score, result.regular_away_score)
  );
}

/** 命中 invariant（规范 9.3）：exact_hit == true => wdl_hit == true。 */
export function assertHitInvariant(outcome: MatchScoreOutcome): void {
  if (outcome.exact_hit && !outcome.wdl_hit) {
    throw internalError(`exact_hit=true 时 wdl_hit 必须为 true`);
  }
}
