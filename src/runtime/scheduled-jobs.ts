import { PeriodType, RankingBoard, SyncJobType } from "../domain/enums.js";
import { DomainError } from "../domain/errors.js";
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { newUuid } from "../domain/ids.js";
import { cloudBaseCollectionName, type CloudBaseDb } from "../infrastructure/cloudbase-db.js";
import { failedJobCooldownMs, LEAGUE_SEASONS_MAINTENANCE_INTERVAL_MINUTES, providerJobIntervalMs, SYNC_TASKS_V1 } from "../sync/config.js";
import { startJobLockRenewal, type ProviderFixtureFailureDiagnostic } from "../application/provider-sync-job.js";
import type { ProviderReconcileService } from "../application/provider-reconcile.js";
import type { ProviderStaleRecoveryService } from "../application/provider-stale-recovery.js";
import { runSettlementTimer, type SettlementTimerOutcome } from "../application/settlement-timer.js";
import { ProviderSyncDispatcher, type ProviderSyncJobType, type ProviderSyncOutcome } from "../application/provider-sync-dispatcher.js";
import { DAILY_CONSISTENCY_MISMATCH_CODE } from "../application/daily-consistency-service.js";
import { listDueWeekPeriodKeys } from "../application/period-finalize.js";
import { listDueSeasonFinalIds, weeklyEvalAsOf } from "../application/weekly-level-eval.js";
import type { ProviderRegistry } from "../provider/registry.js";
import type { ProviderSourceId } from "../provider/sources.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import type { ApplicationRuntime } from "./application-runtime.js";
import type { LeagueSeasonMaintenanceResult } from "../application/league-season-maintenance.js";

export const TIMER_TASK_TYPES = [
  SyncJobType.PostFinishVerify,
  SyncJobType.LiveMatch,
  SyncJobType.NearMatch,
  SyncJobType.FutureSchedule,
  SyncJobType.FullScheduleVerify,
  SyncJobType.ProviderReconcile,
  SyncJobType.StaleRecovery,
  "settlement",
  SyncJobType.PeriodFinalize,
  SyncJobType.DailyConsistency,
  SyncJobType.WeeklyLevelEval,
  SyncJobType.BoardSnapshotCareer,
  SyncJobType.BoardSnapshotStrength,
  SyncJobType.BoardSnapshotSeason,
  SyncJobType.BoardSnapshotSeasonFinal,
] as const;

export const WIRED_PERIODIC_TASKS = [
  {
    task: SyncJobType.PeriodFinalize,
    status: "wired",
    intervalHours: 1,
    note: "hourly enumerate ended unfinalized weeks; catch-up after downtime",
  },
  {
    task: SyncJobType.DailyConsistency,
    status: "wired",
    intervalHours: 24,
    note: "daily cache check; mismatch alerts only, no silent ledger repair",
  },
  {
    task: SyncJobType.WeeklyLevelEval,
    status: "wired",
    note: "Monday 02:10 UTC; as_of Monday 02:00 UTC; strength snapshot on success, no second event",
  },
  {
    task: SyncJobType.LevelCorrectionReeval,
    status: "wired",
    intervalMinutes: SYNC_TASKS_V1[SyncJobType.LevelCorrectionReeval].intervalMinutes ?? 15,
    note: "intra-week compensation scan for pending correction re-evaluation",
  },
  {
    task: SyncJobType.BoardSnapshotCareer,
    status: "wired",
    intervalMinutes: FIXED_CONFIG_V1.CAREER_BOARD_SNAPSHOT_MINUTES,
    note: "hourly career board snapshot via BoardSnapshotService",
  },
  {
    task: SyncJobType.BoardSnapshotStrength,
    status: "wired",
    intervalHours: 24,
    note: "daily 24h strength snapshot; weekly success refreshes inline, no second event",
  },
  {
    task: SyncJobType.BoardSnapshotSeason,
    status: "wired",
    intervalMinutes: FIXED_CONFIG_V1.SEASON_BOARD_SNAPSHOT_MINUTES,
    note: "hourly season board snapshot via BoardSnapshotService",
  },
  {
    task: SyncJobType.BoardSnapshotSeasonFinal,
    status: "wired",
    note: "event after season final eval; generateSeasonFinal, not regular season snapshot",
  },
] as const;

export const UNWIRED_PERIODIC_TASKS = [] as const;

export const SETTLEMENT_ORCHESTRATION_TASKS = [
  {
    task: SyncJobType.LevelCorrectionReeval,
    status: "wired_via_settlement",
    note: "event trigger from settlement orchestration; periodic pending compensation scan runs separately",
  },
] as const;

export function isProviderSyncJobType(value: unknown): value is ProviderSyncJobType {
  return value === SyncJobType.FutureSchedule ||
    value === SyncJobType.FullScheduleVerify ||
    value === SyncJobType.NearMatch ||
    value === SyncJobType.LiveMatch ||
    value === SyncJobType.PostFinishVerify;
}

export interface RunDueProviderJobsInput {
  cloudDb: CloudBaseDb;
  /** 资源命名空间：底层适配器收的是物理集合名，这里必须自己拼前缀。 */
  namespace: string;
  dispatcher: ProviderSyncDispatcher;
  providerRegistry: ProviderRegistry;
  syncLeagueIds: readonly string[];
  sourceIds: readonly ProviderSourceId[];
  profile: "test" | "prod";
  reconcile: ProviderReconcileService;
  staleRecovery: ProviderStaleRecoveryService;
  serverNow: Date;
  log: (entry: Record<string, unknown>) => void;
}

export type DueJobDecision =
  | { task: string; action: "run"; reason: "due"; league_id?: string; due_period_keys?: string[]; due_level_season_ids?: string[]; as_of?: string }
  | { task: string; action: "skip"; reason: string };

const PROVIDER_SYNC_JOBS: ProviderSyncJobType[] = [
  SyncJobType.PostFinishVerify,
  SyncJobType.LiveMatch,
  SyncJobType.NearMatch,
  SyncJobType.FutureSchedule,
  SyncJobType.FullScheduleVerify,
];

function toEpochMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") return Date.parse(String(value));
  return Number.NaN;
}

async function latestSyncLog(
  db: CloudBaseDb,
  namespace: string,
  jobType: string,
): Promise<Record<string, unknown> | undefined> {
  const logs = await db.query(cloudBaseCollectionName(namespace, "sync_logs"), { job_type: jobType }, {
    order_by: "started_at",
    direction: "desc",
    limit: 1,
  });
  return logs[0];
}

