import { describe, expect, it, vi } from "vitest";
import { SyncJobType } from "../domain/enums.js";
import { runDueProviderJobs } from "../runtime/scheduled-jobs.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");

function recentSuccess(jobType: string) {
  return {
    job_type: jobType,
    status: "success",
    started_at: NOW,
  };
}

async function runWithLiveMatchLog(liveMatchLog: Record<string, unknown>) {
  const dueLeagues = vi.fn(async () => []);
  const providerRegistry = { dueLeagues } as unknown as Parameters<typeof runDueProviderJobs>[0]["providerRegistry"];
  const dispatchRun = vi.fn(async (..._args: unknown[]) => ({ kind: "completed" }));
  const dispatcher = { run: dispatchRun } as unknown as Parameters<typeof runDueProviderJobs>[0]["dispatcher"];
  const querySpy = vi.fn(async (_collection: string, filter: { job_type?: string }) => {
    if (filter.job_type === SyncJobType.LiveMatch) return [liveMatchLog];
    if (filter.job_type === SyncJobType.PostFinishVerify) return [recentSuccess(SyncJobType.PostFinishVerify)];
    if (filter.job_type === SyncJobType.NearMatch) return [recentSuccess(SyncJobType.NearMatch)];
    if (filter.job_type === SyncJobType.ProviderReconcile) return [recentSuccess(SyncJobType.ProviderReconcile)];
    return [];
  });
  const cloudDb = { query: querySpy } as unknown as Parameters<typeof runDueProviderJobs>[0]["cloudDb"];
  const reconcile = { run: vi.fn(async () => ({ kind: "completed" })) } as unknown as Parameters<typeof runDueProviderJobs>[0]["reconcile"];

  const result = await runDueProviderJobs({
    cloudDb,
    namespace: "football_test",
    dispatcher,
    providerRegistry,
    syncLeagueIds: ["premier_league"],
    sourceIds: ["fd"],
    profile: "test",
    reconcile,
    serverNow: NOW,
    log: vi.fn(),
  });
  return { result, dispatchRun };
}

describe("runDueProviderJobs 延期调度门", () => {
  it("上一轮 deferred 且 next_attempt_at 在未来时跳过该 job", async () => {
    const { result, dispatchRun } = await runWithLiveMatchLog({
      job_type: SyncJobType.LiveMatch,
      status: "deferred",
      started_at: NOW,
      next_attempt_at: new Date(NOW.getTime() + 60_000),
      retry_attempt: 0,
    });

    expect(dispatchRun).not.toHaveBeenCalled();
    expect(result.skipped).toEqual(expect.arrayContaining([
      { task: SyncJobType.LiveMatch, reason: "deferred_not_due" },
    ]));
  });

  it("上一轮 deferred 且 next_attempt_at 已到期时即使常规间隔未到也调度", async () => {
    const { result, dispatchRun } = await runWithLiveMatchLog({
      job_type: SyncJobType.LiveMatch,
      status: "deferred",
      started_at: NOW,
      next_attempt_at: new Date(NOW.getTime() - 1_000),
      retry_attempt: 0,
    });

    expect(dispatchRun).toHaveBeenCalledTimes(1);
    expect(dispatchRun).toHaveBeenCalledWith(SyncJobType.LiveMatch, NOW);
    expect(result.jobs_run).toEqual(expect.arrayContaining([SyncJobType.LiveMatch]));
    expect(result.skipped).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ task: SyncJobType.LiveMatch }),
    ]));
  });
});
