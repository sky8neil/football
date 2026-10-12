import { describe, expect, it } from "vitest";
import { SyncJobType } from "../domain/enums.js";
import { InMemoryProviderUsageStore, ProviderBudget } from "./budget.js";
import { loadProviderSources } from "./sources.js";
import { ProviderRegistry } from "./registry.js";

describe("ProviderRegistry", () => {
  it("routes each league to its own adapter and authentication key", async () => {
    const config = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "fd,bsd",
      FOOTBALL_PROVIDER_KEY_FD: "fd-key-only",
      FOOTBALL_PROVIDER_KEY_BSD: "bsd-key-only",
    });
    const requests: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push({ url, headers: new Headers(init?.headers) });
      return new Response(JSON.stringify(url.includes("events/") ? { count: 0, next: null, results: [] } : { matches: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new ProviderRegistry({ config, fetchImpl }).asClient();

    await client.getFixtures({ leagueId: "39", season: "2026", dateFrom: "2026-10-10", dateTo: "2026-10-12" });
    await client.getFixtures({ leagueId: "169", season: "2026", dateFrom: "2026-10-10", dateTo: "2026-10-12" });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toContain("/competitions/PL/matches?");
    expect(requests[0]?.headers.get("X-Auth-Token")).toBe("fd-key-only");
    expect(requests[0]?.headers.get("Authorization")).toBeNull();
    expect(requests[1]?.url).toContain("/events/?league_id=52");
    expect(requests[1]?.headers.get("Authorization")).toBe("Token bsd-key-only");
    expect(requests[1]?.headers.get("X-Auth-Token")).toBeNull();
  });

  it("returns null for a league without a configured source", () => {
    const config = loadProviderSources({ FOOTBALL_PROVIDER_SOURCES: "" });
    expect(new ProviderRegistry({ config }).forLeague("premier_league")).toBeNull();
  });

  it("applies each live source's configured polling interval", async () => {
    const config = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "fd,bsd",
      FOOTBALL_PROVIDER_KEY_FD: "fd-key-only",
      FOOTBALL_PROVIDER_KEY_BSD: "bsd-key-only",
      FOOTBALL_SYNC_PROFILE: "test",
    });
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push(url);
      return new Response(JSON.stringify(url.includes("events/") ? { count: 0, next: null, results: [] } : { matches: [] }), { status: 200 });
    };
    const client = new ProviderRegistry({ config, fetchImpl, minimumGapMs: 0 }).asClient();
    const start = new Date("2026-10-11T12:00:00.000Z");
    const poll = (leagueId: string, afterMinutes: number) => client.getFixtures({
      leagueId,
      season: "2026",
      dateFrom: "2026-10-11",
      dateTo: "2026-10-12",
      jobType: SyncJobType.LiveMatch,
      serverNow: new Date(start.getTime() + afterMinutes * 60_000),
    });

    await Promise.all([poll("39", 0), poll("169", 0)]);
    await Promise.all([poll("39", 2), poll("169", 2)]);
    await Promise.all([poll("39", 5), poll("169", 5)]);
    await Promise.all([poll("39", 10), poll("169", 10)]);

    expect(requests).toHaveLength(5);
    expect(requests.filter((url) => url.includes("/events/"))).toHaveLength(3);
    expect(requests.filter((url) => url.includes("/competitions/PL/"))).toHaveLength(2);
  });

  it("stops before a request when BSD reports no remaining quota", async () => {
    const config = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "bsd",
      FOOTBALL_PROVIDER_KEY_BSD: "bsd-key-only",
    });
    let requestCount = 0;
    const budget = new ProviderBudget(config.sources, new InMemoryProviderUsageStore());
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ count: 0, next: null, results: [] }), {
        status: 200,
        headers: { "content-type": "application/json", "RateLimit": "requests; r=0; t=300" },
      });
    };
    const client = new ProviderRegistry({ config, fetchImpl, budget, minimumGapMs: 0 }).asClient();
    const query = {
      leagueId: "169",
      season: "2026",
      dateFrom: "2026-10-11",
      dateTo: "2026-10-12",
      jobType: SyncJobType.FutureSchedule,
      serverNow: new Date("2026-10-11T12:00:00.000Z"),
    };

    await client.getFixtures(query);
    await expect(client.getFixtures(query)).resolves.toEqual([]);
    expect(requestCount).toBe(1);
  });

  it("holds BSD requests until UTC midnight after taster_exhausted", async () => {
    const config = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "bsd",
      FOOTBALL_PROVIDER_KEY_BSD: "bsd-key-only",
    });
    let requestCount = 0;
    const budget = new ProviderBudget(config.sources, new InMemoryProviderUsageStore());
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ code: "taster_exhausted" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new ProviderRegistry({ config, fetchImpl, budget }).asClient();
    const query = {
      leagueId: "169",
      season: "2026",
      dateFrom: "2026-10-11",
      dateTo: "2026-10-12",
      jobType: SyncJobType.FutureSchedule,
      serverNow: new Date("2026-10-11T23:59:00.000Z"),
    };

    await expect(client.getFixtures(query)).rejects.toMatchObject({
      status: 429,
      providerCode: "taster_exhausted",
    });
    await expect(client.getFixtures(query)).resolves.toEqual([]);
    expect(requestCount).toBe(1);
  });

  it("holds BSD requests for Retry-After after rate_limited", async () => {
    const config = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "bsd",
      FOOTBALL_PROVIDER_KEY_BSD: "bsd-key-only",
    });
    let requestCount = 0;
    const budget = new ProviderBudget(config.sources, new InMemoryProviderUsageStore());
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ code: "rate_limited" }), {
        status: 429,
        headers: { "content-type": "application/json", "Retry-After": "60" },
      });
    };
    const client = new ProviderRegistry({ config, fetchImpl, budget }).asClient();
    const query = {
      leagueId: "169",
      season: "2026",
      dateFrom: "2026-10-11",
      dateTo: "2026-10-12",
      jobType: SyncJobType.FutureSchedule,
      serverNow: new Date(),
    };

    await expect(client.getFixtures(query)).rejects.toMatchObject({
      status: 429,
      providerCode: "rate_limited",
    });
    await expect(client.getFixtures(query)).resolves.toEqual([]);
    expect(requestCount).toBe(1);
  });
});