function intervalSkip(
  last: Record<string, unknown> | undefined,
  serverNow: Date,
  intervalMs: number,
  failedCooldownMs: number,
): string | undefined {
  const lastStartedMs = toEpochMs(last?.started_at);
  if (last?.status === "deferred") {
    const nextAtMs = toEpochMs(last.next_attempt_at);
    if (Number.isFinite(nextAtMs) && serverNow.getTime() < nextAtMs) return "deferred_not_due";
    return undefined;
  }
  const leaseExpired =
    last?.status === "running" &&
    Number.isFinite(lastStartedMs) &&
    serverNow.getTime() - lastStartedMs >= FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60_000;
  const effectiveStatus = leaseExpired ? "failed" : last?.status;
  // failed / 超过租约的僵死 running 不被整个周期锁死：按 exhaustedRetryMinutes 收敛重试。
  const effectiveIntervalMs = effectiveStatus === "failed" ? failedCooldownMs : intervalMs;
  if (Number.isFinite(lastStartedMs) && serverNow.getTime() - lastStartedMs < effectiveIntervalMs) {
    return effectiveStatus === "failed" ? "failed_cooldown" : "interval_not_due";
  }
  return undefined;
}

export async function planDueProviderJobs(input: {
  cloudDb: CloudBaseDb;
  namespace: string;
  providerRegistry: Pick<ProviderRegistry, "dueLeagues">;
  syncLeagueIds: readonly string[];
  sourceIds: readonly ProviderSourceId[];
  profile: "test" | "prod";
  serverNow: Date;
}): Promise<DueJobDecision[]> {
  const decisions: DueJobDecision[] = [];
  if (input.sourceIds.length === 0) {
    for (const jobType of PROVIDER_SYNC_JOBS) {
      decisions.push({ task: jobType, action: "skip", reason: "no_provider_sources" });
    }
    decisions.push({ task: SyncJobType.ProviderReconcile, action: "skip", reason: "no_provider_sources" });
    decisions.push({ task: SyncJobType.StaleRecovery, action: "skip", reason: "no_provider_sources" });
    return decisions;
  }

  for (const jobType of PROVIDER_SYNC_JOBS) {
    if (jobType === SyncJobType.FutureSchedule || jobType === SyncJobType.FullScheduleVerify) {
      const dueLeagues = await input.providerRegistry.dueLeagues(
        input.syncLeagueIds,
        jobType,
        input.serverNow,
        providerJobIntervalMs(jobType, input.profile),
      );
      if (dueLeagues.length === 0) {
        decisions.push({ task: jobType, action: "skip", reason: "no_due_league" });
        continue;
      }
      for (const leagueId of dueLeagues) {
        decisions.push({ task: jobType, action: "run", reason: "due", league_id: leagueId });
      }
      continue;
    }
    const last = await latestSyncLog(input.cloudDb, input.namespace, jobType);
    const skipReason = intervalSkip(
      last,
      input.serverNow,
      providerJobIntervalMs(jobType, input.profile),
      failedJobCooldownMs(jobType, input.profile),
    );
    if (skipReason !== undefined) {
      decisions.push({ task: jobType, action: "skip", reason: skipReason });
      continue;
    }
    decisions.push({ task: jobType, action: "run", reason: "due" });
  }

  const lastReconcile = await latestSyncLog(input.cloudDb, input.namespace, SyncJobType.ProviderReconcile);
  const reconcileSkip = intervalSkip(
    lastReconcile,
    input.serverNow,
    providerJobIntervalMs(SyncJobType.ProviderReconcile, input.profile),
    failedJobCooldownMs(SyncJobType.ProviderReconcile, input.profile),
  );
  decisions.push(reconcileSkip === undefined
    ? { task: SyncJobType.ProviderReconcile, action: "run", reason: "due" }
    : { task: SyncJobType.ProviderReconcile, action: "skip", reason: reconcileSkip });
  const lastRecovery = await latestSyncLog(input.cloudDb, input.namespace, SyncJobType.StaleRecovery);
  const recoveryInterval = providerJobIntervalMs(SyncJobType.StaleRecovery, input.profile);
  // 延期待办可能早于 next_attempt_at 到期，但恢复任务本身仍受「每自然小时最多一次」约束，
  // 因此间隔判定必须独立于 deferred 分支。
  const recoverySkip = intervalSkip(lastRecovery, input.serverNow, recoveryInterval, failedJobCooldownMs(SyncJobType.StaleRecovery, input.profile))
    ?? (input.serverNow.getTime() - toEpochMs(lastRecovery?.started_at) < recoveryInterval ? "interval_not_due" : undefined);
  decisions.push(recoverySkip === undefined
    ? { task: SyncJobType.StaleRecovery, action: "run", reason: "due" }
    : { task: SyncJobType.StaleRecovery, action: "skip", reason: recoverySkip });
  return decisions;
}

function intervalMinutesMs(intervalMinutes: number): number {
  return intervalMinutes * 60_000;
}

function cycleSkip(lastCompleted: Date | null | undefined, serverNow: Date, intervalMs: number): string | undefined {
  if (lastCompleted == null) return undefined;
  const lastMs = lastCompleted.getTime();
  if (!Number.isFinite(lastMs)) return undefined;
  if (serverNow.getTime() - lastMs < intervalMs) return "interval_not_due";
  return undefined;
}

function snapshotIntervalMs(jobType: typeof SyncJobType.BoardSnapshotCareer | typeof SyncJobType.BoardSnapshotStrength | typeof SyncJobType.BoardSnapshotSeason): number {
  if (jobType === SyncJobType.BoardSnapshotCareer) {
    return intervalMinutesMs(SYNC_TASKS_V1[SyncJobType.BoardSnapshotCareer]?.intervalMinutes ?? FIXED_CONFIG_V1.CAREER_BOARD_SNAPSHOT_MINUTES);
  }
  if (jobType === SyncJobType.BoardSnapshotSeason) {
    return intervalMinutesMs(SYNC_TASKS_V1[SyncJobType.BoardSnapshotSeason]?.intervalMinutes ?? FIXED_CONFIG_V1.SEASON_BOARD_SNAPSHOT_MINUTES);
  }
  return intervalMinutesMs(SYNC_TASKS_V1[SyncJobType.BoardSnapshotStrength]?.intervalMinutes ?? 24 * 60);
}

