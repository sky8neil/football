import { describe, expect, it, vi } from "vitest";
import { SyncJobType } from "../domain/enums.js";
import type { ApplicationRuntime } from "../runtime/application-runtime.js";
import { weeklyEvalAsOf } from "../application/weekly-level-eval.js";
import { UNWIRED_PERIODIC_TASKS, WIRED_PERIODIC_TASKS } from "../runtime/scheduled-jobs.js";
import { runJobsTick, type JobsTickHandle } from "./tick.js";

const ENV = {
  FOOTBALL_ENVIRONMENT: "test",
  FOOTBALL_MATCH_CURSOR_SECRET: "tick-secret",
  FOOTBALL_REPOSITORY_BACKEND: "postgres",
  FOOTBALL_DATABASE_URL: "postgres://football:secret@127.0.0.1:1/football",
  FOOTBALL_DATABASE_SCHEMA: "football_vps07",
  FOOTBALL_RESOURCE_NAMESPACE: "ft",
  FOOTBALL_WECHAT_APP_ID: "wx-test",
  FOOTBALL_WECHAT_APP_SECRET: "wx-secret",
  FOOTBALL_SESSION_TTL_SECONDS: "60",
};

function makeProviderRegistryMock(overrides: Record<string, unknown> = {}) {
  return {
    beginTickCache: vi.fn(),
    endTickCache: vi.fn(),
    dueLeagues: vi.fn(async () => []),
    commitPendingLeagueSuccess: vi.fn(async () => undefined),
    discardPendingLeagueSuccess: vi.fn(),
    ...overrides,
  };
}

function handleStub(overrides: Record<string, unknown> = {}): JobsTickHandle {
  const close = vi.fn(async () => undefined);
  const begin = vi.fn();
  const end = vi.fn(() => ({ read: 0, write: 0, by_collection: [] }));
  const runtime = {
    db: { query: vi.fn(async () => []) },
    namespace: "ft",
    repo: {
      matches: { findSettlementTodos: vi.fn(async () => []), findById: vi.fn() },
      settlements: { findByStatus: vi.fn(async () => []), findByMatch: vi.fn(async () => []) },
      rankings: { findAll: vi.fn(async () => []) },
    },
    log: vi.fn(),
    providerSources: { sources: [], sync_leagues: new Set(), sync_profile: "test" },
    providerRegistry: makeProviderRegistryMock(),
    providerDispatcher: { run: vi.fn() },
    providerReconcile: { run: vi.fn(async () => ({ kind: "completed" })) },
    schedulerState: {
      getSettlementFallback: vi.fn(async () => null),
      upsertSettlementFallback: vi.fn(async () => undefined),
      getPeriodicJobCycle: vi.fn(async () => null),
      upsertPeriodicJobCycle: vi.fn(async () => undefined),
    },
    periodFinalize: { finalize: vi.fn(async () => ({ skipped: false, finalized_count: 0 })) },
    dailyConsistency: {
      run: vi.fn(async () => ({ kind: "completed", checked_at: new Date("2026-08-09T00:00:00.000Z"), differences: [], skipped_active_settlement: [] })),
    },
    weeklyLevelEval: {
      run: vi.fn(async (serverNow: Date) => ({
        kind: "completed",
        as_of: weeklyEvalAsOf(serverNow),
        evaluated_count: 0,
        changed_count: 0,
        skipped_count: 0,
      })),
    },
    boardSnapshot: {
      generate: vi.fn(async () => []),
      generateSeasonFinal: vi.fn(async () => []),
    },
    settlementTimerOptions: { env: {} },
    ...overrides,
  } as unknown as ApplicationRuntime;
  return {
    application: runtime,
    counter: { begin, end, get active() { return false; } },
    close,
  };
}

