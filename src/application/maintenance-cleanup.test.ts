import { describe, expect, it, vi } from "vitest";
import { RankingBoard } from "../domain/enums.js";
import { cloudBaseCollectionName, type CloudBaseDb, type CloudBaseDocument } from "../infrastructure/cloudbase-db.js";
import { createCountingDb } from "../infrastructure/db-op-counter.js";
import type { AuthSessionStore } from "../infrastructure/postgres-auth-sessions.js";
import {
  MAINTENANCE_CLEANUP_DEFAULTS,
  MaintenanceCleanupService,
} from "./maintenance-cleanup.js";

const NS = "ft";
const NOW = new Date("2026-10-01T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

interface StoredRow extends CloudBaseDocument {
  [key: string]: unknown;
}

function makeCleanupFakeDb(initial: Record<string, StoredRow[]>) {
  const store = new Map<string, StoredRow[]>(
    Object.entries(initial).map(([logical, rows]) => [
      cloudBaseCollectionName(NS, logical),
      rows.map((r) => ({ ...r })),
    ]),
  );

  const matches = (row: StoredRow, filter: Record<string, unknown>): boolean => {
    for (const [field, cond] of Object.entries(filter)) {
      const value = row[field];
      if (cond !== null && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date)) {
        const op = cond as { __lt?: Date; __in?: readonly string[] };
        if (op.__lt !== undefined) {
          const rowMs = value instanceof Date ? value.getTime() : Date.parse(String(value));
          if (!(rowMs < op.__lt.getTime())) return false;
        }
        if (op.__in !== undefined) {
          if (!op.__in.includes(String(value))) return false;
        }
      } else if (value !== cond) {
        return false;
      }
    }
    return true;
  };

  const db: CloudBaseDb = {
    get: async (col, id) => store.get(col)?.find((r) => r._id === id) ?? null,
    add: async (col, id, doc) => {
      const list = store.get(col) ?? [];
      list.push({ ...doc, _id: id });
      store.set(col, list);
    },
    update: async () => undefined,
    query: async (col, filter = {}) =>
      (store.get(col) ?? []).filter((r) => matches(r, filter)),
    count: async (col, filter = {}) =>
      (store.get(col) ?? []).filter((r) => matches(r, filter)).length,
    distinctQuery: async (col, fields, filter = {}) => {
      const rows = (store.get(col) ?? []).filter((r) => matches(r, filter));
      const seen = new Set<string>();
      const out: Record<string, string>[] = [];
      for (const row of rows) {
        const rec: Record<string, string> = {};
        for (const f of fields) {
          const val = row[f];
          rec[f] = val instanceof Date ? val.toISOString() : String(val ?? "");
        }
        const key = JSON.stringify(rec);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(rec);
        }
      }
      return out;
    },
    inFilter: (field, values) => ({ [field]: { __in: values } }),
    ltFilter: (field, value) => ({ [field]: { __lt: value } }),
    deleteWhere: async (col, filter, options) => {
      const list = store.get(col) ?? [];
      const limit = options?.limit ?? Number.POSITIVE_INFINITY;
      const kept: StoredRow[] = [];
      let deleted = 0;
      for (const row of list) {
        if (deleted < limit && matches(row, filter)) {
          deleted += 1;
        } else {
          kept.push(row);
        }
      }
      store.set(col, kept);
      return deleted;
    },
    transaction: async (work) => work(db),
  };

  return { db, store };
}

