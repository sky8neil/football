import { describe, expect, it, vi } from "vitest";
import { SyncJobType, Provider } from "../domain/enums.js";
import { InMemoryProviderUsageStore, ProviderBudget } from "./budget.js";
import { InMemoryProviderKeyStateStore, KeyPool } from "./key-pool.js";
import { InMemoryProviderLeagueStateStore } from "./league-state.js";
import { ProviderRegistry } from "./registry.js";
import { planRequests } from "./strategy.js";
import type { ProviderRole, ProviderSource, ProviderSourceId, ProviderSourcesConfig } from "./sources.js";

const NOW = new Date("2026-10-12T12:30:00.000Z");

const leagueRefs: Record<string, { league_id: "premier_league" | "la_liga" | "serie_a" | "chinese_super_league"; source_league_ref: string; season_ref: string }> = {
  premier_league: { league_id: "premier_league", source_league_ref: "PL", season_ref: "2026" },
  la_liga: { league_id: "la_liga", source_league_ref: "PD", season_ref: "2026" },
  serie_a: { league_id: "serie_a", source_league_ref: "SA", season_ref: "2026" },
  chinese_super_league: { league_id: "chinese_super_league", source_league_ref: "85", season_ref: "2026" },
};

function source(
  sourceId: ProviderSourceId,
  leagues: Array<{ league_id: keyof typeof leagueRefs; source_league_ref?: string; schedule?: ProviderRole; kickoff?: ProviderRole; live?: ProviderRole; result?: ProviderRole; reconcile?: ProviderRole }>,
  keys = [{ key_id: `${sourceId}#1`, api_key: "fake-provider-key-1", env_name: "TEST_KEY_1", max_per_minute: 6 }],
): ProviderSource {
  const provider = { fd: Provider.FootballData, bsd: Provider.Bsd, "5d": Provider.FiveDollar, of: Provider.OpenFoot, sp: Provider.SportApi }[sourceId];
  const adapter = { fd: "football_data", bsd: "bsd", "5d": "fivedollar", of: "openfoot", sp: "sportapi" }[sourceId] as ProviderSource["adapter"];
  const roles = (entry: typeof leagues[number]) => ({
    schedule: entry.schedule ?? "primary",
    kickoff: entry.kickoff ?? "primary",
    live: entry.live ?? "primary",
    result: entry.result ?? "primary",
    reconcile: entry.reconcile ?? "reconcile",
  });
  return {
    source_id: sourceId,
    provider,
    adapter,
    base_url: { fd: "https://api.football-data.org/v4", bsd: "https://sports.bzzoiro.com/api/v2", "5d": "https://api.5dollarfootballapi.com/v1", of: "https://openfootapi.com/v1", sp: "https://sportapi.ai/api" }[sourceId],
    api_key: keys[0]!.api_key,
    api_keys: keys,
    auth: { header: "Authorization", scheme: "bearer" },
    max_per_minute: keys.reduce((sum, key) => sum + key.max_per_minute, 0),
    daily_cap: sourceId === "5d" ? 0 : 100,
    hourly_cap: sourceId === "5d" ? 12 : null,
    monthly_cap: sourceId === "of" ? 1000 : null,
    day_boundary: "utc",
    pool_strategy: sourceId === "fd" ? "least_used" : "failover",
    leagues: leagues.map((entry) => ({ ...leagueRefs[entry.league_id]!, ...entry, roles: roles(entry) })),
  } as ProviderSource;
}

function config(...sources: ProviderSource[]): ProviderSourcesConfig {
  return { sources, sync_profile: "test", sync_leagues: new Set(sources.flatMap((item) => item.leagues.map((league) => league.league_id))) };
}

describe("planRequests", () => {
  it("prioritizes critical jobs and rotates same-priority leagues by oldest success", () => {
    const fd = source("fd", [
      { league_id: "premier_league" }, { league_id: "la_liga" },
    ]);
    const demands = [
      { league_id: "premier_league", job_type: SyncJobType.FutureSchedule },
      { league_id: "premier_league", job_type: SyncJobType.LiveMatch },
      { league_id: "la_liga", job_type: SyncJobType.LiveMatch },
      { league_id: "la_liga", job_type: SyncJobType.LiveMatch },
    ];
    const plans = planRequests(NOW, demands, {
      last_success_at: new Map([
        [`premier_league:${SyncJobType.LiveMatch}`, new Date(NOW.getTime() - 5 * 60_000)],
        [`la_liga:${SyncJobType.LiveMatch}`, new Date(NOW.getTime() - 10 * 60_000)],
      ]),
    }, { sources: [fd] });

    expect(plans.map(({ league_id, job_type }) => [league_id, job_type])).toEqual([
      ["la_liga", SyncJobType.LiveMatch],
      ["premier_league", SyncJobType.LiveMatch],
      ["premier_league", SyncJobType.FutureSchedule],
    ]);
  });

  it("selects an available fallback when the primary is budget-blocked and skips exhausted sources", () => {
    const fd = source("fd", [{ league_id: "premier_league" }]);
    const fiveD = source("5d", [{ league_id: "premier_league", live: "fallback" }]);
    const demand = [{ league_id: "premier_league", job_type: SyncJobType.LiveMatch }];
    expect(planRequests(NOW, demand, { unavailable_sources: new Map([["fd", "hour_limit"]]) }, { sources: [fd, fiveD] }))
      .toMatchObject([{ source_id: "5d", reason: "fallback_budget" }]);
    expect(planRequests(NOW, demand, {
      unavailable_sources: new Map([["fd", "provider_unavailable"], ["5d", "provider_unavailable"]]),
    }, { sources: [fd, fiveD] })).toEqual([]);
  });
});

