import { describe, expect, it, vi } from "vitest";
import { SyncJobType } from "../domain/enums.js";
import { defaultLevelState } from "../domain/types.js";
import { COLLECTION_DEFINITIONS } from "../schema/collections.js";
import { CLOUDBASE_RUNTIME_COLLECTIONS, cloudBaseCollectionName } from "../infrastructure/cloudbase-db.js";
import type { CloudBaseSdkDatabase } from "../infrastructure/cloudbase-wx-db.js";
import { createCloudFunctionRuntime, isSportApiCloudflareBlocked, runDueProviderJobs } from "./runtime.js";
import { runDueProviderJobs as sharedRunDueProviderJobs, WIRED_PERIODIC_TASKS, UNWIRED_PERIODIC_TASKS } from "../runtime/scheduled-jobs.js";

const ENV = {
  FOOTBALL_ENVIRONMENT: "test",
  FOOTBALL_MATCH_CURSOR_SECRET: "test-cursor-secret",
  FOOTBALL_REPOSITORY_BACKEND: "cloudbase",
  FOOTBALL_CLOUD_ENVIRONMENT_ID: "cloud-test",
  FOOTBALL_RESOURCE_NAMESPACE: "football_test",
};

function fakeDatabase(missing: string[] = []) {
  const documents = new Map<string, Record<string, unknown>>();
  let collectionReads = 0;
  const collection = (name: string) => {
    collectionReads += 1;
    let filter: Record<string, unknown> = {};
    let orderBy: { field: string; direction: "asc" | "desc" } | undefined;
    let offset = 0;
    let limit = Number.POSITIVE_INFINITY;
    const chain = {
      where(next: Record<string, unknown> = {}) {
        filter = next;
        return chain;
      },
      orderBy(field: string, direction: "asc" | "desc" = "asc") {
        orderBy = { field, direction };
        return chain;
      },
      skip(count: number) {
        offset = count;
        return chain;
      },
      limit(count: number) {
        limit = count;
        return chain;
      },
      async get() {
        let rows = [...documents.entries()]
          .filter(([key]) => key.startsWith(`${name}/`))
          .map(([, document]) => ({ ...document }));
        if (Object.keys(filter).length > 0) {
          rows = rows.filter((document) => Object.entries(filter).every(([field, value]) => document[field] === value));
        }
        if (orderBy) {
          rows.sort((a, b) => {
            const left = a[orderBy!.field];
            const right = b[orderBy!.field];
            const compare = left instanceof Date && right instanceof Date
              ? left.getTime() - right.getTime()
              : String(left ?? "").localeCompare(String(right ?? ""));
            return compare * (orderBy!.direction === "desc" ? -1 : 1);
          });
        }
        const end = Number.isFinite(limit) ? offset + limit : undefined;
        return { data: rows.slice(offset, end) };
      },
      async count() {
        if (missing.includes(name)) throw Object.assign(new Error(`collection ${name} not found`), { errCode: "COLLECTION_NOT_FOUND" });
        return { total: 0 };
      },
      async add({ data }: { data: Record<string, unknown> }) {
        const id = String(data._id);
        documents.set(`${name}/${id}`, { ...data });
        return { _id: id };
      },
      async update() { return { updated: 0, stats: { updated: 0 } }; },
      doc(id: string) {
        return {
          async get() {
            const data = documents.get(`${name}/${id}`);
            if (!data) throw Object.assign(new Error("document not exist"), { errCode: "DOCUMENT_NOT_FOUND" });
            return { data };
          },
          async update({ data }: { data?: Record<string, unknown> } = {}) {
            const existing = documents.get(`${name}/${id}`);
            if (!existing) throw Object.assign(new Error("document not exist"), { errCode: "DOCUMENT_NOT_FOUND" });
            documents.set(`${name}/${id}`, { ...existing, ...(data ?? {}), _id: id });
            return { updated: 1, stats: { updated: 1 } };
          },
          async remove() {
            documents.delete(`${name}/${id}`);
            return { removed: 1 };
          },
        };
      },
    };
    return chain;
  };
  const db = {
    collection,
    async startTransaction() {
      return {
        collection,
        async commit() {},
        async rollback() {},
      };
    },
  } as unknown as CloudBaseSdkDatabase;
  return { db, documents, collectionReads: () => collectionReads };
}

