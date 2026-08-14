/**
 * 结算状态机（规范第 11 节）。
 *
 * 唯一实现入口（规范 0.4）：validate_settlement_transition(from, to)。
 *
 * 状态含义（11.1）：
 *   pending   尚未达到正式结算条件
 *   waiting   已确认 finished，处于保护时间或等待合法数据
 *   settling  首次正式结算执行中
 *   settled   最新已要求处理的赛果版本结算完成
 *   correcting 已结算后正在应用新赛果版本
 *   failed    结算执行失败，需要重试
 *   voided    比赛无效，不结算
 *
 * cancelled 专用例外（依据规范 11.3 与 49.15 审查表）：
 * `settling->voided`、`failed->voided` 两条边只允许由 `applyCancelledFixture`
 * 的 cancelled 业务路径使用（未结算的 cancelled 一律 voided），禁止其它调用方
 * 借 voided 跳过结算；已结算范畴（settled / correcting）的 cancelled 必须走
 * blocking anomaly，不得自动作废历史。
 */
import {
  MatchStatus,
  SettlementStatus,
  type MatchStatus as MatchStatusType,
  type SettlementStatus as SettlementStatusType,
} from "./enums.js";

const ALLOWED_TRANSITIONS: ReadonlySet<string> = new Set<string>([
  `${SettlementStatus.Pending}->${SettlementStatus.Waiting}`,
  `${SettlementStatus.Pending}->${SettlementStatus.Voided}`,

  `${SettlementStatus.Waiting}->${SettlementStatus.Settling}`,
  `${SettlementStatus.Waiting}->${SettlementStatus.Voided}`,

  `${SettlementStatus.Settling}->${SettlementStatus.Settled}`,
  `${SettlementStatus.Settling}->${SettlementStatus.Failed}`,
  `${SettlementStatus.Settling}->${SettlementStatus.Correcting}`,
  // cancelled 专用例外（11.3 / 49.15），见文件头注释；非 cancelled 业务路径禁用。
  `${SettlementStatus.Settling}->${SettlementStatus.Voided}`,

  `${SettlementStatus.Failed}->${SettlementStatus.Settling}`,
  `${SettlementStatus.Failed}->${SettlementStatus.Correcting}`,
  // cancelled 专用例外（11.3 / 49.15），见文件头注释；非 cancelled 业务路径禁用。
  `${SettlementStatus.Failed}->${SettlementStatus.Voided}`,

  `${SettlementStatus.Settled}->${SettlementStatus.Correcting}`,

  `${SettlementStatus.Correcting}->${SettlementStatus.Settled}`,
  `${SettlementStatus.Correcting}->${SettlementStatus.Failed}`,
]);

/** 唯一实现入口：validate_settlement_transition(from, to)。 */
export function validateSettlementTransition(
  from: SettlementStatusType,
  to: SettlementStatusType,
): boolean {
  return ALLOWED_TRANSITIONS.has(`${from}->${to}`);
}

/**
 * 规范 11.3 / 49.15：比赛首次进入 cancelled 且 settlement 尚未进入已结算范畴时，
 * settlement_status 应置为 voided（voided 幂等保持）。
 * correcting 必有 settled_result_version > 0，属已结算范畴，与 settled 一样由
 * applyCancelledFixture 走 blocking anomaly；本 Set 与上面的 cancelled 例外边一致。
 */
const VOIDABLE_ON_CANCEL: ReadonlySet<SettlementStatusType> = new Set([
  SettlementStatus.Pending,
  SettlementStatus.Waiting,
  SettlementStatus.Settling,
  SettlementStatus.Failed,
  SettlementStatus.Voided,
]);

export function shouldVoidOnCancel(
  matchStatus: MatchStatusType,
  settlementStatus: SettlementStatusType,
): boolean {
  return (
    matchStatus === MatchStatus.Cancelled &&
    VOIDABLE_ON_CANCEL.has(settlementStatus)
  );
}
