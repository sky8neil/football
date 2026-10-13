import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, it, expect, vi } from "vitest";
function load(cache = {}) {
  let definition;
  const listMatches = vi.fn();
  runInNewContext(readFileSync(new URL("./profile.js", import.meta.url), "utf8"), {
    Page: value => { definition = value; },
    require: name => name.includes("matches.js") ? { listMatches } : name.includes("logo-registry") ? { PLACEHOLDER: "placeholder.png", getTeamLogo: (league, team) => league + "/" + team.name + ".png" } : { headerHeight: () => 88 },
    wx: { getStorageSync: key => cache[key], setStorageSync: (key, value) => { cache[key] = value; } },
  });
  const page = { ...definition, data: structuredClone(definition.data), setData(value) { Object.assign(this.data, value); } };
  return { page, listMatches, cache };
}
describe("profile favorite team emblem", () => {
  it("uses a cached club logo after changing teams", async () => {
    const { page, listMatches } = load({ "team_logo:a": "arsenal.png" });
    await page.loadFavoriteTeam("a");
    expect(page.data.favoriteTeamLogo).toBe("arsenal.png");
    expect(listMatches).not.toHaveBeenCalled();
  });
  it("resolves the actual team and caches its logo after cache is cleared", async () => {
    const { page, listMatches, cache } = load();
    listMatches.mockResolvedValueOnce({ statusCode: 200, data: { items: [], page: { next_cursor: "next" } } });
    listMatches.mockResolvedValueOnce({ statusCode: 200, data: { items: [{ league_id: "premier_league", home_team: { team_id: "a", name: "Arsenal" } }] } });
    await page.loadFavoriteTeam("a");
    expect(listMatches).toHaveBeenLastCalledWith({ limit: 100, cursor: "next" });
    expect(page.data.favoriteTeamLogo).toBe("premier_league/Arsenal.png");
    expect(page.data.favoriteTeamText).toBe("Arsenal");
    expect(cache["team_logo:a"]).toBe("premier_league/Arsenal.png");
  });
  it("uses the neutral emblem when no favorite team is set", async () => {
    const { page, listMatches } = load();
    page.setData({ favoriteTeamLogo: "old.png" });
    await page.loadFavoriteTeam(null);
    expect(page.data.favoriteTeamLogo).toBe("placeholder.png");
    expect(page.data.favoriteTeamText).toBe("未设置");
    expect(listMatches).not.toHaveBeenCalled();
  });
  it("ignores a delayed lookup after the selected team changes", async () => {
    const { page, listMatches } = load({ "team_logo:b": "chelsea.png" });
    let finish;
    listMatches.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = page.loadFavoriteTeam("a");
    await page.loadFavoriteTeam("b");
    finish({ statusCode: 200, data: { items: [{ league_id: "premier_league", home_team: { team_id: "a", name: "Arsenal" } }] } });
    await pending;
    expect(page.data.favoriteTeamLogo).toBe("chelsea.png");
  });
});
