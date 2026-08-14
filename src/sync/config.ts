/**
 * 同步任务配置（阶段 3，规范 32.1-32.8）。
 *
 * - 每个 job_type 使用锁 `sync:{job_type}`（32.7），lease 超时可接管。
 * - 普通暂时错误按 1/2/5/10/30 分钟退避重试，最多 5 次，每次 ±20% jitter（32.8）。
 * - quota 超限停止高频自动重试，等 Provider 明确 reset 或下一正常 scheduled run（32.8）。
 */
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import type { SyncJobType } from "../domain/enums.js";
import { ProviderQuotaExceededError } from "../provider/http.js";

export interface SyncTaskConfig {
  lookaheadDays?: number;
  windowStartHoursBeforeKickoff?: number;
  windowEndHoursBeforeKickoff?: number;
  intervalHours?: number;
  intervalMinutes?: number;
  highFrequencyUntilFirstSettlement?: boolean;
}

export const SYNC_TASKS_V1: Record<SyncJobType, SyncTaskConfig> = {
  future_schedule: {
    lookaheadDays: FIXED_CONFIG_V1.SYNC_FUTURE_DAYS,
    intervalHours: FIXED_CONFIG_V1.SYNC_NORMAL_INTERVAL_HOURS,
  },
  full_schedule_verify: {
    intervalHours: 24,
  },
  near_match: {
    windowStartHoursBeforeKickoff: 24,
    windowEndHoursBeforeKickoff: 2,
    intervalMinutes: FIXED_CONFIG_V1.SYNC_NEAR_24H_TO_2H_INTERVAL_MINUTES,
  },
  live_match: {
    windowStartHoursBeforeKickoff: 2,
    intervalMinutes: FIXED_CONFIG_V1.SYNC_NEAR_2H_TO_FINISH_INTERVAL_MINUTES,
  },
  post_finish_verify: {
    intervalMinutes: 3,
    highFrequencyUntilFirstSettlement: true,
  },
  period_finalize: {
    intervalHours: 1,
  },
  daily_consistency: {
    intervalHours: 24,
  },
};

export const SYNC_RETRY_V1 = {
  retryDelaysMinutes: FIXED_CONFIG_V1.SYNC_RETRY_DELAYS_MINUTES,
  maxRetries: FIXED_CONFIG_V1.SYNC_MAX_RETRIES,
  jitterPercent: FIXED_CONFIG_V1.SYNC_RETRY_JITTER_PERCENT,
  quotaExceededStopsAutoRetry: true,
} as const;

/** 第 attempt 次重试（0 起）对应的退避延迟分钟数；超出上限返回 null（不再自动重试）。 */
export function nextRetryDelayMinutes(attempt: number): number | null {
  const delays = FIXED_CONFIG_V1.SYNC_RETRY_DELAYS_MINUTES;
  if (attempt >= delays.length || attempt >= FIXED_CONFIG_V1.SYNC_MAX_RETRIES) {
    return null;
  }
  return delays[attempt] ?? null;
}

/** 在 [value * (1 - percent/100), value * (1 + percent/100)] 范围内加 jitter（±percent%）。 */
export function applyJitter(
  value: number,
  percent: number,
  random: () => number,
): number {
  const factor = 1 + (percent / 100) * (2 * random() - 1);
  return Math.round(value * factor);
}

export function isQuotaExceededError(
  err: unknown,
): err is ProviderQuotaExceededError {
  return err instanceof ProviderQuotaExceededError;
}

/** 同类任务锁 key（32.7）：`sync:{job_type}`。 */
export function jobLockKey(jobType: SyncJobType): string {
  return `sync:${jobType}`;
}