describe("Cloud Function runtime startup", () => {
  it("logs missing environment keys with a stable diagnostic code and no values", () => {
    const log = vi.fn();
    expect(() => createCloudFunctionRuntime({ env: {}, db: fakeDatabase().db, sdkVersion: "4.0.2", nodeVersion: "v24", log })).toThrow("Required environment configuration missing");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "startup_error",
      diag_code: "DIAG_FN_ENV_VAR_MISSING",
      missing_environment_keys: expect.arrayContaining(["FOOTBALL_MATCH_CURSOR_SECRET", "FOOTBALL_RESOURCE_NAMESPACE"]),
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("test-cursor-secret");
  });

  it("rejects a production mock identity at startup", () => {
    const log = vi.fn();
    expect(() => createCloudFunctionRuntime({
      env: { ...ENV, FOOTBALL_ENVIRONMENT: "prod", FOOTBALL_RESOURCE_NAMESPACE: "football_prod", FOOTBALL_MOCK_TRUSTED_OPENID: "private-openid" },
      db: fakeDatabase().db,
      sdkVersion: "4.0.2",
      nodeVersion: "v24",
      log,
    })).toThrow("cannot configure mock identity");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "startup_error", diag_code: "DIAG_PROD_MOCK_IDENTITY" }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-openid");
  });
});

