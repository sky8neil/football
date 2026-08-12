/**
 * 预测关闭（prediction_closed_at）决策（规范 6.4）。
 *
 * prediction_closed_at 业务含义：本场预测入口已经永久关闭的事实时间。
 * - 初始 null；一旦非 null 永远不得恢复为 null（6.4.2）。
 * - 正常到截止时间写 prediction_deadline_at（6.4.4）。
 * - Provider 提前报告 live 时写 server_now（6.4.5）。
 * - 首次发现 finished 且仍未关闭时写 server_now（6.4.6）。
 */
import {
  MatchStatus,
  type MatchStatus as MatchStatusType,
} from "./enums.js";

const IMMEDIATE_CLOSE_STATUSES: ReadonlySet<MatchStatusType> = new Set([
  MatchStatus.Live,
  MatchStatus.Finished,
]);

export interface CloseDecisionInput {
  prediction_closed_at: Date | null;
  prediction_deadline_at: Date | null;
  /** 当前 match_status，决定墙钟到点关闭是否适用（49.4）。 */
  match_status: MatchStatusType;
}

/**
 * 结合 Provider 报告状态决定 prediction_closed_at 应写入的值。
 * 返回 null 表示无需写入（保持现状）。
 *
 * 49.4：墙钟到点关闭仅当 当前 match_status==scheduled AND deadline!=null AND
 * server_now>=deadline 同时满足；postponed 期间不得因旧 deadline 自动写 closed_at。
 */
export function decidePredictionClosedAt(
  match: CloseDecisionInput,
  targetStatus: MatchStatusType,
  serverNow: Date,
): Date | null {
  if (match.prediction_closed_at !== null) {
    return null;
  }
  if (IMMEDIATE_CLOSE_STATUSES.has(targetStatus)) {
    return serverNow;
  }
  if (
    match.match_status === MatchStatus.Scheduled &&
    match.prediction_deadline_at !== null &&
    serverNow.getTime() >= match.prediction_deadline_at.getTime()
  ) {
    return match.prediction_deadline_at;
  }
  return null;
}
