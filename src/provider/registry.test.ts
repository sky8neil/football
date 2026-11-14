import { describe, expect, it, vi } from "vitest";
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
    await expect(client.getFixtures(query)).rejects.toMatchObject({
      name: "ProviderBudgetDeferredError",
      reason: "provider_quota",
      retry_at: new Date("2026-10-11T12:05:00.000Z"),
    });
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
    await expect(client.getFixtures(query)).rejects.toMatchObject({
      name: "ProviderBudgetDeferredError",
      reason: "provider_cooldown",
      retry_at: new Date("2026-10-12T00:00:00.000Z"),
    });
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
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const now = new Date("2026-10-11T12:00:00.000Z");
      vi.setSystemTime(now);
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
        serverNow: now,
      };

      await expect(client.getFixtures(query)).rejects.toMatchObject({
        status: 429,
        providerCode: "rate_limited",
      });
      await expect(client.getFixtures(query)).rejects.toMatchObject({
        name: "ProviderBudgetDeferredError",
        reason: "provider_cooldown",
        retry_at: new Date(now.getTime() + 60_000),
      });
      expect(requestCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
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

  it("defers a 5d live primary within its interval instead of falling back to fd", async () => {
    const config = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "fd,5d",
      FOOTBALL_PROVIDER_KEY_FD: "fd-key-only",
      FOOTBALL_PROVIDER_KEY_5D: "5d-key-only",
      FOOTBALL_SYNC_PROFILE: "test",
    });
    const now = new Date("2026-10-11T12:00:00.000Z");
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push(url);
      const body = url.includes("5dollarfootballapi")
        ? {
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
          }
        : { matches: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const registry = new ProviderRegistry({ config, fetchImpl, minimumGapMs: 0 });
    const client = registry.asClient();
    const query = (at: Date) => ({
      leagueId: "39",
      season: "2026",
      dateFrom: "2026-10-11",
      dateTo: "2026-10-12",
      jobType: SyncJobType.LiveMatch,
      serverNow: at,
    });

    await expect(client.getFixtures(query(now))).resolves.toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("5dollarfootballapi");

    const withinInterval = new Date(now.getTime() + 60_000);
    await expect(client.getFixtures(query(withinInterval))).rejects.toMatchObject({
      name: "ProviderRequestDeferredError",
      reason: "provider_interval",
      retry_at: new Date(now.getTime() + 5 * 60_000),
    });
    expect(requests).toHaveLength(1);
    expect(requests.some((url) => url.includes("football-data.org") || url.includes("/competitions/"))).toBe(false);
  });

  it("keeps a failed 5d live request shared within the tick and defers the source interval", async () => {
    const config = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "5d",
      FOOTBALL_PROVIDER_KEY_5D: "5d-key-only",
      FOOTBALL_SYNC_PROFILE: "test",
    });
    const leagueStateStore = new InMemoryProviderLeagueStateStore();
    const now = new Date("2026-10-11T12:00:00.000Z");
    let requestCount = 0;
    let available = false;
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1;
      if (!available) return new Response("live source unavailable", { status: 404 });
      return new Response(JSON.stringify({ data: [], pagination: { has_more: false } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const registry = new ProviderRegistry({
      config,
      fetchImpl,
      budget: new ProviderBudget(config.sources, new InMemoryProviderUsageStore()),
      leagueStateStore,
      minimumGapMs: 0,
    });
    const client = registry.asClient();
    const query = (leagueId: string, at: Date) => ({
      leagueId,
      season: "2026",
      dateFrom: "2026-10-11",
      dateTo: "2026-10-12",
      jobType: SyncJobType.LiveMatch,
      serverNow: at,
    });

    await expect(client.getFixtures(query("39", now))).rejects.toMatchObject({ status: 404 });
    await expect(client.getFixtures(query("140", now))).rejects.toMatchObject({ status: 404 });
    expect(requestCount).toBe(1);
    await expect(
      leagueStateStore.get("5d", "premier_league", SyncJobType.LiveMatch),
    ).resolves.toBeNull();
    await expect(
      leagueStateStore.get("5d", "la_liga", SyncJobType.LiveMatch),
    ).resolves.toBeNull();

    const withinInterval = new Date(now.getTime() + 60_000);
    await expect(client.getFixtures(query("39", withinInterval))).rejects.toMatchObject({
      name: "ProviderRequestDeferredError",
      reason: "provider_interval",
      retry_at: new Date(now.getTime() + 5 * 60_000),
    });
    expect(requestCount).toBe(1);

    const due = new Date(now.getTime() + 5 * 60_000);
    available = true;
    await expect(client.getFixtures(query("39", due))).resolves.toEqual([]);
    expect(requestCount).toBe(2);
    await expect(client.getFixtures(query("140", due))).resolves.toEqual([]);
    expect(requestCount).toBe(2);

    await expect(
      client.getFixtures(query("39", new Date(due.getTime() + 60_000))),
    ).rejects.toMatchObject({
      name: "ProviderRequestDeferredError",
      reason: "provider_interval",
      retry_at: new Date(due.getTime() + 5 * 60_000),
    });
    expect(requestCount).toBe(2);
  });

  it("reports an unattributable 5d live row at source level without failing other leagues", async () => {
    const config = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "5d",
      FOOTBALL_PROVIDER_KEY_5D: "5d-key-only",
    });
    const now = new Date("2026-10-11T12:00:00.000Z");
    let requestCount = 0;
    const log = vi.fn();
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1;
      return new Response(JSON.stringify({
        data: [
          {
            id: 9100,
            league: { id: "" },
            teams: { home: { id: 9, name: "Bad Home" }, away: { id: 10, name: "Bad Away" } },
            goals: { home: 0, away: 0 },
            status: "live",
            status_code: "first_half",
            kickoff_utc: "2026-10-11T11:00:00.000Z",
            round: 1,
          },
          {
            id: 9101,
            league: { id: "4212821298", name: "La Liga" },
            teams: { home: { id: 3, name: "Home 2" }, away: { id: 4, name: "Away 2" } },
            goals: { home: 1, away: 0 },
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
      leagueStateStore: new InMemoryProviderLeagueStateStore(),
      minimumGapMs: 0,
      log,
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

    await expect(client.getFixtures(query("39"))).resolves.toEqual([]);
    const laLiga = await client.getFixtures(query("140"));
    expect(laLiga).toHaveLength(1);
    expect(String(laLiga[0]?.league.id)).toBe("4212821298");
    expect(requestCount).toBe(1);

    const diagnostics = log.mock.calls
      .map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry.diag_code === "DIAG_PROVIDER_FORMAT");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      event: "provider_data_invalid",
      source_id: "5d",
      field: "league.id",
      invalid_count: 1,
      fixture_ids: ["9100"],
    });
    expect(diagnostics[0]).not.toHaveProperty("league_id");
  });

  it("does not turn a post-finish primary failure into an empty success when no fallback executed", async () => {
    const config = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "fd",
      FOOTBALL_PROVIDER_KEY_FD: "fd-key-only",
    });
    let requestCount = 0;
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1;
      throw new Error("result source unavailable");
    };
    const registry = new ProviderRegistry({
      config,
      fetchImpl,
      leagueStateStore: new InMemoryProviderLeagueStateStore(),
      minimumGapMs: 0,
    });

    await expect(registry.asClient().getFixtures({
      leagueId: "39",
      season: "2026",
      dateFrom: "2026-10-11",
      dateTo: "2026-10-12",
      jobType: SyncJobType.PostFinishVerify,
      serverNow: new Date("2026-10-11T12:00:00.000Z"),
    })).rejects.toThrow();
    expect(requestCount).toBeGreaterThan(0);
  });

  it("uses the configured fallback when an ordinary budget denial has no retry time", async () => {
    const config = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "fd,of",
      FOOTBALL_PROVIDER_KEY_FD: "fd-key-only",
      FOOTBALL_PROVIDER_KEY_OF: "of-key-only",
    });
    const ofLeague = config.sources.find((source) => source.source_id === "of")!
      .leagues.find((league) => league.league_id === "premier_league")!;
    ofLeague.roles.schedule = "fallback";
    let requestCount = 0;
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1;
      return new Response(JSON.stringify({
        data: [],
        meta: { pagination: { next_cursor: null } },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const budget = {
      candidateKeys: async (sourceId: string) =>
        config.sources.find((source) => source.source_id === sourceId)?.api_keys.map((key) => key.key_id) ?? [],
      acquire: async (sourceId: string) => sourceId === "fd"
        ? { allowed: false, reason: "provider_quota", key_id: "fd#1" }
        : { allowed: true, key_id: "of#1", minute_used: 0, daily_used: 0, daily_limit: 40 },
      recordLeagueRequest: async () => undefined,
      pauseSource: () => undefined,
      observeRemoteQuota: () => undefined,
    } as unknown as ProviderBudget;
    const registry = new ProviderRegistry({
      config,
      fetchImpl,
      budget,
      leagueStateStore: new InMemoryProviderLeagueStateStore(),
      minimumGapMs: 0,
    });

    await expect(registry.asClient().getFixtures({
      leagueId: "39",
      season: "2026",
      dateFrom: "2026-10-11",
      dateTo: "2026-10-12",
      jobType: SyncJobType.FutureSchedule,
      serverNow: new Date("2026-10-11T12:00:00.000Z"),
    })).resolves.toEqual([]);
    expect(requestCount).toBeGreaterThan(0);
  });

  it("commits pending league success only for the requested league", async () => {
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
    const query = (leagueId: string) => ({
      leagueId,
      season: "2026",
      dateFrom: "2026-10-11",
      dateTo: "2026-10-12",
      jobType: SyncJobType.FutureSchedule,
      serverNow: now,
    });

    await registry.asClient().getFixtures(query("39"));
    await registry.asClient().getFixtures(query("140"));
    await registry.commitPendingLeagueSuccess(SyncJobType.FutureSchedule, now, "premier_league");

    await expect(
      leagueStateStore.get("fd", "premier_league", SyncJobType.FutureSchedule),
    ).resolves.toMatchObject({ last_success_at: now });
    await expect(
      leagueStateStore.get("fd", "la_liga", SyncJobType.FutureSchedule),
    ).resolves.toBeNull();
  });

  it("does not treat explicit-source reconcile reads as league completion", async () => {
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

    await registry.asClient().getFixturesFromSource("fd", {
      leagueId: "39",
      season: "2026",
      dateFrom: "2026-10-11",
      dateTo: "2026-10-12",
      jobType: SyncJobType.FullScheduleVerify,
      serverNow: now,
    });
    await registry.commitPendingLeagueSuccess(SyncJobType.FullScheduleVerify, now);

    await expect(
      leagueStateStore.get("fd", "premier_league", SyncJobType.FullScheduleVerify),
    ).resolves.toBeNull();
  });
});
