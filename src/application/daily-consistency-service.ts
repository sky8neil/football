import { FIXED_CONFIG_V1 } from "../domain/config.js";
import {
  AnomalyStatus,
  AnomalyType,
  SCHEMA_VERSION,
  SyncJobStatus,
  SyncJobType,
} from "../domain/enums.js";
import { DomainError, internalError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import type { AppRepository, SyncLogRepository } from "../infrastructure/repositories.js";
import type { Anomaly, SyncLog } from "../domain/types.js";
import {
  checkDailyConsistency,
  type DailyConsistencyInput,
  type DailyConsistencyResult,
} from "./daily-consistency.js";
import { assertValidServerNow } from "./period-finalize.js";

export const DAILY_CONSISTENCY_LOCK_KEY = "sync:daily_consistency";
export const DAILY_CONSISTENCY_MISMATCH_CODE = "DAILY_CONSISTENCY_MISMATCH";
export const DAILY_CONSISTENCY_ANOMALY_MATCH_ID =
  "00000000-0000-4000-8000-000000000001";
export const DAILY_CONSISTENCY_ANOMALY_DETAIL_LIMIT = 20;
const DAILY_CONSISTENCY_LEASE_MILLISECONDS =
  FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000;

export interface DailyConsistencySnapshotSource {
  load(
    serverNow: Date,
    firstEvalAsOf?: Date | null,
    assertHealthy?: () => void,
  ): Promise<DailyConsistencyInput>;
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
    private readonly repo: Pick<AppRepository, "jobLocks" | "syncLogs" | "anomalies">,
    private readonly source: DailyConsistencySnapshotSource,
    private readonly firstEvalAsOf?: Date | null,
  ) {}

  /** D-S4-06：差异同步写非阻塞 anomalies；恢复干净时自动收敛同一条告警。 */
  private async persistMismatchAnomaly(
    result: DailyConsistencyResult,
    checkedAt: Date,
  ): Promise<void> {
    const anomalies = this.repo.anomalies;
    if (anomalies === undefined) {
      return;
    }
    const anomalyKey =
      `${DAILY_CONSISTENCY_ANOMALY_MATCH_ID}:${AnomalyType.DailyConsistencyMismatch}`;
    const existing = await anomalies.findByKey(anomalyKey);
    if (result.differences.length === 0) {
      if (existing === null || existing.status === AnomalyStatus.Resolved) {
        return;
      }
      await anomalies.update({
        ...existing,
        status: AnomalyStatus.Resolved,
        last_seen_at: checkedAt,
        resolved_at: checkedAt,
        resolution: "daily_consistency_clean",
      });
      return;
    }

    const details: Record<string, unknown> = {
      checked_at: checkedAt.toISOString(),
      difference_count: result.differences.length,
      truncated: result.differences.length > DAILY_CONSISTENCY_ANOMALY_DETAIL_LIMIT,
      differences: result.differences.slice(0, DAILY_CONSISTENCY_ANOMALY_DETAIL_LIMIT),
      skipped_active_settlement_count: result.skipped_active_settlement.length,
    };
    if (existing === null) {
      const created: Anomaly = {
        schema_version: SCHEMA_VERSION,
        anomaly_id: newUuid(),
        anomaly_key: anomalyKey,
        match_id: DAILY_CONSISTENCY_ANOMALY_MATCH_ID,
        type: AnomalyType.DailyConsistencyMismatch,
        blocking: false,
        status: AnomalyStatus.Open,
        first_seen_at: checkedAt,
        last_seen_at: checkedAt,
        occurrence_count: 1,
        details,
        resolved_at: null,
        resolution: null,
      };
      await anomalies.insert(created);
      return;
    }
    await anomalies.update({
      ...existing,
      blocking: false,
      status: AnomalyStatus.Open,
      last_seen_at: checkedAt,
      occurrence_count: existing.occurrence_count + 1,
      details,
      resolved_at: null,
      resolution: null,
    });
  }

  async run(serverNow: Date): Promise<DailyConsistencyRunOutcome> {
    assertValidServerNow(serverNow);
    const syncLogs = requireSyncLogs(this.repo);
    const ownerId = newUuid();
    const leaseUntil = new Date(
      Math.max(serverNow.getTime(), Date.now()) + DAILY_CONSISTENCY_LEASE_MILLISECONDS,
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
        const assertHealthy = () => lockRenewal.assertHealthy();
        const input = this.firstEvalAsOf === undefined
          ? await this.source.load(serverNow, undefined, assertHealthy)
          : await this.source.load(serverNow, this.firstEvalAsOf, assertHealthy);
        lockRenewal.assertHealthy();
        const result = checkDailyConsistency(input);
        lockRenewal.assertHealthy();
        await this.persistMismatchAnomaly(result, serverNow);
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
