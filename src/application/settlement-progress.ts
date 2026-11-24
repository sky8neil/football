import { SettlementDocStatus, SettlementStatus } from "../domain/enums.js";
import type { AppRepository } from "../infrastructure/repositories.js";

/** Track the latest applied_at millisecond timestamp observed across settlement items. */
export function maxAppliedTimestampMs(
  currentMaxMs: number | null,
  appliedAt: Date | null,
): number | null {
  if (appliedAt === null) {
    return currentMaxMs;
  }
  const ms = appliedAt.getTime();
  return currentMaxMs === null ? ms : Math.max(currentMaxMs, ms);
}

/**
 * Resolve Finalize timestamp after ApplyItems so every settlement's `settled_at`
 * is strictly greater than its items' `applied_at` (§17.9.2 `applied_at < settled_at`).
 */
export function resolveFinalizeTimestamp(
  serverNow: Date,
  maxAppliedAtMs: number | null,
): Date {
  if (maxAppliedAtMs === null) {
    return serverNow;
  }
  return new Date(Math.max(serverNow.getTime(), maxAppliedAtMs + 1));
}

/** 已完成账本是结算进度的事实来源；幂等调用补齐旧的 match 缓存。 */
export async function reconcileSettledMatch(
  repo: AppRepository,
  matchId: string,
): Promise<void> {
  await repo.withTransaction(async (tx) => {
    const match = await tx.matches.findById(matchId);
    if (!match) return;
    const completed = (await tx.settlements.findByMatch(matchId))
      .filter((row) => row.status === SettlementDocStatus.Settled)
      .sort((a, b) => b.result_version - a.result_version)[0];
    if (!completed || completed.result_version < match.settled_result_version)
      return;
    if (
      completed.result_version === match.settled_result_version &&
      (match.settlement_status === SettlementStatus.Failed ||
        match.settlement_status === SettlementStatus.Correcting)
    )
      return;
    const status =
      match.result_version > completed.result_version
        ? SettlementStatus.Correcting
        : SettlementStatus.Settled;
    if (
      match.settled_result_version === completed.result_version &&
      match.settled_at !== null &&
      match.settlement_status === status
    )
      return;
    await tx.matches.updateSettlementProgress(
      matchId,
      completed.result_version,
      completed.settled_at!,
    );
    await tx.matches.updateSettlementStatus(
      matchId,
      status,
      completed.settled_at!,
    );
  });
}