describe("Timer summary observation (simulated CloudBase SDK, not a real cloud database)", () => {
  it("emits exactly one timer_summary log after a Timer event", async () => {
    const log = vi.fn();
    const runtime = createCloudFunctionRuntime({
      env: ENV,
      db: fakeDatabase().db,
      sdkVersion: "4.0.2",
      nodeVersion: "v24",
      log,
      now: () => new Date("2026-08-09T16:00:00.000Z"),
    });
    await runtime({ Type: "Timer" }, {});
    const summaries = log.mock.calls
      .map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry.event === "timer_summary");
    expect(summaries).toHaveLength(1);
    const dbOps = summaries[0]!.db_ops as { read: number };
    expect(typeof dbOps.read).toBe("number");
    expect(dbOps.read).toBeGreaterThanOrEqual(0);
    expect(summaries[0]).toEqual(expect.objectContaining({
      fifteen_items_complete: true,
      wired_periodic_tasks: WIRED_PERIODIC_TASKS,
      unwired_periodic_tasks: UNWIRED_PERIODIC_TASKS,
    }));
    expect(summaries[0]?.ran).toEqual(expect.arrayContaining([
      SyncJobType.PeriodFinalize,
      SyncJobType.DailyConsistency,
      SyncJobType.WeeklyLevelEval,
      SyncJobType.BoardSnapshotCareer,
      SyncJobType.BoardSnapshotSeason,
    ]));
    expect(summaries[0]?.ran ?? []).not.toContain(SyncJobType.BoardSnapshotStrength);
    expect(summaries[0]?.ran ?? []).not.toContain(SyncJobType.BoardSnapshotSeasonFinal);
    expect(summaries[0]?.skipped).toEqual(expect.arrayContaining([
      { task: SyncJobType.BoardSnapshotStrength, reason: "inline_weekly_refresh" },
      { task: SyncJobType.BoardSnapshotSeasonFinal, reason: "inline_weekly_refresh" },
    ]));
    expect(summaries[0]?.task_types).toEqual(expect.arrayContaining([
      SyncJobType.PeriodFinalize,
      SyncJobType.DailyConsistency,
      SyncJobType.WeeklyLevelEval,
      SyncJobType.BoardSnapshotCareer,
      SyncJobType.BoardSnapshotStrength,
      SyncJobType.BoardSnapshotSeason,
      SyncJobType.BoardSnapshotSeasonFinal,
    ]));
  });

  it("skips period_finalize and daily_consistency on a simulated Timer when the cycle is not due", async () => {
    const fake = fakeDatabase();
    let now = new Date("2026-08-09T16:00:00.000Z");
    const log = vi.fn();
    const runtime = createCloudFunctionRuntime({
      env: ENV,
      db: fake.db,
      sdkVersion: "4.0.2",
      nodeVersion: "v24",
      log,
      now: () => now,
    });
    await runtime({ Type: "Timer" }, {});
    now = new Date("2026-08-09T16:30:00.000Z");
    await runtime({ Type: "Timer" }, {});
    const summaries = log.mock.calls
      .map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry.event === "timer_summary");
    expect(summaries).toHaveLength(2);
    expect(summaries[1]?.skipped).toEqual(expect.arrayContaining([
      { task: SyncJobType.PeriodFinalize, reason: "interval_not_due" },
      { task: SyncJobType.DailyConsistency, reason: "interval_not_due" },
      { task: SyncJobType.WeeklyLevelEval, reason: "interval_not_due" },
      { task: SyncJobType.BoardSnapshotCareer, reason: "interval_not_due" },
      { task: SyncJobType.BoardSnapshotSeason, reason: "interval_not_due" },
      { task: SyncJobType.BoardSnapshotStrength, reason: "interval_not_due" },
      { task: SyncJobType.BoardSnapshotSeasonFinal, reason: "no_due_season" },
    ]));
  });

  it("simulated Timer waits until Monday 02:10 UTC, refreshes strength inline, and skips the repeat tick (not a real cloud acceptance)", async () => {
    const fake = fakeDatabase();
    fake.documents.set("football_test_sched_state/weekly_level_eval", {
      _id: "weekly_level_eval",
      job_type: SyncJobType.WeeklyLevelEval,
      completed_cycle_at: new Date("2026-08-03T02:00:00.000Z"),
      updated_at: new Date("2026-08-03T02:00:00.000Z"),
    });
    fake.documents.set("football_test_sched_state/board_snapshot_strength", {
      _id: "board_snapshot_strength",
      job_type: SyncJobType.BoardSnapshotStrength,
      completed_cycle_at: new Date("2026-08-09T03:00:00.000Z"),
      updated_at: new Date("2026-08-09T03:00:00.000Z"),
    });
    let now = new Date("2026-08-10T02:09:00.000Z");
    const log = vi.fn();
    const runtime = createCloudFunctionRuntime({
      env: ENV,
      db: fake.db,
      sdkVersion: "4.0.2",
      nodeVersion: "v24",
      log,
      now: () => now,
    });
    await runtime({ Type: "Timer" }, {});
    now = new Date("2026-08-10T02:10:00.000Z");
    await runtime({ Type: "Timer" }, {});
    now = new Date("2026-08-10T02:20:00.000Z");
    await runtime({ Type: "Timer" }, {});
    const summaries = log.mock.calls
      .map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry.event === "timer_summary");
    expect(summaries).toHaveLength(3);
    expect(summaries[0]?.ran ?? []).not.toContain(SyncJobType.WeeklyLevelEval);
    expect(summaries[0]?.skipped).toEqual(expect.arrayContaining([
      { task: SyncJobType.WeeklyLevelEval, reason: "interval_not_due" },
    ]));
    expect(summaries[1]?.ran).toEqual(expect.arrayContaining([SyncJobType.WeeklyLevelEval]));
    expect(summaries[1]?.ran ?? []).not.toContain(SyncJobType.BoardSnapshotStrength);
    expect(summaries[1]?.skipped).toEqual(expect.arrayContaining([
      { task: SyncJobType.BoardSnapshotStrength, reason: "inline_weekly_refresh" },
      { task: SyncJobType.BoardSnapshotSeasonFinal, reason: "inline_weekly_refresh" },
    ]));
    expect(summaries[2]?.ran ?? []).not.toContain(SyncJobType.WeeklyLevelEval);
    expect(summaries[2]?.ran ?? []).not.toContain(SyncJobType.BoardSnapshotStrength);
    expect(summaries[2]?.skipped).toEqual(expect.arrayContaining([
      { task: SyncJobType.WeeklyLevelEval, reason: "interval_not_due" },
      { task: SyncJobType.BoardSnapshotStrength, reason: "interval_not_due" },
      { task: SyncJobType.BoardSnapshotSeasonFinal, reason: "no_due_season" },
    ]));
    const snapshots = [...fake.documents.values()].filter((row) => row.board === "strength");
    expect(snapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        board: "strength",
        snapshot_kind: "head",
        snapshot_at: new Date("2026-08-10T02:10:00.000Z"),
      }),
    ]));
    expect(snapshots).toHaveLength(1);
    expect(fake.documents.get("football_test_sched_state/weekly_level_eval")).toEqual(
      expect.objectContaining({
        job_type: SyncJobType.WeeklyLevelEval,
        completed_cycle_at: new Date("2026-08-10T02:00:00.000Z"),
      }),
    );
    expect(fake.documents.get("football_test_sched_state/board_snapshot_strength")).toEqual(
      expect.objectContaining({
        job_type: SyncJobType.BoardSnapshotStrength,
        completed_cycle_at: new Date("2026-08-10T02:10:00.000Z"),
      }),
    );
  });

  it("simulated Timer updates career/season hourly and strength daily, skipping a repeat tick (not a real cloud acceptance)", async () => {
    const fake = fakeDatabase();
    const t0 = new Date("2026-08-11T12:00:00.000Z");
    fake.documents.set("football_test_sched_state/weekly_level_eval", {
      _id: "weekly_level_eval",
      job_type: SyncJobType.WeeklyLevelEval,
      completed_cycle_at: new Date("2026-08-10T02:00:00.000Z"),
      updated_at: t0,
    });
    let now = t0;
    const log = vi.fn();
    const runtime = createCloudFunctionRuntime({
      env: ENV,
      db: fake.db,
      sdkVersion: "4.0.2",
      nodeVersion: "v24",
      log,
      now: () => now,
    });
    await runtime({ Type: "Timer" }, {});
    now = new Date(t0.getTime() + 30 * 60_000);
    await runtime({ Type: "Timer" }, {});
    now = new Date(t0.getTime() + 60 * 60_000);
    await runtime({ Type: "Timer" }, {});
    now = new Date(t0.getTime() + 24 * 60 * 60_000);
    await runtime({ Type: "Timer" }, {});
    const summaries = log.mock.calls
      .map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry.event === "timer_summary");
    expect(summaries).toHaveLength(4);
    expect(summaries[0]?.ran).toEqual(expect.arrayContaining([
      SyncJobType.BoardSnapshotCareer,
      SyncJobType.BoardSnapshotSeason,
      SyncJobType.BoardSnapshotStrength,
    ]));
    expect(summaries[0]?.ran ?? []).not.toContain(SyncJobType.WeeklyLevelEval);
    expect(summaries[1]?.skipped).toEqual(expect.arrayContaining([
      { task: SyncJobType.BoardSnapshotCareer, reason: "interval_not_due" },
      { task: SyncJobType.BoardSnapshotSeason, reason: "interval_not_due" },
      { task: SyncJobType.BoardSnapshotStrength, reason: "interval_not_due" },
    ]));
    expect(summaries[2]?.ran).toEqual(expect.arrayContaining([
      SyncJobType.BoardSnapshotCareer,
      SyncJobType.BoardSnapshotSeason,
    ]));
    expect(summaries[2]?.ran ?? []).not.toContain(SyncJobType.BoardSnapshotStrength);
    expect(summaries[3]?.ran).toEqual(expect.arrayContaining([
      SyncJobType.BoardSnapshotCareer,
      SyncJobType.BoardSnapshotSeason,
      SyncJobType.BoardSnapshotStrength,
    ]));
    const career = [...fake.documents.values()].filter((row) => row.board === "career");
    const season = [...fake.documents.values()].filter((row) => row.board === "season");
    const strength = [...fake.documents.values()].filter((row) => row.board === "strength");
    expect(career).toEqual(expect.arrayContaining([
      expect.objectContaining({ snapshot_kind: "head", snapshot_at: t0 }),
      expect.objectContaining({ snapshot_kind: "head", snapshot_at: new Date(t0.getTime() + 60 * 60_000) }),
      expect.objectContaining({ snapshot_kind: "head", snapshot_at: new Date(t0.getTime() + 24 * 60 * 60_000) }),
    ]));
    expect(season).toEqual(expect.arrayContaining([
      expect.objectContaining({ snapshot_kind: "head", snapshot_at: t0 }),
      expect.objectContaining({ snapshot_kind: "head", snapshot_at: new Date(t0.getTime() + 60 * 60_000) }),
      expect.objectContaining({ snapshot_kind: "head", snapshot_at: new Date(t0.getTime() + 24 * 60 * 60_000) }),
    ]));
    expect(strength).toEqual(expect.arrayContaining([
      expect.objectContaining({ snapshot_kind: "head", snapshot_at: t0 }),
      expect.objectContaining({ snapshot_kind: "head", snapshot_at: new Date(t0.getTime() + 24 * 60 * 60_000) }),
    ]));
    expect(career).toHaveLength(3);
    expect(season).toHaveLength(3);
    expect(strength).toHaveLength(2);
  });

  it("simulated Timer does not freeze before season-final eval, then writes is_final rows and stays idempotent (not a real cloud acceptance)", async () => {
    const fake = fakeDatabase();
    const beforeStart = new Date("2026-06-29T02:20:00.000Z");
    const start = new Date("2026-07-06T02:10:00.000Z");
    const asOf = new Date("2026-07-06T02:00:00.000Z");
    const repeatAt = new Date("2026-07-06T02:20:00.000Z");
    const catchUpAt = new Date("2026-08-11T13:00:00.000Z");
    const userId = "00000000-0000-4000-8000-000000000220";
    const missedUserId = "00000000-0000-4000-8000-000000000221";
    const statsId = `key_${Buffer.from(JSON.stringify([userId, "2025_2026"]), "utf8").toString("base64url")}`;
    const missedStatsId = `key_${Buffer.from(JSON.stringify([missedUserId, "2024_2025"]), "utf8").toString("base64url")}`;
    fake.documents.set("football_test_sched_state/weekly_level_eval", {
      _id: "weekly_level_eval",
      job_type: SyncJobType.WeeklyLevelEval,
      completed_cycle_at: new Date("2026-06-29T02:00:00.000Z"),
      updated_at: beforeStart,
    });
    fake.documents.set(`football_test_users/${userId}`, {
      _id: userId,
      schema_version: 1,
      user_id: userId,
      openid: "openid_season_final",
      unionid: null,
      nickname: "SeasonFinal",
      favorite_team_id: null,
      status: "active",
      career_points: 0,
      career_valid_predictions: 0,
      career_wdl_hits: 0,
      career_exact_hits: 0,
      career_last_scoring_match_at: null,
      career_level: 1,
      career_best_level: 1,
      career_level_state: defaultLevelState(),
      deleted_at: null,
      created_at: beforeStart,
      updated_at: beforeStart,
    });
    fake.documents.set(`football_test_stats/${statsId}`, {
      _id: statsId,
      schema_version: 1,
      user_id: userId,
      level_season_id: "2025_2026",
      points: 48,
      valid_predictions: 4,
      wdl_hits: 3,
      exact_hits: 2,
      last_scoring_match_at: new Date("2026-06-28T10:00:00.000Z"),
      level: 1,
      best_level: 1,
      level_state: defaultLevelState(),
      is_level_frozen: false,
      created_at: beforeStart,
      updated_at: beforeStart,
    });
    let now = beforeStart;
    const log = vi.fn();
    const runtime = createCloudFunctionRuntime({
      env: ENV,
      db: fake.db,
      sdkVersion: "4.0.2",
      nodeVersion: "v24",
      log,
      now: () => now,
    });
    await runtime({ Type: "Timer" }, {});
    now = start;
    await runtime({ Type: "Timer" }, {});
    const firstFinals = [...fake.documents.values()].filter((row) =>
      row.board === "season" && row.level_season_id === "2025_2026" && row.is_final === true && row.snapshot_kind !== "head",
    );
    expect(firstFinals).toEqual([
      expect.objectContaining({
        is_final: true,
        user_id: userId,
        season_points: 48,
        snapshot_at: asOf,
      }),
    ]);
    fake.documents.get(`football_test_stats/${statsId}`)!.points = 60;
    now = repeatAt;
    await runtime({ Type: "Timer" }, {});
    now = catchUpAt;
    fake.documents.set("football_test_sched_state/weekly_level_eval", {
      _id: "weekly_level_eval",
      job_type: SyncJobType.WeeklyLevelEval,
      completed_cycle_at: new Date("2026-08-10T02:00:00.000Z"),
      updated_at: catchUpAt,
    });
    fake.documents.set(`football_test_users/${missedUserId}`, {
      _id: missedUserId,
      schema_version: 1,
      user_id: missedUserId,
      openid: "openid_season_final_missed",
      unionid: null,
      nickname: "MissedFinal",
      favorite_team_id: null,
      status: "active",
      career_points: 0,
      career_valid_predictions: 0,
      career_wdl_hits: 0,
      career_exact_hits: 0,
      career_last_scoring_match_at: null,
      career_level: 1,
      career_best_level: 1,
      career_level_state: defaultLevelState(),
      deleted_at: null,
      created_at: catchUpAt,
      updated_at: catchUpAt,
    });
    fake.documents.set(`football_test_stats/${missedStatsId}`, {
      _id: missedStatsId,
      schema_version: 1,
      user_id: missedUserId,
      level_season_id: "2024_2025",
      points: 24,
      valid_predictions: 4,
      wdl_hits: 3,
      exact_hits: 2,
      last_scoring_match_at: new Date("2025-06-28T10:00:00.000Z"),
      level: 1,
      best_level: 1,
      level_state: defaultLevelState(),
      is_level_frozen: true,
      created_at: catchUpAt,
      updated_at: catchUpAt,
    });
    await runtime({ Type: "Timer" }, {});
    const summaries = log.mock.calls
      .map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry.event === "timer_summary");
    expect(summaries).toHaveLength(4);
    expect(summaries[0]?.ran ?? []).not.toContain(SyncJobType.BoardSnapshotSeasonFinal);
    expect(summaries[0]?.skipped).toEqual(expect.arrayContaining([
      { task: SyncJobType.BoardSnapshotSeasonFinal, reason: "no_due_season" },
    ]));
    expect(summaries[1]?.ran).toEqual(expect.arrayContaining([SyncJobType.WeeklyLevelEval]));
    expect(summaries[1]?.ran ?? []).not.toContain(SyncJobType.BoardSnapshotSeasonFinal);
    expect(summaries[1]?.skipped).toEqual(expect.arrayContaining([
      { task: SyncJobType.BoardSnapshotSeasonFinal, reason: "inline_weekly_refresh" },
    ]));
    expect(summaries[2]?.skipped).toEqual(expect.arrayContaining([
      { task: SyncJobType.BoardSnapshotSeasonFinal, reason: "no_due_season" },
    ]));
    expect(summaries[3]?.ran).toEqual(expect.arrayContaining([SyncJobType.BoardSnapshotSeasonFinal]));
    const laterFinals = [...fake.documents.values()].filter((row) =>
      row.board === "season" && row.is_final === true && row.snapshot_kind !== "head",
    );
    expect(laterFinals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level_season_id: "2025_2026",
        is_final: true,
        season_points: 48,
        snapshot_at: asOf,
      }),
      expect.objectContaining({
        level_season_id: "2024_2025",
        is_final: true,
        user_id: missedUserId,
        season_points: 24,
        snapshot_at: new Date("2025-07-07T02:00:00.000Z"),
      }),
    ]));
    expect(laterFinals.filter((row) => row.level_season_id === "2025_2026")).toHaveLength(1);
  });
});

