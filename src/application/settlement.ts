/**
 * 结算应用纯函数（阶段 4 最小可验证切片）。
 *
 * 仅实现内存可测试的结算核心逻辑：
 * - computeSettlementItemDelta：计算单条 prediction 的 settlement item delta
 *   （old/new score、hits、score_delta、valid_prediction_delta），计分复用
 *   domain/scoring.calculateMatchScore（规范 9.2）。
 * - applySettlementItemDelta：把 delta 应用为 prediction 新状态并推进
 *   applied_result_version；同一版本重复 apply 为幂等空操作，返回原对象。
 * - assertResultVersionOrder：result_version 顺序校验，禁止跳过中间版本与回退。
 */
import {
  MatchScoreValue,
  type MatchScoreValue as MatchScoreValueType,
  type ScoringRuleVersion,
} from "../domain/enums.js";
import { conflictError } from "../domain/errors.js";
import { calculateMatchScore } from "../domain/scoring.js";
import type { Prediction } from "../domain/types.js";

export interface SettlementItemDelta {
  old_score: MatchScoreValueType;
  new_score: MatchScoreValueType;
  score_delta: number;
  old_wdl_hit: boolean;
  new_wdl_hit: boolean;
  old_exact_hit: boolean;
  new_exact_hit: boolean;
  valid_prediction_delta: number;
}

/** 未结算预测按 miss（0 分）计。 */
const UNAPPLIED_SCORE = MatchScoreValue.Miss;

/**
 * 计算结算 item delta：用目标 result 对 prediction 重新计分，
 * 与当前已结算状态求差。首次结算 valid_prediction_delta=1，修正为 0。
 */
export function computeSettlementItemDelta(
  prediction: Prediction,
  result: { regular_home_score: number; regular_away_score: number },
  scoringRuleVersion: ScoringRuleVersion,
): SettlementItemDelta {
  const outcome = calculateMatchScore(
    {
      pred_home_score: prediction.pred_home_score,
      pred_away_score: prediction.pred_away_score,
    },
    result,
    scoringRuleVersion,
  );

  const oldScore = prediction.match_score ?? UNAPPLIED_SCORE;
  const oldWdlHit = prediction.wdl_hit ?? false;
  const oldExactHit = prediction.exact_hit ?? false;
  const firstTime = prediction.applied_result_version === 0;

  return {
    old_score: oldScore,
    new_score: outcome.match_score,
    score_delta: outcome.match_score - oldScore,
    old_wdl_hit: oldWdlHit,
    new_wdl_hit: outcome.wdl_hit,
    old_exact_hit: oldExactHit,
    new_exact_hit: outcome.exact_hit,
    valid_prediction_delta: firstTime ? 1 : 0,
  };
}

/**
 * result_version 顺序校验（规范 11.2）：
 * - new === applied + 1：正常推进
 * - new === applied：幂等重放
 * - new > applied + 1：RESULT_VERSION_SKIPPED，不得跳过中间版本
 * - new < applied：RESULT_VERSION_STALE，不得回退应用旧版本
 */
export function assertResultVersionOrder(
  appliedResultVersion: number,
  newResultVersion: number,
): void {
  if (newResultVersion === appliedResultVersion + 1) {
    return;
  }
  if (newResultVersion === appliedResultVersion) {
    return;
  }
  if (newResultVersion > appliedResultVersion + 1) {
    throw conflictError("RESULT_VERSION_SKIPPED", "result_version 不得跳过中间版本");
  }
  throw conflictError("RESULT_VERSION_STALE", "result_version 不得回退到旧版本");
}

/**
 * 把 delta 应用到 prediction：写入 new score/hits 并推进 applied_result_version。
 * 幂等：newResultVersion === applied_result_version 时返回原对象，无任何变化。
 */
export function applySettlementItemDelta(
  prediction: Prediction,
  resultVersion: number,
  delta: SettlementItemDelta,
): Prediction {
  assertResultVersionOrder(prediction.applied_result_version, resultVersion);

  if (resultVersion === prediction.applied_result_version) {
    return prediction;
  }

  return {
    ...prediction,
    match_score: delta.new_score,
    wdl_hit: delta.new_wdl_hit,
    exact_hit: delta.new_exact_hit,
    applied_result_version: resultVersion,
  };
}
