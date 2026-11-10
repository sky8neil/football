import { describe, expect, it, vi } from "vitest";
import { SyncJobType } from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { SyncLog } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { ProviderFixtureSyncService } from "./provider-fixture-sync.js";
import { ProviderFixtureSyncJobService } from "./provider-sync-job.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const DUE_INTERVAL_MS = 3 * 60_000;

function makeLog(overrides: Partial<SyncLog> = {}): SyncLog {
  const startedAt = new Date(NOW.getTime() - 60_000);
  return {
    schema_version: 1,
    sync_job_id: newUuid(),
    job_type: SyncJobType.LiveMatch,
    status: "success",
    started_at: startedAt,
    finished_at: startedAt,
    attempt_count: 1,
    items_read: 0,
    items_changed: 0,
    items_failed: 0,
    last_error_code: null,
    last_error_message: null,
    created_at: startedAt,
    ...overrides,
  };
}

function makeService(
  repo: InMemoryRepository,
  dueIntervalMs?: number,
  ports?: { jobLocks?: InMemoryRepository["jobLocks"]; syncLogs?: InMemoryRepository["syncLogs"] },
) {
  return new ProviderFixtureSyncJobService(
    { jobLocks: ports?.jobLocks ?? repo.jobLocks, syncLogs: ports?.syncLogs ?? repo.syncLogs },
    new ProviderFixtureSyncService(repo),
    {},
    dueIntervalMs === undefined ? {} : { dueIntervalMs },
  );
}

describe("RP08 锁内二次资格确认", () => {
  it("最新日志是 success 且 started_at 在间隔内 → skipped / not_due_after_lock，不写 log、不 load、release 1 次", async () => {
    const repo = new InMemoryRepository();
    await repo.syncLogs.insert(makeLog({
      status: "success",
      started_at: new Date(NOW.getTime() - 60_000),
    }));
    const jobLocks = repo.jobLocks;
    const syncLogs = repo.syncLogs;
    const insert = vi.spyOn(syncLogs, "insert");
    const release = vi.spyOn(jobLocks, "release");
    const load = vi.fn(async () => []);
    const service = makeService(repo, DUE_INTERVAL_MS, { jobLocks, syncLogs });

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toEqual({
      kind: "skipped",
      job_type: SyncJobType.LiveMatch,
      reason: "not_due_after_lock",
    });
    expect(load).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("最新日志 success 但已超过间隔 → 正常执行 completed", async () => {
    const repo = new InMemoryRepository();
    await repo.syncLogs.insert(makeLog({
      status: "success",
      started_at: new Date(NOW.getTime() - DUE_INTERVAL_MS - 1_000),
    }));
    const load = vi.fn(async () => []);
    const service = makeService(repo, DUE_INTERVAL_MS);

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toEqual({
      kind: "completed",
      job_type: SyncJobType.LiveMatch,
      items_read: 0,
      items_changed: 0,
      items_failed: 0,
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("最新日志是 deferred 且 next_attempt_at 在未来 → skipped", async () => {
    const repo = new InMemoryRepository();
    await repo.syncLogs.insert(makeLog({
      status: "deferred",
      next_attempt_at: new Date(NOW.getTime() + 60_000),
    }));
    const syncLogs = repo.syncLogs;
    const insert = vi.spyOn(syncLogs, "insert");
    const load = vi.fn(async () => []);
    const service = makeService(repo, DUE_INTERVAL_MS, { syncLogs });

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toEqual({
      kind: "skipped",
      job_type: SyncJobType.LiveMatch,
      reason: "not_due_after_lock",
    });
    expect(load).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("最新日志是 deferred 但 next_attempt_at 已过 → 正常执行", async () => {
    const repo = new InMemoryRepository();
    await repo.syncLogs.insert(makeLog({
      status: "deferred",
      next_attempt_at: new Date(NOW.getTime() - 1_000),
    }));
    const load = vi.fn(async () => []);
    const service = makeService(repo, DUE_INTERVAL_MS);

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toEqual({
      kind: "completed",
      job_type: SyncJobType.LiveMatch,
      items_read: 0,
      items_changed: 0,
      items_failed: 0,
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("无历史日志 → 正常执行", async () => {
    const repo = new InMemoryRepository();
    const load = vi.fn(async () => []);
    const service = makeService(repo, DUE_INTERVAL_MS);

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toEqual({
      kind: "completed",
      job_type: SyncJobType.LiveMatch,
      items_read: 0,
      items_changed: 0,
      items_failed: 0,
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("不传 dueIntervalMs → 不做二次确认，即使有刚跑完的 success 也照常执行", async () => {
    const repo = new InMemoryRepository();
    await repo.syncLogs.insert(makeLog({
      status: "success",
      started_at: new Date(NOW.getTime() - 1_000),
    }));
    const load = vi.fn(async () => []);
    const service = makeService(repo);

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toEqual({
      kind: "completed",
      job_type: SyncJobType.LiveMatch,
      items_read: 0,
      items_changed: 0,
      items_failed: 0,
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("executeHeldByCaller 在 not-due 时返回 skipped 且不写 sync_log、不 release", async () => {
    const repo = new InMemoryRepository();
    await repo.syncLogs.insert(makeLog({
      status: "success",
      started_at: new Date(NOW.getTime() - 60_000),
    }));
    const jobLocks = repo.jobLocks;
    const syncLogs = repo.syncLogs;
    const insert = vi.spyOn(syncLogs, "insert");
    const release = vi.spyOn(jobLocks, "release");
    const load = vi.fn(async () => []);
    const service = makeService(repo, DUE_INTERVAL_MS, { jobLocks, syncLogs });

    await expect(
      service.executeHeldByCaller(SyncJobType.LiveMatch, load, NOW, "caller-owner"),
    ).resolves.toEqual({
      kind: "skipped",
      job_type: SyncJobType.LiveMatch,
      reason: "not_due_after_lock",
    });
    expect(load).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});