describe("shared scheduled-jobs reuse", () => {
  it("re-exports the shared runDueProviderJobs instead of wrapping a cloud handler", () => {
    expect(runDueProviderJobs).toBe(sharedRunDueProviderJobs);
  });
});

describe("Provider Timer scheduling", () => {
  it("dispatches every due league for each schedule job in one Timer tick", async () => {
    const now = new Date("2026-10-13T12:00:00.000Z");
    const dueLeagues = vi.fn()
      .mockResolvedValueOnce(["la_liga", "serie_a"])
      .mockResolvedValueOnce(["bundesliga", "ligue_1"]);
    const providerRegistry = { dueLeagues } as unknown as Parameters<typeof runDueProviderJobs>[0]["providerRegistry"];
    const commitPendingLeagueSuccess = vi.fn(async (_job: string, _now: Date, _league?: string) => undefined);
    const discardPendingLeagueSuccess = vi.fn();
    const registry = {
      ...providerRegistry,
      commitPendingLeagueSuccess,
      discardPendingLeagueSuccess,
    } as unknown as Parameters<typeof runDueProviderJobs>[0]["providerRegistry"];
    const dispatchRun = vi.fn(async (..._args: unknown[]) => ({ kind: "completed" }));
    const dispatcher = { run: dispatchRun } as unknown as Parameters<typeof runDueProviderJobs>[0]["dispatcher"];
    const querySpy = vi.fn(async () => []);
    const cloudDb = { query: querySpy } as unknown as Parameters<typeof runDueProviderJobs>[0]["cloudDb"];
    const reconcile = { run: vi.fn(async () => ({ kind: "completed" })) } as unknown as Parameters<typeof runDueProviderJobs>[0]["reconcile"];

    const result = await runDueProviderJobs({
      cloudDb,
      namespace: "football_test",
      dispatcher,
      providerRegistry: registry,
      syncLeagueIds: ["la_liga", "serie_a", "bundesliga", "ligue_1"],
      sourceIds: ["fd"],
      profile: "test",
      reconcile,
      serverNow: now,
      log: vi.fn(),
    });

    // 底层适配器收物理集合名：查 sync_logs 必须带命名空间前缀，否则云端报「表不存在」。
    expect(querySpy).toHaveBeenCalledWith("football_test_sync_logs", expect.anything(), expect.anything());

    expect(dispatchRun.mock.calls.filter(([job]) => job === SyncJobType.FutureSchedule).map(([, , league]) => league))
      .toEqual(["la_liga", "serie_a"]);
    expect(dispatchRun.mock.calls.filter(([job]) => job === SyncJobType.FullScheduleVerify).map(([, , league]) => league))
      .toEqual(["bundesliga", "ligue_1"]);
    expect(commitPendingLeagueSuccess.mock.calls.map(([job, , league]) => `${job}:${league}`)).toEqual(expect.arrayContaining([
      `${SyncJobType.FutureSchedule}:la_liga`,
      `${SyncJobType.FutureSchedule}:serie_a`,
      `${SyncJobType.FullScheduleVerify}:bundesliga`,
      `${SyncJobType.FullScheduleVerify}:ligue_1`,
    ]));
    expect(result.jobs_run).toEqual(expect.arrayContaining([
      `${SyncJobType.FutureSchedule}:la_liga`, `${SyncJobType.FullScheduleVerify}:bundesliga`,
    ]));
  });
});

