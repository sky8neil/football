import { describe, expect, it } from "vitest";
import { SyncJobType } from "../domain/enums.js";
import { InMemoryProviderUsageStore, ProviderBudget } from "./budget.js";
import { InMemoryProviderLeagueStateStore } from "./league-state.js";
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

  it("advances league completion only after the batch is committed", async () => {
    const config = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "fd",
      FOOTBALL_PROVIDER_KEY_FD: "fd-key-only",
    });
    const leagueStateStore = new InMemoryProviderLeagueStateStore();
    const now = new Date("2026-10-11T12:00:00.000Z");
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ matches: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const registry = new ProviderRegistry({
      config,
      fetchImpl,
      leagueStateStore,
      minimumGapMs: 0,
    });

    await registry.asClient().getFixtures({
      leagueId: "39",
      season: "2026",
      dateFrom: "2026-10-11",
      dateTo: "2026-10-12",
      jobType: SyncJobType.FutureSchedule,
      serverNow: now,
    });
    await expect(
      leagueStateStore.get("fd", "premier_league", SyncJobType.FutureSchedule),
    ).resolves.toBeNull();

    await registry.commitPendingLeagueSuccess(SyncJobType.FutureSchedule, now);
    await expect(
      leagueStateStore.get("fd", "premier_league", SyncJobType.FutureSchedule),
    ).resolves.toMatchObject({ last_success_at: now });
  });

  it("does not advance fixture league completion after team success when fixture loading fails", async () => {
    const config = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "fd",
      FOOTBALL_PROVIDER_KEY_FD: "fd-key-only",
    });
    const leagueStateStore = new InMemoryProviderLeagueStateStore();
    const now = new Date("2026-10-11T12:00:00.000Z");
    let requestCount = 0;
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify({ matches: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("fixture load unavailable");
    };
    const registry = new ProviderRegistry({
      config,
      fetchImpl,
      leagueStateStore,
      minimumGapMs: 0,
    });
    const client = registry.asClient();

    await client.getTeams({
      leagueId: "39",
      season: "2026",
      jobType: SyncJobType.FutureSchedule,
      serverNow: now,
    });
    await expect(client.getFixtures({
      leagueId: "39",
      season: "2026",
      dateFrom: "2026-10-11",
      dateTo: "2026-10-12",
      jobType: SyncJobType.FutureSchedule,
      serverNow: now,
    })).rejects.toThrow();
    registry.discardPendingLeagueSuccess(SyncJobType.FutureSchedule);
    await expect(
      leagueStateStore.get("fd", "premier_league", SyncJobType.FutureSchedule),
    ).resolves.toBeNull();
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

  it("5d live request success does not advance league completion before the batch commits", async () => {
    const config = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "5d",
      FOOTBALL_PROVIDER_KEY_5D: "5d-key-only",
    });
    const leagueStateStore = new InMemoryProviderLeagueStateStore();
    const now = new Date("2026-10-11T12:00:00.000Z");
    let requestCount = 0;
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1;
      return new Response(JSON.stringify({
        data: [{
          id: 9001,
          league: { id: "4160026622", name: "Premier League" },
          teams: { home: { id: 1, name: "Home" }, away: { id: 2, name: "Away" } },
          goals: { home: 1, away: 0 },
          status: "live",
          status_code: "first_half",
          kickoff_utc: "2026-10-11T11:00:00.000Z",
          round: 1,
        }],
        pagination: { has_more: false },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const registry = new ProviderRegistry({
      config,
      fetchImpl,
      leagueStateStore,
      minimumGapMs: 0,
    });

    await expect(registry.asClient().getFixtures({
      leagueId: "39",
      season: "2026",
      dateFrom: "2026-10-11",
      dateTo: "2026-10-12",
      jobType: SyncJobType.LiveMatch,
      serverNow: now,
    })).resolves.toHaveLength(1);
    expect(requestCount).toBe(1);
    await expect(
      leagueStateStore.get("5d", "premier_league", SyncJobType.LiveMatch),
    ).resolves.toBeNull();

    await registry.commitPendingLeagueSuccess(SyncJobType.LiveMatch, now);
    await expect(
      leagueStateStore.get("5d", "premier_league", SyncJobType.LiveMatch),
    ).resolves.toMatchObject({ last_success_at: now });
  });

  it("distributes one 5d live response to every league in the same tick", async () => {
    const config = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "5d",
      FOOTBALL_PROVIDER_KEY_5D: "5d-key-only",
    });
    const leagueStateStore = new InMemoryProviderLeagueStateStore();
    const now = new Date("2026-10-11T12:00:00.000Z");
    let requestCount = 0;
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1;
      return new Response(JSON.stringify({
        data: [
          {
            id: 9001,
            league: { id: "4160026622", name: "Premier League" },
            teams: { home: { id: 1, name: "Home" }, away: { id: 2, name: "Away" } },
            goals: { home: 1, away: 0 },
            status: "live",
            status_code: "first_half",
            kickoff_utc: "2026-10-11T11:00:00.000Z",
            round: 1,
          },
          {
            id: 9002,
            league: { id: "4212821298", name: "La Liga" },
            teams: { home: { id: 3, name: "Home 2" }, away: { id: 4, name: "Away 2" } },
            goals: { home: 0, away: 0 },
            status: "live",
            status_code: "first_half",
            kickoff_utc: "2026-10-11T11:30:00.000Z",
            round: 1,
          },
        ],
        pagination: { has_more: false },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const registry = new ProviderRegistry({
      config,
      fetchImpl,
      leagueStateStore,
      minimumGapMs: 0,
    });
    const client = registry.asClient();
    const query = (leagueId: string) => ({
      leagueId,
      season: "2026",
      dateFrom: "2026-10-11",
      dateTo: "2026-10-12",
      jobType: SyncJobType.LiveMatch,
      serverNow: now,
    });

    await expect(client.getFixtures(query("39"))).resolves.toHaveLength(1);
    const laLiga = await client.getFixtures(query("140"));
    expect(laLiga).toHaveLength(1);
    expect(String(laLiga[0]?.league.id)).toBe("4212821298");
    expect(requestCount).toBe(1);

    await expect(
      leagueStateStore.get("5d", "premier_league", SyncJobType.LiveMatch),
    ).resolves.toBeNull();
    await expect(
      leagueStateStore.get("5d", "la_liga", SyncJobType.LiveMatch),
    ).resolves.toBeNull();

    await registry.commitPendingLeagueSuccess(SyncJobType.LiveMatch, now);
    await expect(
      leagueStateStore.get("5d", "premier_league", SyncJobType.LiveMatch),
    ).resolves.toMatchObject({ last_success_at: now });
    await expect(
      leagueStateStore.get("5d", "la_liga", SyncJobType.LiveMatch),
    ).resolves.toMatchObject({ last_success_at: now });
  });

  it("isolates live_match cooldown per league for fd when 5d is not configured", async () => {
    const config = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "fd",
      FOOTBALL_PROVIDER_KEY_FD_1: "fd-key-1",
      FOOTBALL_SYNC_PROFILE: "prod",
    });
    const now = new Date("2026-10-11T12:00:00.000Z");
    let requestCount = 0;
    const fetchImpl: typeof fetch = async (input) => {
      requestCount += 1;
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const competition = url.includes("/competitions/PD/") ? "PD" : "PL";
      return new Response(JSON.stringify({
        matches: [{
          id: competition === "PL" ? 1001 : 1002,
          utcDate: "2026-10-11T11:30:00Z",
          status: "IN_PLAY",
          matchday: 8,
          homeTeam: { id: 10, name: "Home" },
          awayTeam: { id: 11, name: "Away" },
          score: { fullTime: { home: 1, away: 0 }, halfTime: { home: 1, away: 0 } },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const registry = new ProviderRegistry({ config, fetchImpl, minimumGapMs: 0 });
    const client = registry.asClient();
    const query = (leagueId: string, serverNow = now) => ({
      leagueId,
      season: "2026",
      dateFrom: "2026-10-11",
      dateTo: "2026-10-12",
      jobType: SyncJobType.LiveMatch,
      serverNow,
    });

    const epl = await client.getFixtures(query("39"));
    const laLiga = await client.getFixtures(query("140"));
    expect(epl).toHaveLength(1);
    expect(laLiga).toHaveLength(1);
    expect(requestCount).toBe(2);

    // Same league within the 5-minute prod cooldown is still throttled.
    await expect(client.getFixtures(query("39", new Date(now.getTime() + 60_000)))).resolves.toEqual([]);
    expect(requestCount).toBe(2);
  });
});
