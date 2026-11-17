import { describe, expect, it, vi } from "vitest";
import { buildProviderLeagueRefs } from "../domain/config.js";
import type { ProviderHttpClient } from "./adapter.js";
import { BsdAdapter } from "./bsd-adapter.js";
import { FiveDollarAdapter } from "./fivedollar-adapter.js";
import { normalizeFixture } from "./fixture-mapper.js";
import { OpenFootAdapter } from "./openfoot-adapter.js";
import { SportApiAdapter } from "./sportapi-adapter.js";

const EPL = { league_id: "premier_league", source_league_ref: "4160026622", season_ref: "2026" };
const LA_LIGA = { league_id: "la_liga", source_league_ref: "4212821298", season_ref: "2026" };
const CSL = { league_id: "chinese_super_league", source_league_ref: "85", season_ref: "2026" };
const NOW = new Date("2026-10-12T12:30:00.000Z");

function mockHttp(respond: (path: string, query: Record<string, string>) => unknown) {
  const calls: Array<{ path: string; query: Record<string, string> }> = [];
  const client: ProviderHttpClient = {
    getJson: async (path, query) => {
      calls.push({ path, query });
      return respond(path, query);
    },
  };
  return { client, calls };
}

function fiveDollarRow(id: number, leagueId = "4160026622") {
  return {
    id,
    kickoff_utc: "2026-10-12T12:00:00Z",
    status: "finished",
    status_code: "full",
    league: { id: leagueId },
    round: 3,
    teams: { home: { id: 10, name: "Home" }, away: { id: 11, name: "Away" } },
    goals: { home: 2, away: 1 },
  };
}

