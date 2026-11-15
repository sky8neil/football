/**
 * 同步任务配置（阶段 3，规范 32.1-32.8）。
 *
 * - 每个 job_type 使用锁 `sync:{job_type}`（32.7），lease 超时可接管。
 * - 普通暂时错误按 1/2/5/10/30 分钟退避重试，最多 5 次，每次 ±20% jitter（32.8）。
 * - quota 超限停止高频自动重试，等 Provider 明确 reset 或下一正常 scheduled run（32.8）。
 *
 * ## 单一来源
 *
 * `SYNC_TASKS_V1` 是**所有任务间隔的唯一来源**。`providerJobIntervalMs()` 只做单位换算
 * 和 profile 覆盖，不再自己硬编码一套数字。历史上两处各写一份（本文件的 intervalMinutes
 * 写了没人读、providerJobIntervalMs 里另有一份硬编码），改配置不生效，已按此约束收敛。
 * `src/runtime/scheduled-jobs.ts` 的周期任务同样只从这里读。
 */
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { SyncJobType } from "../domain/enums.js";
import { ProviderQuotaExceededError } from "../provider/http.js";

export type ProviderJobProfile = "test" | "prod";

export interface SyncTaskConfig {
  lookaheadDays?: number;
  windowStartHoursBeforeKickoff?: number;
  windowEndHoursBeforeKickoff?: number;
  /** 常规运行间隔（分钟）。本文件是全系统唯一来源。 */
  intervalMinutes?: number;
  /** 按 sync profile 覆盖 intervalMinutes；未覆盖的 profile 回落到 intervalMinutes。 */
  intervalMinutesByProfile?: Partial<Record<ProviderJobProfile, number>>;
  cronExpression?: string;
  highFrequencyUntilFirstSettlement?: boolean;
}

export const SYNC_TASKS_V1: Partial<Record<SyncJobType, SyncTaskConfig>> & {
  future_schedule: SyncTaskConfig;
  full_schedule_verify: SyncTaskConfig;
  near_match: SyncTaskConfig;
  live_match: SyncTaskConfig;
  post_finish_verify: SyncTaskConfig;
  period_finalize: SyncTaskConfig;
  daily_consistency: SyncTaskConfig;
  weekly_level_eval: SyncTaskConfig;
  level_correction_reeval: SyncTaskConfig;
  board_snapshot_season_final: SyncTaskConfig;
} = {
  future_schedule: {
    lookaheadDays: FIXED_CONFIG_V1.SYNC_FUTURE_DAYS,
    intervalMinutes: FIXED_CONFIG_V1.SYNC_NORMAL_INTERVAL_HOURS * 60,
    // test profile 配额更紧，赛程刷新降到 12 小时。
    intervalMinutesByProfile: { test: FIXED_CONFIG_V1.SYNC_NORMAL_INTERVAL_HOURS * 2 * 60 },
  },
  full_schedule_verify: {
    intervalMinutes: 24 * 60,
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
    // test profile 配额更紧，完场确认从 3 分钟放宽到 5 分钟。
    intervalMinutesByProfile: { test: 5 },
    highFrequencyUntilFirstSettlement: true,
  },
  period_finalize: {
    intervalMinutes: 60,
  },
  daily_consistency: {
    intervalMinutes: 24 * 60,
  },
  weekly_level_eval: {
    cronExpression: "10 2 * * 1",
  },
  level_correction_reeval: {},
  board_snapshot_career: {
    intervalMinutes: FIXED_CONFIG_V1.CAREER_BOARD_SNAPSHOT_MINUTES,
  },
  board_snapshot_strength: {
    intervalMinutes: 24 * 60,
  },
  board_snapshot_season: {
    intervalMinutes: FIXED_CONFIG_V1.SEASON_BOARD_SNAPSHOT_MINUTES,
  },
  board_snapshot_season_final: {},
};

/**
 * 任务的常规间隔（分钟）：`intervalMinutesByProfile[profile]` 优先，否则 `intervalMinutes`。
 *
 * 未声明即抛错——宁可启动时报错，也不要像历史上那样静默回落到硬编码的 3 分钟。
 */
export function taskIntervalMinutes(jobType: SyncJobType, profile: ProviderJobProfile): number {
  const config: SyncTaskConfig | undefined = SYNC_TASKS_V1[jobType];
  const minutes = config?.intervalMinutesByProfile?.[profile] ?? config?.intervalMinutes;
  if (minutes === undefined) {
    throw new Error(`${jobType} 未在 SYNC_TASKS_V1 中声明 intervalMinutes`);
  }
  return minutes;
}

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

/** 各 job_type 的常规执行间隔（毫秒）。RP08：锁前/锁内资格判断共用同一来源。 */
export function providerJobIntervalMs(jobType: SyncJobType, profile: ProviderJobProfile): number {
  return taskIntervalMinutes(jobType, profile) * 60_000;
}
