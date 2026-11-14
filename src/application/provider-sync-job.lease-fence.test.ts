import { describe, expect, it, vi } from "vitest";
import { MatchStatus, SyncJobType } from "../domain/enums.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { makeApiFixture } from "../provider/fixture-factory.js";
import { ProviderDataError } from "../provider/http.js";
import { jobLockKey } from "../sync/config.js";
import { ProviderFixtureSyncService } from "./provider-fixture-sync.js";
import {
  ProviderFixtureSyncJobService,
  startJobLockRenewal,
  type ProviderFixtureBatchItem,
} from "./provider-sync-job.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const LOCK_KEY = jobLockKey(SyncJobType.LiveMatch);

function item(fixtureId: number): ProviderFixtureBatchItem {
  return {
    fixture: makeApiFixture({ fixtureId, statusShort: "TBD" }),
    payload: { fixture_id: fixtureId },
  };
}

function wrapJobLocks(repo: InMemoryRepository) {
  const acquire = vi.fn(
    (lockKey: string, ownerId: string, leaseUntil: Date) =>
      repo.jobLocks.acquire(lockKey, ownerId, leaseUntil),
  );
  const release = vi.fn(
    (lockKey: string, ownerId: string) => repo.jobLocks.release(lockKey, ownerId),
  );
  return {
    acquire,
    release,
    jobLocks: {
      acquire,
      isHeld: (lockKey: string, asOf: Date) => repo.jobLocks.isHeld(lockKey, asOf),
      isHeldBy: (lockKey: string, ownerId: string, asOf: Date) =>
        repo.jobLocks.isHeldBy(lockKey, ownerId, asOf),
      renew: (lockKey: string, ownerId: string, leaseUntil: Date) =>
        repo.jobLocks.renew(lockKey, ownerId, leaseUntil),
      release,
    },
  };
}

async function stealLock(
  repo: InMemoryRepository,
  acquire: ReturnType<typeof wrapJobLocks>["acquire"],
): Promise<void> {
  const ownerId = acquire.mock.calls[0]?.[1];
  if (typeof ownerId !== "string") throw new Error("未记录到 acquire 的 ownerId");
  await repo.jobLocks.release(LOCK_KEY, ownerId);
  expect(
    await repo.jobLocks.acquire(LOCK_KEY, "other-owner", new Date(NOW.getTime() + 60_000)),
  ).toBe(true);
}

function recordingSyncLogs() {
  return {
    insert: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
  };
}

