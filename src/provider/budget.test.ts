import { describe, expect, it, vi } from "vitest";
import { SyncJobType } from "../domain/enums.js";
import { loadProviderSources } from "./sources.js";
import { InMemoryProviderUsageStore, ProviderBudget } from "./budget.js";

const source = loadProviderSources({
  FOOTBALL_PROVIDER_SOURCES: "bsd",
  FOOTBALL_PROVIDER_KEY_BSD: "test-key",
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
    await expect(budget.acquire("bsd", SyncJobType.PostFinishVerify, now)).resolves.toMatchObject({ allowed: true, daily_used: 10 });
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
