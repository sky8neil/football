import { describe, expect, it, vi } from "vitest";
import { SyncJobType } from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { SyncLog } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { ProviderFixtureSyncService } from "./provider-fixture-sync.js";
import { ProviderFixtureSyncJobService } from "./provider-sync-job.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");

function makeDeferredLog(overrides: Partial<SyncLog> = {}): SyncLog {
  const startedAt = new Date(NOW.getTime() - 60_000);
  return {
    schema_version: 1,
    sync_job_id: newUuid(),
    job_type: SyncJobType.LiveMatch,
    status: "deferred",
    started_at: startedAt,
    finished_at: startedAt,
    attempt_count: 1,
    items_read: 0,
    items_changed: 0,
    items_failed: 0,
    last_error_code: "INTERNAL_ERROR",
    last_error_message: "temporary failure",
    retry_attempt: 0,
    next_attempt_at: new Date(NOW.getTime() - 1_000),
    created_at: startedAt,
    ...overrides,
  };
}

describe("ProviderFixtureSyncJobService 延期序号", () => {
  it("排除本轮 running 日志后按上一条 deferred 的 retry_attempt + 1 累计", async () => {
    const repo = new InMemoryRepository();
    await repo.syncLogs.insert(makeDeferredLog({
      retry_attempt: 2,
      started_at: new Date(NOW.getTime() - 60_000),
    }));
    const load = vi.fn(async () => {
      throw new Error("temporary network failure");
    });
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs: repo.syncLogs },
      new ProviderFixtureSyncService(repo),
      { random: () => 0.5 },
    );

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toMatchObject({
      kind: "deferred",
      retry_attempt: 3,
    });
    const latest = await repo.syncLogs.findLatestByJobType!(SyncJobType.LiveMatch);
    expect(latest).toMatchObject({
      status: "deferred",
      retry_attempt: 3,
    });
  });
});

describe("InMemoryRepository.findLatestByJobType", () => {
  it("多条日志时按 started_at 倒序取最新", async () => {
    const repo = new InMemoryRepository();
    const older = makeDeferredLog({
      retry_attempt: 0,
      started_at: new Date(NOW.getTime() - 120_000),
    });
    const newer = makeDeferredLog({
      retry_attempt: 1,
      started_at: new Date(NOW.getTime() - 30_000),
    });
    await repo.syncLogs.insert(older);
    await repo.syncLogs.insert(newer);

    await expect(repo.syncLogs.findLatestByJobType!(SyncJobType.LiveMatch)).resolves.toMatchObject({
      sync_job_id: newer.sync_job_id,
      retry_attempt: 1,
    });
  });

  it("excludeSyncJobId 生效", async () => {
    const repo = new InMemoryRepository();
    const older = makeDeferredLog({
      retry_attempt: 0,
      started_at: new Date(NOW.getTime() - 120_000),
    });
    const newer = makeDeferredLog({
      retry_attempt: 1,
      started_at: new Date(NOW.getTime() - 30_000),
    });
    await repo.syncLogs.insert(older);
    await repo.syncLogs.insert(newer);

    await expect(
      repo.syncLogs.findLatestByJobType!(SyncJobType.LiveMatch, {
        excludeSyncJobId: newer.sync_job_id,
      }),
    ).resolves.toMatchObject({
      sync_job_id: older.sync_job_id,
      retry_attempt: 0,
    });
  });

  it("无记录返回 null", async () => {
    const repo = new InMemoryRepository();
    await expect(repo.syncLogs.findLatestByJobType!(SyncJobType.LiveMatch)).resolves.toBeNull();
  });
});