describe("RP08-2 租约围栏", () => {
  it("写 success 前锁被他人抢走 → PROVIDER_SYNC_LEASE_LOST，不写 success，release 1 次", async () => {
    const repo = new InMemoryRepository();
    const { jobLocks, acquire, release } = wrapJobLocks(repo);
    const syncLogs = recordingSyncLogs();
    const load = vi.fn(async () => {
      await stealLock(repo, acquire);
      return [];
    });
    const service = new ProviderFixtureSyncJobService(
      { jobLocks, syncLogs },
      { applyFixture: vi.fn(async () => ({ kind: "failed" as const, match_id: null, anomaly_types: [] })) },
      {},
      { renewal: { proofTtlMs: 0, now: () => NOW.getTime() } },
    );

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).rejects.toMatchObject({
      code: "PROVIDER_SYNC_LEASE_LOST",
    });
    expect(syncLogs.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: "success" }));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("批次第 2 条之前锁被抢走 → 第 2 条 applyFixture 未被调用，抛 PROVIDER_SYNC_LEASE_LOST", async () => {
    const repo = new InMemoryRepository();
    const { jobLocks, acquire } = wrapJobLocks(repo);
    const syncLogs = recordingSyncLogs();
    const applyFixture = vi.fn(async () => {
      if (applyFixture.mock.calls.length === 1) {
        await stealLock(repo, acquire);
      }
      return { kind: "failed" as const, match_id: null, anomaly_types: [] };
    });
    const service = new ProviderFixtureSyncJobService(
      { jobLocks, syncLogs },
      { applyFixture },
      {},
      { renewal: { proofTtlMs: 0, now: () => NOW.getTime() } },
    );
    const load = vi.fn(async () => [item(1100001), item(1100002)]);

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).rejects.toMatchObject({
      code: "PROVIDER_SYNC_LEASE_LOST",
    });
    expect(applyFixture).toHaveBeenCalledTimes(1);
  });

  it("lease 丢失后 catch 不写 failed 日志", async () => {
    const repo = new InMemoryRepository();
    const { jobLocks, acquire } = wrapJobLocks(repo);
    const syncLogs = recordingSyncLogs();
    const failure = new ProviderDataError("invalid data");
    const load = vi.fn(async () => {
      await stealLock(repo, acquire);
      throw failure;
    });
    const service = new ProviderFixtureSyncJobService(
      { jobLocks, syncLogs },
      { applyFixture: vi.fn() },
      {},
      { renewal: { proofTtlMs: 0, now: () => NOW.getTime() } },
    );

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).rejects.toBe(failure);
    expect(syncLogs.update).not.toHaveBeenCalled();
  });

  it("正常路径（锁一直持有）→ 全部 assertHeld 通过，行为不变（completed）", async () => {
    const repo = new InMemoryRepository();
    const load = vi.fn(async () => []);
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs: repo.syncLogs },
      new ProviderFixtureSyncService(repo),
    );

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toEqual({
      kind: "completed",
      job_type: SyncJobType.LiveMatch,
      items_read: 0,
      items_changed: 0,
      items_failed: 0,
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("默认校验窗口内不逐条回查 job_locks（围栏不为每条 fixture 增加一次读）", async () => {
    const repo = new InMemoryRepository();
    const isHeldBy = vi.fn(
      (lockKey: string, ownerId: string, asOf: Date) =>
        repo.jobLocks.isHeldBy(lockKey, ownerId, asOf),
    );
    const jobLocks = {
      acquire: (lockKey: string, ownerId: string, leaseUntil: Date) =>
        repo.jobLocks.acquire(lockKey, ownerId, leaseUntil),
      isHeld: (lockKey: string, asOf: Date) => repo.jobLocks.isHeld(lockKey, asOf),
      isHeldBy,
      renew: (lockKey: string, ownerId: string, leaseUntil: Date) =>
        repo.jobLocks.renew(lockKey, ownerId, leaseUntil),
      release: (lockKey: string, ownerId: string) => repo.jobLocks.release(lockKey, ownerId),
    };
    const applyFixture = vi.fn(async () => ({
      kind: "unchanged" as const,
      match_id: "match-1",
      match_status: MatchStatus.Scheduled,
    }));
    const service = new ProviderFixtureSyncJobService(
      { jobLocks, syncLogs: repo.syncLogs },
      { applyFixture },
    );
    const load = vi.fn(async () => [item(1100001), item(1100002), item(1100003)]);

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toMatchObject({
      kind: "completed",
      items_read: 3,
    });
    expect(applyFixture).toHaveBeenCalledTimes(3);
    expect(isHeldBy).not.toHaveBeenCalled();
  });

  it("renewal 防重入：inFlight 时跳过后续 tick，只发起 1 次 renew", async () => {
    vi.useFakeTimers();
    try {
      const renew = vi.fn(() => new Promise<boolean>(() => undefined));
      const renewal = startJobLockRenewal(
        {
          jobLocks: {
            acquire: vi.fn(async () => true),
            isHeld: vi.fn(async () => false),
            isHeldBy: vi.fn(async () => true),
            renew,
            release: vi.fn(async () => undefined),
          },
        },
        LOCK_KEY,
        "owner-1",
        { now: () => Date.now(), leaseMs: 10_000 },
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(renew).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(renew).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(renew).toHaveBeenCalledTimes(1);
      renewal.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() 后推进时间不再发起 renew", async () => {
    vi.useFakeTimers();
    try {
      const renew = vi.fn(async () => true);
      const renewal = startJobLockRenewal(
        {
          jobLocks: {
            acquire: vi.fn(async () => true),
            isHeld: vi.fn(async () => false),
            isHeldBy: vi.fn(async () => true),
            renew,
            release: vi.fn(async () => undefined),
          },
        },
        LOCK_KEY,
        "owner-1",
        { now: () => Date.now(), leaseMs: 10_000 },
      );
      renewal.stop();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(renew).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