describe("KeyPool and per-key budget accounting", () => {
  it("invalidates a 401 key, cools a 429 key, and never logs credential values", async () => {
    const keys = [
      { key_id: "fd#1", api_key: "secret-one", env_name: "FD_1", max_per_minute: 2 },
      { key_id: "fd#2", api_key: "secret-two", env_name: "FD_2", max_per_minute: 2 },
    ];
    const configured = source("fd", [{ league_id: "premier_league" }], keys);
    const store = new InMemoryProviderKeyStateStore();
    const log = vi.fn();
    const pool = new KeyPool(configured, store, log);
    await pool.markFailure("fd#1", 401, "401", NOW, null);
    const resetAt = new Date(NOW.getTime() + 60_000);
    await pool.markFailure("fd#2", 429, "429", NOW, resetAt);

    await expect(pool.candidates(NOW)).resolves.toEqual([]);
    await expect(pool.candidates(resetAt)).resolves.toEqual(["fd#2"]);
    expect(await pool.snapshot(NOW)).toMatchObject([
      { key_id: "fd#1", status: "invalid", last_error_code: "401" },
      { key_id: "fd#2", status: "cooldown", cooldown_until: resetAt.toISOString(), last_error_code: "429" },
    ]);
    const logs = JSON.stringify(log.mock.calls);
    expect(logs).not.toContain("secret-one");
    expect(logs).not.toContain("secret-two");
  });

  it("keeps the two football-data minute buckets independent and chooses the less-used key", async () => {
    const keys = [
      { key_id: "fd#1", api_key: "secret-one", env_name: "FD_1", max_per_minute: 1 },
      { key_id: "fd#2", api_key: "secret-two", env_name: "FD_2", max_per_minute: 1 },
    ];
    const budget = new ProviderBudget([source("fd", [{ league_id: "premier_league" }], keys)], new InMemoryProviderUsageStore());
    await expect(budget.acquire("fd", SyncJobType.PostFinishVerify, NOW, "fd#1")).resolves.toMatchObject({ allowed: true });
    await expect(budget.acquire("fd", SyncJobType.PostFinishVerify, NOW, "fd#1")).resolves.toMatchObject({ allowed: false, reason: "minute_limit" });
    await expect(budget.acquire("fd", SyncJobType.PostFinishVerify, NOW, "fd#2")).resolves.toMatchObject({ allowed: true });
    await expect(budget.usageForKey("fd", NOW, "fd#1")).resolves.toBe(1);
    await expect(budget.usageForKey("fd", NOW, "fd#2")).resolves.toBe(1);
    await expect(budget.candidateKeys("fd", NOW)).resolves.toEqual(["fd#1", "fd#2"]);
  });
});