const SNAPSHOT_JOB_BOARDS = {
  [SyncJobType.BoardSnapshotCareer]: RankingBoard.Career,
  [SyncJobType.BoardSnapshotStrength]: RankingBoard.Strength,
  [SyncJobType.BoardSnapshotSeason]: RankingBoard.Season,
} as const;

async function listDuePeriodKeys(repo: AppRepository, serverNow: Date): Promise<string[]> {
  if (repo.rankings === undefined) return [];
  const entries = repo.rankings.findUnfinalizedWeeks !== undefined
    ? await repo.rankings.findUnfinalizedWeeks()
    : await repo.rankings.findAll();
  return listDueWeekPeriodKeys(entries, serverNow);
}

async function listDueSeasonFinals(repo: AppRepository, asOf: Date): Promise<string[]> {
  if (repo.userSeasonStats === undefined || repo.boardSnapshots === undefined) return [];
  return listDueSeasonFinalIds(repo, asOf);
}

async function markPeriodicCycle(
  runtime: ApplicationRuntime,
  jobType: string,
  completedCycleAt: Date,
  updatedAt: Date = completedCycleAt,
): Promise<void> {
  await runtime.schedulerState.upsertPeriodicJobCycle({
    job_type: jobType,
    completed_cycle_at: completedCycleAt,
    updated_at: updatedAt,
  });
}

export async function planDuePeriodicJobs(input: {
  runtime: ApplicationRuntime;
  serverNow: Date;
}): Promise<DueJobDecision[]> {
  const finalizeInterval = intervalMinutesMs(SYNC_TASKS_V1[SyncJobType.PeriodFinalize].intervalMinutes ?? 60);
  const consistencyInterval = intervalMinutesMs(SYNC_TASKS_V1[SyncJobType.DailyConsistency].intervalMinutes ?? 24 * 60);
  const levelCorrectionInterval = intervalMinutesMs(
    SYNC_TASKS_V1[SyncJobType.LevelCorrectionReeval].intervalMinutes ?? 15,
  );
  const finalizeCycle = await input.runtime.schedulerState.getPeriodicJobCycle(SyncJobType.PeriodFinalize);
  const finalizeSkip = cycleSkip(finalizeCycle?.completed_cycle_at, input.serverNow, finalizeInterval);
  const decisions: DueJobDecision[] = [];
  if (finalizeSkip !== undefined) {
    decisions.push({ task: SyncJobType.PeriodFinalize, action: "skip", reason: finalizeSkip });
  } else {
    const duePeriodKeys = await listDuePeriodKeys(input.runtime.repo, input.serverNow);
    decisions.push({
      task: SyncJobType.PeriodFinalize,
      action: "run",
      reason: "due",
      ...(duePeriodKeys.length === 0 ? {} : { due_period_keys: duePeriodKeys }),
    });
  }
  const consistencyCycle = await input.runtime.schedulerState.getPeriodicJobCycle(SyncJobType.DailyConsistency);
  const consistencySkip = cycleSkip(consistencyCycle?.completed_cycle_at, input.serverNow, consistencyInterval);
  if (consistencySkip !== undefined) {
    decisions.push({ task: SyncJobType.DailyConsistency, action: "skip", reason: consistencySkip });
  } else {
    decisions.push({ task: SyncJobType.DailyConsistency, action: "run", reason: "due" });
  }
  const weeklyAsOf = weeklyEvalAsOf(input.serverNow);
  const weeklyCycle = await input.runtime.schedulerState.getPeriodicJobCycle(SyncJobType.WeeklyLevelEval);
  const weeklyDue = weeklyCycle?.completed_cycle_at.getTime() !== weeklyAsOf.getTime();
  const withinWeeklyInlineGrace =
    input.serverNow.getTime() - weeklyAsOf.getTime() < WEEKLY_INLINE_SNAPSHOT_GRACE_MS;
  if (weeklyDue) {
    decisions.push({
      task: SyncJobType.WeeklyLevelEval,
      action: "run",
      reason: "due",
      as_of: weeklyAsOf.toISOString(),
    });
  } else {
    decisions.push({ task: SyncJobType.WeeklyLevelEval, action: "skip", reason: "interval_not_due" });
  }
  const levelCorrectionCycle = await input.runtime.schedulerState.getPeriodicJobCycle(
    SyncJobType.LevelCorrectionReeval,
  );
  const levelCorrectionSkip = cycleSkip(
    levelCorrectionCycle?.completed_cycle_at,
    input.serverNow,
    levelCorrectionInterval,
  );
  if (levelCorrectionSkip !== undefined) {
    decisions.push({
      task: SyncJobType.LevelCorrectionReeval,
      action: "skip",
      reason: levelCorrectionSkip,
    });
  } else {
    decisions.push({ task: SyncJobType.LevelCorrectionReeval, action: "run", reason: "due" });
  }
  for (const jobType of [
    SyncJobType.BoardSnapshotCareer,
    SyncJobType.BoardSnapshotStrength,
    SyncJobType.BoardSnapshotSeason,
  ] as const) {
    if (jobType === SyncJobType.BoardSnapshotStrength && weeklyDue && withinWeeklyInlineGrace) {
      decisions.push({ task: jobType, action: "skip", reason: "inline_weekly_refresh" });
      continue;
    }
    const cycle = await input.runtime.schedulerState.getPeriodicJobCycle(jobType);
    const skip = cycleSkip(cycle?.completed_cycle_at, input.serverNow, snapshotIntervalMs(jobType));
    if (skip !== undefined) {
      decisions.push({ task: jobType, action: "skip", reason: skip });
    } else {
      decisions.push({ task: jobType, action: "run", reason: "due" });
    }
  }
  if (weeklyDue && withinWeeklyInlineGrace) {
    decisions.push({ task: SyncJobType.BoardSnapshotSeasonFinal, action: "skip", reason: "inline_weekly_refresh" });
  } else {
    const dueLevelSeasonIds = await listDueSeasonFinals(input.runtime.repo, weeklyAsOf);
    if (dueLevelSeasonIds.length === 0) {
      decisions.push({ task: SyncJobType.BoardSnapshotSeasonFinal, action: "skip", reason: "no_due_season" });
    } else {
      decisions.push({
        task: SyncJobType.BoardSnapshotSeasonFinal,
        action: "run",
        reason: "due",
        due_level_season_ids: dueLevelSeasonIds,
      });
    }
  }
  if (input.runtime.leagueSeasons !== undefined) {
    const leagueSeasonsCycle = await input.runtime.schedulerState.getPeriodicJobCycle(
      LEAGUE_SEASONS_CYCLE_KEY,
    );
    const leagueSeasonsSkip = cycleSkip(
      leagueSeasonsCycle?.completed_cycle_at,
      input.serverNow,
      LEAGUE_SEASONS_INTERVAL_MS,
    );
    decisions.push(
      leagueSeasonsSkip !== undefined
        ? { task: LEAGUE_SEASONS_CYCLE_KEY, action: "skip", reason: leagueSeasonsSkip }
        : { task: LEAGUE_SEASONS_CYCLE_KEY, action: "run", reason: "due" },
    );
  }
  if (input.runtime.maintenanceCleanup !== undefined) {
    const cleanupCycle = await input.runtime.schedulerState.getPeriodicJobCycle(
      MAINTENANCE_CLEANUP_CYCLE_KEY,
    );
    const cleanupSkip = cycleSkip(
      cleanupCycle?.completed_cycle_at,
      input.serverNow,
      MAINTENANCE_CLEANUP_INTERVAL_MS,
    );
    decisions.push(
      cleanupSkip !== undefined
        ? { task: MAINTENANCE_CLEANUP_CYCLE_KEY, action: "skip", reason: cleanupSkip }
        : { task: MAINTENANCE_CLEANUP_CYCLE_KEY, action: "run", reason: "due" },
    );
  }
  return decisions;
}

