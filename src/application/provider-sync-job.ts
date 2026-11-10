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
  /** @deprecated 已改为写 deferred 日志并返回，不再在函数内等待。 */
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
}

export interface ProviderFixtureFailureDiagnostic {
  sync_job_id: string;
  provider: string;
  provider_fixture_id: string | null;
  stage: "apply_fixture";
  outcome: "failed" | "conflict" | "exception";
  error_code: string;
  error_name: string | null;
  error_message: string;
  reason_codes: string[];
  match_id: string | null;
}

const MAX_FAILURE_DIAGNOSTICS = 100;
const MAX_DIAGNOSTIC_TEXT_LENGTH = 240;

export type ProviderFixtureSyncJobOutcome =
  | {
      kind: "completed";
      job_type: SyncJobType;
      items_read: number;
      items_changed: number;
      items_failed: number;
      failure_diagnostics?: ProviderFixtureFailureDiagnostic[];
      failure_diagnostics_omitted?: number;
    }
  | {
      kind: "skipped";
      job_type: SyncJobType;
      reason: "lock_held";
    }
  | {
      kind: "deferred";
      job_type: SyncJobType;
      next_attempt_at: Date;
      retry_attempt: number;
      last_error_code: string | null;
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

function safeDiagnosticText(value: string, maxLength = MAX_DIAGNOSTIC_TEXT_LENGTH): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\b(Bearer)\s+[^\s,;]+/gi, "$1 [REDACTED]")
    .replace(/((?:authorization|cookie|set-cookie|x-api-key|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret(?:key)?|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, maxLength);
}

function safeErrorCode(error: unknown): string {
  return safeDiagnosticText(errorCode(error), 80).replace(/[^A-Za-z0-9_.:-]/g, "_");
}

function providerFixtureId(item: ProviderFixtureBatchItem): string | null {
  const id = item.fixture?.fixture?.id;
  if (typeof id !== "string" && typeof id !== "number") return null;
  const value = String(id);
  // UUIDs are valid provider fixture identifiers and must remain actionable in diagnostics.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return value;
  }
  return safeDiagnosticText(value, 100);
}

function failureReasonCodes(outcome: ProviderFixtureSyncOutcome): string[] {
  if (outcome.kind === "failed") {
    return outcome.anomaly_types.map((value) => safeDiagnosticText(value, 80));
  }
  if (outcome.kind === "conflict") {
    return [safeDiagnosticText(outcome.anomaly_type, 80)];
  }
  return [];
}

function diagnosticBase(
  syncJobId: string,
  item: ProviderFixtureBatchItem,
): Pick<ProviderFixtureFailureDiagnostic, "sync_job_id" | "provider" | "provider_fixture_id" | "stage"> {
  return {
    sync_job_id: syncJobId,
    provider: safeDiagnosticText(item.fixture?.provider ?? "api_football", 40),
    provider_fixture_id: providerFixtureId(item),
    stage: "apply_fixture",
  };
}

function outcomeFailureDiagnostic(
  syncJobId: string,
  item: ProviderFixtureBatchItem,
  outcome: ProviderFixtureSyncOutcome,
): ProviderFixtureFailureDiagnostic | null {
  if (!isFailed(outcome)) return null;
  const reasonCodes = failureReasonCodes(outcome);
  return {
    ...diagnosticBase(syncJobId, item),
    outcome: outcome.kind,
    error_code: reasonCodes[0] ?? outcome.kind.toUpperCase(),
    error_name: null,
    error_message: `fixture sync returned ${outcome.kind}`,
    reason_codes: reasonCodes,
    match_id: outcome.match_id,
  };
}

function exceptionFailureDiagnostic(
  syncJobId: string,
  item: ProviderFixtureBatchItem,
  error: unknown,
): ProviderFixtureFailureDiagnostic {
  return {
    ...diagnosticBase(syncJobId, item),
    outcome: "exception",
    error_code: safeErrorCode(error),
    error_name: error instanceof Error ? safeDiagnosticText(error.name, 80) : null,
    error_message: safeDiagnosticText(errorMessage(error)) || "provider fixture sync failed",
    reason_codes: [],
    match_id: null,
  };
}

function isChanged(outcome: ProviderFixtureSyncOutcome): boolean {
  return outcome.kind === "applied";
}

function isFailed(
  outcome: ProviderFixtureSyncOutcome,
): outcome is Extract<ProviderFixtureSyncOutcome, { kind: "failed" | "conflict" }> {
  return outcome.kind === "failed" || outcome.kind === "conflict";
}

