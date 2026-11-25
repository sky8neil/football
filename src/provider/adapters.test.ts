import { describe, expect, it, vi } from "vitest";
import { evaluateLeagueSeason, type StatusMatchInput } from "../domain/league-season-status.js";
import { BsdAdapter } from "./bsd-adapter.js";
import { FootballDataAdapter } from "./football-data-adapter.js";
import type { ProviderHttpClient } from "./adapter.js";

function http(respond: (path: string, query: Record<string, string>) => unknown) {
  const calls: Array<{ path: string; query: Record<string, string> }> = [];
  const client: ProviderHttpClient = {
    getJson: vi.fn(async (path, query) => {
      calls.push({ path, query });
      return respond(path, query);
    }),
  };
  return { client, calls };
}

const EPL = { league_id: "premier_league", source_league_ref: "PL", season_ref: "2026" };
const CSL = { league_id: "chinese_super_league", source_league_ref: "52", season_ref: "2026" };

describe("FootballDataAdapter", () => {
  it("maps match statuses, regular duration scores, and preserves malformed rows", async () => {
    const { client, calls } = http(() => ({
      matches: [
        {
          id: 101,
          utcDate: "2026-08-08T14:00:00Z",
          status: "PAUSED",
          competition: { code: "PL", name: "Premier League" },
          season: { startDate: "2026-08-01", endDate: "2027-05-30" },
          matchday: 1,
          homeTeam: { id: 40, name: "Arsenal FC" },
          awayTeam: { id: 41, name: "Chelsea FC" },
          score: { duration: "REGULAR", fullTime: { home: 1, away: 0 } },
        },
        {
          id: 102,
          utcDate: "2026-08-09T14:00:00Z",
          status: "FINISHED",
          competition: { code: "PL" },
          season: { startDate: "2026-08-01" },
          matchday: 1,
          homeTeam: { id: 40, name: "Arsenal FC" },
          awayTeam: { id: 41, name: "Chelsea FC" },
          score: { duration: "EXTRA_TIME", fullTime: { home: 2, away: 1 } },
        },
        {},
      ],
    }));
    const adapter = new FootballDataAdapter(client);
    const fixtures = await adapter.fetchFixturesByDateRange(EPL, "2026-08-08", "2026-08-09");

    expect(calls).toEqual([{
      path: "competitions/PL/matches",
      query: { dateFrom: "2026-08-08", dateTo: "2026-08-09" },
    }]);
    expect(fixtures).toHaveLength(3);
    expect(fixtures[0]).toMatchObject({
      provider: "football_data",
      fixture: { id: 101, status: { short: "HT" } },
      league: { id: "PL", season: "2026", round: "Matchday 1" },
      score: { fulltime: { home: 1, away: 0 } },
    });
    expect(fixtures[1]).toMatchObject({
      fixture: { id: 102, status: { short: "AWARDED" } },
      score: { fulltime: { home: null, away: null } },
    });
    expect(fixtures[2]).toMatchObject({
      provider: "football_data",
      fixture: { id: "", status: { short: "" } },
    });
  });

  it("falls back to league.source_league_ref when competition.code is missing and never hardcodes PL (A-S3-12)", async () => {
    const PD = { league_id: "la_liga", source_league_ref: "PD", season_ref: "2026" };
    const EMPTY = { league_id: "serie_a", source_league_ref: "", season_ref: "2026" };
    const row = {
      id: 201,
      utcDate: "2026-08-08T14:00:00Z",
      status: "TIMED",
      season: { startDate: "2026-08-01" },
      matchday: 2,
      homeTeam: { id: 50, name: "Home" },
      awayTeam: { id: 51, name: "Away" },
    };
    const { client: pdClient } = http(() => ({ matches: [row] }));
    const [pdFixture] = await new FootballDataAdapter(pdClient).fetchFixturesByDateRange(PD, "2026-08-08", "2026-08-08");
    expect(pdFixture?.league.id).toBe("PD");

    const { client: emptyClient } = http(() => ({ matches: [row] }));
    const [emptyFixture] = await new FootballDataAdapter(emptyClient).fetchFixturesByDateRange(EMPTY, "2026-08-08", "2026-08-08");
    expect(emptyFixture?.league.id).toBe("");
  });

  it("[A-S7-02 / D-S7-02] filters RELEGATION and PLAYOFFS stages out of fixtures and teams so 18-team regular season (306 matches) completes", async () => {
    const BL1 = { league_id: "bundesliga", source_league_ref: "BL1", season_ref: "2026" };
    const FL1 = { league_id: "ligue_1", source_league_ref: "FL1", season_ref: "2026" };
    const log = vi.fn();
    const blMatches: Record<string, unknown>[] = [];
    const teamIds = Array.from({ length: 18 }, (_, i) => i + 1);
    let idSeq = 1000;
    for (const h of teamIds) {
      for (const a of teamIds) {
        if (h === a) continue;
        idSeq += 1;
        blMatches.push({
          id: idSeq,
          stage: "REGULAR_SEASON",
          utcDate: "2026-09-01T13:30:00Z",
          status: "FINISHED",
          competition: { code: "BL1" },
          season: { startDate: "2026-08-01" },
          matchday: 1,
          homeTeam: { id: h, name: `BL Club ${h}` },
          awayTeam: { id: a, name: `BL Club ${a}` },
          score: { duration: "REGULAR", fullTime: { home: 2, away: 1 } },
        });
      }
    }
    // Inject relegation & playoffs ties involving a 19th 2. Bundesliga / Ligue 2 team
    blMatches.push(
      {
        id: 9001,
        stage: "RELEGATION",
        utcDate: "2027-05-22T18:30:00Z",
        status: "SCHEDULED",
        competition: { code: "BL1" },
        season: { startDate: "2026-08-01" },
        matchday: 1,
        homeTeam: { id: 16, name: "BL Club 16" },
        awayTeam: { id: 999, name: "2. Liga Relegation Club" },
      },
      {
        id: 9002,
        stage: "PLAYOFFS",
        utcDate: "2027-05-26T18:30:00Z",
        status: "SCHEDULED",
        competition: { code: "BL1" },
        season: { startDate: "2026-08-01" },
        matchday: 2,
        homeTeam: { id: 999, name: "2. Liga Relegation Club" },
        awayTeam: { id: 16, name: "BL Club 16" },
      },
    );

    const { client, calls } = http((path) => path === "competitions/BL1/matches"
      ? { matches: blMatches }
      : {
          matches: [
            {
              id: 7001,
              stage: "REGULAR_SEASON",
              utcDate: "2027-05-15T19:00:00Z",
              status: "FINISHED",
              homeTeam: { id: 201, name: "Paris SG" },
              awayTeam: { id: 202, name: "Lyon" },
              score: { duration: "REGULAR", fullTime: { home: 1, away: 0 } },
            },
            {
              id: 7002,
              stage: "RELEGATION",
              utcDate: "2027-05-25T19:00:00Z",
              status: "SCHEDULED",
              homeTeam: { id: 216, name: "Ligue 1 16th" },
              awayTeam: { id: 299, name: "Ligue 2 Challenger" },
            },
          ],
        });
    const adapter = new FootballDataAdapter(client, log);

    const seasonFixtures = await adapter.fetchSeasonFixtures(BL1);
    expect(calls[0]).toEqual({
      path: "competitions/BL1/matches",
      query: { season: "2026", stage: "REGULAR_SEASON" },
    });
    expect(seasonFixtures).toHaveLength(306);
    expect(seasonFixtures.some((f) => f.fixture.id === 9001 || f.fixture.id === 9002)).toBe(false);

    const blTeams = await adapter.fetchTeams(BL1);
    expect(blTeams).toHaveLength(18);
    expect(blTeams.some((t) => String(t.team.id) === "999")).toBe(false);

    // Date-range path also excludes RELEGATION matches (e.g. Ligue 1 relegation tie)
    const flDateRange = await adapter.fetchFixturesByDateRange(FL1, "2027-05-15", "2027-05-28");
    expect(flDateRange).toHaveLength(1);
    expect(flDateRange[0]?.fixture.id).toBe(7001);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "provider_fixture_ignored",
      source_id: "fd",
      reason: "non_regular_stage",
      stage: "RELEGATION",
    }));

    // Verify 18 filtered teams + 306 regular fixtures complete cleanly under evaluateLeagueSeason
    const statusMatches: StatusMatchInput[] = seasonFixtures.map((f) => ({
      match_id: String(f.fixture.id),
      canonical_match_id: String(f.fixture.id),
      superseded_by: null,
      round_id: "01",
      home_team_id: String(f.teams.home.id),
      away_team_id: String(f.teams.away.id),
      match_status: "finished",
      regular_home_score: f.score?.fulltime?.home ?? null,
      regular_away_score: f.score?.fulltime?.away ?? null,
    }));
    const evalResult = evaluateLeagueSeason({
      format: { kind: "double_round_robin", team_count: 18, round_count: 34 },
      teamIds: blTeams.map((t) => String(t.team.id)),
      matches: statusMatches,
      previous: null,
      now: new Date("2027-05-20T00:00:00Z"),
    });
    expect(evalResult).toMatchObject({
      schedule_status: "locked",
      completion_status: "completed",
      reason: "completed",
    });
  });
});

