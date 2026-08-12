import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { DomainError, internalError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import { periodEndAt } from "../domain/time.js";
import { PeriodType, SCHEMA_VERSION, SyncJobStatus, SyncJobType } from "../domain/enums.js";
import type { RankingEntry, SyncLog } from "../domain/types.js";
import type { AppRepository, SyncLogRepository, UnitOfWork } from "../infrastructure/repositories.js";
import { assertValidServerNow, finalizeRankingEntry } from "./period-finalize.js";

const PERIOD_FINALIZE_LOCK_KEY = "sync:period_finalize";

export interface PeriodFinalizeOutcome {
  period_type: PeriodType;
  period_key: string;
  due: boolean;
  skipped: boolean;
  finalized_count: number;
  skipped_count: number;
}

function assertRankingPort(tx: UnitOfWork): asserts tx is UnitOfWork & { rankings: NonNullable<UnitOfWork["rankings"]> } {
  if (tx.rankings === undefined) {
    throw internalError("rankings repository port 未配置");
  }
}

function requireSyncLogs(
  repo: Pick<AppRepository, "syncLogs">,
): SyncLogRepository {
  if (repo.syncLogs === undefined) {
    throw internalError("period_finalize 缺少 sync_logs repository port");
  }
  return repo.syncLogs;
}

function errorCode(error: unknown): string {
  return error instanceof DomainError ? error.code : "INTERNAL_ERROR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "period finalize failed";
}

/**
 * 封存一个已知周期。周期枚举/边界仍由 domain time 统一校验，写入只发生在事务内。
 * 调度器负责按小时枚举需要处理的周期；锁保证同一 period_finalize job 不并发。
 */
export class PeriodFinalizeService {
  constructor(private readonly repo: AppRepository) {}

  async finalize(
    periodType: PeriodType,
    periodKey: string,
    serverNow: Date,
  ): Promise<PeriodFinalizeOutcome> {
    assertValidServerNow(serverNow);
    const endAt = periodEndAt(periodType, periodKey);
    if (serverNow.getTime() < endAt.getTime()) {
      return {
        period_type: periodType,
        period_key: periodKey,
        due: false,
        skipped: false,
        finalized_count: 0,
        skipped_count: 0,
      };
    }

    assertRankingPort(this.repo);
    const syncLogs = requireSyncLogs(this.repo);

    const ownerId = newUuid();
    const leaseUntil = new Date(
      serverNow.getTime() + FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60_000,
    );
    const acquired = await this.repo.jobLocks.acquire(
      PERIOD_FINALIZE_LOCK_KEY,
      ownerId,
      leaseUntil,
    );
    if (!acquired) {
      return {
        period_type: periodType,
        period_key: periodKey,
        due: true,
        skipped: true,
        finalized_count: 0,
        skipped_count: 0,
      };
    }

    try {
      const runningLog: SyncLog = {
        schema_version: SCHEMA_VERSION,
        sync_job_id: newUuid(),
        job_type: SyncJobType.PeriodFinalize,
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

      let itemsRead = 0;
      try {
        const outcome = await this.repo.withTransaction(async (tx) => {
          assertRankingPort(tx);
          const entries = await tx.rankings.findByPeriod(periodType, periodKey);
          itemsRead = entries.length;
          let finalizedCount = 0;
          let skippedCount = 0;

          for (const entry of entries) {
            const finalized = finalizeRankingEntry(entry, serverNow);
            if (finalized === entry) {
              skippedCount += 1;
              continue;
            }
            await tx.rankings.update(finalized);
            finalizedCount += 1;
          }

          return {
            period_type: periodType,
            period_key: periodKey,
            due: true,
            skipped: false,
            finalized_count: finalizedCount,
            skipped_count: skippedCount,
          };
        });
        await syncLogs.update({
          ...runningLog,
          status: SyncJobStatus.Success,
          finished_at: serverNow,
          items_read: itemsRead,
          items_changed: outcome.finalized_count,
        });
        return outcome;
      } catch (error) {
        await syncLogs.update({
          ...runningLog,
          status: SyncJobStatus.Failed,
          finished_at: serverNow,
          items_read: itemsRead,
          items_failed: 1,
          last_error_code: errorCode(error),
          last_error_message: errorMessage(error),
        });
        throw error;
      }
    } finally {
      await this.repo.jobLocks.release(PERIOD_FINALIZE_LOCK_KEY, ownerId);
    }
  }
}

export { PERIOD_FINALIZE_LOCK_KEY };
