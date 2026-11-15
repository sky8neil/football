import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = new URL("./matches-default-league.js", import.meta.url);
const moduleShim = { exports: {} };
runInNewContext(readFileSync(source, "utf8"), { module: moduleShim, exports: moduleShim.exports });
const { resolveDefaultLeague } = moduleShim.exports;
const NOW = new Date("2026-08-10T00:00:00.000Z");
const LEAGUE_IDS = ["premier_league", "la_liga", "serie_a", "bundesliga", "ligue_1", "chinese_super_league"];

function scheduled(match_status = "scheduled") {
  return { match_status };
}

function makeListMatches(fixtures = {}) {
  return vi.fn(async ({ league_id }) => {
    const fixture = fixtures[league_id];
    if (fixture instanceof Error) throw fixture;
    if (fixture && fixture.statusCode !== undefined) return fixture;
    return { statusCode: 200, data: { items: fixture || [] } };
  });
}

describe("default match league", () => {
  it("probes all six leagues in parallel with the recent and upcoming window", async () => {
    const listMatches = makeListMatches({ premier_league: [scheduled("live")] });
    const resultPromise = resolveDefaultLeague(listMatches, NOW);

    expect(listMatches).toHaveBeenCalledTimes(6);
    const result = await resultPromise;
    expect(result).toEqual({ leagueId: "premier_league", activeLeagueIds: ["premier_league"] });
    expect(listMatches.mock.calls.map(([query]) => query.league_id)).toEqual(LEAGUE_IDS);
    for (const [query] of listMatches.mock.calls) {
      expect(query).toEqual({
        league_id: expect.any(String),
        from: "2026-08-03T00:00:00.000Z",
        to: "2026-08-31T00:00:00.000Z",
        limit: 20,
      });
    }
  });

  it("chooses the first league in the fixed order with a scheduled or live match", async () => {
    const listMatches = makeListMatches({
      la_liga: [scheduled("live")],
      bundesliga: [scheduled()],
    });
    await expect(resolveDefaultLeague(listMatches, NOW)).resolves.toEqual({
      leagueId: "la_liga",
      activeLeagueIds: ["la_liga", "bundesliga"],
    });
  });

  it("selects the Bundesliga when it is the only league with an upcoming match", async () => {
    const listMatches = makeListMatches({ bundesliga: [scheduled()] });
    await expect(resolveDefaultLeague(listMatches, NOW)).resolves.toEqual({
      leagueId: "bundesliga",
      activeLeagueIds: ["bundesliga"],
    });
  });

  it("selects the Chinese Super League when Premier League and La Liga have no upcoming matches", async () => {
    const listMatches = makeListMatches({
      premier_league: [{ match_status: "finished" }],
      la_liga: [],
      chinese_super_league: [scheduled()],
    });
    await expect(resolveDefaultLeague(listMatches, NOW)).resolves.toEqual({
      leagueId: "chinese_super_league",
      activeLeagueIds: ["chinese_super_league"],
    });
  });

  it("falls back to the first league with any returned item when none are upcoming", async () => {
    const listMatches = makeListMatches({
      la_liga: [{ match_status: "finished" }],
      bundesliga: [{ match_status: "postponed" }],
    });
    await expect(resolveDefaultLeague(listMatches, NOW)).resolves.toEqual({
      leagueId: "la_liga",
      activeLeagueIds: [],
    });
  });

  it("treats individual request failures as leagues without a schedule", async () => {
    const listMatches = makeListMatches({
      premier_league: new Error("request failed"),
      la_liga: { statusCode: 503, data: { items: [scheduled()] } },
      serie_a: [scheduled("live")],
    });
    await expect(resolveDefaultLeague(listMatches, NOW)).resolves.toEqual({
      leagueId: "serie_a",
      activeLeagueIds: ["serie_a"],
    });
  });

  it("defaults to the Premier League when every request is empty", async () => {
    await expect(resolveDefaultLeague(makeListMatches(), NOW)).resolves.toEqual({
      leagueId: "premier_league",
      activeLeagueIds: [],
    });
  });
});