export const TICK_MODES = ["all", "realtime", "periodic"] as const;
export type TickMode = (typeof TICK_MODES)[number];

export async function planScheduledJobs(input: {
  runtime: ApplicationRuntime;
  serverNow: Date;
  mode?: TickMode;
}): Promise<{
  mode: TickMode;
  tasks: DueJobDecision[];
  settlement: DueJobDecision;
  wired_periodic_tasks: typeof WIRED_PERIODIC_TASKS;
  unwired_periodic_tasks: typeof UNWIRED_PERIODIC_TASKS;
  settlement_orchestration_tasks: typeof SETTLEMENT_ORCHESTRATION_TASKS;
  fifteen_items_complete: true;
}> {
  const mode: TickMode = input.mode ?? "all";
  const runRealtime = mode === "all" || mode === "realtime";
  const runPeriodic = mode === "all" || mode === "periodic";
  const tasks: DueJobDecision[] = [
    ...(runRealtime
      ? await planDueProviderJobs({
          cloudDb: input.runtime.db,
          namespace: input.runtime.namespace,
          providerRegistry: input.runtime.providerRegistry,
          syncLeagueIds: [...input.runtime.providerSources.sync_leagues],
          sourceIds: input.runtime.providerSources.sources.map((source) => source.source_id),
          profile: input.runtime.providerSources.sync_profile,
          serverNow: input.serverNow,
        })
      : []),
    ...(runPeriodic ? await planDuePeriodicJobs(input) : []),
  ];
  return {
    mode,
    tasks,
    settlement: runRealtime
      ? { task: "settlement", action: "run", reason: "due" }
      : { task: "settlement", action: "skip", reason: "mode_periodic" },
    wired_periodic_tasks: WIRED_PERIODIC_TASKS,
    unwired_periodic_tasks: UNWIRED_PERIODIC_TASKS,
    settlement_orchestration_tasks: SETTLEMENT_ORCHESTRATION_TASKS,
    fifteen_items_complete: true,
  };
}

type ProviderJobSkipped = { task: string; reason: string };
type ProviderJobDeferred = {
  task: string;
  next_attempt_at: string;
  retry_attempt: number;
  last_error_code: string | null;
};
type ProviderJobFailed = { task: string; reason: string; items_failed?: number };

function classifyProviderSyncOutcome(outcome: ProviderSyncOutcome): {
  bucket: "ran" | "skipped" | "deferred" | "failed";
  reason?: string;
  deferred?: Omit<ProviderJobDeferred, "task">;
  items_failed?: number;
} {
  if (outcome.kind === "skipped") {
    return { bucket: "skipped", reason: outcome.fixtures.reason };
  }
  if (outcome.kind === "deferred") {
    return {
      bucket: "deferred",
      deferred: {
        next_attempt_at: outcome.fixtures.next_attempt_at.toISOString(),
        retry_attempt: outcome.fixtures.retry_attempt,
        last_error_code: outcome.fixtures.last_error_code,
      },
    };
  }
  const itemsFailed = outcome.fixtures?.items_failed ?? 0;
  if (itemsFailed > 0) {
    return { bucket: "failed", reason: "items_failed", items_failed: itemsFailed };
  }
  return { bucket: "ran" };
}

function taskRows<T>(
  value: unknown,
  map: (row: Record<string, unknown>, task: string) => T | undefined,
): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((row) => {
    if (typeof row !== "object" || row === null) return [];
    const task = (row as { task?: unknown }).task;
    if (typeof task !== "string") return [];
    const mapped = map(row as Record<string, unknown>, task);
    return mapped === undefined ? [] : [mapped];
  });
}

export function providerScheduleSummary(providerData: Record<string, unknown>): {
  outcome: string;
  jobs_run?: string[];
  skipped?: ProviderJobSkipped[];
  deferred?: ProviderJobDeferred[];
  failed?: ProviderJobFailed[];
} {
  const jobs_run = Array.isArray(providerData.jobs_run)
    ? providerData.jobs_run.filter((value): value is string => typeof value === "string")
    : undefined;
  const skipped = taskRows(providerData.skipped, (row, task) => (
    typeof row.reason === "string" ? { task, reason: row.reason } : undefined
  ));
  const deferred = taskRows(providerData.deferred, (row, task) => (
    typeof row.next_attempt_at === "string"
      && typeof row.retry_attempt === "number"
      && (typeof row.last_error_code === "string" || row.last_error_code === null)
      ? {
        task,
        next_attempt_at: row.next_attempt_at,
        retry_attempt: row.retry_attempt,
        last_error_code: row.last_error_code,
      }
      : undefined
  ));
  const failed = taskRows(providerData.failed, (row, task) => ({
    task,
    reason: typeof row.reason === "string" ? row.reason : "failed",
    ...(typeof row.items_failed === "number" ? { items_failed: row.items_failed } : {}),
  }));
  return {
    outcome: typeof providerData.outcome === "string" ? providerData.outcome : "failed",
    ...(jobs_run === undefined ? {} : { jobs_run }),
    ...(skipped === undefined ? {} : { skipped }),
    ...(deferred === undefined ? {} : { deferred }),
    ...(failed === undefined ? {} : { failed }),
  };
}

