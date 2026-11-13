import { describe, expect, it, vi } from "vitest";
import { PeriodType, RankingBoard, SyncJobType } from "../domain/enums.js";
import { defaultLevelState, type RankingEntry, type User, type UserSeasonStats } from "../domain/types.js";
import { InMemorySchedulerStateStore } from "../infrastructure/cloudbase-scheduler-state.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { BoardSnapshotService } from "../application/board-snapshot.js";
import { PeriodFinalizeService } from "../application/period-finalize-service.js";
import { weeklyEvalAsOf, WeeklyLevelEvalService } from "../application/weekly-level-eval.js";
import {
  TIMER_TASK_TYPES,
  UNWIRED_PERIODIC_TASKS,
  WIRED_PERIODIC_TASKS,
  planScheduledJobs,
  runDueProviderJobs,
  runScheduledJobs,
} from "./scheduled-jobs.js";
import type { ApplicationRuntime } from "./application-runtime.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");

function recentSuccess(jobType: string) {
  return { job_type: jobType, status: "success", started_at: NOW };
}

async function runDueLiveMatch(outcome: unknown) {
  const dispatchRun = vi.fn(async () => outcome);
  const querySpy = vi.fn(async (_collection: string, filter: { job_type?: string }) => {
    if (filter.job_type === SyncJobType.LiveMatch) return [];
    return [recentSuccess(filter.job_type ?? "")];
  });
  const result = await runDueProviderJobs({
    cloudDb: { query: querySpy } as unknown as Parameters<typeof runDueProviderJobs>[0]["cloudDb"],
    namespace: "football_test",
    dispatcher: { run: dispatchRun } as unknown as Parameters<typeof runDueProviderJobs>[0]["dispatcher"],
    providerRegistry: { dueLeagues: vi.fn(async () => []) } as unknown as Parameters<typeof runDueProviderJobs>[0]["providerRegistry"],
    syncLeagueIds: ["premier_league"],
    sourceIds: ["fd"],
    profile: "test",
    reconcile: { run: vi.fn(async () => ({ kind: "completed" })) } as unknown as Parameters<typeof runDueProviderJobs>[0]["reconcile"],
    serverNow: NOW,
    log: vi.fn(),
  });
  return { result, dispatchRun };
}

