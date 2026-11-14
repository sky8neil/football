import { describe, expect, it, vi } from "vitest";
import { SyncJobType } from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { SyncLog } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { InMemoryProviderUsageStore, ProviderBudget } from "../provider/budget.js";
import { ProviderRequestDeferredError } from "../provider/http.js";
import { InMemoryProviderLeagueStateStore } from "../provider/league-state.js";
import { ProviderRegistry } from "../provider/registry.js";
import { loadProviderSources } from "../provider/sources.js";
import { createFutureScheduleLoader } from "./provider-fixture-loader.js";
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

describe("ProviderFixtureSyncJobService 配额延期", () => {
  it("日配额耗尽时不发请求、不提交空成功，并按真实重置时间写 deferred", async () => {
    const now = new Date("2026-08-09T12:00:00.000Z");
    const config = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "bsd",
      FOOTBALL_PROVIDER_KEY_BSD: "test-key",
    });
    config.sources[0] = { ...config.sources[0]!, daily_cap: 2 };
    const budget = new ProviderBudget(config.sources, new InMemoryProviderUsageStore());
    await expect(budget.acquire("bsd", SyncJobType.FutureSchedule, now)).resolves.toMatchObject({ allowed: true });

    let requestCount = 0;
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ count: 0, next: null, results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const leagueStateStore = new InMemoryProviderLeagueStateStore();
    const registry = new ProviderRegistry({
      config,
      fetchImpl,
      budget,
      leagueStateStore,
      minimumGapMs: 0,
    });
    const repo = new InMemoryRepository();
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs: repo.syncLogs },
      new ProviderFixtureSyncService(repo),
      { random: () => 0.5 },
    );

    const outcome = await service.run(
      SyncJobType.FutureSchedule,
      createFutureScheduleLoader(registry.asClient(), ["chinese_super_league"]),
      now,
    );

    expect(requestCount).toBe(0);
    expect(outcome).toMatchObject({
      kind: "deferred",
      job_type: SyncJobType.FutureSchedule,
      last_error_code: "PROVIDER_BUDGET_DENIED",
      retry_attempt: 0,
    });
    if (outcome.kind !== "deferred") throw new Error("expected deferred outcome");
    expect(outcome.next_attempt_at).toEqual(new Date("2026-08-10T00:00:00.000Z"));
    const latest = await repo.syncLogs.findLatestByJobType!(SyncJobType.FutureSchedule);
    expect(latest).toMatchObject({
      status: "deferred",
      last_error_code: "PROVIDER_BUDGET_DENIED",
    });
    await expect(
      leagueStateStore.get("bsd", "chinese_super_league", SyncJobType.FutureSchedule),
    ).resolves.toBeNull();
  });
});

describe("ProviderFixtureSyncJobService 源间隔延期", () => {
  it("源级轮询间隔未到时写 deferred 并携带真实 retry_at，而不是空成功", async () => {
    const repo = new InMemoryRepository();
    const retryAt = new Date(NOW.getTime() + 5 * 60_000);
    const load = vi.fn(async () => {
      throw new ProviderRequestDeferredError("provider_interval", retryAt);
    });
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs: repo.syncLogs },
      new ProviderFixtureSyncService(repo),
      { random: () => 0.5 },
    );

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toMatchObject({
      kind: "deferred",
      job_type: SyncJobType.LiveMatch,
      retry_attempt: 0,
      last_error_code: "PROVIDER_REQUEST_DEFERRED",
      next_attempt_at: retryAt,
    });
    expect(load).toHaveBeenCalledTimes(1);
    const latest = await repo.syncLogs.findLatestByJobType!(SyncJobType.LiveMatch);
    expect(latest).toMatchObject({
      status: "deferred",
      last_error_code: "PROVIDER_REQUEST_DEFERRED",
      next_attempt_at: retryAt,
    });
    expect(latest).not.toMatchObject({ status: "success" });
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
