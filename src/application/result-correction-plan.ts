/**
 * 赛果修正版本计划纯切片（阶段 4 切片 E）。
 *
 * 仅实现内存可测试的纯决策函数，不接 repository、不执行任何写入：
 * - planResultCorrection：给定当前结果快照与新比分（provider/admin），生成下一结果版本
 *   计划。严格拒绝：非 finished（MATCH_NOT_FINISHED）、比分非整数 0..99（INVALID_SCORE）、
 *   新比分与当前相同（RESULT_UNCHANGED）、result_version 为负（INVALID_RESULT_VERSION）。
 *   成功返回 next_result_version=current+1、is_correction=current>0、
 *   needs_correction_settlement=settlement 已 settled、source。只记录计划，不覆盖旧版本
 *   （版本严格递增，账本不可变）。
 * - nextSettlementVersion：确定下一次待结算的版本。无 result 或已追平返回 null，
 *   否则返回 settled+1，禁止跳过中间版本直达最新版本。
 */
import { MatchStatus, type ResultSource, SettlementStatus } from "../domain/enums.js";
import { conflictError } from "../domain/errors.js";

export const ResultCorrectionCode = {
  MatchNotFinished: "MATCH_NOT_FINISHED",
  InvalidScore: "INVALID_SCORE",
  ResultUnchanged: "RESULT_UNCHANGED",
  InvalidResultVersion: "INVALID_RESULT_VERSION",
} as const;

export interface ResultCorrectionPlan {
  next_result_version: number;
  is_correction: boolean;
  needs_correction_settlement: boolean;
  source: ResultSource;
}

/** 合法比分：0..99 的整数（规范 11.1，与首次结算校验一致）。 */
function isValidScore(score: number): boolean {
  return Number.isInteger(score) && score >= 0 && score <= 99;
}

export function planResultCorrection(
  currentResultVersion: number,
  currentHome: number | null,
  currentAway: number | null,
  nextHome: number,
  nextAway: number,
  matchStatus: string,
  settlementStatus: string,
  source: ResultSource,
): ResultCorrectionPlan {
  if (currentResultVersion < 0) {
    throw conflictError(ResultCorrectionCode.InvalidResultVersion, "result_version 不能为负数");
  }

  if (matchStatus !== MatchStatus.Finished) {
    throw conflictError(
      ResultCorrectionCode.MatchNotFinished,
      "只有 finished 状态的比赛才能记录赛果",
    );
  }

  if (!isValidScore(nextHome) || !isValidScore(nextAway)) {
    throw conflictError(ResultCorrectionCode.InvalidScore, "比分必须是 0..99 的整数");
  }

  if (
    currentHome !== null &&
    currentAway !== null &&
    nextHome === currentHome &&
    nextAway === currentAway
  ) {
    throw conflictError(ResultCorrectionCode.ResultUnchanged, "新比分与当前比分相同，无需修正");
  }

  return {
    next_result_version: currentResultVersion + 1,
    is_correction: currentResultVersion > 0,
    needs_correction_settlement: settlementStatus === SettlementStatus.Settled,
    source,
  };
}

export function nextSettlementVersion(
  currentResultVersion: number,
  settledResultVersion: number,
): number | null {
  if (currentResultVersion < 1) {
    return null;
  }
  const settled = settledResultVersion < 0 ? 0 : settledResultVersion;
  if (settled >= currentResultVersion) {
    return null;
  }
  return settled + 1;
}
