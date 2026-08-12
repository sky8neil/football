import { periodEndAt } from "../domain/time.js";
import { validationError } from "../domain/errors.js";
import type { RankingEntry } from "../domain/types.js";

export function assertValidServerNow(serverNow: Date): void {
  if (!(serverNow instanceof Date) || Number.isNaN(serverNow.getTime())) {
    throw validationError("server_now 必须是有效时间", { field: "server_now" });
  }
}

/** 规范 19.7：周期结束后封榜；历史修正不得重新开放周期。 */
export function finalizeRankingEntry(
  entry: RankingEntry,
  serverNow: Date,
): RankingEntry {
  assertValidServerNow(serverNow);
  const endAt = periodEndAt(entry.period_type, entry.period_key);
  if (entry.is_final || serverNow.getTime() < endAt.getTime()) {
    return entry;
  }

  return {
    ...entry,
    is_final: true,
    updated_at: serverNow,
  };
}
