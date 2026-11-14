import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { DomainError, internalError } from "../domain/errors.js";
import { SCHEMA_VERSION, SyncJobStatus, type SyncJobType } from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { SyncLog } from "../domain/types.js";
import {
  ProviderDataError,
  ProviderHttpError,
  ProviderError,
  ProviderRequestDeferredError,
} from "../provider/http.js";
import { ProviderBudgetDeferredError } from "../provider/budget.js";
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
  /** 窗口任务加载时记录的候选 match_id；用于限制跨源关联不落到窗口外比赛。 */
  candidateMatchIds?: readonly string[];
}

/**
 * 窗口加载阶段的可观察计数。字段名带 `window_`，表示这是窗口加载器按联赛查询后
 * 进入/被窗口过滤的条数；它不是 5d 全联赛共享原始响应总数，也不代表 HTTP 请求次数。
 */
export interface ProviderFixtureBatchWindowCounts {
  /** 进入窗口过滤阶段的条数（已按目标联赛筛选，未计入窗口过滤前的其他联赛行）。 */
  items_window_input?: number;
  /** 因已有映射、唯一候选不在活动窗口或主源缺少映射而被正常过滤的条数。 */
  items_window_filtered?: number;
}

export interface ProviderFixtureLoadResult extends ProviderFixtureBatchWindowCounts {
  items: readonly ProviderFixtureBatchItem[];
}

export type ProviderFixtureBatchLoader = (
  serverNow: Date,
) => Promise<readonly ProviderFixtureBatchItem[] | ProviderFixtureLoadResult>;

export interface ProviderFixtureSyncRetryOptions {
  /** @deprecated 已改为写 deferred 日志并返回，不再在函数内等待。 */
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
}

export interface ProviderFixtureSyncLockOptions {
  /** RP08：锁内二次资格确认的周期间隔；不传则不做二次确认（保持旧行为）。 */
  dueIntervalMs?: number;
  /** RP08-2：续租/围栏参数；生产用默认值，测试注入时钟与校验窗口。 */
  renewal?: JobLockRenewalOptions;
}

export interface ProviderFixtureFailureDiagnostic {
  sync_job_id: string;
  provider: string;
  provider_fixture_id: string | null;
  stage: "apply_fixture";
  outcome: "failed" | "conflict" | "unlinked" | "exception";
  error_code: string;
  error_name: string | null;
  error_message: string;
  reason_codes: string[];
  match_id: string | null;
}

const MAX_FAILURE_DIAGNOSTICS = 100;
const MAX_DIAGNOSTIC_TEXT_LENGTH = 240;
const PROVIDER_FIXTURE_FAILED = "PROVIDER_FIXTURE_FAILED";