describe("MaintenanceCleanupService [Slice 5.4]", () => {
  it("cleans expired sessions, old usage/logs/snapshots and excess non-final board snapshots while preserving final boards and core ledger", async () => {
    const d = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY_MS);

    const boardRows: StoredRow[] = [];
    // 26 non-final career snapshots across 2 users (52 rows); latest 24 timestamps must stay.
    for (let i = 0; i < 26; i += 1) {
      const snapAt = new Date(NOW.getTime() - i * 60 * 60_000);
      boardRows.push(
        { _id: `c-${i}-u1`, board: RankingBoard.Career, is_final: false, snapshot_at: snapAt, user_id: "u1" },
        { _id: `c-${i}-u2`, board: RankingBoard.Career, is_final: false, snapshot_at: snapAt, user_id: "u2" },
      );
    }
    // Old final season snapshot must NEVER be deleted regardless of age.
    boardRows.push({
      _id: "final-2024",
      board: RankingBoard.Season,
      is_final: true,
      snapshot_at: d(400),
      user_id: "u1",
    });

    const { db, store } = makeCleanupFakeDb({
      provider_usage: [
        { _id: "u-min-old", bucket_type: "minute", bucket_start: d(8) },
        { _id: "u-hr-old", bucket_type: "hour", bucket_start: d(7.1) },
        { _id: "u-min-new", bucket_type: "minute", bucket_start: d(2) },
        { _id: "u-day-100d", bucket_type: "day", bucket_start: d(100) },
        { _id: "u-day-400d", bucket_type: "day", bucket_start: d(400) },
      ],
      sync_logs: [
        { _id: "sl-old", started_at: d(61) },
        { _id: "sl-new", started_at: d(10) },
      ],
      provider_snapshots: [
        { _id: "ps-old", created_at: d(65) },
        { _id: "ps-new", created_at: d(59) },
      ],
      board_snapshots: boardRows,
      users: [{ _id: "u1", career_points: 100 }],
      settlement_items: [{ _id: "si1", status: "applied", applied_at: d(500) }],
    });

    const authSessions: AuthSessionStore = {
      create: vi.fn(),
      findActiveByToken: vi.fn(),
      deleteByOpenid: vi.fn(async () => 0),
      deleteExpiredBefore: vi.fn(async () => 4),
    };
    const counted = createCountingDb(db);
    const log = vi.fn();

    const service = new MaintenanceCleanupService({
      db: counted.db,
      namespace: NS,
      authSessions,
      log,
    });

    counted.counter.begin();
    const result = await service.run(NOW);
    const ops = counted.counter.end();

    expect(authSessions.deleteExpiredBefore).toHaveBeenCalledWith(
      new Date(NOW.getTime() - MAINTENANCE_CLEANUP_DEFAULTS.authSessionsRetentionDays * DAY_MS),
      { limit: MAINTENANCE_CLEANUP_DEFAULTS.deleteBatchSize },
    );
    expect(result.deleted).toEqual({
      auth_sessions: 4,
      provider_usage: 3, // min-old, hr-old, day-400d
      sync_logs: 1,
      provider_snapshots: 0,
      board_snapshots: 4, // 2 oldest timestamps (index 24, 25) * 2 users
    });
    expect(ops.write).toBeGreaterThan(0);

    expect(store.get(cloudBaseCollectionName(NS, "provider_usage"))?.map((r) => r._id)).toEqual([
      "u-min-new",
      "u-day-100d",
    ]);
    expect(store.get(cloudBaseCollectionName(NS, "sync_logs"))?.map((r) => r._id)).toEqual(["sl-new"]);
    expect(store.get(cloudBaseCollectionName(NS, "provider_snapshots"))?.map((r) => r._id)).toEqual([
      "ps-old",
      "ps-new",
    ]);
    const remainingBoards = store.get(cloudBaseCollectionName(NS, "board_snapshots")) ?? [];
    expect(remainingBoards.some((r) => r._id === "final-2024")).toBe(true);
    expect(remainingBoards.filter((r) => r.board === RankingBoard.Career)).toHaveLength(48);

    // Core ledger tables remain untouched.
    expect(store.get(cloudBaseCollectionName(NS, "users"))).toHaveLength(1);
    expect(store.get(cloudBaseCollectionName(NS, "settlement_items"))).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "maintenance_cleanup",
      deleted: result.deleted,
    }));
  });

  it("[Slice 2] 按 level_season_id 分组滚动清理赛季快照，未终榜赛季同样保留最近 24 份", async () => {
    const boardRows: StoredRow[] = [];
    const oldSeason = "2025_2026";
    const currentSeason = "2026_2027";
    const finalizedSeason = "2024_2025";
    for (let i = 0; i < 30; i += 1) {
      boardRows.push({
        _id: `old-${i}`,
        board: RankingBoard.Season,
        is_final: false,
        level_season_id: oldSeason,
        snapshot_at: new Date(NOW.getTime() - (i + 1) * DAY_MS),
        user_id: "u1",
      });
    }
    for (let i = 0; i < 25; i += 1) {
      boardRows.push({
        _id: `current-${i}`,
        board: RankingBoard.Season,
        is_final: false,
        level_season_id: currentSeason,
        snapshot_at: new Date(NOW.getTime() - i * 60 * 60_000),
        user_id: "u1",
      });
    }
    for (let i = 0; i < 30; i += 1) {
      boardRows.push({
        _id: `finalized-${i}`,
        board: RankingBoard.Season,
        is_final: false,
        level_season_id: finalizedSeason,
        snapshot_at: new Date(NOW.getTime() - (i + 10) * DAY_MS),
        user_id: "u1",
      });
    }
    boardRows.push({
      _id: "finalized-head",
      board: RankingBoard.Season,
      is_final: true,
      level_season_id: finalizedSeason,
      snapshot_at: new Date(NOW.getTime() - 400 * DAY_MS),
      user_id: "u1",
    });

    const { db, store } = makeCleanupFakeDb({ board_snapshots: boardRows });
    const service = new MaintenanceCleanupService({ db, namespace: NS });
    const result = await service.run(NOW);

    expect(result.truncated).toBe(false);
    const remaining = store.get(cloudBaseCollectionName(NS, "board_snapshots")) ?? [];
    expect(remaining.filter((row) => row.level_season_id === oldSeason && row.is_final === false))
      .toHaveLength(24);
    expect(remaining.filter((row) => row.level_season_id === currentSeason && row.is_final === false))
      .toHaveLength(24);
    expect(remaining.filter((row) => row.level_season_id === finalizedSeason && row.is_final === false))
      .toHaveLength(24);
    expect(remaining.some((row) => row._id === "finalized-head")).toBe(true);
  });

  it("[Slice 3.2] batches deleteWhere calls with bounded limit and enforces maxBatchesPerTarget budget", async () => {
    const d = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY_MS);
    const oldLogs = Array.from({ length: 10 }, (_, idx) => ({
      _id: `sl-old-${idx}`,
      started_at: d(65),
    }));
    const { db, store } = makeCleanupFakeDb({
      sync_logs: [...oldLogs, { _id: "sl-new", started_at: d(10) }],
    });
    const deleteSpy = vi.fn(db.deleteWhere!);
    db.deleteWhere = deleteSpy;
    const log = vi.fn();

    const service = new MaintenanceCleanupService({
      db,
      namespace: NS,
      batchSize: 3,
      maxBatchesPerTarget: 10,
      log,
    });
    const res1 = await service.run(NOW);
    expect(res1.deleted.sync_logs).toBe(10);
    expect(store.get(cloudBaseCollectionName(NS, "sync_logs"))?.map((r) => r._id)).toEqual(["sl-new"]);
    const syncLogCalls = deleteSpy.mock.calls.filter(([col]) => col === cloudBaseCollectionName(NS, "sync_logs"));
    expect(syncLogCalls).toHaveLength(4); // 3 + 3 + 3 + 1 (< batchSize stops)
    expect(syncLogCalls.every(([, , opts]) => opts?.limit === 3)).toBe(true);

    // Budget cap: 7 rows with batchSize=2, maxBatchesPerTarget=2 stops at 4 rows + logs cap warning
    const cappedDb = makeCleanupFakeDb({
      sync_logs: Array.from({ length: 7 }, (_, idx) => ({ _id: `cap-${idx}`, started_at: d(90) })),
    });
    const cappedLog = vi.fn();
    const cappedService = new MaintenanceCleanupService({
      db: cappedDb.db,
      namespace: NS,
      batchSize: 2,
      maxBatchesPerTarget: 2,
      log: cappedLog,
    });
    const res2 = await cappedService.run(NOW);
    expect(res2.deleted.sync_logs).toBe(4);
    expect(res2.truncated).toBe(true);
    expect(cappedDb.store.get(cloudBaseCollectionName(NS, "sync_logs"))).toHaveLength(3);
    expect(cappedLog).toHaveBeenCalledWith(expect.objectContaining({
      event: "maintenance_cleanup_batch_cap_reached",
      collection: cloudBaseCollectionName(NS, "sync_logs"),
      batch_size: 2,
      max_batches_per_target: 2,
      deleted_so_far: 4,
    }));
  });

  it("永不按时间自动物理删除关键审计与观测 provider_snapshots (A-S3-11)", async () => {
    const oldCreatedAt = new Date(NOW.getTime() - 365 * DAY_MS);
    const eventTypes = [
      "discovered",
      "kickoff_changed",
      "status_changed",
      "result_observed",
      "result_changed",
      "provider_conflict",
      "admin_conflict",
      "provider_error",
    ] as const;
    const { db, store } = makeCleanupFakeDb({
      provider_snapshots: eventTypes.map((eventType, idx) => ({
        _id: `snap-${idx}`,
        event_type: eventType,
        created_at: oldCreatedAt,
      })),
    });
    const res = await new MaintenanceCleanupService({ db, namespace: NS }).run(NOW);
    expect(res.deleted.provider_snapshots).toBe(0);
    expect(store.get(cloudBaseCollectionName(NS, "provider_snapshots"))).toHaveLength(eventTypes.length);
  });
});
