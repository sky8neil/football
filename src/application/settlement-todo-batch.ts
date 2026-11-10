export const DEFAULT_SETTLEMENT_TODO_BATCH = 50;
export const SETTLEMENT_FALLBACK_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const SETTLEMENT_FALLBACK_STATE_ID = "settlement_fallback";

export function settlementTodoBatch(
  env: Record<string, string | undefined>,
): number {
  const raw = env.FOOTBALL_SETTLEMENT_TODO_BATCH;
  if (raw === undefined) return DEFAULT_SETTLEMENT_TODO_BATCH;
  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_SETTLEMENT_TODO_BATCH;
  if (!/^[0-9]+$/.test(trimmed)) return DEFAULT_SETTLEMENT_TODO_BATCH;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_SETTLEMENT_TODO_BATCH;
  return value;
}

export function shouldRunFallback(
  lastRunAt: Date | null | undefined,
  now: Date,
  intervalMs: number,
): boolean {
  if (lastRunAt == null) return true;
  const lastMs = lastRunAt.getTime();
  const nowMs = now.getTime();
  if (!Number.isFinite(lastMs) || !Number.isFinite(nowMs)) return true;
  return nowMs - lastMs >= intervalMs;
}
