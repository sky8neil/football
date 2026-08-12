/**
 * 比赛状态机（规范第 10 节）。
 *
 * 唯一实现入口（规范 0.4）：validate_match_transition(from, to)。
 *
 * 说明：
 * - 只回答“Provider 自动转移是否合法”；不合法时由调用方（同步服务）创建 blocking anomaly（10.3）。
 * - 同状态重复同步为幂等 update，不制造状态历史事件（10.4）。
 */
import {
  MatchStatus,
  type MatchStatus as MatchStatusType,
  SettlementStatus,
  type SettlementStatus as SettlementStatusType,
} from "./enums.js";

export const MATCH_STATUSES: readonly MatchStatusType[] = [
  MatchStatus.Scheduled,
  MatchStatus.Live,
  MatchStatus.Finished,
  MatchStatus.Postponed,
  MatchStatus.Cancelled,
  MatchStatus.Abandoned,
] as const;

export const SETTLEMENT_STATUSES: readonly SettlementStatusType[] = [
  SettlementStatus.Pending,
  SettlementStatus.Waiting,
  SettlementStatus.Settling,
  SettlementStatus.Settled,
  SettlementStatus.Correcting,
  SettlementStatus.Failed,
  SettlementStatus.Voided,
] as const;

/** 规范 10.2 Provider 自动允许的转移。 */
const ALLOWED_TRANSITIONS: ReadonlySet<string> = new Set<string>([
  `${MatchStatus.Scheduled}->${MatchStatus.Live}`,
  `${MatchStatus.Scheduled}->${MatchStatus.Finished}`,
  `${MatchStatus.Scheduled}->${MatchStatus.Postponed}`,
  `${MatchStatus.Scheduled}->${MatchStatus.Cancelled}`,
  `${MatchStatus.Scheduled}->${MatchStatus.Abandoned}`,

  `${MatchStatus.Postponed}->${MatchStatus.Scheduled}`,
  `${MatchStatus.Postponed}->${MatchStatus.Live}`,
  `${MatchStatus.Postponed}->${MatchStatus.Finished}`,
  `${MatchStatus.Postponed}->${MatchStatus.Cancelled}`,
  `${MatchStatus.Postponed}->${MatchStatus.Abandoned}`,

  `${MatchStatus.Live}->${MatchStatus.Finished}`,
  `${MatchStatus.Live}->${MatchStatus.Abandoned}`,

  `${MatchStatus.Abandoned}->${MatchStatus.Finished}`,
  `${MatchStatus.Abandoned}->${MatchStatus.Cancelled}`,
]);

/** 唯一实现入口：validate_match_transition(from, to)。 */
export function validateMatchTransition(
  from: MatchStatusType,
  to: MatchStatusType,
): boolean {
  return ALLOWED_TRANSITIONS.has(`${from}->${to}`);
}

/** 规范 10.3：列举从该状态出发的所有被禁止的自动转移（用于异常明细）。 */
export function forbiddenTransitionsFrom(
  from: MatchStatusType,
): readonly MatchStatusType[] {
  return MATCH_STATUSES.filter(
    (to) => to !== from && !validateMatchTransition(from, to),
  );
}
