import type { DbOpCollectionCount } from "../infrastructure/db-op-counter.js";
import { classifyFailure, isBenignSkip } from "./failure-taxonomy.js";

const SETTLED_KINDS = new Set(["settled", "already_settled", "started"]);

export function buildTimerSummary(input: {
  taskTypes: readonly string[];
  provider: {
    outcome: string;
    jobs_run?: readonly string[];
    skipped?: readonly { task: string; reason: string }[];
    deferred?: readonly {
      task: string;
      next_attempt_at?: string;
      retry_attempt?: number;
      last_error_code?: string | null;
    }[];
    failed?: readonly { task: string; reason: string; items_failed?: number }[];
  };
  settlements: readonly { match_id: string; outcome: unknown }[];
  dbOps: { read: number; write: number; by_collection?: readonly DbOpCollectionCount[] };
  durationMs: number;
  errors: readonly unknown[];
}): Record<string, unknown> {
  const error_categories: Record<string, number> = {};
  let benign_skips = 0;
  let nonBenignErrors = 0;
  for (const error of input.errors) {
    const classified = classifyFailure(error);
    error_categories[classified.category] = (error_categories[classified.category] ?? 0) + 1;
    if (isBenignSkip(classified)) {
      benign_skips += 1;
    } else {
      nonBenignErrors += 1;
    }
  }

  let settled = 0;
  let failed = 0;
  for (const row of input.settlements) {
    const kind = settlementKind(row.outcome);
    if (kind !== undefined && SETTLED_KINDS.has(kind)) settled += 1;
    else if (kind === "failed") failed += 1;
  }

  const ran = [...(input.provider.jobs_run ?? [])];
  const skipped = (input.provider.skipped ?? []).map((row) => ({ task: row.task, reason: row.reason }));
  const deferred = (input.provider.deferred ?? []).map((row) => ({
    task: row.task,
    ...(row.next_attempt_at === undefined ? {} : { next_attempt_at: row.next_attempt_at }),
    ...(row.retry_attempt === undefined ? {} : { retry_attempt: row.retry_attempt }),
    ...(row.last_error_code === undefined ? {} : { last_error_code: row.last_error_code }),
  }));
  const failedJobs = (input.provider.failed ?? []).map((row) => ({
    task: row.task,
    reason: row.reason,
    ...(row.items_failed === undefined ? {} : { items_failed: row.items_failed }),
  }));
  const outcome = nonBenignErrors === 0 && failedJobs.length === 0
    ? "ok"
    : ran.length === 0 && settled === 0
      ? "failed"
      : "partial";

  return {
    task_types: [...input.taskTypes],
    ran,
    skipped,
    deferred,
    failed: failedJobs,
    db_ops: { read: input.dbOps.read, write: input.dbOps.write },
    db_ops_by_collection: (input.dbOps.by_collection ?? []).map((row) => ({
      collection: row.collection,
      read: row.read,
      write: row.write,
    })),
    settlements: {
      attempted: input.settlements.length,
      settled,
      failed,
    },
    duration_ms: input.durationMs,
    error_categories,
    outcome,
    benign_skips,
  };
}

function settlementKind(outcome: unknown): string | undefined {
  if (typeof outcome !== "object" || outcome === null) return undefined;
  const kind = (outcome as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : undefined;
}