export async function runDueProviderJobs(input: RunDueProviderJobsInput): Promise<Record<string, unknown>> {
  const decisions = await planDueProviderJobs(input);
  const skipped: ProviderJobSkipped[] = [];
  const ran: string[] = [];
  const deferred: ProviderJobDeferred[] = [];
  const failed: ProviderJobFailed[] = [];
  const errors: unknown[] = [];
  if (input.sourceIds.length === 0) {
    for (const decision of decisions) {
      if (decision.action === "skip") skipped.push({ task: decision.task, reason: decision.reason });
    }
    return { outcome: "skipped", reason: "no_provider_sources", skipped, deferred, failed, errors };
  }

  for (const decision of decisions) {
    if (decision.action === "skip") {
      skipped.push({ task: decision.task, reason: decision.reason });
      continue;
    }
    if (decision.task === SyncJobType.ProviderReconcile) {
      try {
        const outcome = await input.reconcile.run(input.serverNow);
        if (outcome.kind === "completed") ran.push(SyncJobType.ProviderReconcile);
        else skipped.push({ task: SyncJobType.ProviderReconcile, reason: outcome.reason });
        input.log({ event: "provider_schedule", job_type: SyncJobType.ProviderReconcile, outcome: outcome.kind });
      } catch (error) {
        errors.push(error);
        failed.push({ task: SyncJobType.ProviderReconcile, reason: "exception" });
        input.log({ event: "provider_schedule", job_type: SyncJobType.ProviderReconcile, outcome: "failed" });
      }
      continue;
    }
    if (decision.task === SyncJobType.StaleRecovery) {
      try {
        const outcome = await input.staleRecovery.run(input.serverNow);
        if (outcome.kind === "completed") {
          if (outcome.items_failed > 0) failed.push({ task: decision.task, reason: "items_failed", items_failed: outcome.items_failed });
          else ran.push(decision.task);
        } else if (outcome.kind === "skipped") skipped.push({ task: decision.task, reason: outcome.reason });
        else deferred.push({ task: decision.task, next_attempt_at: outcome.next_attempt_at.toISOString(), retry_attempt: outcome.retry_attempt, last_error_code: outcome.last_error_code });
        input.log({ event: "provider_schedule", job_type: decision.task, outcome: outcome.kind });
      } catch (error) {
        errors.push(error);
        failed.push({ task: decision.task, reason: "exception" });
        input.log({ event: "provider_schedule", job_type: decision.task, outcome: "failed" });
      }
      continue;
    }
    if (!isProviderSyncJobType(decision.task)) continue;
    const label = decision.league_id === undefined ? decision.task : `${decision.task}:${decision.league_id}`;
    try {
      const outcome = decision.league_id === undefined
        ? await input.dispatcher.run(decision.task, input.serverNow)
        : await input.dispatcher.run(decision.task, input.serverNow, decision.league_id);
      logProviderFixtureFailures(input.log, decision.task, outcome);
      input.log({
        event: "provider_schedule",
        job_type: decision.task,
        ...(decision.league_id === undefined ? {} : { league_id: decision.league_id }),
        outcome: outcome.kind,
      });
      const classified = classifyProviderSyncOutcome(outcome);
      if (classified.bucket === "ran") {
        await input.providerRegistry.commitPendingLeagueSuccess?.(decision.task, input.serverNow);
        ran.push(label);
      } else {
        input.providerRegistry.discardPendingLeagueSuccess?.(decision.task);
        if (classified.bucket === "skipped") skipped.push({ task: label, reason: classified.reason ?? "skipped" });
        else if (classified.bucket === "deferred" && classified.deferred !== undefined) {
          deferred.push({ task: label, ...classified.deferred });
        } else if (classified.bucket === "failed") {
          failed.push({
            task: label,
            reason: classified.reason ?? "failed",
            ...(classified.items_failed === undefined ? {} : { items_failed: classified.items_failed }),
          });
        }
      }
    } catch (error) {
      input.providerRegistry.discardPendingLeagueSuccess?.(decision.task);
      errors.push(error);
      failed.push({ task: label, reason: "exception" });
      input.log({
        event: "provider_schedule",
        job_type: decision.task,
        ...(decision.league_id === undefined ? {} : { league_id: decision.league_id }),
        outcome: "failed",
      });
    }
  }

  return {
    outcome: errors.length > 0 || failed.length > 0 ? "failed" : "completed",
    jobs_run: ran,
    skipped,
    deferred,
    failed,
    errors,
  };
}

export function logProviderFixtureFailures(
  log: (entry: Record<string, unknown>) => void,
  jobType: ProviderSyncJobType,
  outcome: unknown,
): void {
  if (typeof outcome !== "object" || outcome === null || Array.isArray(outcome)) return;
  const fixtures = (outcome as { fixtures?: unknown }).fixtures;
  if (typeof fixtures !== "object" || fixtures === null || Array.isArray(fixtures)) return;
  const diagnostics = (fixtures as { failure_diagnostics?: unknown }).failure_diagnostics;
  if (!Array.isArray(diagnostics)) return;

  for (const raw of diagnostics) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const diagnostic = raw as ProviderFixtureFailureDiagnostic;
    log({
      event: "provider_fixture_failure",
      job_type: jobType,
      sync_job_id: diagnostic.sync_job_id,
      provider: diagnostic.provider,
      provider_fixture_id: diagnostic.provider_fixture_id,
      stage: diagnostic.stage,
      outcome: diagnostic.outcome,
      error_code: diagnostic.error_code,
      error_name: diagnostic.error_name,
      error_message: diagnostic.error_message,
      reason_codes: diagnostic.reason_codes,
      match_id: diagnostic.match_id,
    });
  }
}

