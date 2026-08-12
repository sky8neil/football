/**
 * 首次结算 orchestration 纯决策切片（阶段 4）。
 *
 * 仅实现纯函数状态决策：给定某场比赛的当前状态快照，判断是否满足"首次结算"
 * 触发条件，不接 repository、不执行任何写入。决策规则：
 * - match_status 非 finished -> SETTLEMENT_NOT_READY
 * - settlement_status 非 waiting：settled -> SETTLEMENT_ALREADY_SETTLED，
 *   settling/running 及其他非 waiting 状态 -> SETTLEMENT_ALREADY_RUNNING
 * - 存在阻塞异常 -> SETTLEMENT_NOT_READY
 * - finish_detected_at 缺失 / result_version < 1 / 比分非整数 0..99 -> SETTLEMENT_NOT_READY
 * - server_now 早于 finish + 10 分钟（冷却窗口）-> SETTLEMENT_NOT_READY
 * - 全部满足 -> FIRST_SETTLEMENT_START
 */
import { MatchStatus, SettlementStatus } from "../domain/enums.js";

export interface FirstSettlementInput {
  match_status: string;
  settlement_status: string;
  finish_detected_at: Date | null;
  result_version: number;
  regular_home_score: number | null;
  regular_away_score: number | null;
  server_now: Date;
  has_blocking_anomaly: boolean;
}

export type FirstSettlementDecision = {
  kind: "not_ready" | "conflict" | "start" | "settled";
  code: string;
};

export const FirstSettlementCode = {
  NotReady: "SETTLEMENT_NOT_READY",
  AlreadySettled: "SETTLEMENT_ALREADY_SETTLED",
  AlreadyRunning: "SETTLEMENT_ALREADY_RUNNING",
  Start: "FIRST_SETTLEMENT_START",
} as const;

/** finish 检测后到允许首次结算的冷却窗口：10 分钟。 */
const FINISH_TO_SETTLEMENT_DELAY_MS = 10 * 60 * 1000;

/** 合法比分：0..99 的整数；null / 非整数 / 越界均不合法。 */
function isValidScore(score: number | null): boolean {
  return score !== null && Number.isInteger(score) && score >= 0 && score <= 99;
}

export function decideFirstSettlement(input: FirstSettlementInput): FirstSettlementDecision {
  if (input.match_status !== MatchStatus.Finished) {
    return { kind: "not_ready", code: FirstSettlementCode.NotReady };
  }

  if (input.settlement_status !== SettlementStatus.Waiting) {
    if (input.settlement_status === SettlementStatus.Settled) {
      return { kind: "settled", code: FirstSettlementCode.AlreadySettled };
    }
    return { kind: "conflict", code: FirstSettlementCode.AlreadyRunning };
  }

  if (input.has_blocking_anomaly) {
    return { kind: "not_ready", code: FirstSettlementCode.NotReady };
  }

  if (
    input.finish_detected_at === null ||
    input.result_version < 1 ||
    !isValidScore(input.regular_home_score) ||
    !isValidScore(input.regular_away_score)
  ) {
    return { kind: "not_ready", code: FirstSettlementCode.NotReady };
  }

  const earliestSettlementAt = new Date(
    input.finish_detected_at.getTime() + FINISH_TO_SETTLEMENT_DELAY_MS,
  );
  if (input.server_now.getTime() < earliestSettlementAt.getTime()) {
    return { kind: "not_ready", code: FirstSettlementCode.NotReady };
  }

  return { kind: "start", code: FirstSettlementCode.Start };
}