describe("FiveDollarAdapter", () => {
  it("直播缓存推断的赛季不会覆盖显式旧目标季", async () => {
    const { client } = mockHttp(() => ({ data: [fiveDollarRow(1)], pagination: { has_more: false } }));
    const [fixture] = await new FiveDollarAdapter(client).fetchLiveFixtures({ jobType: "live_match", serverNow: NOW });
    expect(fixture?.season_inferred).toBe(true);
    expect(normalizeFixture(fixture!, undefined, NOW, "2025_2026").anomalies.some((anomaly) => anomaly.details.field === "league.season")).toBe(false);
  });
  it("splits date ranges into 24-hour windows, follows pages, and maps fixture fields", async () => {
    const responses = [
      { data: [fiveDollarRow(1)], pagination: { has_more: true } },
      { data: [fiveDollarRow(2)], pagination: { has_more: false } },
      { data: [fiveDollarRow(3)], pagination: { has_more: false } },
    ];
    const { client, calls } = mockHttp(() => responses.shift());
    const beforeRequest = vi.fn(async () => undefined);
    const fixtures = await new FiveDollarAdapter(client).fetchFixturesByDateRange(
      EPL, "2026-10-12", "2026-10-13", { jobType: "future_schedule", serverNow: NOW, beforeRequest },
    );

    expect(fixtures).toHaveLength(3);
    expect(calls.map(({ query }) => query.page)).toEqual(["1", "2", "1"]);
    for (const call of calls) {
      expect(call.path).toBe("fixtures");
      expect(Number(call.query.end_time) - Number(call.query.start_time)).toBe(86_400);
      expect(call.query.per_page).toBe("100");
    }
    expect(beforeRequest).toHaveBeenCalledTimes(3);
    expect(fixtures[0]).toMatchObject({
      provider: "5dollar",
      fixture: { id: 1, status: { short: "FT" } },
      league: { id: "4160026622", season: "2026", round: "3" },
      teams: { home: { id: 10, name: "Home" } },
      score: { fulltime: { home: 2, away: 1 } },
    });
  });

  it("filters out other leagues when querying fixtures by date range", async () => {
    const { client } = mockHttp(() => ({
      data: [fiveDollarRow(1, EPL.source_league_ref), fiveDollarRow(2, LA_LIGA.source_league_ref)],
      pagination: { has_more: false },
    }));
    const fixtures = await new FiveDollarAdapter(client).fetchFixturesByDateRange(
      LA_LIGA, "2026-10-12", "2026-10-12", { jobType: "post_finish_verify", serverNow: NOW },
    );

    expect(fixtures.map((fixture) => fixture.fixture.id)).toEqual([2]);
    expect(fixtures[0]?.league.id).toBe(LA_LIGA.source_league_ref);
  });

  it("uses the requested source season when the provider omits it", async () => {
    const { client } = mockHttp(() => ({
      data: [{ ...fiveDollarRow(4), kickoff_utc: "2027-08-12T12:00:00Z" }],
      pagination: { has_more: false },
    }));
    const fixtures = await new FiveDollarAdapter(client).fetchSeasonFixtures(EPL, {
      jobType: "future_schedule",
      serverNow: new Date("2027-07-02T00:00:00.000Z"),
    });

    expect(fixtures[0]?.league.season).toBe("2026");
  });

  it("assigns a postponed January fixture without a season to the requested season", async () => {
    const leagueRefs = buildProviderLeagueRefs([
      { source_id: "5d", source_league_ref: "9901", league_id: "chinese_super_league" },
    ]);
    const { client } = mockHttp(() => ({
      data: [{ ...fiveDollarRow(5, "9901"), kickoff_utc: "2027-01-05T12:00:00Z" }],
      pagination: { has_more: false },
    }));
    const fixtures = await new FiveDollarAdapter(client, leagueRefs).fetchSeasonFixtures(
      { ...CSL, source_league_ref: "9901" },
      { jobType: "full_schedule_verify", serverNow: new Date("2027-01-05T12:00:00Z") },
    );

    expect(fixtures[0]?.league.season).toBe("2026");
    expect(normalizeFixture(fixtures[0]!, leagueRefs, new Date("2027-01-05T12:00:00Z")).entityFailed).toBe(false);
  });

  it("preserves explicit adjacent seasons and assigns requested seasons to other kickoffs", async () => {
    const { client } = mockHttp(() => ({
      data: [
        { ...fiveDollarRow(101), season: "2025" },
        { ...fiveDollarRow(102), kickoff_utc: "2025-10-12T12:00:00Z" },
        { ...fiveDollarRow(103), kickoff_utc: "2027-05-15T12:00:00Z" },
      ],
      pagination: { has_more: false },
    }));
    const fixtures = await new FiveDollarAdapter(client).fetchSeasonFixtures(EPL, {
      jobType: "full_schedule_verify", serverNow: NOW,
    });

    expect(fixtures[0]?.league.season).toBe("2025");
    expect(normalizeFixture(fixtures[0]!, undefined, NOW).entityFailed).toBe(false);
    expect(fixtures[1]?.league.season).toBe("2026");
    expect(normalizeFixture(fixtures[1]!, undefined, NOW).entityFailed).toBe(false);
    expect(fixtures[2]?.league.season).toBe("2026");
    expect(normalizeFixture(fixtures[2]!, undefined, NOW).entityFailed).toBe(false);
  });

  it("uses active source seasons for live fixtures without a requested season", async () => {
    const leagueRefs = buildProviderLeagueRefs([
      { source_id: "5d", source_league_ref: "9901", league_id: "chinese_super_league" },
    ]);
    const { client } = mockHttp(() => ({
      data: [
        { ...fiveDollarRow(201, EPL.source_league_ref), kickoff_utc: "2027-05-15T12:00:00Z" },
        { ...fiveDollarRow(202, "9901"), kickoff_utc: "2027-01-05T12:00:00Z" },
        { ...fiveDollarRow(203, "9901"), kickoff_utc: "2026-06-01T12:00:00Z" },
      ],
      pagination: { has_more: false },
    }));
    const fixtures = await new FiveDollarAdapter(client, leagueRefs).fetchLiveFixtures({
      jobType: "live_match", serverNow: NOW,
    });

    expect(fixtures[0]?.league.season).toBe("2026");
    expect(fixtures[1]?.league.season).toBe("2026");
    expect(normalizeFixture(fixtures[1]!, leagueRefs, NOW).entityFailed).toBe(false);
    expect(fixtures[2]?.league.season).toBe("2026");
    expect(normalizeFixture(fixtures[2]!, leagueRefs, NOW).entityFailed).toBe(false);
  });
});

describe("OpenFootAdapter", () => {
  it("follows next_cursor, maps matches, and reports the quota window", async () => {
    const calls: Array<{ path: string; query: Record<string, string> }> = [];
    const client: ProviderHttpClient = {
      getJson: async (path, query) => {
        calls.push({ path, query });
        return calls.length === 1
          ? {
              data: [{ id: "of-1", competitionId: "comp_premier_league_eng", kickoffAt: "2026-10-12T12:00:00Z", status: "finished", homeTeam: { id: "h", name: "Home" }, awayTeam: { id: "a", name: "Away" }, score: { home: 1, away: 0 } }],
              meta: { access: { remaining: 87, period: "2026-10" }, pagination: { next_cursor: "cursor-next" } },
            }
          : {
              data: [{ id: "of-2", competitionId: "comp_premier_league_eng", kickoffAt: "2026-10-12T13:00:00Z", status: "scheduled", homeTeam: { id: "h", name: "Home" }, awayTeam: { id: "a", name: "Away" } }],
              meta: { pagination: { next_cursor: null } },
            };
      },
    };
    const onQuota = vi.fn();
    const fixtures = await new OpenFootAdapter(client, onQuota).fetchSeasonFixtures(EPL, {
      jobType: "future_schedule", serverNow: NOW,
    });

    expect(calls).toEqual([
      { path: "matches", query: { competition: EPL.source_league_ref, season: "2026/27" } },
      { path: "matches", query: { competition: EPL.source_league_ref, season: "2026/27", cursor: "cursor-next" } },
    ]);
    expect(fixtures).toHaveLength(2);
    expect(fixtures[0]).toMatchObject({ provider: "openfoot", fixture: { id: "of-1", status: { short: "FT" } }, score: { fulltime: { home: 1, away: 0 } } });
    expect(fixtures[1]?.fixture.status.short).toBe("NS");
    expect(onQuota).toHaveBeenCalledWith(87, new Date("2026-11-01T00:00:00.000Z"), NOW);
  });

  it("queries natural-year leagues with the natural-year season", async () => {
    const { client, calls } = mockHttp(() => ({ data: [], meta: { pagination: { next_cursor: null } } }));
    await new OpenFootAdapter(client).fetchSeasonFixtures(CSL, {
      jobType: "future_schedule", serverNow: NOW,
    });

    expect(calls).toEqual([
      { path: "matches", query: { competition: CSL.source_league_ref, season: "2026" } },
    ]);
  });

  it("fails closed when a page is marked partial", async () => {
    const { client } = mockHttp(() => ({ data: [], meta: { partial: true } }));
    await expect(new OpenFootAdapter(client).fetchFixturesByDateRange(EPL, "2026-10-12", "2026-10-12"))
      .rejects.toThrow("DIAG_PROVIDER_PARTIAL source_id=of");
  });
});

