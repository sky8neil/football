import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = new URL("./matches-default-league.js", import.meta.url);
const moduleShim = { exports: {} };
runInNewContext(readFileSync(source, "utf8"), { module: moduleShim, exports: moduleShim.exports });
const { resolveDefaultLeague } = moduleShim.exports;
const NOW = new Date("2026-08-10T00:00:00.000Z");

describe("default match league", () => {
  it("keeps the Premier League during an international break when a match is within 21 days", async () => {
    const listMatches = vi.fn(async (query) => ({
      statusCode: 200,
      data: { items: query.league_id === "premier_league" ? [{ match_id: "pl-1" }] : [] },
    }));
    await expect(resolveDefaultLeague(listMatches, NOW)).resolves.toBe("premier_league");
    expect(listMatches).toHaveBeenCalledTimes(1);
    expect(listMatches.mock.calls[0][0]).toMatchObject({
      from: "2026-08-03T00:00:00.000Z",
      to: "2026-08-31T00:00:00.000Z",
      limit: 100,
    });
  });

  it("uses the Chinese Super League only when it has an upcoming match during the Premier League break", async () => {
    const listMatches = vi.fn(async (query) => ({
      statusCode: 200,
      data: { items: query.league_id === "chinese_super_league" ? [{ match_id: "csl-1" }] : [] },
    }));
    await expect(resolveDefaultLeague(listMatches, NOW)).resolves.toBe("chinese_super_league");
    expect(listMatches).toHaveBeenCalledTimes(2);
    expect(listMatches.mock.calls[1][0]).toMatchObject({
      from: "2026-08-10T00:00:00.000Z",
      to: "2026-08-31T00:00:00.000Z",
    });
  });

  it("keeps the Premier League when both leagues have no upcoming fixtures", async () => {
    const listMatches = vi.fn(async () => ({ statusCode: 200, data: { items: [] } }));
    await expect(resolveDefaultLeague(listMatches, NOW)).resolves.toBe("premier_league");
  });
});
