import { describe, expect, it, vi } from "vitest";
import { SyncJobType } from "../domain/enums.js";
import { loadProviderSources } from "./sources.js";
import { InMemoryProviderUsageStore, ProviderBudget, type ProviderUsageBucket } from "./budget.js";

const source = loadProviderSources({
  FOOTBALL_PROVIDER_SOURCES: "bsd",
  FOOTBALL_PROVIDER_KEY_BSD: "test-key",
}).sources[0]!;
const openFootSource = loadProviderSources({
  FOOTBALL_PROVIDER_SOURCES: "of",
  FOOTBALL_PROVIDER_KEY_OF: "test-key",
  FOOTBALL_SYNC_PROFILE: "prod",
}).sources[0]!;

describe("ProviderBudget", () => {
  it("enforces per-minute and priority-based daily caps", async () => {
    const configured = { ...source, max_per_minute: 20, daily_cap: 10 };
    const budget = new ProviderBudget([configured], new InMemoryProviderUsageStore());
    const now = new Date("2026-10-11T12:00:00.000Z");

    for (let i = 0; i < 5; i += 1) {
      await expect(budget.acquire("bsd", SyncJobType.FutureSchedule, now)).resolves.toMatchObject({ allowed: true });
    }
    await expect(budget.acquire("bsd", SyncJobType.FutureSchedule, now)).resolves.toMatchObject({ allowed: false, reason: "day_limit", key_id: "bsd#1" });
    for (let i = 0; i < 4; i += 1) {
      await expect(budget.acquire("bsd", SyncJobType.LiveMatch, now)).resolves.toMatchObject({ allowed: true });
    }
    await expect(budget.acquire("bsd", SyncJobType.LiveMatch, now)).resolves.toMatchObject({ allowed: false, reason: "day_limit", key_id: "bsd#1" });
    await expect(budget.acquire("bsd", SyncJobType.PostFinishVerify, now)).resolves.toMatchObject({
      allowed: false,
      reason: "day_limit",
    });
  });

  it.each([[120, 72, 12, 36], [40, 24, 4, 12], [11, 6, 1, 4]])("isolates OpenFoot daily pools for cap %i", async (cap, windowCap, recoveryCap, reconcileCap) => {
    const configured = { ...openFootSource, max_per_minute: 200, daily_cap: cap, monthly_cap: null };
    const now = new Date("2026-10-11T12:00:00.000Z");
    const budget = new ProviderBudget([configured], new InMemoryProviderUsageStore());
    const pools = [
      [SyncJobType.PostFinishVerify, windowCap],
      [SyncJobType.StaleRecovery, recoveryCap],
      [SyncJobType.ProviderReconcile, reconcileCap],
    ] as const;

    expect(windowCap + recoveryCap + reconcileCap).toBe(cap);
    for (const [job, limit] of pools) {
      for (let i = 0; i < limit; i += 1) {
        await expect(budget.acquire("of", job, now)).resolves.toMatchObject({ allowed: true });
      }
      await expect(budget.acquire("of", job, now)).resolves.toMatchObject({ allowed: false, reason: "day_limit" });
    }
    await expect(budget.usageSnapshot(now)).resolves.toMatchObject({ of: { used: cap, cap } });
  });

  it("isolates OpenFoot monthly pools and allocates rounding remainder to reconciliation", async () => {
    const configured = { ...openFootSource, max_per_minute: 200, daily_cap: 0, monthly_cap: 11 };
    const now = new Date("2026-10-11T12:00:00.000Z");
    const budget = new ProviderBudget([configured], new InMemoryProviderUsageStore());
    for (const [job, limit] of [[SyncJobType.PostFinishVerify, 6], [SyncJobType.StaleRecovery, 1], [SyncJobType.ProviderReconcile, 4]] as const) {
      for (let i = 0; i < limit; i += 1) {
        await expect(budget.acquire("of", job, now)).resolves.toMatchObject({ allowed: true });
      }
      await expect(budget.acquire("of", job, now)).resolves.toMatchObject({ allowed: false, reason: "month_limit" });
    }
    await expect(budget.usageSnapshot(now)).resolves.toMatchObject({ of: { month_used: 11 } });
  });

  it.each(["day", "month"] as const)("enforces the OpenFoot total %s cap even with pool quota remaining", async (type) => {
    const configured = { ...openFootSource, max_per_minute: 200, daily_cap: 10, monthly_cap: 10 };
    const now = new Date("2026-10-11T12:00:00.000Z");
    const store = new InMemoryProviderUsageStore();
    const bucket: ProviderUsageBucket = type === "day"
      ? { source_id: "of", bucket_type: "day", bucket_key: "2026-10-11", bucket_start: new Date("2026-10-11T00:00:00.000Z") }
      : { source_id: "of", bucket_type: "month", bucket_key: "2026-10", bucket_start: new Date("2026-10-01T00:00:00.000Z") };
    for (let i = 0; i < 10; i += 1) await store.reserve(bucket, 10);
    const budget = new ProviderBudget([configured], store);
    await expect(budget.acquire("of", SyncJobType.ProviderReconcile, now)).resolves.toMatchObject({ allowed: false, reason: `${type}_limit` });
    await expect(budget.usageSnapshot(now)).resolves.toMatchObject({ of: { used: type === "day" ? 10 : 0, month_used: type === "month" ? 10 : 0, minute_used: 0 } });
  });

  it("keeps window and recovery pools available after reconciliation is exhausted", async () => {
    const configured = { ...openFootSource, max_per_minute: 200, daily_cap: 10, monthly_cap: null };
    const now = new Date("2026-10-11T12:00:00.000Z");
    const budget = new ProviderBudget([configured], new InMemoryProviderUsageStore());
    for (let i = 0; i < 3; i += 1) await expect(budget.acquire("of", SyncJobType.ProviderReconcile, now)).resolves.toMatchObject({ allowed: true });
    await expect(budget.acquire("of", SyncJobType.ProviderReconcile, now)).resolves.toMatchObject({ allowed: false, reason: "day_limit" });
    await expect(budget.acquire("of", SyncJobType.PostFinishVerify, now)).resolves.toMatchObject({ allowed: true });
    await expect(budget.acquire("of", SyncJobType.StaleRecovery, now)).resolves.toMatchObject({ allowed: true });
  });

  it("retains the OpenFoot full schedule verification limit", async () => {
    const configured = { ...openFootSource, max_per_minute: 200, daily_cap: 120 };
    const now = new Date("2026-10-11T12:00:00.000Z");
    const budget = new ProviderBudget([configured], new InMemoryProviderUsageStore());
    for (let i = 0; i < 60; i += 1) {
      await expect(budget.acquire("of", SyncJobType.FullScheduleVerify, now)).resolves.toMatchObject({ allowed: true });
    }
    await expect(budget.acquire("of", SyncJobType.FullScheduleVerify, now)).resolves.toMatchObject({ allowed: false, reason: "day_limit" });
  });

  it("rejects exhausted daily quota with the real reset time and no extra reservation", async () => {
    const configured = { ...source, max_per_minute: 20, daily_cap: 10 };
    const budget = new ProviderBudget([configured], new InMemoryProviderUsageStore());
    const now = new Date("2026-10-11T12:00:00.000Z");

    for (let i = 0; i < 5; i += 1) {
      await expect(budget.acquire("bsd", SyncJobType.FutureSchedule, now)).resolves.toMatchObject({ allowed: true });
    }
    await expect(budget.acquire("bsd", SyncJobType.FutureSchedule, now)).resolves.toMatchObject({
      allowed: false,
      reason: "day_limit",
      key_id: "bsd#1",
      retry_at: new Date("2026-10-12T00:00:00.000Z"),
    });
    await expect(budget.usageSnapshot(now)).resolves.toMatchObject({ bsd: { used: 5, cap: 10 } });
  });

  it("shares atomic reservations across concurrent acquisitions and emits the 80% warning", async () => {
    const configured = { ...source, max_per_minute: 3, daily_cap: 10 };
    const log = vi.fn();
    const budget = new ProviderBudget([configured], new InMemoryProviderUsageStore(), log);
    const now = new Date("2026-10-11T12:00:00.000Z");
    const concurrent = await Promise.all(Array.from({ length: 20 }, () =>
      budget.acquire("bsd", SyncJobType.PostFinishVerify, now),
    ));
    expect(concurrent.filter((item) => item.allowed)).toHaveLength(3);

    const snapshot = await budget.usageSnapshot(now);
    expect(snapshot.bsd).toMatchObject({ used: 3, cap: 10, warning: false, minute_used: 3, hour_used: 0, month_used: 0 });
    for (let i = 1; i <= 5; i += 1) {
      await budget.acquire("bsd", SyncJobType.PostFinishVerify, new Date(now.getTime() + i * 60_000));
    }
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ diag_code: "DIAG_PROVIDER_QUOTA_WARN", source_id: "bsd" }));
  });

  it("resets the BSD day bucket at UTC midnight", async () => {
    const configured = { ...source, max_per_minute: 10, daily_cap: 10 };
    const budget = new ProviderBudget([configured], new InMemoryProviderUsageStore());
    await budget.acquire("bsd", SyncJobType.PostFinishVerify, new Date("2026-10-11T23:59:00.000Z"));
    await expect(budget.usageSnapshot(new Date("2026-10-12T00:00:00.000Z"))).resolves.toMatchObject({ bsd: { used: 0, cap: 10 } });
  });

  it("denies requests when the observed provider quota is empty, until its reset time", async () => {
    const configured = { ...source, max_per_minute: 10, daily_cap: 10 };
    const budget = new ProviderBudget([configured], new InMemoryProviderUsageStore());
    const now = new Date("2026-10-11T12:00:00.000Z");
    const resetAt = new Date(now.getTime() + 60_000);
    budget.observeRemoteQuota("bsd", 0, resetAt, now);

    await expect(budget.acquire("bsd", SyncJobType.LiveMatch, now)).resolves.toEqual({
      allowed: false,
      reason: "provider_quota",
      key_id: "bsd#1",
    });
    await expect(budget.acquire("bsd", SyncJobType.LiveMatch, resetAt)).resolves.toMatchObject({ allowed: true });
  });

  it("pauses a provider until the recorded recovery time", async () => {
    const budget = new ProviderBudget([source], new InMemoryProviderUsageStore());
    const now = new Date("2026-10-11T12:00:00.000Z");
    const resetAt = new Date(now.getTime() + 60_000);
    budget.pauseSource("bsd", resetAt, "rate_limited");

    await expect(budget.acquire("bsd", SyncJobType.LiveMatch, now)).resolves.toEqual({
      allowed: false,
      reason: "provider_cooldown",
      key_id: "bsd#1",
    });
    await expect(budget.acquire("bsd", SyncJobType.LiveMatch, resetAt)).resolves.toMatchObject({ allowed: true });
  });
});
