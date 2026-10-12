import { describe, expect, it, vi } from "vitest";
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
        event_date: "2026-08-08T14:00:00Z",
        status: "finished",
        round_number: 1,
        home_team_id: 10,
        away_team_id: 11,
        home_team_name: "Beijing Guoan",
        away_team_name: "Shanghai Port",
        home_score: 2,
        away_score: 1,
      }],
    } : {
      count: 2,
      next: null,
      results: [{
        id: "event-2",
        league_id: 52,
        event_date: "2026-08-09T14:00:00Z",
        status: "upcoming",
        round_number: "2",
        home_team: { id: 12, name: "Shandong Taishan" },
        away_team: { id: 13, name: "Zhejiang" },
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
      league: { id: 52, round: "1" },
      teams: { home: { id: 10, name: "Beijing Guoan" } },
      score: { fulltime: { home: 2, away: 1 } },
    });
    expect(fixtures[1]).toMatchObject({
      fixture: { id: "event-2", status: { short: "NS" } },
      teams: { home: { id: 12, name: "Shandong Taishan" } },
    });
  });

  it("rejects a next page outside the events listing", async () => {
    const { client } = http(() => ({ count: 1, next: "https://sports.bzzoiro.com/api/v2/odds/", results: [] }));
    await expect(new BsdAdapter(client).fetchFixturesByDateRange(CSL, "2026-08-08", "2026-08-09"))
      .rejects.toThrow("field=next");
  });
});