describe("ProviderRegistry request selection and diagnostics", () => {
  it("rotates schedule work toward the league with the oldest successful request", async () => {
    const store = new InMemoryProviderLeagueStateStore();
    const registry = new ProviderRegistry({ config: config(source("fd", [
      { league_id: "premier_league" }, { league_id: "la_liga" }, { league_id: "serie_a" },
    ])), leagueStateStore: store, minimumGapMs: 0 });
    await store.markSuccess("fd", "premier_league", SyncJobType.FutureSchedule, new Date(NOW.getTime() - 2 * 60_000));
    await store.markSuccess("fd", "la_liga", SyncJobType.FutureSchedule, new Date(NOW.getTime() - 10 * 60_000));

    await expect(registry.orderLeagues(["premier_league", "la_liga", "serie_a"], SyncJobType.FutureSchedule, NOW))
      .resolves.toEqual(["serie_a", "la_liga", "premier_league"]);
    await expect(registry.dueLeagues(["premier_league", "la_liga", "serie_a"], SyncJobType.FutureSchedule, NOW, 60 * 60_000))
      .resolves.toEqual(["serie_a"]);
    await expect(registry.dueLeagues(["premier_league", "la_liga", "serie_a"], SyncJobType.FutureSchedule, NOW, 0))
      .resolves.toEqual(["serie_a", "la_liga", "premier_league"]);
  });

  it.each([
    { sourceId: "fd" as const, league: "premier_league" as const, apiLeague: "39", ref: "PL", headers: { "x-requests-available-minute": "7", "x-requestcounter-reset": "60" }, expectedRemaining: 7 },
    { sourceId: "bsd" as const, league: "chinese_super_league" as const, apiLeague: "169", ref: "52", headers: { ratelimit: "30;r=17;t=45" }, expectedRemaining: 17 },
    { sourceId: "5d" as const, league: "premier_league" as const, apiLeague: "39", ref: "4160026622", headers: { "x-ratelimit-remaining": "88", "x-ratelimit-reset": "60" }, expectedRemaining: 88 },
    { sourceId: "of" as const, league: "premier_league" as const, apiLeague: "39", ref: "comp_premier_league_eng", headers: { "x-ratelimit-remaining": "39", "x-ratelimit-reset": "60" }, expectedRemaining: 39 },
    { sourceId: "sp" as const, league: "chinese_super_league" as const, apiLeague: "169", ref: "85", headers: { "x-ratelimit-remaining": "77", "x-ratelimit-reset": "60" }, expectedRemaining: 77 },
  ])("records quota and role diagnostics for $sourceId", async ({ sourceId, league, apiLeague, ref, headers, expectedRemaining }) => {
    const configured = source(sourceId, [{ league_id: league, source_league_ref: ref }]);
    const budget = new ProviderBudget([configured], new InMemoryProviderUsageStore());
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify(
      sourceId === "fd" ? { matches: [] }
        : sourceId === "bsd" ? { results: [], next: null }
        : sourceId === "5d" ? { data: [], pagination: { has_more: false } }
        : sourceId === "of" ? { data: [], meta: { pagination: { next_cursor: null } } }
        : { data: [] },
    ), { status: 200, headers: { "content-type": "application/json", ...headers } });
    const registry = new ProviderRegistry({ config: config(configured), budget, fetchImpl, minimumGapMs: 0 });
    await registry.asClient().getFixtures({
      leagueId: apiLeague, season: "2026", dateFrom: "2026-10-12", dateTo: "2026-10-12",
      jobType: SyncJobType.FutureSchedule, serverNow: NOW,
    });

    expect(registry.lastRequest(sourceId)).toMatchObject({ status: 200, quota_remaining: expectedRemaining });
    const leagueRows = await registry.leagueDiagnostics(sourceId, [SyncJobType.FutureSchedule], NOW);
    expect(leagueRows[0]).toMatchObject({
      league_id: league, source_league_ref: ref, roles: { schedule: "primary" },
      last_success_at: { [SyncJobType.FutureSchedule]: NOW.toISOString() }, daily_request_count: 1,
    });
    if (sourceId === "fd") {
      await expect(registry.keyDiagnostics("fd", NOW)).resolves.toEqual([
        expect.objectContaining({ key_id: "fd#1", minute_used: 1, remote_remaining: expectedRemaining, daily_used: 1, daily_limit: 100 }),
      ]);
    }
  });

  it("records sportapi 403/1010 as the signal used by cloudflare_blocked diagnostics", async () => {
    const configured = source("sp", [{ league_id: "chinese_super_league", source_league_ref: "85" }]);
    const registry = new ProviderRegistry({
      config: config(configured), minimumGapMs: 0,
      fetchImpl: async () => new Response(JSON.stringify({ code: 1010 }), { status: 403, headers: { "content-type": "application/json" } }),
    });
    await expect(registry.asClient().getFixtures({
      leagueId: "169", season: "2026", dateFrom: "2026-10-12", dateTo: "2026-10-12",
      jobType: SyncJobType.FutureSchedule, serverNow: NOW,
    })).rejects.toMatchObject({ status: 403, providerCode: "1010" });

    expect(registry.lastRequest("sp")).toMatchObject({ status: 403, provider_code: "1010" });
    expect(registry.lastRequest("sp")!.status === 403 || registry.lastRequest("sp")!.provider_code === "1010").toBe(true);
  });

  it("uses one all-league 5d live request for simultaneous league reads", async () => {
    const configured = source("5d", [
      { league_id: "premier_league", source_league_ref: "4160026622" },
      { league_id: "la_liga", source_league_ref: "4212821298" },
    ]);
    let fetchCount = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ data: [
        { id: 1, kickoff_utc: "2026-10-12T12:00:00Z", status: "live", league: { id: "4160026622" }, teams: { home: { id: 1 }, away: { id: 2 } } },
        { id: 2, kickoff_utc: "2026-10-12T12:00:00Z", status: "live", league: { id: "4212821298" }, teams: { home: { id: 3 }, away: { id: 4 } } },
      ], pagination: { has_more: false } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const registry = new ProviderRegistry({ config: config(configured), fetchImpl, minimumGapMs: 0 });
    const query = (leagueId: string) => registry.asClient().getFixtures({
      leagueId, season: "2026", dateFrom: "2026-10-12", dateTo: "2026-10-12",
      jobType: SyncJobType.LiveMatch, serverNow: NOW,
    });
    const [premier, laLiga] = await Promise.all([query("39"), query("140")]);

    expect(fetchCount).toBe(1);
    expect(premier.map((fixture) => fixture.fixture.id)).toEqual([1]);
    expect(laLiga.map((fixture) => fixture.fixture.id)).toEqual([2]);
  });
});
