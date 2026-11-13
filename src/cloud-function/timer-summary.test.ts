import { describe, expect, it } from "vitest";
import { ProviderDataError } from "../provider/http.js";
import { buildTimerSummary } from "./timer-summary.js";

const TASK_TYPES = ["post_finish_verify", "live_match", "near_match", "future_schedule", "full_schedule_verify", "provider_reconcile", "settlement", "period_finalize", "daily_consistency", "weekly_level_eval", "board_snapshot_career", "board_snapshot_strength", "board_snapshot_season"] as const;

function assertNoSensitiveKeys(summary: Record<string, unknown>): void {
  expect(JSON.stringify(summary)).not.toMatch(/"(openid|api_key|apikey|token)"/i);
}

describe("buildTimerSummary", () => {
  it("summarizes a normal round as ok", () => {
    const summary = buildTimerSummary({
      taskTypes: TASK_TYPES,
      provider: { outcome: "completed", jobs_run: ["live_match", "future_schedule:la_liga"] },
      settlements: [
        { match_id: "m1", outcome: { kind: "settled" } },
        { match_id: "m2", outcome: { kind: "started" } },
      ],
      dbOps: { read: 4, write: 2 },
      durationMs: 12,
      errors: [],
    });
    expect(summary.outcome).toBe("ok");
    expect(summary.settlements).toEqual({ attempted: 2, settled: 2, failed: 0 });
    expect(summary.error_categories).toEqual({});
    expect(summary.db_ops).toEqual({ read: 4, write: 2 });
    expect(summary.ran).toEqual(["live_match", "future_schedule:la_liga"]);
    expect(summary.benign_skips).toBe(0);
    assertNoSensitiveKeys(summary);
  });

  it("summarizes an all-skipped round as ok", () => {
    const summary = buildTimerSummary({
      taskTypes: TASK_TYPES,
      provider: {
        outcome: "skipped",
        skipped: [
          { task: "live_match", reason: "no_provider_sources" },
          { task: "provider_reconcile", reason: "no_provider_sources" },
        ],
      },
      settlements: [],
      dbOps: { read: 0, write: 0 },
      durationMs: 3,
      errors: [],
    });
    expect(summary.outcome).toBe("ok");
    expect(summary.settlements).toEqual({ attempted: 0, settled: 0, failed: 0 });
    expect(summary.skipped).toEqual([
      { task: "live_match", reason: "no_provider_sources" },
      { task: "provider_reconcile", reason: "no_provider_sources" },
    ]);
    expect(summary.error_categories).toEqual({});
    assertNoSensitiveKeys(summary);
  });

  it("classifies one transient error as partial", () => {
    const summary = buildTimerSummary({
      taskTypes: TASK_TYPES,
      provider: { outcome: "completed", jobs_run: ["near_match"] },
      settlements: [
        { match_id: "m1", outcome: { kind: "settled" } },
        { match_id: "m2", outcome: { kind: "failed" } },
      ],
      dbOps: { read: 1, write: 0 },
      durationMs: 8,
      errors: [Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })],
    });
    expect(summary.outcome).toBe("partial");
    expect(summary.settlements).toEqual({ attempted: 2, settled: 1, failed: 1 });
    expect(summary.error_categories).toEqual({ transient: 1 });
    expect(summary.benign_skips).toBe(0);
    assertNoSensitiveKeys(summary);
  });

  it("classifies a data_format error with no successes as failed", () => {
    const summary = buildTimerSummary({
      taskTypes: TASK_TYPES,
      provider: { outcome: "skipped", skipped: [{ task: "live_match", reason: "interval_not_due" }] },
      settlements: [{ match_id: "m1", outcome: { kind: "failed" } }],
      dbOps: { read: 2, write: 0 },
      durationMs: 5,
      errors: [new ProviderDataError("invalid provider envelope")],
    });
    expect(summary.outcome).toBe("failed");
    expect(summary.settlements).toEqual({ attempted: 1, settled: 0, failed: 1 });
    expect(summary.error_categories).toEqual({ data_format: 1 });
    assertNoSensitiveKeys(summary);
  });

  it("maps by_collection onto db_ops_by_collection", () => {
    const summary = buildTimerSummary({
      taskTypes: TASK_TYPES,
      provider: { outcome: "completed", jobs_run: ["live_match"] },
      settlements: [],
      dbOps: {
        read: 5,
        write: 3,
        by_collection: [
          { collection: "ns_provider_usage", read: 3, write: 2 },
          { collection: "ns_provider_keys", read: 2, write: 1 },
        ],
      },
      durationMs: 9,
      errors: [],
    });
    expect(summary.db_ops).toEqual({ read: 5, write: 3 });
    expect(summary.db_ops_by_collection).toEqual([
      { collection: "ns_provider_usage", read: 3, write: 2 },
      { collection: "ns_provider_keys", read: 2, write: 1 },
    ]);
    assertNoSensitiveKeys(summary);
  });

  it("emits empty db_ops_by_collection when by_collection is omitted", () => {
    const summary = buildTimerSummary({
      taskTypes: TASK_TYPES,
      provider: { outcome: "completed" },
      settlements: [],
      dbOps: { read: 1, write: 0 },
      durationMs: 1,
      errors: [],
    });
    expect(summary.db_ops).toEqual({ read: 1, write: 0 });
    expect(summary.db_ops_by_collection).toEqual([]);
    assertNoSensitiveKeys(summary);
  });

  it("keeps deferred and skipped distinct from ran and does not mark them failed", () => {
    const summary = buildTimerSummary({
      taskTypes: TASK_TYPES,
      provider: {
        outcome: "completed",
        skipped: [{ task: "near_match", reason: "lock_held" }],
        deferred: [{
          task: "live_match",
          next_attempt_at: "2026-08-09T00:01:00.000Z",
          retry_attempt: 0,
          last_error_code: "ECONNRESET",
        }],
      },
      settlements: [],
      dbOps: { read: 1, write: 0 },
      durationMs: 4,
      errors: [],
    });
    expect(summary.outcome).toBe("ok");
    expect(summary.ran).toEqual([]);
    expect(summary.skipped).toEqual([{ task: "near_match", reason: "lock_held" }]);
    expect(summary.deferred).toEqual([{
      task: "live_match",
      next_attempt_at: "2026-08-09T00:01:00.000Z",
      retry_attempt: 0,
      last_error_code: "ECONNRESET",
    }]);
    expect(summary.failed).toEqual([]);
    assertNoSensitiveKeys(summary);
  });

  it("marks completed items_failed as failed even without thrown errors", () => {
    const summary = buildTimerSummary({
      taskTypes: TASK_TYPES,
      provider: {
        outcome: "failed",
        failed: [{ task: "live_match", reason: "items_failed", items_failed: 1 }],
      },
      settlements: [{ match_id: "m1", outcome: { kind: "settled" } }],
      dbOps: { read: 2, write: 1 },
      durationMs: 6,
      errors: [],
    });
    expect(summary.outcome).toBe("partial");
    expect(summary.ran).toEqual([]);
    expect(summary.failed).toEqual([{ task: "live_match", reason: "items_failed", items_failed: 1 }]);
    expect(summary.settlements).toEqual({ attempted: 1, settled: 1, failed: 0 });
    assertNoSensitiveKeys(summary);
  });
});