export type ProviderFixtureSyncJobOutcome =
  | {
      kind: "completed";
      job_type: SyncJobType;
      items_read: number;
      items_changed: number;
      items_failed: number;
      items_window_input?: number;
      items_window_filtered?: number;
      failure_diagnostics?: ProviderFixtureFailureDiagnostic[];
      failure_diagnostics_omitted?: number;
    }
  | {
      kind: "skipped";
      job_type: SyncJobType;
      reason: "lock_held" | "not_due_after_lock";
    }
  | {
      kind: "deferred";
      job_type: SyncJobType;
      next_attempt_at: Date;
      retry_attempt: number;
      last_error_code: string | null;
      items_read?: number;
      items_changed?: number;
      items_failed?: number;
      items_window_input?: number;
      items_window_filtered?: number;
      failure_diagnostics?: ProviderFixtureFailureDiagnostic[];
      failure_diagnostics_omitted?: number;
    }
  | {
      kind: "failed";
      job_type: SyncJobType;
      items_read: number;
      items_changed: number;
      items_failed: number;
      items_window_input?: number;
      items_window_filtered?: number;
      last_error_code: string;
      last_error_message: string;
      failure_diagnostics?: ProviderFixtureFailureDiagnostic[];
      failure_diagnostics_omitted?: number;
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
    return [
      ...(outcome.reason_codes ?? []).map((value) => safeDiagnosticText(value, 120)),
      ...outcome.anomaly_types.map((value) => safeDiagnosticText(value, 80)),
    ];
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
  if (outcome.kind === "unlinked") {
    return {
      ...diagnosticBase(syncJobId, item),
      outcome: "unlinked",
      error_code: outcome.reason === "ambiguous" ? "AMBIGUOUS" : "UNLINKED",
      error_name: null,
      error_message: `fixture sync returned unlinked (${outcome.reason})`,
      reason_codes: [outcome.reason],
      match_id: null,
    };
  }
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

function isFixtureLoadResult(
  value: readonly ProviderFixtureBatchItem[] | ProviderFixtureLoadResult,
): value is ProviderFixtureLoadResult {
  return !Array.isArray(value);
}

function normalizeLoadedBatch(
  loaded: readonly ProviderFixtureBatchItem[] | ProviderFixtureLoadResult,
): {
  items: readonly ProviderFixtureBatchItem[];
  windowCounts: ProviderFixtureBatchWindowCounts;
} {
  if (!isFixtureLoadResult(loaded)) return { items: loaded, windowCounts: {} };
  const windowCounts: ProviderFixtureBatchWindowCounts = {};
  if (loaded.items_window_input !== undefined) {
    windowCounts.items_window_input = loaded.items_window_input;
  }
  if (loaded.items_window_filtered !== undefined) {
    windowCounts.items_window_filtered = loaded.items_window_filtered;
  }
  return { items: loaded.items, windowCounts };
}

function isRetryableLoaderError(error: unknown): boolean {
  if (error instanceof ProviderBudgetDeferredError || error instanceof ProviderRequestDeferredError) {
    return true;
  }
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

function nextRetryAt(error: unknown, serverNow: Date, delayMs: number): Date {
  const backoffAt = new Date(serverNow.getTime() + delayMs);
  if (!(error instanceof ProviderBudgetDeferredError) && !(error instanceof ProviderRequestDeferredError)) {
    return backoffAt;
  }
  const resetAt = error.retry_at;
  return resetAt.getTime() > backoffAt.getTime() ? resetAt : backoffAt;
}

export interface JobLockRenewalOptions {
  /** 墙钟，默认 Date.now；测试注入。 */
  now?: () => number;
  leaseMs?: number;
  /**
   * 「所有权仍在」结论的复用窗口，默认 leaseMs/2。窗口内 assertHeld 只查内存标志，
   * 不回查 job_locks，避免逐条 fixture 多一次读；0 表示每次都回查（测试用）。
   */
  proofTtlMs?: number;
}

export function startJobLockRenewal(
  repo: Pick<AppRepository, "jobLocks">,
  lockKey: string,
  ownerId: string,
  options: JobLockRenewalOptions = {},
): {
  /** 同步：内存里已记录的续租失败，立即抛。 */
  assertHealthy: () => void;
  /** 异步围栏：确认数据库里锁仍属于自己；失败或不持有都抛。 */
  assertHeld: () => Promise<void>;
  stop: () => void;
} {
  let renewalFailure: DomainError | undefined;
  let inFlight = false;
  let stopped = false;
  const clock = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60_000;
  /**
   * 最近一次「所有权已证实」的时间点。acquire 成功即视为已证实；此后每次成功续租
   * 也是一次证实（renew 只对 owner 生效）。窗口内不必逐条回查数据库，避免为了围栏
   * 把每处理一条 fixture 就多读一次 job_locks。
   */
  let lastProvenAtMs = clock();
  const proofTtlMs = options.proofTtlMs ?? leaseMs / 2;
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = true;
    void Promise.resolve()
      .then(() =>
        repo.jobLocks.renew(
          lockKey,
          ownerId,
          new Date(clock() + leaseMs),
        ),
      )
      .then((renewed) => {
        if (stopped) return;
        if (!renewed) {
          renewalFailure ??= internalError("Provider 同步锁续租失败");
          clearInterval(timer);
          return;
        }
        lastProvenAtMs = clock();
      }, () => {
        if (stopped) return;
        renewalFailure ??= internalError("Provider 同步锁续租失败");
        clearInterval(timer);
      })
      .finally(() => {
        inFlight = false;
      });
  }, leaseMs / 2);

  const assertHealthy = () => {
    if (renewalFailure !== undefined) {
      throw renewalFailure;
    }
  };

  return {
    assertHealthy,
    assertHeld: async () => {
      assertHealthy();
      if (clock() - lastProvenAtMs < proofTtlMs) return;
      const held = await repo.jobLocks.isHeldBy(lockKey, ownerId, new Date(clock()));
      if (!held) {
        throw new DomainError(
          "PROVIDER_SYNC_LEASE_LOST",
          "Provider 同步锁已失效，停止写入",
        );
      }
      lastProvenAtMs = clock();
    },
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * 执行一个注入 fixture 批次。Provider client / scheduler 在边界外提供 loader；本服务不
 * 连接外部网络，只协调既有单 fixture 同步、lease 和 sync_logs。
 */
export class ProviderFixtureSyncJobService {
  private readonly random: () => number;
  private readonly lockOptions: ProviderFixtureSyncLockOptions;

  constructor(
    private readonly repo: Pick<AppRepository, "jobLocks" | "syncLogs">,
    private readonly fixtureSync: Pick<ProviderFixtureSyncService, "applyFixture">,
    retryOptions: ProviderFixtureSyncRetryOptions = {},
    lockOptions: ProviderFixtureSyncLockOptions = {},
  ) {
    this.random = retryOptions.random ?? Math.random;
    this.lockOptions = lockOptions;
  }

  /** RP08 锁内二次资格确认：锁前判断可能已过期（拿到锁时上一实例刚跑完），这里再核一次。 */
  private async isStillDue(
    jobType: SyncJobType,
    serverNow: Date,
    dueIntervalMs: number,
    leagueId?: string,
  ): Promise<boolean> {
    const latest = await this.repo.syncLogs?.findLatestByJobType?.(
      jobType,
      leagueId === undefined ? undefined : { leagueId },
    );
    if (!latest) return true;
    const startedAt = latest.started_at as Date | string;
    const startedMs = startedAt instanceof Date
      ? startedAt.getTime()
      : typeof startedAt === "string" ? Date.parse(startedAt) : Number.NaN;
    if (!Number.isFinite(startedMs)) return true;
    if (latest.status === "deferred") {
      const nextAttemptAt = latest.next_attempt_at as Date | string | null | undefined;
      const nextAtMs = nextAttemptAt instanceof Date
        ? nextAttemptAt.getTime()
        : typeof nextAttemptAt === "string" ? Date.parse(nextAttemptAt) : Number.NaN;
      if (Number.isFinite(nextAtMs) && serverNow.getTime() < nextAtMs) return false;
      return true;
    }
    if (serverNow.getTime() - startedMs < dueIntervalMs) return false;
    return true;
  }

  /** RP07：跨轮累计重试序号。上一条 deferred 日志的 retry_attempt + 1；无则 0。 */
  private async priorRetryAttempt(
    jobType: SyncJobType,
    excludeSyncJobId: string,
    leagueId?: string,
  ): Promise<number> {
    const latest = await this.repo.syncLogs?.findLatestByJobType?.(jobType, {
      excludeSyncJobId,
      ...(leagueId === undefined ? {} : { leagueId }),
    });
    if (!latest || latest.status !== SyncJobStatus.Deferred) return 0;
    return (latest.retry_attempt ?? 0) + 1;
  }

  async run(
    jobType: SyncJobType,
    load: ProviderFixtureBatchLoader,
    serverNow: Date,
    leagueId?: string,
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
      // RP08：锁内二次资格确认在 executeHeldByCaller 内部完成，这里不重复查询。
      return await this.executeHeldByCaller(jobType, load, serverNow, ownerId, leagueId);
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
    leagueId?: string,
  ): Promise<ProviderFixtureSyncJobOutcome> {
    assertValidServerNow(serverNow);
    const dueIntervalMs = this.lockOptions.dueIntervalMs;
    if (dueIntervalMs !== undefined && !(await this.isStillDue(jobType, serverNow, dueIntervalMs, leagueId))) {
      return { kind: "skipped", job_type: jobType, reason: "not_due_after_lock" };
    }
    const syncLogs = requireSyncLogs(this.repo);
    const lockKey = jobLockKey(jobType);

    const runningLog: SyncLog = {
      schema_version: SCHEMA_VERSION,
      sync_job_id: newUuid(),
      job_type: jobType,
      ...(leagueId === undefined ? {} : { league_id: leagueId }),
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

    const lockRenewal = startJobLockRenewal(this.repo, lockKey, ownerId, this.lockOptions.renewal);
    try {
      await lockRenewal.assertHeld();
      await syncLogs.insert(runningLog);
      let attemptCount = 0;
      try {
        let items: readonly ProviderFixtureBatchItem[];
        let windowCounts: ProviderFixtureBatchWindowCounts = {};
        while (true) {
          await lockRenewal.assertHeld();
          attemptCount += 1;
          try {
            const normalized = normalizeLoadedBatch(await load(serverNow));
            items = normalized.items;
            windowCounts = normalized.windowCounts;
            break;
          } catch (error) {
            if (!isRetryableLoaderError(error)) throw error;
            const retryAttempt = await this.priorRetryAttempt(jobType, runningLog.sync_job_id, leagueId);
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
            const nextAttemptAt = nextRetryAt(error, serverNow, delayMs);
            await lockRenewal.assertHeld();
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
          await lockRenewal.assertHeld();
          try {
            const outcome = await this.fixtureSync.applyFixture(
              item.fixture,
              item.payload,
              serverNow,
              item.candidateMatchIds === undefined
                ? undefined
                : new Set(item.candidateMatchIds),
            );
            if (isChanged(outcome)) {
              changed += 1;
            }
            if (isFailed(outcome)) {
              failed += 1;
            }
            const diagnostic = outcomeFailureDiagnostic(
              runningLog.sync_job_id,
              item,
              outcome,
            );
            if (diagnostic !== null) recordFailure(diagnostic);
          } catch (error) {
            // 单个实体失败不影响同一批次其他实体；其事务已由 fixture service 回滚。
            failed += 1;
            recordFailure(exceptionFailureDiagnostic(runningLog.sync_job_id, item, error));
          }
        }

        await lockRenewal.assertHeld();
        const failureOutput = failureDiagnostics.length > 0 ? {
          failure_diagnostics: failureDiagnostics,
          failure_diagnostics_omitted: failureDiagnosticsOmitted,
        } : {};
        if (failed > 0) {
          const retryAttempt = await this.priorRetryAttempt(
            jobType,
            runningLog.sync_job_id,
            leagueId,
          );
          const delayMinutes = nextRetryDelayMinutes(retryAttempt);
          const failureMessage = `provider fixture sync failed for ${failed}/${items.length} item(s)`;
          const failureOutcome = {
            items_read: items.length,
            items_changed: changed,
            items_failed: failed,
            ...windowCounts,
            last_error_code: PROVIDER_FIXTURE_FAILED,
            last_error_message: failureMessage,
            ...failureOutput,
          };
          const failureFields = { attempt_count: attemptCount, finished_at: serverNow, ...failureOutcome };
          if (delayMinutes === null) {
            await syncLogs.update({ ...runningLog, ...failureFields, status: SyncJobStatus.Failed });
            return { kind: "failed", job_type: jobType, ...failureOutcome };
          }
          const delayMs = applyJitter(
            delayMinutes * 60_000,
            SYNC_RETRY_V1.jitterPercent,
            this.random,
          );
          const nextAttemptAt = new Date(serverNow.getTime() + delayMs);
          await syncLogs.update({
            ...runningLog,
            ...failureFields,
            status: SyncJobStatus.Deferred,
            retry_attempt: retryAttempt,
            next_attempt_at: nextAttemptAt,
          });
          return {
            kind: "deferred",
            job_type: jobType,
            next_attempt_at: nextAttemptAt,
            retry_attempt: retryAttempt,
            last_error_code: PROVIDER_FIXTURE_FAILED,
            items_read: items.length,
            items_changed: changed,
            items_failed: failed,
            ...windowCounts,
            ...failureOutput,
          };
        }
        await syncLogs.update({
          ...runningLog,
          status: SyncJobStatus.Success,
          attempt_count: attemptCount,
          finished_at: serverNow,
          items_read: items.length,
          items_changed: changed,
          items_failed: failed,
          ...windowCounts,
          ...failureOutput,
        });
        return {
          kind: "completed",
          job_type: jobType,
          items_read: items.length,
          items_changed: changed,
          items_failed: failed,
          ...windowCounts,
          ...failureOutput,
        };
      } catch (error) {
        const stillHeld = await lockRenewal.assertHeld().then(() => true, () => false);
        if (stillHeld) {
          await syncLogs.update({
            ...runningLog,
            status: SyncJobStatus.Failed,
            attempt_count: attemptCount,
            finished_at: serverNow,
            items_failed: 1,
            last_error_code: errorCode(error),
            last_error_message: errorMessage(error),
          });
        }
        throw error;
      }
    } finally {
      lockRenewal.stop();
    }
  }
}