describe("Cloud Function diagnostic action", () => {
  it("marks only sportapi 403 or provider code 1010 requests as Cloudflare blocked", () => {
    expect(isSportApiCloudflareBlocked("sp", { status: 403 })).toBe(true);
    expect(isSportApiCloudflareBlocked("sp", { status: 200, provider_code: "1010" })).toBe(true);
    expect(isSportApiCloudflareBlocked("sp", { status: 429, provider_code: "429" })).toBe(false);
    expect(isSportApiCloudflareBlocked("fd", { status: 403 })).toBe(false);
    expect(isSportApiCloudflareBlocked("sp", null)).toBe(false);
  });

  it("reports collection, environment, namespace, identity and transaction checks without exposing OPENID", async () => {
    const fake = fakeDatabase();
    const runtime = createCloudFunctionRuntime({ env: ENV, db: fake.db, sdkVersion: "4.0.2", nodeVersion: "v24.21.0", buildTime: "2026-10-11T01:02:03.000Z", log: vi.fn() });
    const result = await runtime({ action: "diag" }, { ENV: "cloud-test", OPENID: "wx-private-openid" });
    const body = result.result.body as { data: Record<string, any>; request_id: string };
    expect(result.result.status).toBe(200);
    expect(body.request_id).toEqual(expect.any(String));
    expect(body.data).toMatchObject({
      environment: { ok: true, missing_keys: [] },
      environment_match: { ok: true, configured_id: "cloud-test", runtime_id: "cloud-test" },
      namespace_match: { ok: true, resource_namespace: "football_test", environment: "test" },
      read_write_probe: { ok: true },
      transaction_probe: { ok: true },
      identity_available: true,
      versions: { wx_server_sdk: "4.0.2", node: "v24.21.0", build: "2026-10-11T01:02:03.000Z" },
    });
    expect(Object.keys(body.data.collections).sort()).toEqual([
      ...new Set([
        ...COLLECTION_DEFINITIONS.map((definition) => cloudBaseCollectionName("football_test", definition.collection)),
        ...CLOUDBASE_RUNTIME_COLLECTIONS.map((collection) => cloudBaseCollectionName("football_test", collection)),
      ]),
    ].sort());
    expect(body.data.indexes).toContain("人工核对");
    expect(JSON.stringify(body)).not.toContain("wx-private-openid");
    expect(fake.collectionReads()).toBeGreaterThan(COLLECTION_DEFINITIONS.length);
  });

  it("attaches diagnostic code and hint to missing collections and environment mismatches", async () => {
    const missingCollection = `football_test_${COLLECTION_DEFINITIONS[0]!.collection}`;
    const runtime = createCloudFunctionRuntime({
      env: ENV,
      db: fakeDatabase([missingCollection]).db,
      sdkVersion: "4.0.2",
      nodeVersion: "v24.21.0",
      log: vi.fn(),
    });
    const result = await runtime({ action: "diag" }, { ENV: "wrong-env" });
    const data = (result.result.body as { data: Record<string, any> }).data;
    expect(result.result.status).toBe(503);
    expect(data.environment_match).toMatchObject({ ok: false, diag_code: "DIAG_ENV_MISMATCH", hint: expect.any(String) });
    expect(data.collections[missingCollection]).toMatchObject({ exists: false, diag_code: "DIAG_DB_COLLECTION_MISSING", hint: expect.any(String) });
  });

  it("returns a non-informative 404 for the diagnostic action in prod", async () => {
    const fake = fakeDatabase();
    const runtime = createCloudFunctionRuntime({
      env: { ...ENV, FOOTBALL_ENVIRONMENT: "prod", FOOTBALL_RESOURCE_NAMESPACE: "football_prod" },
      db: fake.db,
      sdkVersion: "4.0.2",
      nodeVersion: "v24.21.0",
      log: vi.fn(),
    });
    const result = await runtime({ action: "diag" }, { ENV: "cloud-test", OPENID: "wx-private-openid" });
    expect(result.result).toMatchObject({ status: 404, body: { code: "NOT_FOUND", request_id: expect.any(String) } });
    expect(fake.collectionReads()).toBe(0);
    expect(JSON.stringify(result)).not.toContain("wx-private-openid");
  });
});