async function runPeriodFinalizeJob(
  runtime: ApplicationRuntime,
  serverNow: Date,
  duePeriodKeys: readonly string[] | undefined,
): Promise<{ bucket: "ran" | "skipped"; reason?: string; due_period_keys: string[] }> {
  const keys = duePeriodKeys === undefined
    ? await listDuePeriodKeys(runtime.repo, serverNow)
    : [...duePeriodKeys];
  if (keys.length === 0) {
    await markPeriodicCycle(runtime, SyncJobType.PeriodFinalize, serverNow);
    return { bucket: "ran", due_period_keys: [] };
  }
  let skippedLock = false;
  for (const periodKey of keys) {
    const outcome = await runtime.periodFinalize.finalize(PeriodType.Week, periodKey, serverNow);
    if (outcome.skipped) skippedLock = true;
  }
  if (skippedLock) {
    return { bucket: "skipped", reason: "lock_held", due_period_keys: keys };
  }
  await markPeriodicCycle(runtime, SyncJobType.PeriodFinalize, serverNow);
  return { bucket: "ran", due_period_keys: keys };
}

async function runWeeklyLevelEvalJob(
  runtime: ApplicationRuntime,
  serverNow: Date,
): Promise<{
  bucket: "ran" | "skipped" | "failed";
  reason?: string;
  items_failed?: number;
  as_of: Date;
  error?: unknown;
}> {
  const outcome = await runtime.weeklyLevelEval.run(serverNow);
  if (outcome.kind === "skipped") {
    return { bucket: "skipped", reason: "lock_held", as_of: outcome.as_of };
  }
  const settlementSkipped = outcome.settlement_skipped_count ?? 0;
  const failedCount = outcome.failed_count ?? 0;
  if (failedCount > 0) {
    const error = new DomainError(
      "INTERNAL_ERROR",
      `weekly level eval had ${failedCount} user failure(s)`,
      { as_of: outcome.as_of.toISOString(), failed_count: failedCount },
    );
    runtime.log({
      event: "weekly_level_eval_job_failed",
      as_of: outcome.as_of.toISOString(),
      failed_count: failedCount,
      settlement_skipped_count: settlementSkipped,
      deferred_count: outcome.deferred_count ?? 0,
    });
    return {
      bucket: "failed",
      reason: "user_eval_failed",
      items_failed: failedCount,
      as_of: outcome.as_of,
      error,
    };
  }
  if (settlementSkipped > 0) {
    return {
      bucket: "skipped",
      reason: "settlement_already_running",
      as_of: outcome.as_of,
    };
  }
  const deferredCount = outcome.deferred_count ?? 0;
  if (deferredCount > 0) {
    return { bucket: "skipped", reason: "user_lock_held", as_of: outcome.as_of };
  }
  await markPeriodicCycle(runtime, SyncJobType.WeeklyLevelEval, outcome.as_of, serverNow);
  await markPeriodicCycle(runtime, SyncJobType.BoardSnapshotStrength, serverNow);
  await markPeriodicCycle(runtime, SyncJobType.BoardSnapshotSeasonFinal, serverNow);
  return { bucket: "ran", as_of: outcome.as_of };
}

async function runLevelCorrectionReevalPendingJob(
  runtime: ApplicationRuntime,
  serverNow: Date,
): Promise<{ bucket: "ran" | "skipped"; reason?: string }> {
  const weeklyCycle = await runtime.schedulerState.getPeriodicJobCycle(
    SyncJobType.WeeklyLevelEval,
  );
  const outcome = await runtime.levelCorrectionReeval.runPendingCompensation(
    serverNow,
    weeklyCycle?.completed_cycle_at ?? null,
  );
  if (outcome.kind === "skipped") {
    return { bucket: "skipped", reason: "lock_held" };
  }
  if (outcome.kind === "deferred") {
    return {
      bucket: "skipped",
      reason: outcome.deferred_reason ?? outcome.deferred_reasons?.[0] ?? "deferred",
    };
  }
  await markPeriodicCycle(runtime, SyncJobType.LevelCorrectionReeval, serverNow);
  return { bucket: "ran" };
}

function isSnapshotLockHeld(error: unknown): boolean {
  return error instanceof DomainError && error.code === "SETTLEMENT_ALREADY_RUNNING";
}

async function runBoardSnapshotJob(
  runtime: ApplicationRuntime,
  jobType: typeof SyncJobType.BoardSnapshotCareer | typeof SyncJobType.BoardSnapshotStrength | typeof SyncJobType.BoardSnapshotSeason,
  serverNow: Date,
): Promise<{ bucket: "ran" | "skipped"; reason?: string }> {
  try {
    await runtime.boardSnapshot.generate(SNAPSHOT_JOB_BOARDS[jobType], serverNow);
  } catch (error) {
    if (isSnapshotLockHeld(error)) {
      return { bucket: "skipped", reason: "lock_held" };
    }
    throw error;
  }
  await markPeriodicCycle(runtime, jobType, serverNow);
  return { bucket: "ran" };
}

async function runBoardSnapshotSeasonFinalJob(
  runtime: ApplicationRuntime,
  serverNow: Date,
  dueLevelSeasonIds: readonly string[] | undefined,
): Promise<{ bucket: "ran" | "skipped"; reason?: string; due_level_season_ids: string[] }> {
  const asOf = weeklyEvalAsOf(serverNow);
  const ids = dueLevelSeasonIds === undefined
    ? await listDueSeasonFinals(runtime.repo, asOf)
    : [...dueLevelSeasonIds];
  if (ids.length === 0) {
    await markPeriodicCycle(runtime, SyncJobType.BoardSnapshotSeasonFinal, serverNow);
    return { bucket: "ran", due_level_season_ids: [] };
  }
  let skippedLock = false;
  for (const seasonId of ids) {
    try {
      await runtime.boardSnapshot.generateSeasonFinal(seasonId, serverNow);
    } catch (error) {
      if (isSnapshotLockHeld(error)) {
        skippedLock = true;
        continue;
      }
      throw error;
    }
  }
  if (skippedLock) {
    return { bucket: "skipped", reason: "lock_held", due_level_season_ids: ids };
  }
  await markPeriodicCycle(runtime, SyncJobType.BoardSnapshotSeasonFinal, serverNow);
  return { bucket: "ran", due_level_season_ids: ids };
}