describe("runJobsTick", () => {
  it("prints due jobs in --dry-run and does not dispatch provider or settlement writes", async () => {
    const dispatcherRun = vi.fn();
    const reconcileRun = vi.fn();
    const findByStatus = vi.fn(async () => []);
    const handle = handleStub({
      providerDispatcher: { run: dispatcherRun },
      providerReconcile: { run: reconcileRun },
      repo: {
        matches: { findSettlementTodos: vi.fn(async () => [{ match_id: "m1" }]) },
        settlements: { findByStatus },
        rankings: { findAll: vi.fn(async () => []) },
      },
    });
    const log = vi.fn();
    const result = await runJobsTick({
      env: ENV,
      argv: ["--dry-run"],
      now: () => new Date("2026-08-09T00:00:00.000Z"),
      log,
      assemble: async () => handle,
    });
    expect(result.exitCode).toBe(0);
    expect(dispatcherRun).not.toHaveBeenCalled();
    expect(reconcileRun).not.toHaveBeenCalled();
    expect(findByStatus).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledTimes(1);
    const plan = log.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "jobs_tick_plan");
    expect(plan).toEqual(expect.objectContaining({
      dry_run: true,
      settlement_todo_count: 1,
      fifteen_items_complete: true,
      settlement: { task: "settlement", action: "run", reason: "due" },
    }));
    expect(plan?.wired_periodic_tasks).toEqual(WIRED_PERIODIC_TASKS);
    expect(plan?.unwired_periodic_tasks).toEqual(UNWIRED_PERIODIC_TASKS);
    expect(plan?.tasks).toEqual(expect.arrayContaining([
      { task: SyncJobType.LiveMatch, action: "skip", reason: "no_provider_sources" },
      {
        task: SyncJobType.WeeklyLevelEval,
        action: "run",
        reason: "due",
        as_of: weeklyEvalAsOf(new Date("2026-08-09T00:00:00.000Z")).toISOString(),
      },
      { task: SyncJobType.BoardSnapshotCareer, action: "run", reason: "due" },
      { task: SyncJobType.BoardSnapshotSeason, action: "run", reason: "due" },
      { task: SyncJobType.BoardSnapshotStrength, action: "skip", reason: "inline_weekly_refresh" },
      { task: SyncJobType.BoardSnapshotSeasonFinal, action: "skip", reason: "inline_weekly_refresh" },
    ]));
  });

  it("emits timer_summary, keeps skipped distinct from ran, and closes the pool", async () => {
    const handle = handleStub();
    const log = vi.fn();
    const result = await runJobsTick({
      env: ENV,
      argv: [],
      now: () => new Date("2026-08-09T00:00:00.000Z"),
      log,
      assemble: async () => handle,
    });
    expect(result.exitCode).toBe(0);
    expect(handle.counter.begin).toHaveBeenCalledTimes(1);
    expect(handle.close).toHaveBeenCalledTimes(1);
    const summaries = log.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry.event === "timer_summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual(expect.objectContaining({
      outcome: "ok",
      fifteen_items_complete: true,
    }));
    expect(summaries[0]?.skipped).toEqual(expect.arrayContaining([
      { task: SyncJobType.LiveMatch, reason: "no_provider_sources" },
    ]));
    expect(summaries[0]?.ran).toEqual(expect.arrayContaining([
      SyncJobType.PeriodFinalize,
      SyncJobType.DailyConsistency,
      SyncJobType.WeeklyLevelEval,
      SyncJobType.BoardSnapshotCareer,
      SyncJobType.BoardSnapshotSeason,
    ]));
    expect(summaries[0]?.ran ?? []).not.toContain(SyncJobType.BoardSnapshotStrength);
    expect(summaries[0]?.skipped).toEqual(expect.arrayContaining([
      { task: SyncJobType.LiveMatch, reason: "no_provider_sources" },
      { task: SyncJobType.BoardSnapshotStrength, reason: "inline_weekly_refresh" },
      { task: SyncJobType.BoardSnapshotSeasonFinal, reason: "inline_weekly_refresh" },
    ]));
    expect(summaries[0]?.wired_periodic_tasks).toEqual(WIRED_PERIODIC_TASKS);
    expect(summaries[0]?.unwired_periodic_tasks).toEqual(UNWIRED_PERIODIC_TASKS);
  });

  it("still attempts settlement when provider jobs fail and exits non-zero", async () => {
    const findSettlementTodos = vi.fn(async () => []);
    const handle = handleStub({
      providerSources: { sources: [{ source_id: "fd" }], sync_leagues: new Set(["premier_league"]), sync_profile: "test" },
      providerDispatcher: { run: vi.fn(async () => { throw new Error("provider down"); }) },
      repo: {
        matches: { findSettlementTodos, findById: vi.fn() },
        settlements: { findByStatus: vi.fn(async () => []), findByMatch: vi.fn(async () => []) },
        rankings: { findAll: vi.fn(async () => []) },
      },
    });
    const log = vi.fn();
    const result = await runJobsTick({
      env: ENV,
      argv: [],
      now: () => new Date("2026-08-09T00:00:00.000Z"),
      log,
      assemble: async () => handle,
    });
    expect(findSettlementTodos).toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    const summaries = log.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry.event === "timer_summary");
    expect(summaries).toHaveLength(1);
    expect(["failed", "partial"]).toContain(summaries[0]?.outcome);
  });

  it("exits non-zero for completed items_failed, keeps it out of ran, and still settles", async () => {
    const findSettlementTodos = vi.fn(async () => []);
    const now = new Date("2026-08-09T00:00:00.000Z");
    const handle = handleStub({
      providerSources: { sources: [{ source_id: "fd" }], sync_leagues: new Set(["premier_league"]), sync_profile: "test" },
      providerRegistry: makeProviderRegistryMock(),
      db: {
        query: vi.fn(async (_collection: string, filter: { job_type?: string }) => {
          if (filter.job_type === SyncJobType.LiveMatch) return [];
          return [{ job_type: filter.job_type, status: "success", started_at: now }];
        }),
      },
      providerDispatcher: {
        run: vi.fn(async () => ({
          kind: "completed",
          fixtures: {
            kind: "completed",
            job_type: SyncJobType.LiveMatch,
            items_read: 2,
            items_changed: 1,
            items_failed: 1,
          },
        })),
      },
      repo: {
        matches: { findSettlementTodos, findById: vi.fn() },
        settlements: { findByStatus: vi.fn(async () => []), findByMatch: vi.fn(async () => []) },
        rankings: { findAll: vi.fn(async () => []) },
      },
    });
    const log = vi.fn();
    const result = await runJobsTick({
      env: ENV,
      argv: [],
      now: () => now,
      log,
      assemble: async () => handle,
    });
    expect(findSettlementTodos).toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    const summary = log.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "timer_summary");
    expect(summary?.ran).toEqual(expect.arrayContaining([
      SyncJobType.PeriodFinalize,
      SyncJobType.DailyConsistency,
      SyncJobType.WeeklyLevelEval,
      SyncJobType.BoardSnapshotCareer,
      SyncJobType.BoardSnapshotSeason,
    ]));
    expect(summary?.ran ?? []).not.toContain(SyncJobType.BoardSnapshotStrength);
    expect(summary?.failed).toEqual([
      { task: SyncJobType.LiveMatch, reason: "items_failed", items_failed: 1 },
    ]);
    expect(["failed", "partial"]).toContain(summary?.outcome);
  });

  it("keeps deferred and lock skip out of ran and exits zero after settlement", async () => {
    const findSettlementTodos = vi.fn(async () => []);
    const now = new Date("2026-08-09T00:00:00.000Z");
    const nextAttemptAt = new Date(now.getTime() + 60_000);
    const handle = handleStub({
      providerSources: { sources: [{ source_id: "fd" }], sync_leagues: new Set(["premier_league"]), sync_profile: "test" },
      providerRegistry: makeProviderRegistryMock(),
      db: {
        query: vi.fn(async (_collection: string, filter: { job_type?: string }) => {
          if (filter.job_type === SyncJobType.LiveMatch || filter.job_type === SyncJobType.NearMatch) return [];
          return [{ job_type: filter.job_type, status: "success", started_at: now }];
        }),
      },
      providerDispatcher: {
        run: vi.fn(async (jobType: string) => {
          if (jobType === SyncJobType.LiveMatch) {
            return {
              kind: "deferred",
              fixtures: {
                kind: "deferred",
                job_type: SyncJobType.LiveMatch,
                next_attempt_at: nextAttemptAt,
                retry_attempt: 0,
                last_error_code: "ECONNRESET",
              },
            };
          }
          return {
            kind: "skipped",
            fixtures: { kind: "skipped", job_type: SyncJobType.NearMatch, reason: "lock_held" },
          };
        }),
      },
      repo: {
        matches: { findSettlementTodos, findById: vi.fn() },
        settlements: { findByStatus: vi.fn(async () => []), findByMatch: vi.fn(async () => []) },
        rankings: { findAll: vi.fn(async () => []) },
      },
    });
    const log = vi.fn();
    const result = await runJobsTick({
      env: ENV,
      argv: [],
      now: () => now,
      log,
      assemble: async () => handle,
    });
    expect(findSettlementTodos).toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    const summary = log.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "timer_summary");
    expect(summary?.outcome).toBe("ok");
    expect(summary?.ran).toEqual(expect.arrayContaining([
      SyncJobType.PeriodFinalize,
      SyncJobType.DailyConsistency,
      SyncJobType.WeeklyLevelEval,
      SyncJobType.BoardSnapshotCareer,
      SyncJobType.BoardSnapshotSeason,
    ]));
    expect(summary?.ran ?? []).not.toContain(SyncJobType.BoardSnapshotStrength);
    expect(summary?.deferred).toEqual([
      {
        task: SyncJobType.LiveMatch,
        next_attempt_at: nextAttemptAt.toISOString(),
        retry_attempt: 0,
        last_error_code: "ECONNRESET",
      },
    ]);
    expect(summary?.skipped).toEqual(expect.arrayContaining([
      { task: SyncJobType.NearMatch, reason: "lock_held" },
    ]));
    expect(summary?.failed).toEqual([]);
  });
});
