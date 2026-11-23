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
} as const;

export interface MaintenanceCleanupInput {
  db: CloudBaseDb;
  namespace: string;
  authSessions?: AuthSessionStore | null;
  log?: (entry: Record<string, unknown>) => void;
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
  constructor(private readonly input: MaintenanceCleanupInput) {}

  async run(serverNow: Date): Promise<MaintenanceCleanupResult> {
    assertValidServerNow(serverNow);
    const { db, namespace, authSessions, log } = this.input;

    let authSessionsDeleted = 0;
    if (authSessions?.deleteExpiredBefore !== undefined) {
      const authCutoff = subtractDays(
        serverNow,
        MAINTENANCE_CLEANUP_DEFAULTS.authSessionsRetentionDays,
      );
      authSessionsDeleted = await authSessions.deleteExpiredBefore(authCutoff);
    }

    let providerUsageDeleted = 0;
    let syncLogsDeleted = 0;
    let providerSnapshotsDeleted = 0;
    let boardSnapshotsDeleted = 0;

    if (db.deleteWhere !== undefined) {
      providerUsageDeleted = await this.cleanupProviderUsage(db, namespace, serverNow);
      syncLogsDeleted = await this.cleanupCollectionBefore(
        db,
        namespace,
        "sync_logs",
        "started_at",
        subtractDays(serverNow, MAINTENANCE_CLEANUP_DEFAULTS.syncLogsRetentionDays),
      );
      providerSnapshotsDeleted = await this.cleanupCollectionBefore(
        db,
        namespace,
        "provider_snapshots",
        "created_at",
        subtractDays(serverNow, MAINTENANCE_CLEANUP_DEFAULTS.providerSnapshotsRetentionDays),
      );
      boardSnapshotsDeleted = await this.cleanupBoardSnapshots(db, namespace);
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
  ): Promise<number> {
    if (db.deleteWhere === undefined) return 0;
    const range = beforeFilter(db, dateField, cutoff);
    if (range === undefined) return 0;
    return db.deleteWhere(cloudBaseCollectionName(namespace, logicalCollection), range);
  }

  private async cleanupProviderUsage(
    db: CloudBaseDb,
    namespace: string,
    serverNow: Date,
  ): Promise<number> {
    if (db.deleteWhere === undefined) return 0;
    const table = cloudBaseCollectionName(namespace, "provider_usage");
    let deleted = 0;

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
        deleted += await db.deleteWhere(table, { ...inClause, ...range });
        continue;
      }
      for (const bucketType of group.bucketTypes) {
        deleted += await db.deleteWhere(table, { bucket_type: bucketType, ...range });
      }
    }

    return deleted;
  }

  private async cleanupBoardSnapshots(
    db: CloudBaseDb,
    namespace: string,
  ): Promise<number> {
    if (db.deleteWhere === undefined) return 0;
    const table = cloudBaseCollectionName(namespace, "board_snapshots");
    const keepVersions = MAINTENANCE_CLEANUP_DEFAULTS.boardSnapshotsKeepVersions;
    let deleted = 0;

    for (const board of SNAPSHOT_BOARDS) {
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
      deleted += await db.deleteWhere(table, {
        board,
        is_final: false,
        ...range,
      });
    }

    return deleted;
  }
}
