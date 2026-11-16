import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = new URL("./matches-default-league.js", import.meta.url);
const moduleShim = { exports: {} };
runInNewContext(readFileSync(source, "utf8"), { module: moduleShim, exports: moduleShim.exports });
const { resolveDefaultLeagueFromStatus } = moduleShim.exports;

describe("default match league", () => {
  it("prefers a live league over the earliest next kickoff", () => {
    const items = [
      { league_id: "la_liga", phase: "in_season", next_kickoff_at: "2026-08-12T00:00:00Z" },
      { league_id: "serie_a", phase: "break", next_kickoff_at: "2026-08-11T00:00:00Z" },
      { league_id: "bundesliga", phase: "in_season", has_live_match: true },
    ];
    expect(resolveDefaultLeagueFromStatus(items).leagueId).toBe("bundesliga");
  });

  it("uses the earliest next kickoff when no league is live", () => {
    const items = [
      { league_id: "la_liga", phase: "in_season", next_kickoff_at: "2026-08-12T00:00:00Z" },
      { league_id: "serie_a", phase: "break", next_kickoff_at: "2026-08-11T00:00:00Z" },
      { league_id: "bundesliga", phase: "in_season", has_live_match: false },
    ];
    expect(resolveDefaultLeagueFromStatus(items).leagueId).toBe("serie_a");
  });

  it("collects active leagues from in-season and break phases only", () => {
    const items = [
      { league_id: "premier_league", phase: "completed" },
      { league_id: "la_liga", phase: "in_season", next_kickoff_at: "2026-08-12T00:00:00Z" },
      { league_id: "serie_a", phase: "break" },
      { league_id: "chinese_super_league", phase: "between_seasons" },
    ];
    expect(resolveDefaultLeagueFromStatus(items).activeLeagueIds).toEqual(["la_liga", "serie_a"]);
  });

  it("keeps the Premier League when no league reports an active phase or next kickoff", () => {
    expect(resolveDefaultLeagueFromStatus([{ league_id: "la_liga", phase: "completed" }])).toEqual({
      leagueId: "premier_league",
      activeLeagueIds: [],
    });
  });

  it("keeps the Premier League when the status list is empty or missing", () => {
    expect(resolveDefaultLeagueFromStatus([]).leagueId).toBe("premier_league");
    expect(resolveDefaultLeagueFromStatus(undefined).leagueId).toBe("premier_league");
  });
});