describe("SportApiAdapter", () => {
  it("filters by league, sends the ETag, and reuses cached rows on 304", async () => {
    const calls: Array<{ path: string; headers?: Record<string, string> }> = [];
    let request = 0;
    const client: ProviderHttpClient = {
      getJson: async () => { throw new Error("getJsonResponse should be used"); },
      getJsonResponse: async (path, _query, headers) => {
        calls.push({ path, ...(headers ? { headers } : {}) });
        request += 1;
        return request === 1
          ? {
              status: 200,
              headers: new Headers({ ETag: '"csl-v1"' }),
              data: { data: [
                { id: 51, league_id: 85, league_name: "CSL", kickoff_utc: "2026-10-12T12:00:00Z", status: "FT", home_id: 10, away_id: 11, home_team: "Home", away_team: "Away", home_score: 2, away_score: 0 },
                { id: 52, league_id: 39, kickoff_utc: "2026-10-12T12:00:00Z", status: "FT" },
              ] },
            }
          : { status: 304, headers: new Headers({ ETag: '"csl-v1"' }), data: null };
      },
    };
    const adapter = new SportApiAdapter(client);
    const first = await adapter.fetchFixturesByDateRange(CSL, "2026-10-12", "2026-10-12");
    const second = await adapter.fetchFixturesByDateRange(CSL, "2026-10-12", "2026-10-12");

    expect(calls).toHaveLength(2);
    expect(calls[0]?.path).toBe("fixtures/date/2026-10-12");
    expect(calls[0]?.headers?.["User-Agent"]).toContain("Mozilla/");
    expect(calls[1]?.headers?.["If-None-Match"]).toBe('"csl-v1"');
    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(second[0]).toMatchObject({ provider: "sportapi", fixture: { id: 51, status: { short: "FT" } }, league: { id: "85" } });
  });
});

describe("BSD stage and status mapping", () => {
  it("跨年补赛缺少来源赛季时使用请求赛季", async () => {
    const { client } = mockHttp(() => ({ results: [
      { id: 1, stage: "regular-season", league_id: 52, event_date: "2027-01-05T12:00:00Z", status: "notstarted", home_team_id: 10, away_team_id: 11 },
      { id: 2, stage: "regular-season", league_id: 52, season: "2027", event_date: "2027-01-05T13:00:00Z", status: "notstarted", home_team_id: 10, away_team_id: 11 },
    ], next: null }));
    const fixtures = await new BsdAdapter(client).fetchFixturesByDateRange(CSL, "2027-01-05", "2027-01-05");
    expect(fixtures.map((fixture) => fixture.league.season)).toEqual(["2026", "2027"]);
  });
  it("maps notstarted and ignores non-regular-season rows", async () => {
    const log = vi.fn();
    const { client } = mockHttp(() => ({
      results: [
        { id: 1, stage: "regular-season", league_id: 52, event_date: "2026-10-12T12:00:00Z", status: "notstarted", home_team_id: 10, away_team_id: 11 },
        { id: 2, stage: "playoffs", league_id: 52, event_date: "2026-10-12T13:00:00Z", status: "finished", home_team_id: 10, away_team_id: 11 },
      ],
      next: null,
    }));
    const fixtures = await new BsdAdapter(client, log).fetchFixturesByDateRange(CSL, "2026-10-12", "2026-10-12");

    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]).toMatchObject({ provider: "bsd", fixture: { id: 1, status: { short: "NS" } } });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "provider_fixture_ignored", source_id: "bsd", reason: "non_regular_stage", stage: "playoffs" }));
  });
});
