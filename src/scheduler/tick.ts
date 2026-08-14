/**
 * 生产调度 tick：被触发一次就执行一次。
 * 频率属于云函数定时触发器（见 triggers.md / SYNC_TASKS_V1），此处不内置循环。
 * `now()` 只用于日志 duration_ms；lease 与业务判断一律使用注入的 server_now。
 */
import { assertValidServerNow } from "../application/period-finalize.js";
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { SyncJobType } from "../domain/enums.js";
import { validationError } from "../domain/errors.js";
import type { JobLockRepository } from "../infrastructure/repositories.js";
import { jobLockKey } from "../sync/config.js";

/** 与 A3.3 初次 lease 一致：server_now + JOB_LEASE_MINUTES，不另发明超时。 */
export const SCHEDULER_LEASE_MS = FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60_000;

export type SchedulerRunner = (
  serverNow: Date,
) => Promise<Readonly<Record<string, unknown>>>;

export type SchedulerRunnerMap = {
  [jobType in SyncJobType]: SchedulerRunner;
};

export interface SchedulerErrorSummary {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly status?: number;
}

export type SchedulerLogEntry = {
  readonly job_type: SyncJobType;
  readonly outcome: "completed" | "skipped" | "failed";
  readonly started_at: string;
  readonly finished_at: string;
  readonly duration_ms: number;
  readonly lock_key: string;
  readonly owner_id: string;
  readonly error?: SchedulerErrorSummary;
} & Record<string, unknown>;

export interface SchedulerTickDeps {
  jobLocks: JobLockRepository;
  runners: SchedulerRunnerMap;
  /** 仅观测 duration_ms；禁止进入业务写入或 lease 计算。 */
  now?: () => number;
  /** 实例身份，如 instance-<host>-<pid>。 */
  ownerId: string;
  log?: (entry: SchedulerLogEntry) => void;
}

export type SchedulerTickResult =
  | { readonly outcome: "skipped" }
  | ({ readonly outcome: "completed" } & Record<string, unknown>)
  | { readonly outcome: "failed"; readonly error: unknown };

const SYNC_JOB_TYPES = new Set<string>(Object.values(SyncJobType));

export function isSyncJobType(value: unknown): value is SyncJobType {
  return typeof value === "string" && SYNC_JOB_TYPES.has(value);
}

function numericRunnerCounts(
  result: Readonly<Record<string, unknown>>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(result)) {
    if (key === "outcome") {
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      counts[key] = value;
    }
  }
  return counts;
}

/** 日志只保留 name/code/message/status，不透传 details、payload、凭证。 */
export function summarizeSchedulerError(error: unknown): SchedulerErrorSummary {
  if (error instanceof Error) {
    const summary: SchedulerErrorSummary = {
      name: error.name,
      message: error.message,
    };
    const record = error as Error & { code?: unknown; status?: unknown };
    return {
      ...summary,
      ...(typeof record.code === "string" ? { code: record.code } : {}),
      ...(typeof record.status === "number" && Number.isFinite(record.status)
        ? { status: record.status }
        : {}),
    };
  }
  return { name: "Error", message: "unknown error" };
}

export class SchedulerTick {
  constructor(private readonly deps: SchedulerTickDeps) {}

  async run(jobType: SyncJobType, serverNow: Date): Promise<SchedulerTickResult> {
    assertValidServerNow(serverNow);
    if (!isSyncJobType(jobType) || typeof this.deps.runners[jobType] !== "function") {
      throw validationError("未知 job_type", { field: "job_type" });
    }

    const clock = this.deps.now ?? Date.now;
    const startedMs = clock();
    const lockKey = jobLockKey(jobType);
    const leaseUntil = new Date(serverNow.getTime() + SCHEDULER_LEASE_MS);
    const acquired = await this.deps.jobLocks.acquire(
      lockKey,
      this.deps.ownerId,
      leaseUntil,
    );

    if (!acquired) {
      const finishedMs = clock();
      this.writeLog({
        job_type: jobType,
        outcome: "skipped",
        started_at: new Date(startedMs).toISOString(),
        finished_at: new Date(finishedMs).toISOString(),
        duration_ms: Math.max(0, finishedMs - startedMs),
        lock_key: lockKey,
        owner_id: this.deps.ownerId,
      });
      return { outcome: "skipped" };
    }

    try {
      const runnerResult = await this.deps.runners[jobType](serverNow);
      const finishedMs = clock();
      this.writeLog({
        job_type: jobType,
        outcome: "completed",
        started_at: new Date(startedMs).toISOString(),
        finished_at: new Date(finishedMs).toISOString(),
        duration_ms: Math.max(0, finishedMs - startedMs),
        lock_key: lockKey,
        owner_id: this.deps.ownerId,
        ...numericRunnerCounts(runnerResult),
      });
      return { ...runnerResult, outcome: "completed" };
    } catch (error) {
      const finishedMs = clock();
      this.writeLog({
        job_type: jobType,
        outcome: "failed",
        started_at: new Date(startedMs).toISOString(),
        finished_at: new Date(finishedMs).toISOString(),
        duration_ms: Math.max(0, finishedMs - startedMs),
        lock_key: lockKey,
        owner_id: this.deps.ownerId,
        error: summarizeSchedulerError(error),
      });
      return { outcome: "failed", error };
    } finally {
      await this.deps.jobLocks.release(lockKey, this.deps.ownerId);
    }
  }

  private writeLog(entry: SchedulerLogEntry): void {
    this.deps.log?.(entry);
  }
}
