import { describe, expect, it, vi } from "vitest";
import { SyncJobType } from "../domain/enums.js";
import {
  ProviderSyncDispatcher,
  type ProviderSyncJobType,
  type ProviderSyncRunnerMap,
} from "./provider-sync-dispatcher.js";

const NOW = new Date("2026-08-10T12:34:56.000Z");

function skipped(jobType: ProviderSyncJobType) {
  return {
    kind: "skipped" as const,
    fixtures: {
      kind: "skipped" as const,
      job_type: jobType,
      reason: "lock_held" as const,
    },
  };
}

function runners(): ProviderSyncRunnerMap {
  return {
    [SyncJobType.FutureSchedule]: vi.fn(async () => skipped(SyncJobType.FutureSchedule)),
    [SyncJobType.FullScheduleVerify]: vi.fn(async () => skipped(SyncJobType.FullScheduleVerify)),
    [SyncJobType.NearMatch]: vi.fn(async () => skipped(SyncJobType.NearMatch)),
    [SyncJobType.LiveMatch]: vi.fn(async () => skipped(SyncJobType.LiveMatch)),
    [SyncJobType.PostFinishVerify]: vi.fn(async () => skipped(SyncJobType.PostFinishVerify)),
  };
}

describe("ProviderSyncDispatcher", () => {
  it("按固定 Provider job_type 只调用对应 runner，并透传可信 server_now", async () => {
    const jobRunners = runners();
    const dispatcher = new ProviderSyncDispatcher(jobRunners);

    await expect(dispatcher.run(SyncJobType.LiveMatch, NOW)).resolves.toEqual(
      skipped(SyncJobType.LiveMatch),
    );
    expect(jobRunners[SyncJobType.LiveMatch]).toHaveBeenCalledWith(NOW);
    expect(jobRunners[SyncJobType.LiveMatch]).toHaveBeenCalledTimes(1);
    expect(jobRunners[SyncJobType.FutureSchedule]).not.toHaveBeenCalled();
    expect(jobRunners[SyncJobType.FullScheduleVerify]).not.toHaveBeenCalled();
    expect(jobRunners[SyncJobType.NearMatch]).not.toHaveBeenCalled();
    expect(jobRunners[SyncJobType.PostFinishVerify]).not.toHaveBeenCalled();
  });

  it("拒绝不属于 Provider 任务的 job_type", async () => {
    const dispatcher = new ProviderSyncDispatcher(runners());

    await expect(
      dispatcher.run("daily_consistency" as ProviderSyncJobType, NOW),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("拒绝无效 server_now，避免调度层使用不可信时间", async () => {
    const jobRunners = runners();
    const dispatcher = new ProviderSyncDispatcher(jobRunners);

    await expect(
      dispatcher.run(SyncJobType.FutureSchedule, new Date(Number.NaN)),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(jobRunners[SyncJobType.FutureSchedule]).not.toHaveBeenCalled();
  });
});
