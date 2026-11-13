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
