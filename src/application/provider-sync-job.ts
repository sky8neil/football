import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { DomainError, internalError } from "../domain/errors.js";
import { SCHEMA_VERSION, SyncJobStatus, type SyncJobType } from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { SyncLog } from "../domain/types.js";
import {
  ProviderDataError,
  ProviderHttpError,
  ProviderError,
} from "../provider/http.js";
import type { ApiFootballFixture } from "../provider/types.js";
import {
  applyJitter,
  isQuotaExceededError,
  jobLockKey,
  nextRetryDelayMinutes,
  SYNC_RETRY_V1,
} from "../sync/config.js";
import type { AppRepository, SyncLogRepository } from "../infrastructure/repositories.js";
import type {
  ProviderFixtureSyncOutcome,
  ProviderFixtureSyncService,
} from "./provider-fixture-sync.js";
import { assertValidServerNow } from "./period-finalize.js";

export interface ProviderFixtureBatchItem {
  fixture: ApiFootballFixture;
  payload: Record<string, unknown>;
}

export type ProviderFixtureBatchLoader = (
  serverNow: Date,
) => Promise<readonly ProviderFixtureBatchItem[]>;

export interface ProviderFixtureSyncRetryOptions {
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
}

export type ProviderFixtureSyncJobOutcome =
  | {
      kind: "completed";
      job_type: SyncJobType;
      items_read: number;
      items_changed: number;
      items_failed: number;
    }
  | {
      kind: "skipped";
      job_type: SyncJobType;
      reason: "lock_held";
    };

function requireSyncLogs(
  repo: Pick<AppRepository, "syncLogs">,
): SyncLogRepository {
  if (repo.syncLogs === undefined) {
    throw internalError("Provider 同步缺少 sync_logs repository port");
  }
  return repo.syncLogs;
}

function errorCode(error: unknown): string {
  if (error instanceof DomainError) {
    return error.code;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "INTERNAL_ERROR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "provider sync failed";
}

function isChanged(outcome: ProviderFixtureSyncOutcome): boolean {
  return outcome.kind === "applied";
}

function isFailed(outcome: ProviderFixtureSyncOutcome): boolean {
  return outcome.kind === "failed" || outcome.kind === "conflict";
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isRetryableLoaderError(error: unknown): boolean {
  if (isQuotaExceededError(error) || error instanceof ProviderDataError) {
    return false;
  }
  if (error instanceof ProviderHttpError) {
    return error.status === 408 || error.status >= 500;
  }
  if (error instanceof ProviderError) {
    return false;
  }
  return error instanceof Error;
}

function startJobLockRenewal(
  repo: Pick<AppRepository, "jobLocks">,
  lockKey: string,
  ownerId: string,
): { assertHealthy: () => void; stop: () => void } {
  let renewalFailure: DomainError | undefined;
  const leaseMs = FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60_000;
  const timer = setInterval(() => {
    void Promise.resolve()
      .then(() =>
        repo.jobLocks.renew(
          lockKey,
          ownerId,
          new Date(Date.now() + leaseMs),
        ),
      )
      .then((renewed) => {
        if (!renewed) {
          renewalFailure ??= internalError("Provider 同步锁续租失败");
        }
      }, () => {
        renewalFailure ??= internalError("Provider 同步锁续租失败");
      });
  }, leaseMs / 2);

  return {
    assertHealthy: () => {
      if (renewalFailure !== undefined) {
        throw renewalFailure;
      }
    },
    stop: () => clearInterval(timer),
  };
}

/**
 * 执行一个注入 fixture 批次。Provider client / scheduler 在边界外提供 loader；本服务不
 * 连接外部网络，只协调既有单 fixture 同步、lease 和 sync_logs。
 */
export class ProviderFixtureSyncJobService {
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly random: () => number;

  constructor(
    private readonly repo: Pick<AppRepository, "jobLocks" | "syncLogs">,
    private readonly fixtureSync: Pick<ProviderFixtureSyncService, "applyFixture">,
    retryOptions: ProviderFixtureSyncRetryOptions = {},
  ) {
    this.sleep = retryOptions.sleep ?? defaultSleep;
    this.random = retryOptions.random ?? Math.random;
  }

  async run(
    jobType: SyncJobType,
    load: ProviderFixtureBatchLoader,
    serverNow: Date,
  ): Promise<ProviderFixtureSyncJobOutcome> {
    assertValidServerNow(serverNow);
    const syncLogs = requireSyncLogs(this.repo);
    const lockKey = jobLockKey(jobType);
    const ownerId = newUuid();
    const leaseUntil = new Date(
      serverNow.getTime() + FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000,
    );
    const acquired = await this.repo.jobLocks.acquire(lockKey, ownerId, leaseUntil);
    if (!acquired) {
      return { kind: "skipped", job_type: jobType, reason: "lock_held" };
    }

    const runningLog: SyncLog = {
      schema_version: SCHEMA_VERSION,
      sync_job_id: newUuid(),
      job_type: jobType,
      status: SyncJobStatus.Running,
      started_at: serverNow,
      finished_at: null,
      attempt_count: 1,
      items_read: 0,
      items_changed: 0,
      items_failed: 0,
      last_error_code: null,
      last_error_message: null,
      created_at: serverNow,
    };

    const lockRenewal = startJobLockRenewal(this.repo, lockKey, ownerId);
    try {
      await syncLogs.insert(runningLog);
      let attemptCount = 0;
      try {
        let items: readonly ProviderFixtureBatchItem[];
        let retryIndex = 0;
        while (true) {
          lockRenewal.assertHealthy();
          attemptCount += 1;
          try {
            items = await load(serverNow);
            break;
          } catch (error) {
            const delayMinutes = isRetryableLoaderError(error)
              ? nextRetryDelayMinutes(retryIndex)
              : null;
            if (delayMinutes === null) {
              throw error;
            }

            await syncLogs.update({
              ...runningLog,
              status: SyncJobStatus.Running,
              attempt_count: attemptCount,
              last_error_code: errorCode(error),
              last_error_message: errorMessage(error),
            });
            const delayMs = applyJitter(
              delayMinutes * 60_000,
              SYNC_RETRY_V1.jitterPercent,
              this.random,
            );
            await this.sleep(delayMs);
            retryIndex += 1;
          }
        }

        let changed = 0;
        let failed = 0;

        for (const item of items) {
          lockRenewal.assertHealthy();
          try {
            const outcome = await this.fixtureSync.applyFixture(
              item.fixture,
              item.payload,
              serverNow,
            );
            if (isChanged(outcome)) {
              changed += 1;
            }
            if (isFailed(outcome)) {
              failed += 1;
            }
          } catch {
            // 单个实体失败不影响同一批次其他实体；其事务已由 fixture service 回滚。
            failed += 1;
          }
        }

        lockRenewal.assertHealthy();
        await syncLogs.update({
          ...runningLog,
          status: SyncJobStatus.Success,
          attempt_count: attemptCount,
          finished_at: serverNow,
          items_read: items.length,
          items_changed: changed,
          items_failed: failed,
        });
        return {
          kind: "completed",
          job_type: jobType,
          items_read: items.length,
          items_changed: changed,
          items_failed: failed,
        };
      } catch (error) {
        await syncLogs.update({
          ...runningLog,
          status: SyncJobStatus.Failed,
          attempt_count: attemptCount,
          finished_at: serverNow,
          items_failed: 1,
          last_error_code: errorCode(error),
          last_error_message: errorMessage(error),
        });
        throw error;
      }
    } finally {
      lockRenewal.stop();
      await this.repo.jobLocks.release(lockKey, ownerId);
    }
  }
}
