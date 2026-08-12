/**
 * API-Football short status 映射（规范 31.3）。
 *
 * 唯一入口 mapProviderStatus(short)：
 * - 已知映射 -> 对应领域状态；
 * - 未知或 MVP 英超不应出现的 ET/BT/P/AET/PEN -> unexpected（fail-closed，不结算）；
 * - 缺失 -> missing。
 */

export type ProviderFixtureStatus =
  | { kind: "scheduled"; kickoffConfirmed: boolean }
  | { kind: "live" }
  | { kind: "postponed" }
  | { kind: "cancelled" }
  | { kind: "abandoned" }
  | { kind: "finished" }
  | { kind: "unexpected"; raw: string }
  | { kind: "missing" };

/** MVP 英超不应出现的加时/点球状态（31.3）。 */
export const UNEXPECTED_PROVIDER_STATUSES: readonly string[] = [
  "ET",
  "BT",
  "P",
  "AET",
  "PEN",
] as const;

const STATUS_MAP: ReadonlyMap<string, ProviderFixtureStatus> = new Map<
  string,
  ProviderFixtureStatus
>([
  ["TBD", { kind: "scheduled", kickoffConfirmed: false }],
  ["NS", { kind: "scheduled", kickoffConfirmed: true }],
  ["1H", { kind: "live" }],
  ["HT", { kind: "live" }],
  ["2H", { kind: "live" }],
  ["SUSP", { kind: "live" }],
  ["INT", { kind: "live" }],
  ["LIVE", { kind: "live" }],
  ["PST", { kind: "postponed" }],
  ["CANC", { kind: "cancelled" }],
  ["AWD", { kind: "cancelled" }],
  ["WO", { kind: "cancelled" }],
  ["ABD", { kind: "abandoned" }],
  ["FT", { kind: "finished" }],
]);

export function mapProviderStatus(short: unknown): ProviderFixtureStatus {
  if (typeof short !== "string" || short.length === 0) {
    return { kind: "missing" };
  }
  const known = STATUS_MAP.get(short);
  if (known !== undefined) {
    return known;
  }
  return { kind: "unexpected", raw: short };
}
