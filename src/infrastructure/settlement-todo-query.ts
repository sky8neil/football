import { MatchStatus, SettlementStatus } from "../domain/enums.js";
import type { Match } from "../domain/types.js";

export interface SettlementTodoQuery {
  limit: number;
  /** 游标：只取排序在该记录之后的候选（兜底分页用）；null/缺省表示从头 */
  after?: { kickoff_at: Date; match_id: string } | null;
}

/** 待办结算状态：排除 Settled / Voided。 */
export const SETTLEMENT_TODO_STATUSES: readonly SettlementStatus[] = [
  SettlementStatus.Pending,
  SettlementStatus.Waiting,
  SettlementStatus.Settling,
  SettlementStatus.Failed,
  SettlementStatus.Correcting,
];

const TODO_STATUS_SET = new Set<string>(SETTLEMENT_TODO_STATUSES);

export function isSettlementTodoStatus(status: string): boolean {
  return TODO_STATUS_SET.has(status);
}

/** kickoff_at 落库为 Date 或可比较时间串，统一成毫秒。 */
export function kickoffMs(value: unknown): number {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (typeof value === "string" || typeof value === "number") {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

export function compareSettlementTodo(left: Match, right: Match): number {
  const kickoffDelta = kickoffMs(left.kickoff_at) - kickoffMs(right.kickoff_at);
  if (kickoffDelta !== 0) return kickoffDelta;
  if (left.match_id < right.match_id) return -1;
  if (left.match_id > right.match_id) return 1;
  return 0;
}

export function isAfterSettlementCursor(
  match: Match,
  after: SettlementTodoQuery["after"],
): boolean {
  if (after == null) return true;
  const matchKickoff = kickoffMs(match.kickoff_at);
  const cursorKickoff = kickoffMs(after.kickoff_at);
  if (matchKickoff !== cursorKickoff) return matchKickoff > cursorKickoff;
  return match.match_id > after.match_id;
}

export function coerceMatchKickoff(match: Match): Match {
  if (match.kickoff_at instanceof Date) return match;
  const parsed = new Date(match.kickoff_at as unknown as string);
  return Number.isFinite(parsed.getTime()) ? { ...match, kickoff_at: parsed } : match;
}

export function selectSettlementTodos(
  matches: Iterable<Match>,
  query: SettlementTodoQuery,
): Match[] {
  return [...matches]
    .map(coerceMatchKickoff)
    .filter(
      (match) =>
        match.match_status === MatchStatus.Finished &&
        isSettlementTodoStatus(match.settlement_status),
    )
    .filter((match) => isAfterSettlementCursor(match, query.after))
    .sort(compareSettlementTodo)
    .slice(0, Math.max(0, query.limit));
}

export function selectSettlementFallbackPage(
  matches: Iterable<Match>,
  query: SettlementTodoQuery,
): Match[] {
  return [...matches]
    .map(coerceMatchKickoff)
    .filter(
      (match) =>
        match.match_status === MatchStatus.Finished &&
        match.settlement_status !== SettlementStatus.Voided,
    )
    .filter((match) => isAfterSettlementCursor(match, query.after))
    .sort(compareSettlementTodo)
    .slice(0, Math.max(0, query.limit));
}
