import { RankingBoard } from "../domain/enums.js";
import { cloudBaseCollectionName, type CloudBaseDb } from "../infrastructure/cloudbase-db.js";
import type { AuthSessionStore } from "../infrastructure/postgres-auth-sessions.js";
import { assertValidServerNow } from "./period-finalize.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const MAINTENANCE_CLEANUP_DEFAULTS = {
  authSessionsRetentionDays: 7,
  providerUsageShortRetentionDays: 7,
  providerUsageLongRetentionDays: 365,
  syncLogsRetentionDays: 60,
  providerSnapshotsRetentionDays: 60,
  boardSnapshotsKeepVersions: 24,
  deleteBatchSize: 1000,
  maxBatchesPerTarget: 500,
} as const;

export interface MaintenanceCleanupInput {
  db: CloudBaseDb;
  namespace: string;
  authSessions?: AuthSessionStore | null;
  batchSize?: number;
  maxBatchesPerTarget?: number;
  log?: (entry: Record<string, unknown>) => void;
  /** 每完成一批删除后回调，用于外层续租清理锁；抛错立即中止。 */
  onProgress?: () => Promise<void>;
}

export interface MaintenanceCleanupResult {
  ran_at: string;
  deleted: {
    auth_sessions: number;
    provider_usage: number;
    sync_logs: number;
    provider_snapshots: number;
    board_snapshots: number;
  };
  truncated: boolean;
}

interface DeleteBatchResult {
  deleted: number;
  truncated: boolean;
}

function subtractDays(date: Date, days: number): Date {
  return new Date(date.getTime() - days * DAY_MS);
}

function beforeFilter(
  db: CloudBaseDb,
  field: string,
  cutoff: Date,
): Record<string, unknown> | undefined {
  if (db.ltFilter !== undefined) {
    return db.ltFilter(field, cutoff);
  }
  if (db.lteFilter !== undefined) {
    return db.lteFilter(field, new Date(cutoff.getTime() - 1));
  }
  return undefined;
}

function parseTimestampMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "string" || typeof value === "number") {
    const ms = Date.parse(String(value));
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

const SNAPSHOT_BOARDS: readonly RankingBoard[] = [
  RankingBoard.Career,
  RankingBoard.Strength,
  RankingBoard.Season,
];

/**
 * 定期数据清理服务（Slice 5.4）：只清理过期会话、短期用量桶、历史运行日志与超量非终榜快照，
 * 绝不删除终榜（is_final=true）或任何核心业务账本（users/predictions/matches/settlements 等）。
 */
export class MaintenanceCleanupService {
  private readonly batchSize: number;
  private readonly maxBatchesPerTarget: number;
  private progressCallback: (() => Promise<void>) | undefined;

  constructor(private readonly input: MaintenanceCleanupInput) {
    const batchSize = input.batchSize ?? MAINTENANCE_CLEANUP_DEFAULTS.deleteBatchSize;
    const maxBatches = input.maxBatchesPerTarget ?? MAINTENANCE_CLEANUP_DEFAULTS.maxBatchesPerTarget;
    this.batchSize = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : MAINTENANCE_CLEANUP_DEFAULTS.deleteBatchSize;
    this.maxBatchesPerTarget = Number.isInteger(maxBatches) && maxBatches > 0 ? maxBatches : MAINTENANCE_CLEANUP_DEFAULTS.maxBatchesPerTarget;
  }

  private async deleteInBatches(
    db: CloudBaseDb,
    collection: string,
    filter: Record<string, unknown>,
  ): Promise<DeleteBatchResult> {
    if (db.deleteWhere === undefined) return { deleted: 0, truncated: false };
    let total = 0;
    for (let batch = 0; batch < this.maxBatchesPerTarget; batch += 1) {
      const removed = await db.deleteWhere(collection, filter, { limit: this.batchSize });
      total += removed;
      await this.progressCallback?.();
      if (removed < this.batchSize) return { deleted: total, truncated: false };
    }
    this.input.log?.({
      event: "maintenance_cleanup_batch_cap_reached",
      collection,
      batch_size: this.batchSize,
      max_batches_per_target: this.maxBatchesPerTarget,
      deleted_so_far: total,
    });
    return { deleted: total, truncated: true };
  }

  async run(
    serverNow: Date,
    onProgress?: () => Promise<void>,
  ): Promise<MaintenanceCleanupResult> {
    assertValidServerNow(serverNow);
    const { db, namespace, authSessions, log } = this.input;
    this.progressCallback = onProgress ?? this.input.onProgress;

    let truncated = false;
    let authSessionsDeleted = 0;
    if (authSessions?.deleteExpiredBefore !== undefined) {
      const authCutoff = subtractDays(
        serverNow,
        MAINTENANCE_CLEANUP_DEFAULTS.authSessionsRetentionDays,
      );
      for (let batch = 0; batch < this.maxBatchesPerTarget; batch += 1) {
        const removed = await authSessions.deleteExpiredBefore(authCutoff, {
          limit: this.batchSize,
        });
        authSessionsDeleted += removed;
        await this.progressCallback?.();
        if (removed < this.batchSize) break;
        if (batch === this.maxBatchesPerTarget - 1) truncated = true;
      }
    }

    let providerUsageDeleted = 0;
    let syncLogsDeleted = 0;
    let providerSnapshotsDeleted = 0;
    let boardSnapshotsDeleted = 0;

    if (db.deleteWhere !== undefined) {
      const usage = await this.cleanupProviderUsage(db, namespace, serverNow);
      providerUsageDeleted = usage.deleted;
      truncated = truncated || usage.truncated;
      const logs = await this.cleanupCollectionBefore(
        db,
        namespace,
        "sync_logs",
        "started_at",
        subtractDays(serverNow, MAINTENANCE_CLEANUP_DEFAULTS.syncLogsRetentionDays),
      );
      syncLogsDeleted = logs.deleted;
      truncated = truncated || logs.truncated;
      const snapshots = await this.cleanupCollectionBefore(
        db,
        namespace,
        "provider_snapshots",
        "created_at",
        subtractDays(serverNow, MAINTENANCE_CLEANUP_DEFAULTS.providerSnapshotsRetentionDays),
      );
      providerSnapshotsDeleted = snapshots.deleted;
      truncated = truncated || snapshots.truncated;
      const boards = await this.cleanupBoardSnapshots(db, namespace);
      boardSnapshotsDeleted = boards.deleted;
      truncated = truncated || boards.truncated;
    }

    const result: MaintenanceCleanupResult = {
      ran_at: serverNow.toISOString(),
      deleted: {
        auth_sessions: authSessionsDeleted,
        provider_usage: providerUsageDeleted,
        sync_logs: syncLogsDeleted,
        provider_snapshots: providerSnapshotsDeleted,
        board_snapshots: boardSnapshotsDeleted,
      },
      truncated,
    };
    log?.({ event: "maintenance_cleanup", ...result });
    return result;
  }

  private async cleanupCollectionBefore(
    db: CloudBaseDb,
    namespace: string,
    logicalCollection: string,
    dateField: string,
    cutoff: Date,
  ): Promise<DeleteBatchResult> {
    if (db.deleteWhere === undefined) return { deleted: 0, truncated: false };
    const range = beforeFilter(db, dateField, cutoff);
    if (range === undefined) return { deleted: 0, truncated: false };
    return this.deleteInBatches(db, cloudBaseCollectionName(namespace, logicalCollection), range);
  }

  private async cleanupProviderUsage(
    db: CloudBaseDb,
    namespace: string,
    serverNow: Date,
  ): Promise<DeleteBatchResult> {
    if (db.deleteWhere === undefined) return { deleted: 0, truncated: false };
    const table = cloudBaseCollectionName(namespace, "provider_usage");
    let deleted = 0;
    let truncated = false;

    const groups: Array<{ bucketTypes: readonly string[]; cutoff: Date }> = [
      {
        bucketTypes: ["minute", "hour"],
        cutoff: subtractDays(serverNow, MAINTENANCE_CLEANUP_DEFAULTS.providerUsageShortRetentionDays),
      },
      {
        bucketTypes: ["day", "month"],
        cutoff: subtractDays(serverNow, MAINTENANCE_CLEANUP_DEFAULTS.providerUsageLongRetentionDays),
      },
    ];

    for (const group of groups) {
      const range = beforeFilter(db, "bucket_start", group.cutoff);
      if (range === undefined) continue;
      const inClause = db.inFilter?.("bucket_type", group.bucketTypes);
      if (inClause !== undefined) {
        const result = await this.deleteInBatches(db, table, { ...inClause, ...range });
        deleted += result.deleted;
        truncated = truncated || result.truncated;
        continue;
      }
      for (const bucketType of group.bucketTypes) {
        const result = await this.deleteInBatches(db, table, { bucket_type: bucketType, ...range });
        deleted += result.deleted;
        truncated = truncated || result.truncated;
      }
    }

    return { deleted, truncated };
  }

  private async cleanupBoardSnapshots(
    db: CloudBaseDb,
    namespace: string,
  ): Promise<DeleteBatchResult> {
    if (db.deleteWhere === undefined) return { deleted: 0, truncated: false };
    const table = cloudBaseCollectionName(namespace, "board_snapshots");
    const keepVersions = MAINTENANCE_CLEANUP_DEFAULTS.boardSnapshotsKeepVersions;
    let deleted = 0;
    let truncated = false;

    for (const board of SNAPSHOT_BOARDS) {
      if (board === RankingBoard.Season) {
        const rows = db.distinctQuery !== undefined
          ? await db.distinctQuery(table, ["level_season_id", "snapshot_at"], {
            board,
            is_final: false,
          })
          : await db.query(
              table,
              { board, is_final: false },
              { order_by: "snapshot_at", direction: "desc" },
            );
        const bySeason = new Map<string, Set<number>>();
        for (const row of rows) {
          const seasonId = typeof row.level_season_id === "string" ? row.level_season_id : "";
          if (seasonId.length === 0) continue;
          const ms = parseTimestampMs(row.snapshot_at);
          if (ms === null) continue;
          const versions = bySeason.get(seasonId) ?? new Set<number>();
          versions.add(ms);
          bySeason.set(seasonId, versions);
        }
        for (const [seasonId, distinctMs] of bySeason) {
          // 各赛季（含未出终榜的活跃/上赛季）独立保留最近 keepVersions 份常规快照；
          // findLatestBySeason 与 available_level_seasons 只依赖最新快照，滚动裁剪不会删空。
          if (distinctMs.size <= keepVersions) continue;
          const sortedDesc = [...distinctMs].sort((a, b) => b - a);
          const keepBoundaryMs = sortedDesc[keepVersions - 1];
          if (keepBoundaryMs === undefined) continue;
          const range = beforeFilter(db, "snapshot_at", new Date(keepBoundaryMs));
          if (range === undefined) continue;
          const result = await this.deleteInBatches(db, table, {
            board,
            is_final: false,
            level_season_id: seasonId,
            ...range,
          });
          deleted += result.deleted;
          truncated = truncated || result.truncated;
        }
        continue;
      }

      const rows = db.distinctQuery !== undefined
        ? await db.distinctQuery(table, ["snapshot_at"], { board, is_final: false })
        : await db.query(
            table,
            { board, is_final: false },
            { order_by: "snapshot_at", direction: "desc" },
          );
      const distinctMs = new Set<number>();
      for (const row of rows) {
        const ms = parseTimestampMs(row.snapshot_at);
        if (ms !== null) distinctMs.add(ms);
      }
      if (distinctMs.size <= keepVersions) continue;
      const sortedDesc = [...distinctMs].sort((a, b) => b - a);
      const keepBoundaryMs = sortedDesc[keepVersions - 1];
      if (keepBoundaryMs === undefined) continue;
      const range = beforeFilter(db, "snapshot_at", new Date(keepBoundaryMs));
      if (range === undefined) continue;
      const result = await this.deleteInBatches(db, table, {
        board,
        is_final: false,
        ...range,
      });
      deleted += result.deleted;
      truncated = truncated || result.truncated;
    }

    return { deleted, truncated };
  }
}
