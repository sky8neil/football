import { describe, expect, it, vi } from "vitest";
import type { ProviderHttpClient } from "./adapter.js";
import { BsdAdapter } from "./bsd-adapter.js";
import { FiveDollarAdapter } from "./fivedollar-adapter.js";
import { OpenFootAdapter } from "./openfoot-adapter.js";
import { SportApiAdapter } from "./sportapi-adapter.js";

const EPL = { league_id: "premier_league", source_league_ref: "4160026622", season_ref: "2026" };
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

function fiveDollarRow(id: number, leagueId = "4160026622", season?: string) {
  return {
    id,
    kickoff_utc: "2026-10-12T12:00:00Z",
    status: "finished",
    status_code: "full",
    league: { id: leagueId, ...(season === undefined ? {} : { season }) },
    round: 3,
    teams: { home: { id: 10, name: "Home" }, away: { id: 11, name: "Away" } },
    goals: { home: 2, away: 1 },
  };
}

describe("FiveDollarAdapter", () => {
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
      expect(call.path).toBe(`leagues/${EPL.source_league_ref}/fixtures`);
      expect(call.query.season).toBe("26/27");
      expect(Number(call.query.end_time) - Number(call.query.start_time)).toBe(86_400);
      expect(call.query.per_page).toBe("100");
    }
    expect(beforeRequest).toHaveBeenCalledTimes(3);
    expect(fixtures[0]).toMatchObject({
      provider: "5dollar",
      fixture: { id: 1, status: { short: "FT" } },
      league: { id: "4160026622", round: "3" },
      teams: { home: { id: 10, name: "Home" } },
      score: { fulltime: { home: 2, away: 1 } },
    });
    expect(fixtures[0]?.league.season).toBeUndefined();
  });

  it("filters date-window fixtures to the requested league and keeps upstream season, including absent", async () => {
    const { client, calls } = mockHttp(() => ({
      data: [fiveDollarRow(1), fiveDollarRow(2, "4212821298")],
      pagination: { has_more: false },
    }));
    const fixtures = await new FiveDollarAdapter(client).fetchFixturesByDateRange(
      EPL, "2026-12-31", "2027-01-01", { jobType: "future_schedule", serverNow: NOW },
    );

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.path).toBe(`leagues/${EPL.source_league_ref}/fixtures`);
      expect(call.query.season).toBe("26/27");
    }
    expect(fixtures.map((fixture) => fixture.fixture.id)).toEqual([1, 1]);
    expect(fixtures.every((fixture) => fixture.league.id === EPL.source_league_ref)).toBe(true);
    expect(fixtures.every((fixture) => fixture.league.season === undefined)).toBe(true);
  });

  it("fails closed when a requested-league row omits league identity instead of returning zero fixtures", async () => {
    const missingLeagueId = fiveDollarRow(1) as { league?: { id?: string } };
    delete missingLeagueId.league?.id;
    const { client } = mockHttp(() => ({
      data: [missingLeagueId],
      pagination: { has_more: false },
    }));

    await expect(
      new FiveDollarAdapter(client).fetchFixturesByDateRange(
        EPL, "2026-10-12", "2026-10-12", { jobType: "post_finish_verify", serverNow: NOW },
      ),
    ).rejects.toThrow(/source_id=5d field=league\.id/);
  });

  it("retains an empty requested-league identity for application-level rejection instead of dropping it", async () => {
    const { client } = mockHttp(() => ({
      data: [fiveDollarRow(1, "")],
      pagination: { has_more: false },
    }));

    const fixtures = await new FiveDollarAdapter(client).fetchFixturesByDateRange(
      EPL, "2026-10-12", "2026-10-12", { jobType: "post_finish_verify", serverNow: NOW },
    );

    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]?.league.id).toBe("");
  });

  it("does not fabricate a requested league identity on the live entry", async () => {
    const missingLeagueId = fiveDollarRow(1) as { league?: { id?: string } };
    delete missingLeagueId.league?.id;
    const { client } = mockHttp(() => ({
      data: [missingLeagueId],
      pagination: { has_more: false },
    }));

    const fixtures = await new FiveDollarAdapter(client).fetchLiveFixtures({
      jobType: "live_match", serverNow: NOW,
    });

    expect(fixtures[0]?.league.id).toBe("");
  });

  it("keeps the verified season across a calendar-year boundary", async () => {
    const { client, calls } = mockHttp(() => ({
      data: [fiveDollarRow(1)],
      pagination: { has_more: false },
    }));
    const fixtures = await new FiveDollarAdapter(client).fetchFixturesByDateRange(
      EPL, "2026-12-31", "2027-01-01", { jobType: "future_schedule", serverNow: NOW },
    );

    expect(calls.map((call) => call.path)).toEqual([
      `leagues/${EPL.source_league_ref}/fixtures`,
      `leagues/${EPL.source_league_ref}/fixtures`,
    ]);
    expect(calls.map((call) => call.query.season)).toEqual(["26/27", "26/27"]);
    expect(fixtures.map((fixture) => fixture.fixture.id)).toEqual([1, 1]);
    expect(fixtures.every((fixture) => fixture.league.season === undefined)).toBe(true);
  });

  it("uses the runtime custom league ref when constraining the date window", async () => {
    const custom = { league_id: "premier_league", source_league_ref: "999", season_ref: "2026" };
    const { client, calls } = mockHttp(() => ({
      data: [fiveDollarRow(1, "999")],
      pagination: { has_more: false },
    }));
    const fixtures = await new FiveDollarAdapter(client).fetchFixturesByDateRange(
      custom, "2026-10-12", "2026-10-12", { jobType: "post_finish_verify", serverNow: NOW },
    );

    expect(calls[0]?.path).toBe("leagues/999/fixtures");
    expect(calls[0]?.query.season).toBe("26/27");
    expect(fixtures[0]?.league).toMatchObject({ id: "999" });
    expect(fixtures[0]?.league.season).toBeUndefined();
  });

  it("constrains the season entry with the source season window", async () => {
    const { client, calls } = mockHttp(() => ({
      data: [fiveDollarRow(1)],
      pagination: { has_more: false },
    }));
    const fixtures = await new FiveDollarAdapter(client).fetchSeasonFixtures(EPL, {
      jobType: "future_schedule", serverNow: NOW,
    });

    expect(calls).toEqual([
      {
        path: `leagues/${EPL.source_league_ref}/fixtures`,
        query: { season: "26/27", page: "1", per_page: "100" },
      },
    ]);
    expect(fixtures[0]?.league.season).toBeUndefined();
  });

  it("preserves an explicitly older source season instead of relabeling it", async () => {
    const { client } = mockHttp(() => ({
      data: [fiveDollarRow(1, "4160026622", "25/26"), fiveDollarRow(2, "4160026622", "26/27")],
      pagination: { has_more: false },
    }));
    const fixtures = await new FiveDollarAdapter(client).fetchSeasonFixtures(EPL, {
      jobType: "future_schedule", serverNow: NOW,
    });

    expect(fixtures[0]?.league.season).toBe("25/26");
    expect(fixtures[1]?.league.season).toBe("26/27");
  });

  it("keeps all leagues for the live entry without a fixed 2026 season", async () => {
    const { client, calls } = mockHttp(() => ({
      data: [fiveDollarRow(1), fiveDollarRow(2, "4212821298")],
      pagination: { has_more: false },
    }));
    const fixtures = await new FiveDollarAdapter(client).fetchLiveFixtures({
      jobType: "live_match", serverNow: NOW,
    });

    expect(calls).toEqual([
      { path: "fixtures", query: { status: "live", page: "1", per_page: "100" } },
    ]);
    expect(fixtures.map((fixture) => fixture.league.id)).toEqual(["4160026622", "4212821298"]);
    expect(fixtures.every((fixture) => fixture.league.season === undefined)).toBe(true);
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