describe("BsdAdapter", () => {
  it("uses the OpenAPI league_id filter, follows next pages, and maps event fields", async () => {
    const next = "https://sports.bzzoiro.com/api/v2/events/?league_id=52&offset=200";
    const { client, calls } = http((path) => path === "events/" ? {
      count: 2,
      next,
      results: [{
        id: "event-1",
        league_id: 52,
        stage: "regular-season",
        event_date: "2026-08-08T14:00:00Z",
        status: "finished",
        round_number: 1,
        home_team_id: 10,
        away_team_id: 11,
        home_team: "Beijing Guoan",
        away_team: "Shanghai Port",
        home_score: 2,
        away_score: 1,
      }],
    } : {
      count: 2,
      next: null,
      results: [{
        id: "event-2",
        league_id: 52,
        stage: "regular-season",
        event_date: "2026-08-09T14:00:00Z",
        status: "upcoming",
        round_number: 2,
        home_team_id: 12,
        away_team_id: 13,
        home_team: "Shandong Taishan",
        away_team: "Zhejiang",
      }],
    });
    const adapter = new BsdAdapter(client);
    const fixtures = await adapter.fetchFixturesByDateRange(CSL, "2026-08-08", "2026-08-09");

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      path: "events/",
      query: { league_id: "52", date_from: "2026-08-08", date_to: "2026-08-09", limit: "200", offset: "0" },
    });
    expect(calls[1]?.path).toBe(next);
    expect(fixtures).toHaveLength(2);
    expect(fixtures[0]).toMatchObject({
      provider: "bsd",
      fixture: { id: "event-1", status: { short: "FT" } },
      league: { id: 52, round: "01" },
      teams: { home: { id: 10, name: "Beijing Guoan" } },
      score: { fulltime: { home: 2, away: 1 } },
    });
    expect(fixtures[1]).toMatchObject({
      fixture: { id: "event-2", status: { short: "NS" } },
      league: { round: "02" },
      teams: { home: { id: 12, name: "Shandong Taishan" } },
    });
  });

  it("rejects a next page outside the events listing", async () => {
    const { client } = http(() => ({ count: 1, next: "https://sports.bzzoiro.com/api/v2/odds/", results: [] }));
    await expect(new BsdAdapter(client).fetchFixturesByDateRange(CSL, "2026-08-08", "2026-08-09"))
      .rejects.toThrow("field=next");
  });

  it("rejects cross-origin next URLs and duplicate cursor loops (A-S3-13)", async () => {
    const { client: crossOrigin } = http(() => ({
      count: 1,
      next: "https://evil.example/api/v2/events/?offset=200",
      results: [],
    }));
    await expect(new BsdAdapter(crossOrigin).fetchFixturesByDateRange(CSL, "2026-08-08", "2026-08-09"))
      .rejects.toThrow("field=next");

    const repeatedNext = "https://sports.bzzoiro.com/api/v2/events/?league_id=52&offset=200";
    const { client: loopClient } = http(() => ({
      count: 1,
      next: repeatedNext,
      results: [],
    }));
    await expect(new BsdAdapter(loopClient).fetchFixturesByDateRange(CSL, "2026-08-08", "2026-08-09"))
      .rejects.toThrow(/DIAG_PROVIDER_PAGINATION.*reason=cursor_loop/);

    let page = 0;
    const { client: runawayClient } = http(() => {
      page += 1;
      return {
        count: 99999,
        next: `https://sports.bzzoiro.com/api/v2/events/?league_id=52&offset=${page * 200}`,
        results: [],
      };
    });
    await expect(new BsdAdapter(runawayClient).fetchFixturesByDateRange(CSL, "2026-08-08", "2026-08-09"))
      .rejects.toThrow(/DIAG_PROVIDER_PAGINATION.*reason=max_pages/);
  });
});
