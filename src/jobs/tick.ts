import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { CloudBaseAppRepository } from "../infrastructure/cloudbase-app-repository.js";
import { createCountingDb, type DbOpCounter } from "../infrastructure/db-op-counter.js";
import { loadGatewayRuntimeConfig, type GatewayRuntimeConfig } from "../gateway/config.js";
import { buildTimerSummary } from "../cloud-function/timer-summary.js";
import { createApplicationRuntime, type ApplicationRuntime } from "../runtime/application-runtime.js";
import {
  planScheduledJobs,
  providerScheduleSummary,
  runScheduledJobs,
  SETTLEMENT_ORCHESTRATION_TASKS,
  TIMER_TASK_TYPES,
  UNWIRED_PERIODIC_TASKS,
  WIRED_PERIODIC_TASKS,
} from "../runtime/scheduled-jobs.js";
import { createVpsRuntime } from "../runtime/vps-runtime.js";
import { SyncJobType } from "../domain/enums.js";
import { effectiveRefreshMinutes, schedulerTickMinutes } from "../sync/deploy-target.js";
import { taskIntervalMinutes, type ProviderJobProfile } from "../sync/config.js";

export interface JobsTickHandle {
  application: ApplicationRuntime;
  counter: DbOpCounter;
  close(): Promise<void>;
}

export interface JobsTickOptions {
  env?: Record<string, string | undefined>;
  argv?: string[];
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
  assemble?: (config: GatewayRuntimeConfig) => Promise<JobsTickHandle>;
}

export interface JobsTickResult {
  exitCode: number;
  plan?: Record<string, unknown>;
  summary?: Record<string, unknown>;
}

function stdoutLog(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

function settlementFailed(settlements: readonly { match_id: string; outcome: unknown }[]): boolean {
  return settlements.some((row) => {
    if (typeof row.outcome !== "object" || row.outcome === null) return false;
    return (row.outcome as { kind?: unknown }).kind === "failed";
  });
}

/**
 * 调度策略快照：部署目标决定 tick 粒度，tick 粒度决定"实时"到底有多实时。
 *
 * 每轮打一条日志。线上排查"比分为什么十几分钟才动"时先看这条：
 * `live_match_effective_minutes` 才是真正生效的刷新间隔。
 */
function schedulerPolicy(
  config: GatewayRuntimeConfig,
  profile: ProviderJobProfile,
): Record<string, unknown> {
  const target = config.deploy_target;
  const tickMinutes = schedulerTickMinutes(target);
  const liveConfigured = taskIntervalMinutes(SyncJobType.LiveMatch, profile);
  const liveEffective = effectiveRefreshMinutes(SyncJobType.LiveMatch, profile, target);
  return {
    event: "scheduler_policy",
    deploy_target: target,
    sync_profile: profile,
    tick_minutes: tickMinutes,
    live_match_configured_minutes: liveConfigured,
    live_match_effective_minutes: liveEffective,
    ...(liveConfigured < tickMinutes
      ? {
        degraded_to_tick: true,
        note: `调度粒度 ${tickMinutes} 分钟 > live_match 配置 ${liveConfigured} 分钟，实时刷新实际按 ${liveEffective} 分钟生效`,
      }
      : {}),
  };
}

function createHandle(
  config: GatewayRuntimeConfig,
  env: Record<string, string | undefined>,
  log: (entry: Record<string, unknown>) => void,
): JobsTickHandle {
  if (config.repository_backend !== "postgres" || config.postgres_repository === null) {
    throw new Error("jobs:tick requires FOOTBALL_REPOSITORY_BACKEND=postgres");
  }
  const postgres = config.postgres_repository;
  const vps = createVpsRuntime({ postgres });
  const counted = createCountingDb(vps.db);
  const repo = new CloudBaseAppRepository(
    { resource_namespace: postgres.resource_namespace },
    counted.db,
  );
  return {
    application: createApplicationRuntime({
      env,
      db: counted.db,
      namespace: postgres.resource_namespace,
      repo,
      matchCursorSecret: config.match_cursor_secret,
      log,
    }),
    counter: counted.counter,
    close: () => vps.close(),
  };
}

export async function runJobsTick(options: JobsTickOptions = {}): Promise<JobsTickResult> {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv.slice(2);
  const log = options.log ?? stdoutLog;
  const dryRun = hasFlag(argv, "--dry-run");
  const serverNow = (options.now ?? (() => new Date()))();
  let handle: JobsTickHandle | undefined;
  try {
    const config = loadGatewayRuntimeConfig(env);
    handle = options.assemble === undefined
      ? createHandle(config, env, log)
      : await options.assemble(config);
    const policy = schedulerPolicy(config, handle.application.providerSources.sync_profile);
    log(policy);
    if (dryRun) {
      const planned = await planScheduledJobs({ runtime: handle.application, serverNow });
      const todos = await handle.application.repo.matches.findSettlementTodos({ limit: 100 });
      const plan = {
        event: "jobs_tick_plan",
        dry_run: true,
        server_now: serverNow.toISOString(),
        tasks: planned.tasks,
        settlement: planned.settlement,
        settlement_todo_count: todos.length,
        wired_periodic_tasks: planned.wired_periodic_tasks,
        unwired_periodic_tasks: planned.unwired_periodic_tasks,
        settlement_orchestration_tasks: planned.settlement_orchestration_tasks,
        fifteen_items_complete: planned.fifteen_items_complete,
      };
      log(plan);
      return { exitCode: 0, plan };
    }

    handle.counter.begin();
    const startedAt = Date.now();
    const scheduled = await runScheduledJobs({ runtime: handle.application, serverNow });
    const dbOps = handle.counter.end();
    const timerSummary = buildTimerSummary({
      taskTypes: TIMER_TASK_TYPES,
      provider: providerScheduleSummary(scheduled.providerData),
      settlements: scheduled.settlements,
      dbOps,
      durationMs: Date.now() - startedAt,
      errors: scheduled.errors,
    });
    const summary = {
      ...timerSummary,
      wired_periodic_tasks: WIRED_PERIODIC_TASKS,
      unwired_periodic_tasks: UNWIRED_PERIODIC_TASKS,
      settlement_orchestration_tasks: SETTLEMENT_ORCHESTRATION_TASKS,
      fifteen_items_complete: true,
    };
    log({ event: "timer_summary", ...summary });
    const failed = scheduled.errors.length > 0
      || settlementFailed(scheduled.settlements)
      || timerSummary.outcome === "failed"
      || timerSummary.outcome === "partial";
    return { exitCode: failed ? 1 : 0, summary };
  } catch (error) {
    log({
      event: "jobs_tick_error",
      message: error instanceof Error ? error.message : String(error),
    });
    return { exitCode: 1 };
  } finally {
    if (handle !== undefined) await handle.close();
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectRun()) {
  void runJobsTick().then((result) => {
    process.exitCode = result.exitCode;
  });
}
