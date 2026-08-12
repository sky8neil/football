import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { SCHEMA_VERSION, SyncJobStatus, SyncJobType } from "../domain/enums.js";
import { DomainError, internalError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import type { AppRepository, SyncLogRepository } from "../infrastructure/repositories.js";
import type { SyncLog } from "../domain/types.js";
import {
  checkDailyConsistency,
  type DailyConsistencyInput,
  type DailyConsistencyResult,
} from "./daily-consistency.js";
import { assertValidServerNow } from "./period-finalize.js";

export const DAILY_CONSISTENCY_LOCK_KEY = "sync:daily_consistency";
export const DAILY_CONSISTENCY_MISMATCH_CODE = "DAILY_CONSISTENCY_MISMATCH";
const DAILY_CONSISTENCY_LEASE_MILLISECONDS =
  FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000;

export interface DailyConsistencySnapshotSource {
  load(serverNow: Date): Promise<DailyConsistencyInput>;
}

export type DailyConsistencyRunOutcome =
  | (DailyConsistencyResult & {
      kind: "completed";
      checked_at: Date;
    })
  | {
      kind: "skipped";
      checked_at: Date;
      reason: "lock_held";
  };

function errorCode(error: unknown): string {
  return error instanceof DomainError ? error.code : "INTERNAL_ERROR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "daily consistency failed";
}

function itemsRead(input: DailyConsistencyInput): number {
  return input.career.length + input.season_stats.length + input.rankings.length;
}

function mismatchSummary(result: DailyConsistencyResult): string | null {
  if (result.differences.length === 0) {
    return null;
  }
  return result.differences
    .map((difference) =>
      `${difference.scope}:${difference.key} [${difference.fields.join(",")}]`,
    )
    .join("; ");
}

function skippedActiveSettlementSummary(result: DailyConsistencyResult): string | null {
  if (result.skipped_active_settlement.length === 0) {
    return null;
  }
  return result.skipped_active_settlement
    .map((scope) => {
      const periods = scope.periods
        .map((period) => `${period.period_type}:${period.period_key}`)
        .join(",");
      return `${scope.kind}:${scope.match_id} [users:${scope.user_ids.join(",")};season:${scope.season_id};periods:${periods}]`;
    })
    .join("; ");
}

function consistencySummary(result: DailyConsistencyResult): string | null {
  const messages: string[] = [];
  const mismatch = mismatchSummary(result);
  if (mismatch !== null) {
    messages.push(mismatch);
  }
  const skipped = skippedActiveSettlementSummary(result);
  if (skipped !== null) {
    messages.push(skipped);
  }
  return messages.length === 0 ? null : messages.join("; ");
}

function requireSyncLogs(
  repo: Pick<AppRepository, "syncLogs">,
): SyncLogRepository {
  if (repo.syncLogs === undefined) {
    throw internalError("daily consistency 缺少 sync_logs repository port");
  }
  return repo.syncLogs;
}

interface DailyConsistencyLockRenewal {
  assertHealthy(): void;
  stop(): void;
}

function startLockRenewal(
  repo: Pick<AppRepository, "jobLocks">,
  ownerId: string,
): DailyConsistencyLockRenewal {
  let renewalFailure: DomainError | undefined;
  const timer = setInterval(() => {
    void Promise.resolve()
      .then(() =>
        repo.jobLocks.renew(
          DAILY_CONSISTENCY_LOCK_KEY,
          ownerId,
          new Date(Date.now() + DAILY_CONSISTENCY_LEASE_MILLISECONDS),
        ),
      )
      .then((renewed) => {
        if (!renewed) {
          renewalFailure ??= internalError("daily consistency 锁续租失败");
        }
      }, () => {
        renewalFailure ??= internalError("daily consistency 锁续租失败");
      });
  }, DAILY_CONSISTENCY_LEASE_MILLISECONDS / 2);

  return {
    assertHealthy: () => {
      if (renewalFailure !== undefined) {
        throw renewalFailure;
      }
    },
    stop: () => clearInterval(timer),
  };
}

/** 每日校验只读事实快照；发现差异由调用方报警，不在此处静默修复缓存。 */
export class DailyConsistencyService {
  constructor(
    private readonly repo: Pick<AppRepository, "jobLocks" | "syncLogs">,
    private readonly source: DailyConsistencySnapshotSource,
  ) {}

  async run(serverNow: Date): Promise<DailyConsistencyRunOutcome> {
    assertValidServerNow(serverNow);
    const syncLogs = requireSyncLogs(this.repo);
    const ownerId = newUuid();
    const leaseUntil = new Date(
      serverNow.getTime() + FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000,
    );
    const acquired = await this.repo.jobLocks.acquire(
      DAILY_CONSISTENCY_LOCK_KEY,
      ownerId,
      leaseUntil,
    );
    if (!acquired) {
      return {
        kind: "skipped",
        checked_at: serverNow,
        reason: "lock_held",
      };
    }

    const lockRenewal = startLockRenewal(this.repo, ownerId);
    try {
      const runningLog: SyncLog = {
        schema_version: SCHEMA_VERSION,
        sync_job_id: newUuid(),
        job_type: SyncJobType.DailyConsistency,
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
      await syncLogs.insert(runningLog);

      try {
        const input = await this.source.load(serverNow);
        lockRenewal.assertHealthy();
        const result = checkDailyConsistency(input);
        lockRenewal.assertHealthy();
        const mismatchMessage = mismatchSummary(result);
        const summaryMessage = consistencySummary(result);
        await syncLogs.update({
          ...runningLog,
          status: SyncJobStatus.Success,
          finished_at: serverNow,
          items_read: itemsRead(input),
          items_changed: result.differences.length,
          last_error_code:
            mismatchMessage === null ? null : DAILY_CONSISTENCY_MISMATCH_CODE,
          last_error_message: summaryMessage,
        });
        return {
          kind: "completed",
          checked_at: serverNow,
          ...result,
        };
      } catch (error) {
        await syncLogs.update({
          ...runningLog,
          status: SyncJobStatus.Failed,
          finished_at: serverNow,
          items_failed: 1,
          last_error_code: errorCode(error),
          last_error_message: errorMessage(error),
        });
        throw error;
      }
    } finally {
      lockRenewal.stop();
      await this.repo.jobLocks.release(DAILY_CONSISTENCY_LOCK_KEY, ownerId);
    }
  }
}