async function runDailyConsistencyJob(
  runtime: ApplicationRuntime,
  serverNow: Date,
): Promise<{ bucket: "ran" | "skipped"; reason?: string }> {
  const outcome = await runtime.dailyConsistency.run(serverNow);
  if (outcome.kind === "skipped") {
    return { bucket: "skipped", reason: outcome.reason };
  }
  await markPeriodicCycle(runtime, SyncJobType.DailyConsistency, serverNow);
  if (outcome.differences.length > 0) {
    runtime.log({
      event: "daily_consistency_mismatch",
      code: DAILY_CONSISTENCY_MISMATCH_CODE,
      difference_count: outcome.differences.length,
      differences: outcome.differences.map((row) => `${row.scope}:${row.key}`),
    });
  }
  return { bucket: "ran" };
}

export const MAINTENANCE_CLEANUP_CYCLE_KEY = "maintenance_cleanup";
export const MAINTENANCE_CLEANUP_LOCK_KEY = "sync:maintenance_cleanup";
export const LEAGUE_SEASONS_CYCLE_KEY = "league_seasons";
export const LEAGUE_SEASONS_LOCK_KEY = "sync:league_seasons";
export const WEEKLY_INLINE_SNAPSHOT_GRACE_MS = 60 * 60_000;
const LEAGUE_SEASONS_INTERVAL_MS = LEAGUE_SEASONS_MAINTENANCE_INTERVAL_MINUTES * 60_000;
const MAINTENANCE_CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;
const MAINTENANCE_CLEANUP_LEASE_MS = FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000;

async function runLeagueSeasonsMaintenanceJob(
  runtime: ApplicationRuntime,
  serverNow: Date,
): Promise<{ bucket: "ran" | "skipped"; reason?: string; outcome: LeagueSeasonMaintenanceResult | null }> {
  const jobLocks = (runtime.repo as Partial<AppRepository>).jobLocks;
  if (jobLocks === undefined) {
    const outcome = await runtime.leagueSeasons.run(serverNow);
    await markPeriodicCycle(runtime, LEAGUE_SEASONS_CYCLE_KEY, serverNow);
    return { bucket: "ran", outcome };
  }
  const ownerId = newUuid();
  const leaseMs = FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000;
  const leaseUntil = new Date(Math.max(Date.now(), serverNow.getTime()) + leaseMs);
  const acquired = await jobLocks.acquire(LEAGUE_SEASONS_LOCK_KEY, ownerId, leaseUntil);
  if (!acquired) {
    runtime.log({ event: "league_seasons_maintenance_skipped", reason: "lock_held" });
    return { bucket: "skipped", reason: "lock_held", outcome: null };
  }
  const lockRenewal = startJobLockRenewal(
    { jobLocks },
    LEAGUE_SEASONS_LOCK_KEY,
    ownerId,
    { leaseMs, now: () => Math.max(Date.now(), serverNow.getTime()) },
  );
  try {
    const outcome = await runtime.leagueSeasons.run(serverNow);
    await markPeriodicCycle(runtime, LEAGUE_SEASONS_CYCLE_KEY, serverNow);
    return { bucket: "ran", outcome };
  } finally {
    lockRenewal.stop();
    await jobLocks.release(LEAGUE_SEASONS_LOCK_KEY, ownerId).catch(() => undefined);
  }
}

async function runMaintenanceCleanupJob(
  runtime: ApplicationRuntime,
  serverNow: Date,
): Promise<{ bucket: "ran" | "skipped"; reason?: string }> {
  const service = runtime.maintenanceCleanup;
  if (service === undefined) {
    return { bucket: "skipped", reason: "unconfigured" };
  }
  const jobLocks = (runtime.repo as Partial<AppRepository>).jobLocks;
  const ownerId = newUuid();
  const leaseUntil = (): Date =>
    new Date(Math.max(Date.now(), serverNow.getTime()) + MAINTENANCE_CLEANUP_LEASE_MS);
  if (jobLocks !== undefined) {
    const acquired = await jobLocks.acquire(MAINTENANCE_CLEANUP_LOCK_KEY, ownerId, leaseUntil());
    if (!acquired) {
      return { bucket: "skipped", reason: "lock_held" };
    }
  }
  try {
    const result = await service.run(serverNow, jobLocks === undefined
      ? undefined
      : async () => {
        const renewed = await jobLocks.renew(MAINTENANCE_CLEANUP_LOCK_KEY, ownerId, leaseUntil());
        if (!renewed) {
          throw new Error("maintenance cleanup lock lost");
        }
      });
    if (!result.truncated) {
      await markPeriodicCycle(runtime, MAINTENANCE_CLEANUP_CYCLE_KEY, serverNow);
    }
    return { bucket: "ran" };
  } finally {
    if (jobLocks !== undefined) {
      await jobLocks.release(MAINTENANCE_CLEANUP_LOCK_KEY, ownerId).catch(() => undefined);
    }
  }
}

