import { describe, expect, it } from "vitest";
import { Provider, SyncJobType } from "../domain/enums.js";
import type { ProviderLeagueState, ProviderLeagueStateStore } from "./league-state.js";
import { ProviderRegistry } from "./registry.js";
import type { ProviderSource, ProviderSourcesConfig } from "./sources.js";

const NOW = new Date("2026-10-12T12:30:00.000Z");
const JOB = SyncJobType.FutureSchedule;
const LEAGUES = ["premier_league", "la_liga"] as const;
const TEN_MINUTES = 10 * 60_000;
const ONE_DAY = 24 * 60 * 60_000;

class CountingLeagueStateStore implements ProviderLeagueStateStore {
  public getCalls: Array<{ sourceId: string; leagueId: string; jobType: string }> = [];
  private states = new Map<string, ProviderLeagueState>();

  private key(sourceId: string, leagueId: string, jobType: string): string {
    return `${sourceId}|${leagueId}|${jobType}`;
  }

  async get(sourceId: string, leagueId: string, jobType: string): Promise<ProviderLeagueState | null> {
    this.getCalls.push({ sourceId, leagueId, jobType });
    return this.states.get(this.key(sourceId, leagueId, jobType)) ?? null;
  }

  async markSuccess(sourceId: string, leagueId: string, jobType: string, at: Date): Promise<void> {
    this.states.set(this.key(sourceId, leagueId, jobType), {
      source_id: sourceId as ProviderLeagueState["source_id"],
      league_id: leagueId,
      job_type: jobType as ProviderLeagueState["job_type"],
      last_success_at: new Date(at),
    });
  }

  count(sourceId: string, leagueId: string, jobType: string): number {
    return this.getCalls.filter(
      (call) => call.sourceId === sourceId && call.leagueId === leagueId && call.jobType === jobType,
    ).length;
  }
}

function makeConfig(): ProviderSourcesConfig {
  const source = {
    source_id: "fd",
    provider: Provider.FootballData,
    adapter: "football_data",
    base_url: "https://api.football-data.org/v4",
    api_key: "fake-provider-key-1",
    api_keys: [{ key_id: "fd#1", api_key: "fake-provider-key-1", env_name: "TEST_KEY_1", max_per_minute: 6 }],
    auth: { header: "Authorization", scheme: "bearer" },
    max_per_minute: 6,
    daily_cap: 100,
    hourly_cap: null,
    monthly_cap: null,
    day_boundary: "utc",
    pool_strategy: "failover",
    leagues: [
      {
        league_id: "premier_league",
        source_league_ref: "PL",
        season_ref: "2026",
        roles: { schedule: "primary", kickoff: "primary", live: "primary", result: "primary", reconcile: "reconcile" },
      },
      {
        league_id: "la_liga",
        source_league_ref: "PD",
        season_ref: "2026",
        roles: { schedule: "primary", kickoff: "primary", live: "primary", result: "primary", reconcile: "reconcile" },
      },
    ],
  } as ProviderSource;
  return { sources: [source], sync_profile: "test", sync_leagues: new Set(LEAGUES) };
}

function makeRegistry(store: CountingLeagueStateStore): ProviderRegistry {
  return new ProviderRegistry({ config: makeConfig(), leagueStateStore: store, minimumGapMs: 0 });
}

describe("ProviderRegistry tick league-state cache", () => {
  it("reads each league state once within a tick", async () => {
    const store = new CountingLeagueStateStore();
    const registry = makeRegistry(store);
    registry.beginTickCache();
    await registry.orderLeagues([...LEAGUES], JOB, NOW);
    await registry.dueLeagues([...LEAGUES], JOB, NOW, 0);
    await registry.dueLeagues([...LEAGUES], JOB, NOW, 0);
    for (const leagueId of LEAGUES) {
      expect(store.count("fd", leagueId, JOB)).toBe(1);
    }
  });

  it("reads the store on every call when the tick cache is off", async () => {
    const store = new CountingLeagueStateStore();
    const registry = makeRegistry(store);
    await registry.orderLeagues([...LEAGUES], JOB, NOW);
    await registry.dueLeagues([...LEAGUES], JOB, NOW, 0);
    for (const leagueId of LEAGUES) {
      expect(store.count("fd", leagueId, JOB)).toBe(3);
    }
  });

  it("sees markSuccess within the same tick", async () => {
    const store = new CountingLeagueStateStore();
    const registry = makeRegistry(store);
    await store.markSuccess("fd", "premier_league", JOB, NOW);
    await store.markSuccess("fd", "la_liga", JOB, NOW);
    registry.beginTickCache();
    await expect(registry.dueLeagues([...LEAGUES], JOB, NOW, ONE_DAY)).resolves.toEqual([]);
    const getsAfterFirstDue = store.getCalls.length;
    await store.markSuccess("fd", "premier_league", JOB, NOW);
    await expect(registry.dueLeagues([...LEAGUES], JOB, NOW, TEN_MINUTES)).resolves.not.toContain("premier_league");
    expect(store.count("fd", "premier_league", JOB)).toBe(1);
    expect(store.getCalls.length).toBe(getsAfterFirstDue);
  });

  it("reads the store again after endTickCache", async () => {
    const store = new CountingLeagueStateStore();
    const registry = makeRegistry(store);
    registry.beginTickCache();
    await registry.dueLeagues([...LEAGUES], JOB, NOW, 0);
    const getsWhileCached = store.getCalls.length;
    registry.endTickCache();
    await registry.dueLeagues([...LEAGUES], JOB, NOW, 0);
    expect(store.getCalls.length).toBeGreaterThan(getsWhileCached);
    for (const leagueId of LEAGUES) {
      expect(store.count("fd", leagueId, JOB)).toBeGreaterThan(1);
    }
  });

  it("caches a missing (null) league state", async () => {
    const store = new CountingLeagueStateStore();
    const registry = makeRegistry(store);
    registry.beginTickCache();
    await expect(registry.dueLeagues([...LEAGUES], JOB, NOW, TEN_MINUTES)).resolves.toEqual([...LEAGUES]);
    await expect(registry.dueLeagues([...LEAGUES], JOB, NOW, TEN_MINUTES)).resolves.toEqual([...LEAGUES]);
    for (const leagueId of LEAGUES) {
      expect(store.count("fd", leagueId, JOB)).toBe(1);
    }
  });
});