function isRetryableLoaderError(error: unknown): boolean {
  if (
    error instanceof DomainError ||
    isQuotaExceededError(error) ||
    error instanceof ProviderDataError
  ) {
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
          clearInterval(timer);
        }
      }, () => {
        renewalFailure ??= internalError("Provider 同步锁续租失败");
        clearInterval(timer);
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
  private readonly random: () => number;

  constructor(
    private readonly repo: Pick<AppRepository, "jobLocks" | "syncLogs">,
    private readonly fixtureSync: Pick<ProviderFixtureSyncService, "applyFixture">,
    retryOptions: ProviderFixtureSyncRetryOptions = {},
  ) {
    this.random = retryOptions.random ?? Math.random;
  }

  /** RP07：跨轮累计重试序号。上一条 deferred 日志的 retry_attempt + 1；无则 0。 */
  private async priorRetryAttempt(jobType: SyncJobType, excludeSyncJobId: string): Promise<number> {
    const latest = await this.repo.syncLogs?.findLatestByJobType?.(jobType, { excludeSyncJobId });
    if (!latest || latest.status !== SyncJobStatus.Deferred) return 0;
    return (latest.retry_attempt ?? 0) + 1;
  }

  async run(
    jobType: SyncJobType,
    load: ProviderFixtureBatchLoader,
    serverNow: Date,
  ): Promise<ProviderFixtureSyncJobOutcome> {
    assertValidServerNow(serverNow);
    const lockKey = jobLockKey(jobType);
    const ownerId = newUuid();
    const leaseUntil = new Date(
      serverNow.getTime() + FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000,
    );
    const acquired = await this.repo.jobLocks.acquire(lockKey, ownerId, leaseUntil);
    if (!acquired) {
      return { kind: "skipped", job_type: jobType, reason: "lock_held" };
    }

    try {
      return await this.executeHeldByCaller(jobType, load, serverNow, ownerId);
    } finally {
      await this.repo.jobLocks.release(lockKey, ownerId);
    }
  }

  /**
   * P1-2（方案 A）无锁批次核心：供已持有 `sync:{job_type}` 锁的调用方（如
   * SchedulerTick runner 接线）复用 loader + apply + sync_logs，不再 acquire/release。
   * ownerId 必须等于持锁方（tick）的 ownerId，保证 lease 续租与 acquire owner 一致。
   */
  async executeHeldByCaller(
    jobType: SyncJobType,
    load: ProviderFixtureBatchLoader,
    serverNow: Date,
    ownerId: string,
  ): Promise<ProviderFixtureSyncJobOutcome> {
    assertValidServerNow(serverNow);
    const syncLogs = requireSyncLogs(this.repo);
    const lockKey = jobLockKey(jobType);

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
        while (true) {
          lockRenewal.assertHealthy();
          attemptCount += 1;
          try {
            items = await load(serverNow);
            break;
          } catch (error) {
            if (!isRetryableLoaderError(error)) throw error;
            const retryAttempt = await this.priorRetryAttempt(jobType, runningLog.sync_job_id);
            const delayMinutes = nextRetryDelayMinutes(retryAttempt);
            if (delayMinutes === null) {
              throw new DomainError(
                "PROVIDER_RETRY_EXHAUSTED",
                `Provider 同步连续失败 ${attemptCount} 次（重试序号 ${retryAttempt}），已停止自动重试`,
              );
            }
            const delayMs = applyJitter(
              delayMinutes * 60_000,
              SYNC_RETRY_V1.jitterPercent,
              this.random,
            );
            const nextAttemptAt = new Date(serverNow.getTime() + delayMs);
            await syncLogs.update({
              ...runningLog,
              status: SyncJobStatus.Deferred,
              attempt_count: attemptCount,
              finished_at: serverNow,
              retry_attempt: retryAttempt,
              next_attempt_at: nextAttemptAt,
              last_error_code: errorCode(error),
              last_error_message: errorMessage(error),
            });
            return {
              kind: "deferred",
              job_type: jobType,
              next_attempt_at: nextAttemptAt,
              retry_attempt: retryAttempt,
              last_error_code: errorCode(error),
            };
          }
        }

        let changed = 0;
        let failed = 0;
        const failureDiagnostics: ProviderFixtureFailureDiagnostic[] = [];
        let failureDiagnosticsOmitted = 0;

        const recordFailure = (diagnostic: ProviderFixtureFailureDiagnostic) => {
          if (failureDiagnostics.length < MAX_FAILURE_DIAGNOSTICS) {
            failureDiagnostics.push(diagnostic);
          } else {
            failureDiagnosticsOmitted += 1;
          }
        };

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
              const diagnostic = outcomeFailureDiagnostic(
                runningLog.sync_job_id,
                item,
                outcome,
              );
              if (diagnostic !== null) recordFailure(diagnostic);
            }
          } catch (error) {
            // 单个实体失败不影响同一批次其他实体；其事务已由 fixture service 回滚。
            failed += 1;
            recordFailure(exceptionFailureDiagnostic(runningLog.sync_job_id, item, error));
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
          ...(failureDiagnostics.length > 0 ? {
            failure_diagnostics: failureDiagnostics,
            failure_diagnostics_omitted: failureDiagnosticsOmitted,
          } : {}),
        });
        return {
          kind: "completed",
          job_type: jobType,
          items_read: items.length,
          items_changed: changed,
          items_failed: failed,
          ...(failureDiagnostics.length > 0 ? {
            failure_diagnostics: failureDiagnostics,
            failure_diagnostics_omitted: failureDiagnosticsOmitted,
          } : {}),
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
    }
  }
}
