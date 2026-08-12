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

  `${SettlementStatus.Failed}->${SettlementStatus.Settling}`,
  `${SettlementStatus.Failed}->${SettlementStatus.Correcting}`,

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
 * 规范 11.3：比赛首次进入 cancelled 且尚未 settled 时，
 * settlement_status 应置为 voided。已 settled 的取消属于非正常业务（blocking anomaly）。
 */
export function shouldVoidOnCancel(
  matchStatus: MatchStatusType,
  settlementStatus: SettlementStatusType,
): boolean {
  return (
    matchStatus === MatchStatus.Cancelled &&
    settlementStatus !== SettlementStatus.Settled
  );
}