export async function runDuePeriodicJobs(input: {
  runtime: ApplicationRuntime;
  serverNow: Date;
}): Promise<Record<string, unknown>> {
  const decisions = await planDuePeriodicJobs(input);
  const skipped: ProviderJobSkipped[] = [];
  const ran: string[] = [];
  const failed: ProviderJobFailed[] = [];
  const errors: unknown[] = [];
  let leagueSeasonsOutcome: LeagueSeasonMaintenanceResult | null = null;
  for (const decision of decisions) {
    if (decision.action === "skip") {
      skipped.push({ task: decision.task, reason: decision.reason });
      continue;
    }
    try {
      if (decision.task === SyncJobType.PeriodFinalize) {
        const outcome = await runPeriodFinalizeJob(input.runtime, input.serverNow, decision.due_period_keys);
        if (outcome.bucket === "ran") ran.push(decision.task);
        else skipped.push({ task: decision.task, reason: outcome.reason ?? "skipped" });
        continue;
      }
      if (decision.task === SyncJobType.DailyConsistency) {
        const outcome = await runDailyConsistencyJob(input.runtime, input.serverNow);
        if (outcome.bucket === "ran") ran.push(decision.task);
        else skipped.push({ task: decision.task, reason: outcome.reason ?? "skipped" });
        continue;
      }
      if (decision.task === SyncJobType.WeeklyLevelEval) {
        const outcome = await runWeeklyLevelEvalJob(input.runtime, input.serverNow);
        if (outcome.bucket === "ran") ran.push(decision.task);
        else if (outcome.bucket === "failed") {
          if (outcome.error !== undefined) errors.push(outcome.error);
          failed.push({
            task: decision.task,
            reason: outcome.reason ?? "user_eval_failed",
            ...(outcome.items_failed === undefined ? {} : { items_failed: outcome.items_failed }),
          });
        } else {
          skipped.push({ task: decision.task, reason: outcome.reason ?? "skipped" });
        }
        continue;
      }
      if (decision.task === SyncJobType.LevelCorrectionReeval) {
        const outcome = await runLevelCorrectionReevalPendingJob(input.runtime, input.serverNow);
        if (outcome.bucket === "ran") ran.push(decision.task);
        else skipped.push({ task: decision.task, reason: outcome.reason ?? "skipped" });
        continue;
      }
      if (
        decision.task === SyncJobType.BoardSnapshotCareer
        || decision.task === SyncJobType.BoardSnapshotStrength
        || decision.task === SyncJobType.BoardSnapshotSeason
      ) {
        const outcome = await runBoardSnapshotJob(input.runtime, decision.task, input.serverNow);
        if (outcome.bucket === "ran") ran.push(decision.task);
        else skipped.push({ task: decision.task, reason: outcome.reason ?? "skipped" });
        continue;
      }
      if (decision.task === SyncJobType.BoardSnapshotSeasonFinal) {
        const outcome = await runBoardSnapshotSeasonFinalJob(
          input.runtime,
          input.serverNow,
          decision.due_level_season_ids,
        );
        if (outcome.bucket === "ran") ran.push(decision.task);
        else skipped.push({ task: decision.task, reason: outcome.reason ?? "skipped" });
        continue;
      }
      if (decision.task === LEAGUE_SEASONS_CYCLE_KEY) {
        const outcome = await runLeagueSeasonsMaintenanceJob(input.runtime, input.serverNow);
        leagueSeasonsOutcome = outcome.outcome;
        if (outcome.bucket === "ran") ran.push(decision.task);
        else skipped.push({ task: decision.task, reason: outcome.reason ?? "skipped" });
        continue;
      }
      if (decision.task === MAINTENANCE_CLEANUP_CYCLE_KEY) {
        const outcome = await runMaintenanceCleanupJob(input.runtime, input.serverNow);
        if (outcome.bucket === "ran") ran.push(decision.task);
        else skipped.push({ task: decision.task, reason: outcome.reason ?? "skipped" });
      }
    } catch (error) {
      errors.push(error);
      failed.push({ task: decision.task, reason: "exception" });
    }
  }
  return {
    outcome: errors.length > 0 || failed.length > 0 ? "failed" : "completed",
    jobs_run: ran,
    skipped,
    failed,
    errors,
    league_seasons: leagueSeasonsOutcome,
  };
}

export async function runScheduledJobs(input: {
  runtime: ApplicationRuntime;
  serverNow: Date;
  mode?: TickMode;
}): Promise<{ providerData: Record<string, unknown>; settlements: SettlementTimerOutcome[]; leagueSeasons: LeagueSeasonMaintenanceResult | null; errors: unknown[] }> {
  const { runtime, serverNow } = input;
  const mode: TickMode = input.mode ?? "all";
  const runRealtime = mode === "all" || mode === "realtime";
  const runPeriodic = mode === "all" || mode === "periodic";
  runtime.providerRegistry.beginTickCache();
  const errors: unknown[] = [];
  let providerData: Record<string, unknown> = runRealtime
    ? { outcome: "failed" }
    : { outcome: "skipped", jobs_run: [], skipped: [], failed: [], errors: [] };
  let settlements: SettlementTimerOutcome[] = [];
  let leagueSeasons: LeagueSeasonMaintenanceResult | null = null;
  try {
    if (runRealtime) {
      try {
        providerData = await runDueProviderJobs({
          cloudDb: runtime.db,
          namespace: runtime.namespace,
          dispatcher: runtime.providerDispatcher,
          providerRegistry: runtime.providerRegistry,
          syncLeagueIds: [...runtime.providerSources.sync_leagues],
          sourceIds: runtime.providerSources.sources.map((source) => source.source_id),
          profile: runtime.providerSources.sync_profile,
          reconcile: runtime.providerReconcile,
          staleRecovery: runtime.providerStaleRecovery,
          serverNow,
          log: runtime.log,
        });
        const nested = providerData.errors;
        if (Array.isArray(nested)) errors.push(...nested);
      } catch (error) {
        errors.push(error);
        providerData = { outcome: "failed", jobs_run: [], skipped: [], errors };
      }
      try {
        settlements = await runSettlementTimer(runtime.repo, serverNow, runtime.settlementTimerOptions);
      } catch (error) {
        errors.push(error);
      }
    }
    if (runPeriodic) {
      try {
        const periodic = await runDuePeriodicJobs({ runtime, serverNow });
        leagueSeasons = (periodic.league_seasons as LeagueSeasonMaintenanceResult | null | undefined) ?? null;
        const nested = periodic.errors;
        if (Array.isArray(nested)) errors.push(...nested);
        const periodicRan = Array.isArray(periodic.jobs_run)
          ? periodic.jobs_run.filter((value): value is string => typeof value === "string")
          : [];
        const existingRan = Array.isArray(providerData.jobs_run)
          ? providerData.jobs_run.filter((value): value is string => typeof value === "string")
          : [];
        const existingSkipped = Array.isArray(providerData.skipped) ? providerData.skipped : [];
        const existingFailed = Array.isArray(providerData.failed) ? providerData.failed : [];
        const periodicFailed = Array.isArray(periodic.failed) ? periodic.failed : [];
        const periodicSkipped = Array.isArray(periodic.skipped) ? periodic.skipped : [];
        providerData = {
          ...providerData,
          jobs_run: [...existingRan, ...periodicRan],
          skipped: [...existingSkipped, ...periodicSkipped],
          failed: [...existingFailed, ...periodicFailed],
          outcome: errors.length > 0 || existingFailed.length > 0 || periodicFailed.length > 0
            ? "failed"
            : providerData.outcome === "skipped" && periodicRan.length === 0
              ? providerData.outcome
              : "completed",
        };
      } catch (error) {
        errors.push(error);
      }
    }
    return { providerData, settlements, leagueSeasons, errors };
  } finally {
    runtime.providerRegistry.endTickCache();
  }
}