function runtimeStub(overrides: Record<string, unknown> = {}): ApplicationRuntime {
  return {
    db: { query: vi.fn(async () => []) },
    namespace: "football_test",
    repo: {
      matches: { findSettlementTodos: vi.fn(async () => []) },
      settlements: { findByStatus: vi.fn(async () => []) },
      rankings: { findAll: vi.fn(async () => []) },
    },
    log: vi.fn(),
    providerSources: { sources: [], sync_leagues: new Set(), sync_profile: "test" },
    providerRegistry: { beginTickCache: vi.fn(), endTickCache: vi.fn(), dueLeagues: vi.fn(async () => []) },
    providerDispatcher: { run: vi.fn() },
    providerReconcile: { run: vi.fn(async () => ({ kind: "completed" })) },
    schedulerState: {
      getSettlementFallback: vi.fn(async () => null),
      upsertSettlementFallback: vi.fn(async () => undefined),
      getPeriodicJobCycle: vi.fn(async () => null),
      upsertPeriodicJobCycle: vi.fn(async () => undefined),
    },
    periodFinalize: {
      finalize: vi.fn(async () => ({
        period_type: "week",
        period_key: "2026-W32",
        due: true,
        skipped: false,
        finalized_count: 0,
        skipped_count: 0,
      })),
    },
    dailyConsistency: {
      run: vi.fn(async () => ({
        kind: "completed",
        checked_at: NOW,
        differences: [],
        skipped_active_settlement: [],
      })),
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
}

describe("TIMER_TASK_TYPES", () => {
  it("keeps the original seven timer tasks including independent settlement", () => {
    expect(TIMER_TASK_TYPES).toEqual([
      SyncJobType.PostFinishVerify,
      SyncJobType.LiveMatch,
      SyncJobType.NearMatch,
      SyncJobType.FutureSchedule,
      SyncJobType.FullScheduleVerify,
      SyncJobType.ProviderReconcile,
      "settlement",
      SyncJobType.PeriodFinalize,
      SyncJobType.DailyConsistency,
      SyncJobType.WeeklyLevelEval,
      SyncJobType.BoardSnapshotCareer,
      SyncJobType.BoardSnapshotStrength,
      SyncJobType.BoardSnapshotSeason,
      SyncJobType.BoardSnapshotSeasonFinal,
    ]);
  });
});

describe("UNWIRED_PERIODIC_TASKS", () => {
  it("lists all §7.3 periodic jobs as wired and claims fifteen items complete", () => {
    expect(WIRED_PERIODIC_TASKS.map((row) => row.task)).toEqual([
      SyncJobType.PeriodFinalize,
      SyncJobType.DailyConsistency,
      SyncJobType.WeeklyLevelEval,
      SyncJobType.BoardSnapshotCareer,
      SyncJobType.BoardSnapshotStrength,
      SyncJobType.BoardSnapshotSeason,
      SyncJobType.BoardSnapshotSeasonFinal,
    ]);
    expect(WIRED_PERIODIC_TASKS.every((row) => row.status === "wired")).toBe(true);
    expect(UNWIRED_PERIODIC_TASKS).toEqual([]);
  });
});

describe("runScheduledJobs", () => {
  it("runs settlement after provider jobs and always ends the tick cache", async () => {
    const beginTickCache = vi.fn();
    const endTickCache = vi.fn();
    const query = vi.fn(async () => []);
    const reconcileRun = vi.fn(async () => ({ kind: "completed" }));
    const findSettlementTodos = vi.fn(async () => []);
    const findByStatus = vi.fn(async () => []);
    const runtime = runtimeStub({
      db: { query },
      repo: { matches: { findSettlementTodos }, settlements: { findByStatus }, rankings: { findAll: vi.fn(async () => []) } },
      providerRegistry: { beginTickCache, endTickCache, dueLeagues: vi.fn() },
      providerReconcile: { run: reconcileRun },
    });

    const result = await runScheduledJobs({
      runtime,
      serverNow: new Date("2026-08-09T00:00:00.000Z"),
    });

    expect(beginTickCache).toHaveBeenCalledTimes(1);
    expect(endTickCache).toHaveBeenCalledTimes(1);
    expect(reconcileRun).not.toHaveBeenCalled();
    expect(findSettlementTodos).toHaveBeenCalled();
    expect(result.providerData).toEqual(expect.objectContaining({
      outcome: "completed",
      reason: "no_provider_sources",
      jobs_run: expect.arrayContaining([SyncJobType.PeriodFinalize, SyncJobType.DailyConsistency]),
    }));
    expect(result.settlements).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("still runs settlement and ends the tick cache when provider jobs throw", async () => {
    const beginTickCache = vi.fn();
    const endTickCache = vi.fn();
    const findSettlementTodos = vi.fn(async () => []);
    const findByStatus = vi.fn(async () => []);
    const runtime = runtimeStub({
      repo: { matches: { findSettlementTodos }, settlements: { findByStatus }, rankings: { findAll: vi.fn(async () => []) } },
      providerSources: { sources: [{ source_id: "fd" }], sync_leagues: new Set(["premier_league"]), sync_profile: "test" },
      providerRegistry: {
        beginTickCache,
        endTickCache,
        dueLeagues: vi.fn(async () => []),
      },
      providerDispatcher: { run: vi.fn(async () => { throw new Error("due league failed"); }) },
      providerReconcile: { run: vi.fn(async () => ({ kind: "completed" })) },
    });

    const result = await runScheduledJobs({
      runtime,
      serverNow: new Date("2026-08-09T00:00:00.000Z"),
    });
    expect(result.errors.map((error) => error instanceof Error ? error.message : error)).toEqual(
      expect.arrayContaining(["due league failed"]),
    );
    expect(findSettlementTodos).toHaveBeenCalled();
    expect(beginTickCache).toHaveBeenCalledTimes(1);
    expect(endTickCache).toHaveBeenCalledTimes(1);
  });

  it("still runs settlement when dispatcher returns items_failed without throwing", async () => {
    const findSettlementTodos = vi.fn(async () => []);
    const findByStatus = vi.fn(async () => []);
    const runtime = runtimeStub({
      repo: { matches: { findSettlementTodos }, settlements: { findByStatus }, rankings: { findAll: vi.fn(async () => []) } },
      providerSources: { sources: [{ source_id: "fd" }], sync_leagues: new Set(["premier_league"]), sync_profile: "test" },
      providerRegistry: {
        beginTickCache: vi.fn(),
        endTickCache: vi.fn(),
        dueLeagues: vi.fn(async () => []),
      },
      db: {
        query: vi.fn(async (_collection: string, filter: { job_type?: string }) => {
          if (filter.job_type === SyncJobType.LiveMatch) return [];
          return [recentSuccess(filter.job_type ?? "")];
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
    });

    const result = await runScheduledJobs({ runtime, serverNow: NOW });
    expect(result.providerData).toEqual(expect.objectContaining({
      outcome: "failed",
      jobs_run: expect.arrayContaining([SyncJobType.PeriodFinalize, SyncJobType.DailyConsistency]),
      failed: [expect.objectContaining({ task: SyncJobType.LiveMatch, reason: "items_failed", items_failed: 1 })],
    }));
    expect(findSettlementTodos).toHaveBeenCalled();
    expect(result.errors).toEqual([]);
  });

  it("still runs settlement when dispatcher defers or skips without treating them as ran", async () => {
    const findSettlementTodos = vi.fn(async () => []);
    const nextAttemptAt = new Date(NOW.getTime() + 60_000);
    const runtime = runtimeStub({
      repo: { matches: { findSettlementTodos }, settlements: { findByStatus: vi.fn(async () => []) }, rankings: { findAll: vi.fn(async () => []) } },
      providerSources: { sources: [{ source_id: "fd" }], sync_leagues: new Set(["premier_league"]), sync_profile: "test" },
      providerRegistry: {
        beginTickCache: vi.fn(),
        endTickCache: vi.fn(),
        dueLeagues: vi.fn(async () => []),
      },
      db: {
        query: vi.fn(async (_collection: string, filter: { job_type?: string }) => {
          if (filter.job_type === SyncJobType.LiveMatch || filter.job_type === SyncJobType.NearMatch) return [];
          return [recentSuccess(filter.job_type ?? "")];
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
    });

    const result = await runScheduledJobs({ runtime, serverNow: NOW });
    expect(result.providerData).toEqual(expect.objectContaining({
      outcome: "completed",
      jobs_run: expect.arrayContaining([SyncJobType.PeriodFinalize, SyncJobType.DailyConsistency]),
    }));
    expect(result.providerData.deferred).toEqual([
      {
        task: SyncJobType.LiveMatch,
        next_attempt_at: nextAttemptAt.toISOString(),
        retry_attempt: 0,
        last_error_code: "ECONNRESET",
      },
    ]);
    expect(result.providerData.skipped).toEqual(expect.arrayContaining([
      { task: SyncJobType.NearMatch, reason: "lock_held" },
    ]));
    expect(findSettlementTodos).toHaveBeenCalled();
    expect(result.errors).toEqual([]);
  });
});

describe("runDueProviderJobs outcomes", () => {
  it("records completed items_failed as failed, not ran", async () => {
    const { result, dispatchRun } = await runDueLiveMatch({
      kind: "completed",
      fixtures: {
        kind: "completed",
        job_type: SyncJobType.LiveMatch,
        items_read: 2,
        items_changed: 1,
        items_failed: 1,
      },
    });
    expect(dispatchRun).toHaveBeenCalledWith(SyncJobType.LiveMatch, NOW);
    expect(result).toEqual(expect.objectContaining({
      outcome: "failed",
      jobs_run: [],
      failed: [{ task: SyncJobType.LiveMatch, reason: "items_failed", items_failed: 1 }],
      errors: [],
    }));
  });

  it("records dispatcher skipped and deferred separately from ran", async () => {
    const nextAttemptAt = new Date(NOW.getTime() + 120_000);
    const { result } = await runDueLiveMatch({
      kind: "deferred",
      fixtures: {
        kind: "deferred",
        job_type: SyncJobType.LiveMatch,
        next_attempt_at: nextAttemptAt,
        retry_attempt: 1,
        last_error_code: null,
      },
    });
    expect(result).toEqual(expect.objectContaining({
      outcome: "completed",
      jobs_run: [],
      deferred: [{
        task: SyncJobType.LiveMatch,
        next_attempt_at: nextAttemptAt.toISOString(),
        retry_attempt: 1,
        last_error_code: null,
      }],
    }));

    const skipped = await runDueLiveMatch({
      kind: "skipped",
      fixtures: { kind: "skipped", job_type: SyncJobType.LiveMatch, reason: "lock_held" },
    });
    expect(skipped.result).toEqual(expect.objectContaining({
      outcome: "completed",
      jobs_run: [],
      skipped: expect.arrayContaining([{ task: SyncJobType.LiveMatch, reason: "lock_held" }]),
    }));
  });
});

describe("planScheduledJobs", () => {
  it("prints due/skip decisions without dispatching provider work", async () => {
    const dispatcherRun = vi.fn();
    const reconcileRun = vi.fn();
    const planned = await planScheduledJobs({
      runtime: runtimeStub({
        providerDispatcher: { run: dispatcherRun },
        providerReconcile: { run: reconcileRun },
      }),
      serverNow: new Date("2026-08-09T00:00:00.000Z"),
    });
    expect(dispatcherRun).not.toHaveBeenCalled();
    expect(reconcileRun).not.toHaveBeenCalled();
    expect(planned.tasks).toEqual(expect.arrayContaining([
      { task: SyncJobType.LiveMatch, action: "skip", reason: "no_provider_sources" },
      { task: SyncJobType.ProviderReconcile, action: "skip", reason: "no_provider_sources" },
    ]));
    expect(planned.settlement).toEqual({ task: "settlement", action: "run", reason: "due" });
    expect(planned.fifteen_items_complete).toBe(true);
    expect(planned.wired_periodic_tasks).toBe(WIRED_PERIODIC_TASKS);
    expect(planned.unwired_periodic_tasks).toBe(UNWIRED_PERIODIC_TASKS);
    expect(planned.tasks).toEqual(expect.arrayContaining([
      { task: SyncJobType.PeriodFinalize, action: "run", reason: "due" },
      { task: SyncJobType.DailyConsistency, action: "run", reason: "due" },
      {
        task: SyncJobType.WeeklyLevelEval,
        action: "run",
        reason: "due",
        as_of: weeklyEvalAsOf(new Date("2026-08-09T00:00:00.000Z")).toISOString(),
      },
      { task: SyncJobType.BoardSnapshotCareer, action: "run", reason: "due" },
      { task: SyncJobType.BoardSnapshotStrength, action: "skip", reason: "inline_weekly_refresh" },
      { task: SyncJobType.BoardSnapshotSeason, action: "run", reason: "due" },
      { task: SyncJobType.BoardSnapshotSeasonFinal, action: "skip", reason: "inline_weekly_refresh" },
    ]));
  });
});

const FINALIZE_NOW = new Date("2026-08-09T16:00:00.000Z");

function makeWeekRanking(overrides: Partial<RankingEntry> = {}): RankingEntry {
  return {
    schema_version: 1,
    period_type: PeriodType.Week,
    period_key: "2026-W32",
    user_id: "00000000-0000-4000-8000-000000000091",
    period_score: 12,
    valid_predictions: 1,
    wdl_hits: 1,
    exact_hits: 1,
    last_scoring_match_at: new Date("2026-08-08T06:00:00.000Z"),
    global_rank: null,
    is_final: false,
    created_at: new Date("2026-08-08T06:00:00.000Z"),
    updated_at: new Date("2026-08-08T06:00:00.000Z"),
    ...overrides,
  };
}

describe("wired period_finalize and daily_consistency", () => {
  it("enumerates ended unfinalized weeks, persists scheduler_state, and skips the next hour", async () => {
    const repo = new InMemoryRepository();
    await repo.rankings.insert(makeWeekRanking());
    await repo.rankings.insert(makeWeekRanking({
      user_id: "00000000-0000-4000-8000-000000000092",
      period_key: "2026-W31",
      is_final: false,
    }));
    await repo.rankings.insert(makeWeekRanking({
      user_id: "00000000-0000-4000-8000-000000000093",
      period_key: "2026-W33",
    }));
    const schedulerState = new InMemorySchedulerStateStore();
    const runtime = runtimeStub({
      repo,
      schedulerState,
      periodFinalize: new PeriodFinalizeService(repo),
      dailyConsistency: {
        run: vi.fn(async () => ({
          kind: "completed",
          checked_at: FINALIZE_NOW,
          differences: [],
          skipped_active_settlement: [],
        })),
      },
    });

    const planned = await planScheduledJobs({ runtime, serverNow: FINALIZE_NOW });
    expect(planned.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        task: SyncJobType.PeriodFinalize,
        action: "run",
        due_period_keys: ["2026-W31", "2026-W32"],
      }),
    ]));

    const first = await runScheduledJobs({ runtime, serverNow: FINALIZE_NOW });
    expect(first.providerData.jobs_run).toEqual(expect.arrayContaining([
      SyncJobType.PeriodFinalize,
      SyncJobType.DailyConsistency,
    ]));
    const week32 = await repo.rankings.findByPeriod(PeriodType.Week, "2026-W32");
    const week31 = await repo.rankings.findByPeriod(PeriodType.Week, "2026-W31");
    const week33 = await repo.rankings.findByPeriod(PeriodType.Week, "2026-W33");
    expect(week32).toHaveLength(1);
    expect(week31).toHaveLength(1);
    expect(week33).toHaveLength(1);
    expect(week32).toEqual([expect.objectContaining({
      user_id: "00000000-0000-4000-8000-000000000091",
      period_key: "2026-W32",
      is_final: true,
    })]);
    expect(week31).toEqual([expect.objectContaining({
      user_id: "00000000-0000-4000-8000-000000000092",
      period_key: "2026-W31",
      is_final: true,
    })]);
    expect(week33).toEqual([expect.objectContaining({
      user_id: "00000000-0000-4000-8000-000000000093",
      period_key: "2026-W33",
      is_final: false,
    })]);
    expect(await schedulerState.getPeriodicJobCycle(SyncJobType.PeriodFinalize)).toEqual(
      expect.objectContaining({ completed_cycle_at: FINALIZE_NOW }),
    );

    const laterSameHour = new Date(FINALIZE_NOW.getTime() + 30 * 60_000);
    const secondPlan = await planScheduledJobs({ runtime, serverNow: laterSameHour });
    expect(secondPlan.tasks).toEqual(expect.arrayContaining([
      { task: SyncJobType.PeriodFinalize, action: "skip", reason: "interval_not_due" },
      { task: SyncJobType.DailyConsistency, action: "skip", reason: "interval_not_due" },
    ]));
    const second = await runScheduledJobs({ runtime, serverNow: laterSameHour });
    expect(second.providerData.jobs_run).not.toEqual(expect.arrayContaining([
      SyncJobType.PeriodFinalize,
      SyncJobType.DailyConsistency,
    ]));
    expect(await repo.rankings.findByPeriod(PeriodType.Week, "2026-W33")).toEqual(week33);
  });

  it("alerts daily_consistency mismatches without rewriting caches", async () => {
    const repo = new InMemoryRepository();
    const userId = "00000000-0000-4000-8000-000000000094";
    const schedulerState = new InMemorySchedulerStateStore();
    const dailyRun = vi.fn(async () => ({
      kind: "completed" as const,
      checked_at: FINALIZE_NOW,
      differences: [{
        scope: "career" as const,
        key: userId,
        fields: ["career_points"],
        actual: { career_points: 0 },
        expected: { career_points: 3 },
      }],
      skipped_active_settlement: [],
    }));
    const log = vi.fn();
    const runtime = runtimeStub({
      repo,
      log,
      schedulerState,
      periodFinalize: new PeriodFinalizeService(repo),
      dailyConsistency: { run: dailyRun },
    });
    const result = await runScheduledJobs({ runtime, serverNow: FINALIZE_NOW });
    expect(dailyRun).toHaveBeenCalledWith(FINALIZE_NOW);
    expect(result.providerData.jobs_run).toEqual(expect.arrayContaining([SyncJobType.DailyConsistency]));
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "daily_consistency_mismatch",
      code: "DAILY_CONSISTENCY_MISMATCH",
      difference_count: 1,
    }));
    expect(await schedulerState.getPeriodicJobCycle(SyncJobType.DailyConsistency)).toEqual(
      expect.objectContaining({ completed_cycle_at: FINALIZE_NOW }),
    );
  });
});

const WEEKLY_AS_OF = new Date("2026-08-10T02:00:00.000Z");
const WEEKLY_START = new Date("2026-08-10T02:10:00.000Z");
const BEFORE_WEEKLY_START = new Date("2026-08-10T02:09:00.000Z");
const PREV_WEEKLY_AS_OF = new Date("2026-08-03T02:00:00.000Z");
const WEEKLY_REPEAT = new Date("2026-08-10T02:20:00.000Z");
const WEEKLY_DELAYED = new Date("2026-08-10T05:00:00.000Z");

describe("wired weekly_level_eval and inline strength snapshot", () => {
  it("waits until Monday 02:10 UTC, uses as_of 02:00 UTC, refreshes strength once, and skips repeat ticks", async () => {
    const repo = new InMemoryRepository();
    const schedulerState = new InMemorySchedulerStateStore();
    await schedulerState.upsertPeriodicJobCycle({
      job_type: SyncJobType.WeeklyLevelEval,
      completed_cycle_at: PREV_WEEKLY_AS_OF,
      updated_at: PREV_WEEKLY_AS_OF,
    });
    const weeklyRun = vi.fn(async (serverNow: Date) => new WeeklyLevelEvalService(repo).run(serverNow));
    await schedulerState.upsertPeriodicJobCycle({
      job_type: SyncJobType.BoardSnapshotStrength,
      completed_cycle_at: new Date("2026-08-09T03:00:00.000Z"),
      updated_at: new Date("2026-08-09T03:00:00.000Z"),
    });
    const runtime = runtimeStub({
      repo,
      schedulerState,
      weeklyLevelEval: { run: weeklyRun },
      boardSnapshot: new BoardSnapshotService(repo),
      periodFinalize: new PeriodFinalizeService(repo),
      dailyConsistency: {
        run: vi.fn(async () => ({
          kind: "completed",
          checked_at: WEEKLY_START,
          differences: [],
          skipped_active_settlement: [],
        })),
      },
    });

    expect(weeklyEvalAsOf(BEFORE_WEEKLY_START).toISOString()).toBe(PREV_WEEKLY_AS_OF.toISOString());
    expect(weeklyEvalAsOf(WEEKLY_START).toISOString()).toBe(WEEKLY_AS_OF.toISOString());
    const earlyPlan = await planScheduledJobs({ runtime, serverNow: BEFORE_WEEKLY_START });
    expect(earlyPlan.tasks).toEqual(expect.arrayContaining([
      { task: SyncJobType.WeeklyLevelEval, action: "skip", reason: "interval_not_due" },
    ]));
    const early = await runScheduledJobs({ runtime, serverNow: BEFORE_WEEKLY_START });
    expect(weeklyRun).not.toHaveBeenCalled();
    expect(early.providerData.jobs_run ?? []).not.toContain(SyncJobType.WeeklyLevelEval);
    expect(await repo.boardSnapshots.findByBoardAndSnapshotAt(RankingBoard.Strength, BEFORE_WEEKLY_START)).toEqual([]);

    const duePlan = await planScheduledJobs({ runtime, serverNow: WEEKLY_START });
    expect(duePlan.tasks).toEqual(expect.arrayContaining([
      {
        task: SyncJobType.WeeklyLevelEval,
        action: "run",
        reason: "due",
        as_of: WEEKLY_AS_OF.toISOString(),
      },
    ]));
    expect(duePlan.wired_periodic_tasks.map((row) => row.task)).toContain(SyncJobType.BoardSnapshotStrength);
    expect(duePlan.wired_periodic_tasks.map((row) => row.task)).toContain(SyncJobType.BoardSnapshotSeasonFinal);
    expect(duePlan.unwired_periodic_tasks).toEqual([]);
    expect(duePlan.tasks).toEqual(expect.arrayContaining([
      { task: SyncJobType.BoardSnapshotStrength, action: "skip", reason: "inline_weekly_refresh" },
      { task: SyncJobType.BoardSnapshotSeasonFinal, action: "skip", reason: "inline_weekly_refresh" },
    ]));
    const first = await runScheduledJobs({ runtime, serverNow: WEEKLY_START });
    expect(weeklyRun).toHaveBeenCalledTimes(1);
    expect(weeklyRun).toHaveBeenCalledWith(WEEKLY_START);
    expect(first.providerData.jobs_run).toEqual(expect.arrayContaining([SyncJobType.WeeklyLevelEval]));
    expect(first.providerData.jobs_run ?? []).not.toContain(SyncJobType.BoardSnapshotStrength);
    expect(first.providerData.jobs_run ?? []).not.toContain(SyncJobType.BoardSnapshotSeasonFinal);
    expect(await repo.boardSnapshots.findByBoardAndSnapshotAt(RankingBoard.Strength, WEEKLY_START)).toEqual([
      expect.objectContaining({ snapshot_kind: "head", snapshot_at: WEEKLY_START }),
    ]);
    expect(await schedulerState.getPeriodicJobCycle(SyncJobType.WeeklyLevelEval)).toEqual(
      expect.objectContaining({ completed_cycle_at: WEEKLY_AS_OF, updated_at: WEEKLY_START }),
    );
    expect(await schedulerState.getPeriodicJobCycle(SyncJobType.BoardSnapshotStrength)).toEqual(
      expect.objectContaining({ completed_cycle_at: WEEKLY_START, updated_at: WEEKLY_START }),
    );

    const repeatPlan = await planScheduledJobs({ runtime, serverNow: WEEKLY_REPEAT });
    expect(repeatPlan.tasks).toEqual(expect.arrayContaining([
      { task: SyncJobType.WeeklyLevelEval, action: "skip", reason: "interval_not_due" },
      { task: SyncJobType.BoardSnapshotStrength, action: "skip", reason: "interval_not_due" },
      { task: SyncJobType.BoardSnapshotSeasonFinal, action: "skip", reason: "no_due_season" },
    ]));
    const repeat = await runScheduledJobs({ runtime, serverNow: WEEKLY_REPEAT });
    expect(weeklyRun).toHaveBeenCalledTimes(1);
    expect(repeat.providerData.jobs_run ?? []).not.toContain(SyncJobType.WeeklyLevelEval);
    expect(repeat.providerData.jobs_run ?? []).not.toContain(SyncJobType.BoardSnapshotStrength);
    expect(await repo.boardSnapshots.findByBoardAndSnapshotAt(RankingBoard.Strength, WEEKLY_REPEAT)).toEqual([]);
    expect(await repo.boardSnapshots.findByBoardAndSnapshotAt(RankingBoard.Strength, WEEKLY_START)).toHaveLength(1);
  });

  it("keeps delayed ticks on the Monday 02:00 UTC as_of and does not mark a skipped lock", async () => {
    const repo = new InMemoryRepository();
    const schedulerState = new InMemorySchedulerStateStore();
    const lockHeld = vi.fn(async () => ({
      kind: "skipped" as const,
      as_of: WEEKLY_AS_OF,
      evaluated_count: 0,
      changed_count: 0,
      skipped_count: 0,
    }));
    const lockedRuntime = runtimeStub({
      repo,
      schedulerState,
      weeklyLevelEval: { run: lockHeld },
    });
    const locked = await runScheduledJobs({ runtime: lockedRuntime, serverNow: WEEKLY_DELAYED });
    expect(lockHeld).toHaveBeenCalledWith(WEEKLY_DELAYED);
    expect(locked.providerData.skipped).toEqual(expect.arrayContaining([
      { task: SyncJobType.WeeklyLevelEval, reason: "lock_held" },
    ]));
    expect(await schedulerState.getPeriodicJobCycle(SyncJobType.WeeklyLevelEval)).toBeNull();

    const weeklyRun = vi.fn(async (serverNow: Date) => new WeeklyLevelEvalService(repo).run(serverNow));
    const runtime = runtimeStub({
      repo,
      schedulerState,
      weeklyLevelEval: { run: weeklyRun },
      boardSnapshot: new BoardSnapshotService(repo),
    });
    const delayedPlan = await planScheduledJobs({ runtime, serverNow: WEEKLY_DELAYED });
    expect(delayedPlan.tasks).toEqual(expect.arrayContaining([
      {
        task: SyncJobType.WeeklyLevelEval,
        action: "run",
        reason: "due",
        as_of: WEEKLY_AS_OF.toISOString(),
      },
    ]));
    const delayed = await runScheduledJobs({ runtime, serverNow: WEEKLY_DELAYED });
    expect(weeklyRun).toHaveBeenCalledWith(WEEKLY_DELAYED);
    expect(delayed.providerData.jobs_run).toEqual(expect.arrayContaining([SyncJobType.WeeklyLevelEval]));
    expect(delayed.providerData.jobs_run ?? []).not.toContain(SyncJobType.BoardSnapshotStrength);
    expect(delayed.providerData.jobs_run ?? []).not.toContain(SyncJobType.BoardSnapshotSeasonFinal);
    expect(await repo.boardSnapshots.findByBoardAndSnapshotAt(RankingBoard.Strength, WEEKLY_DELAYED)).toEqual([
      expect.objectContaining({ snapshot_kind: "head", snapshot_at: WEEKLY_DELAYED }),
    ]);
    expect(await schedulerState.getPeriodicJobCycle(SyncJobType.WeeklyLevelEval)).toEqual(
      expect.objectContaining({ completed_cycle_at: WEEKLY_AS_OF, updated_at: WEEKLY_DELAYED }),
    );
    expect(await schedulerState.getPeriodicJobCycle(SyncJobType.BoardSnapshotStrength)).toEqual(
      expect.objectContaining({ completed_cycle_at: WEEKLY_DELAYED, updated_at: WEEKLY_DELAYED }),
    );
  });
});

const SNAPSHOT_T0 = new Date("2026-08-11T12:00:00.000Z");
const SNAPSHOT_PLUS_30M = new Date(SNAPSHOT_T0.getTime() + 30 * 60_000);
const SNAPSHOT_PLUS_60M = new Date(SNAPSHOT_T0.getTime() + 60 * 60_000);
const SNAPSHOT_PLUS_24H = new Date(SNAPSHOT_T0.getTime() + 24 * 60 * 60_000);

describe("wired career/season hourly and strength daily snapshots", () => {
  it("runs career and season hourly, strength daily, and does not refresh strength again in the weekly tick", async () => {
    const repo = new InMemoryRepository();
    const schedulerState = new InMemorySchedulerStateStore();
    await schedulerState.upsertPeriodicJobCycle({
      job_type: SyncJobType.WeeklyLevelEval,
      completed_cycle_at: weeklyEvalAsOf(SNAPSHOT_T0),
      updated_at: SNAPSHOT_T0,
    });
    const runtime = runtimeStub({
      repo,
      schedulerState,
      boardSnapshot: new BoardSnapshotService(repo),
      weeklyLevelEval: { run: vi.fn(async (serverNow: Date) => new WeeklyLevelEvalService(repo).run(serverNow)) },
      periodFinalize: new PeriodFinalizeService(repo),
      dailyConsistency: {
        run: vi.fn(async () => ({
          kind: "completed",
          checked_at: SNAPSHOT_T0,
          differences: [],
          skipped_active_settlement: [],
        })),
      },
    });

    const firstPlan = await planScheduledJobs({ runtime, serverNow: SNAPSHOT_T0 });
    expect(firstPlan.tasks).toEqual(expect.arrayContaining([
      { task: SyncJobType.BoardSnapshotCareer, action: "run", reason: "due" },
      { task: SyncJobType.BoardSnapshotSeason, action: "run", reason: "due" },
      { task: SyncJobType.BoardSnapshotStrength, action: "run", reason: "due" },
      { task: SyncJobType.WeeklyLevelEval, action: "skip", reason: "interval_not_due" },
    ]));
    expect(firstPlan.unwired_periodic_tasks).toEqual([]);
    expect(firstPlan.fifteen_items_complete).toBe(true);
    expect(firstPlan.tasks).toEqual(expect.arrayContaining([
      { task: SyncJobType.BoardSnapshotSeasonFinal, action: "skip", reason: "no_due_season" },
    ]));
    const first = await runScheduledJobs({ runtime, serverNow: SNAPSHOT_T0 });
    expect(first.providerData.jobs_run).toEqual(expect.arrayContaining([
      SyncJobType.BoardSnapshotCareer,
      SyncJobType.BoardSnapshotSeason,
      SyncJobType.BoardSnapshotStrength,
    ]));
    expect(first.providerData.jobs_run ?? []).not.toContain(SyncJobType.WeeklyLevelEval);
    expect(await repo.boardSnapshots.findByBoardAndSnapshotAt(RankingBoard.Career, SNAPSHOT_T0)).toEqual([
      expect.objectContaining({ snapshot_kind: "head", snapshot_at: SNAPSHOT_T0 }),
    ]);
    expect(await repo.boardSnapshots.findByBoardAndSnapshotAt(RankingBoard.Season, SNAPSHOT_T0)).toEqual([
      expect.objectContaining({ snapshot_kind: "head", snapshot_at: SNAPSHOT_T0 }),
    ]);
    expect(await repo.boardSnapshots.findByBoardAndSnapshotAt(RankingBoard.Strength, SNAPSHOT_T0)).toEqual([
      expect.objectContaining({ snapshot_kind: "head", snapshot_at: SNAPSHOT_T0 }),
    ]);

    const plus30Plan = await planScheduledJobs({ runtime, serverNow: SNAPSHOT_PLUS_30M });
    expect(plus30Plan.tasks).toEqual(expect.arrayContaining([
      { task: SyncJobType.BoardSnapshotCareer, action: "skip", reason: "interval_not_due" },
      { task: SyncJobType.BoardSnapshotSeason, action: "skip", reason: "interval_not_due" },
      { task: SyncJobType.BoardSnapshotStrength, action: "skip", reason: "interval_not_due" },
    ]));
    const plus30 = await runScheduledJobs({ runtime, serverNow: SNAPSHOT_PLUS_30M });
    expect(plus30.providerData.jobs_run ?? []).not.toContain(SyncJobType.BoardSnapshotCareer);
    expect(plus30.providerData.jobs_run ?? []).not.toContain(SyncJobType.BoardSnapshotSeason);
    expect(plus30.providerData.jobs_run ?? []).not.toContain(SyncJobType.BoardSnapshotStrength);
    expect(await repo.boardSnapshots.findByBoardAndSnapshotAt(RankingBoard.Career, SNAPSHOT_PLUS_30M)).toEqual([]);

    const plus60Plan = await planScheduledJobs({ runtime, serverNow: SNAPSHOT_PLUS_60M });
    expect(plus60Plan.tasks).toEqual(expect.arrayContaining([
      { task: SyncJobType.BoardSnapshotCareer, action: "run", reason: "due" },
      { task: SyncJobType.BoardSnapshotSeason, action: "run", reason: "due" },
      { task: SyncJobType.BoardSnapshotStrength, action: "skip", reason: "interval_not_due" },
    ]));
    const plus60 = await runScheduledJobs({ runtime, serverNow: SNAPSHOT_PLUS_60M });
    expect(plus60.providerData.jobs_run).toEqual(expect.arrayContaining([
      SyncJobType.BoardSnapshotCareer,
      SyncJobType.BoardSnapshotSeason,
    ]));
    expect(plus60.providerData.jobs_run ?? []).not.toContain(SyncJobType.BoardSnapshotStrength);
    expect(await repo.boardSnapshots.findByBoardAndSnapshotAt(RankingBoard.Career, SNAPSHOT_PLUS_60M)).toHaveLength(1);
    expect(await repo.boardSnapshots.findByBoardAndSnapshotAt(RankingBoard.Season, SNAPSHOT_PLUS_60M)).toHaveLength(1);
    expect(await repo.boardSnapshots.findByBoardAndSnapshotAt(RankingBoard.Strength, SNAPSHOT_PLUS_60M)).toEqual([]);

    const plus24Plan = await planScheduledJobs({ runtime, serverNow: SNAPSHOT_PLUS_24H });
    expect(plus24Plan.tasks).toEqual(expect.arrayContaining([
      { task: SyncJobType.BoardSnapshotCareer, action: "run", reason: "due" },
      { task: SyncJobType.BoardSnapshotSeason, action: "run", reason: "due" },
      { task: SyncJobType.BoardSnapshotStrength, action: "run", reason: "due" },
    ]));
    const plus24 = await runScheduledJobs({ runtime, serverNow: SNAPSHOT_PLUS_24H });
    expect(plus24.providerData.jobs_run).toEqual(expect.arrayContaining([
      SyncJobType.BoardSnapshotCareer,
      SyncJobType.BoardSnapshotSeason,
      SyncJobType.BoardSnapshotStrength,
    ]));
    expect(await repo.boardSnapshots.findByBoardAndSnapshotAt(RankingBoard.Strength, SNAPSHOT_PLUS_24H)).toHaveLength(1);
  });
});

const SEASON_FINAL_BEFORE = new Date("2026-06-29T02:20:00.000Z");
const SEASON_FINAL_START = new Date("2026-07-06T02:10:00.000Z");
const SEASON_FINAL_AS_OF = new Date("2026-07-06T02:00:00.000Z");
const SEASON_FINAL_REPEAT = new Date("2026-07-06T02:20:00.000Z");
const SEASON_FINAL_CATCHUP = new Date("2026-08-10T12:00:00.000Z");

function makeSnapshotUser(userId: string): User {
  return {
    schema_version: 1,
    user_id: userId,
    openid: `openid_${userId}`,
    unionid: null,
    nickname: userId,
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
    created_at: SEASON_FINAL_BEFORE,
    updated_at: SEASON_FINAL_BEFORE,
  };
}

function makeSnapshotSeasonStats(userId: string, overrides: Partial<UserSeasonStats> = {}): UserSeasonStats {
  return {
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
    created_at: SEASON_FINAL_BEFORE,
    updated_at: SEASON_FINAL_BEFORE,
    ...overrides,
  };
}

describe("wired board_snapshot_season_final event", () => {
  it("does not freeze before the first weekly eval after season end, then writes is_final rows and stays idempotent", async () => {
    const repo = new InMemoryRepository();
    const schedulerState = new InMemorySchedulerStateStore();
    const user = makeSnapshotUser("00000000-0000-4000-8000-000000000201");
    await repo.users.insert(user);
    await repo.userSeasonStats.insert(makeSnapshotSeasonStats(user.user_id));
    await schedulerState.upsertPeriodicJobCycle({
      job_type: SyncJobType.WeeklyLevelEval,
      completed_cycle_at: weeklyEvalAsOf(SEASON_FINAL_BEFORE),
      updated_at: SEASON_FINAL_BEFORE,
    });
    const runtime = runtimeStub({
      repo,
      schedulerState,
      boardSnapshot: new BoardSnapshotService(repo),
      weeklyLevelEval: { run: vi.fn(async (serverNow: Date) => new WeeklyLevelEvalService(repo).run(serverNow)) },
      periodFinalize: new PeriodFinalizeService(repo),
      dailyConsistency: {
        run: vi.fn(async () => ({
          kind: "completed",
          checked_at: SEASON_FINAL_BEFORE,
          differences: [],
          skipped_active_settlement: [],
        })),
      },
    });

    const beforePlan = await planScheduledJobs({ runtime, serverNow: SEASON_FINAL_BEFORE });
    expect(beforePlan.tasks).toEqual(expect.arrayContaining([
      { task: SyncJobType.WeeklyLevelEval, action: "skip", reason: "interval_not_due" },
      { task: SyncJobType.BoardSnapshotSeasonFinal, action: "skip", reason: "no_due_season" },
      { task: SyncJobType.BoardSnapshotSeason, action: "run", reason: "due" },
    ]));
    const before = await runScheduledJobs({ runtime, serverNow: SEASON_FINAL_BEFORE });
    expect(before.providerData.jobs_run ?? []).not.toContain(SyncJobType.BoardSnapshotSeasonFinal);
    expect(before.providerData.jobs_run).toEqual(expect.arrayContaining([SyncJobType.BoardSnapshotSeason]));
    expect(await repo.boardSnapshots.findFinalBySeason("2025_2026")).toEqual([]);
    expect(await repo.boardSnapshots.findByBoardAndSnapshotAt(RankingBoard.Season, SEASON_FINAL_BEFORE)).toEqual([
      expect.objectContaining({ is_final: false, snapshot_at: SEASON_FINAL_BEFORE, level_season_id: "2025_2026" }),
    ]);

    const duePlan = await planScheduledJobs({ runtime, serverNow: SEASON_FINAL_START });
    expect(duePlan.tasks).toEqual(expect.arrayContaining([
      {
        task: SyncJobType.WeeklyLevelEval,
        action: "run",
        reason: "due",
        as_of: SEASON_FINAL_AS_OF.toISOString(),
      },
      { task: SyncJobType.BoardSnapshotSeasonFinal, action: "skip", reason: "inline_weekly_refresh" },
      { task: SyncJobType.BoardSnapshotSeason, action: "run", reason: "due" },
    ]));
    const first = await runScheduledJobs({ runtime, serverNow: SEASON_FINAL_START });
    expect(first.providerData.jobs_run).toEqual(expect.arrayContaining([SyncJobType.WeeklyLevelEval]));
    expect(first.providerData.jobs_run ?? []).not.toContain(SyncJobType.BoardSnapshotSeasonFinal);
    const finals = await repo.boardSnapshots.findFinalBySeason("2025_2026");
    expect(finals).toEqual([
      expect.objectContaining({
        is_final: true,
        level_season_id: "2025_2026",
        user_id: user.user_id,
        season_points: 48,
        snapshot_at: SEASON_FINAL_AS_OF,
      }),
    ]);
    expect(await schedulerState.getPeriodicJobCycle(SyncJobType.BoardSnapshotSeasonFinal)).toEqual(
      expect.objectContaining({ completed_cycle_at: SEASON_FINAL_START }),
    );

    await repo.userSeasonStats.update({
      ...(await repo.userSeasonStats.findByUserAndSeason(user.user_id, "2025_2026"))!,
      points: 60,
      updated_at: SEASON_FINAL_REPEAT,
    });
    const repeatPlan = await planScheduledJobs({ runtime, serverNow: SEASON_FINAL_REPEAT });
    expect(repeatPlan.tasks).toEqual(expect.arrayContaining([
      { task: SyncJobType.WeeklyLevelEval, action: "skip", reason: "interval_not_due" },
      { task: SyncJobType.BoardSnapshotSeasonFinal, action: "skip", reason: "no_due_season" },
    ]));
    const repeat = await runScheduledJobs({ runtime, serverNow: SEASON_FINAL_REPEAT });
    expect(repeat.providerData.jobs_run ?? []).not.toContain(SyncJobType.BoardSnapshotSeasonFinal);
    expect(await repo.boardSnapshots.findFinalBySeason("2025_2026")).toEqual(finals);
  });

  it("catch-up generates a missed season final without using a regular season snapshot", async () => {
    const repo = new InMemoryRepository();
    const schedulerState = new InMemorySchedulerStateStore();
    const user = makeSnapshotUser("00000000-0000-4000-8000-000000000202");
    await repo.users.insert(user);
    await repo.userSeasonStats.insert(makeSnapshotSeasonStats(user.user_id, { is_level_frozen: true }));
    await schedulerState.upsertPeriodicJobCycle({
      job_type: SyncJobType.WeeklyLevelEval,
      completed_cycle_at: weeklyEvalAsOf(SEASON_FINAL_CATCHUP),
      updated_at: SEASON_FINAL_CATCHUP,
    });
    const generate = vi.fn(async () => []);
    const generateSeasonFinal = vi.fn(async (levelSeasonId: string, serverNow: Date) =>
      new BoardSnapshotService(repo).generateSeasonFinal(levelSeasonId, serverNow),
    );
    const runtime = runtimeStub({
      repo,
      schedulerState,
      boardSnapshot: { generate, generateSeasonFinal },
      weeklyLevelEval: { run: vi.fn(async (serverNow: Date) => new WeeklyLevelEvalService(repo).run(serverNow)) },
      periodFinalize: new PeriodFinalizeService(repo),
      dailyConsistency: {
        run: vi.fn(async () => ({
          kind: "completed",
          checked_at: SEASON_FINAL_CATCHUP,
          differences: [],
          skipped_active_settlement: [],
        })),
      },
    });

    const plan = await planScheduledJobs({ runtime, serverNow: SEASON_FINAL_CATCHUP });
    expect(plan.tasks).toEqual(expect.arrayContaining([
      { task: SyncJobType.WeeklyLevelEval, action: "skip", reason: "interval_not_due" },
      {
        task: SyncJobType.BoardSnapshotSeasonFinal,
        action: "run",
        reason: "due",
        due_level_season_ids: ["2025_2026"],
      },
    ]));
    const result = await runScheduledJobs({ runtime, serverNow: SEASON_FINAL_CATCHUP });
    expect(result.providerData.jobs_run).toEqual(expect.arrayContaining([SyncJobType.BoardSnapshotSeasonFinal]));
    expect(generateSeasonFinal).toHaveBeenCalledWith("2025_2026", SEASON_FINAL_CATCHUP);
    expect(generate).not.toHaveBeenCalledWith("2025_2026", SEASON_FINAL_CATCHUP);
    expect(await repo.boardSnapshots.findFinalBySeason("2025_2026")).toEqual([
      expect.objectContaining({
        is_final: true,
        level_season_id: "2025_2026",
        season_points: 48,
        snapshot_at: SEASON_FINAL_AS_OF,
      }),
    ]);
    expect(await repo.boardSnapshots.findByBoardAndSnapshotAt(RankingBoard.Season, SEASON_FINAL_AS_OF)).toEqual([]);
  });

  it("does not catch-up an immutable season final when that season's final eval has not frozen levels", async () => {
    const repo = new InMemoryRepository();
    const schedulerState = new InMemorySchedulerStateStore();
    const user = makeSnapshotUser("00000000-0000-4000-8000-000000000203");
    await repo.users.insert(user);
    await repo.userSeasonStats.insert(makeSnapshotSeasonStats(user.user_id, { is_level_frozen: false }));
    await schedulerState.upsertPeriodicJobCycle({
      job_type: SyncJobType.WeeklyLevelEval,
      completed_cycle_at: weeklyEvalAsOf(SEASON_FINAL_CATCHUP),
      updated_at: SEASON_FINAL_CATCHUP,
    });
    const generateSeasonFinal = vi.fn(async (levelSeasonId: string, serverNow: Date) =>
      new BoardSnapshotService(repo).generateSeasonFinal(levelSeasonId, serverNow),
    );
    const runtime = runtimeStub({
      repo,
      schedulerState,
      boardSnapshot: { generate: vi.fn(async () => []), generateSeasonFinal },
      weeklyLevelEval: { run: vi.fn(async (serverNow: Date) => new WeeklyLevelEvalService(repo).run(serverNow)) },
      periodFinalize: new PeriodFinalizeService(repo),
      dailyConsistency: {
        run: vi.fn(async () => ({
          kind: "completed",
          checked_at: SEASON_FINAL_CATCHUP,
          differences: [],
          skipped_active_settlement: [],
        })),
      },
    });

    const plan = await planScheduledJobs({ runtime, serverNow: SEASON_FINAL_CATCHUP });
    expect(plan.tasks).toEqual(expect.arrayContaining([
      { task: SyncJobType.WeeklyLevelEval, action: "skip", reason: "interval_not_due" },
      { task: SyncJobType.BoardSnapshotSeasonFinal, action: "skip", reason: "no_due_season" },
    ]));
    const result = await runScheduledJobs({ runtime, serverNow: SEASON_FINAL_CATCHUP });
    expect(result.providerData.jobs_run ?? []).not.toContain(SyncJobType.BoardSnapshotSeasonFinal);
    expect(generateSeasonFinal).not.toHaveBeenCalled();
    expect(await repo.boardSnapshots.findFinalBySeason("2025_2026")).toEqual([]);
  });

  it("does not generate a season final when weekly eval is lock-skipped across a season boundary", async () => {
    const repo = new InMemoryRepository();
    const schedulerState = new InMemorySchedulerStateStore();
    const user = makeSnapshotUser("00000000-0000-4000-8000-000000000204");
    await repo.users.insert(user);
    await repo.userSeasonStats.insert(makeSnapshotSeasonStats(user.user_id, { is_level_frozen: false }));
    const generateSeasonFinal = vi.fn(async (levelSeasonId: string, serverNow: Date) =>
      new BoardSnapshotService(repo).generateSeasonFinal(levelSeasonId, serverNow),
    );
    const lockHeld = vi.fn(async () => ({
      kind: "skipped" as const,
      as_of: SEASON_FINAL_AS_OF,
      evaluated_count: 0,
      changed_count: 0,
      skipped_count: 0,
    }));
    const runtime = runtimeStub({
      repo,
      schedulerState,
      boardSnapshot: { generate: vi.fn(async () => []), generateSeasonFinal },
      weeklyLevelEval: { run: lockHeld },
      periodFinalize: new PeriodFinalizeService(repo),
      dailyConsistency: {
        run: vi.fn(async () => ({
          kind: "completed",
          checked_at: SEASON_FINAL_START,
          differences: [],
          skipped_active_settlement: [],
        })),
      },
    });

    const result = await runScheduledJobs({ runtime, serverNow: SEASON_FINAL_START });
    expect(lockHeld).toHaveBeenCalledWith(SEASON_FINAL_START);
    expect(result.providerData.skipped).toEqual(expect.arrayContaining([
      { task: SyncJobType.WeeklyLevelEval, reason: "lock_held" },
    ]));
    expect(result.providerData.jobs_run ?? []).not.toContain(SyncJobType.BoardSnapshotSeasonFinal);
    expect(generateSeasonFinal).not.toHaveBeenCalled();
    expect(await schedulerState.getPeriodicJobCycle(SyncJobType.WeeklyLevelEval)).toBeNull();
    expect(await schedulerState.getPeriodicJobCycle(SyncJobType.BoardSnapshotSeasonFinal)).toBeNull();
    expect(await repo.boardSnapshots.findFinalBySeason("2025_2026")).toEqual([]);
  });
});
