import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, it, expect, vi } from "vitest";
function load(cache = {}, registeredTeam = null, logoOverride = null, options = {}) {
  let definition;
  const listMatches = vi.fn();
  const getMatchDetail = vi.fn();
  const listMyPredictions = options.listMyPredictions || vi.fn();
  const presentTeam = options.presentTeam || ((team) => ({ teamId: team && team.team_id, nameZh: "球队资料待补全", logo: "", missing: true }));
  runInNewContext(readFileSync(new URL("./profile.js", import.meta.url), "utf8"), {
    Page: value => { definition = value; },
    require: name => name.includes("matches.js") ? { listMatches, getMatchDetail } : name.includes("predictions.js") ? { listMyPredictions } : name.includes("prediction-history") ? { formatShanghaiKickoff: () => "" } : name.includes("logo-registry") ? { PLACEHOLDER: "placeholder.png", getTeamLogo: logoOverride || ((league, team) => league + "/" + team.name + ".png") } : name.includes("level-presentation") ? { buildLevelView: () => ({}) } : name.includes("team-presentation") ? { presentTeam } : name.includes("team-registry") ? { findTeam: () => registeredTeam } : { headerHeight: () => 88 },
    wx: {
      getStorageSync: key => cache[key],
      setStorageSync: (key, value) => { cache[key] = value; },
      removeStorageSync: key => { delete cache[key]; },
    },
  });
  const page = { ...definition, data: structuredClone(definition.data), setData(value) { Object.assign(this.data, value); } };
  return { page, listMatches, getMatchDetail, listMyPredictions, cache };
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
  it("resolves a registered team from local registry without querying listMatches", async () => {
    const { page, listMatches, cache } = load({}, { league_id: "premier_league", source_name: "Arsenal", name_zh: "阿森纳" });
    await page.loadFavoriteTeam("a");
    expect(listMatches).not.toHaveBeenCalled();
    expect(page.data.favoriteTeamLogo).toBe("premier_league/Arsenal.png");
    expect(page.data.favoriteTeamText).toBe("阿森纳");
    expect(cache["team_name:a"]).toBe("Arsenal");
    expect(cache["team_logo:a"]).toBe("premier_league/Arsenal.png");
  });
  it("falls back to listMatches when a registered team only resolves to the placeholder logo", async () => {
    let calls = 0;
    const { page, listMatches } = load(
      {},
      { league_id: "premier_league", source_name: "Arsenal", name_zh: "阿森纳" },
      (league, team) => {
        calls += 1;
        return calls === 1 ? "placeholder.png" : `${league}/${team.name}.png`;
      },
    );
    listMatches.mockResolvedValueOnce({ statusCode: 200, data: { items: [{ league_id: "premier_league", home_team: { team_id: "a", name: "Arsenal" } }] } });
    await page.loadFavoriteTeam("a");
    expect(listMatches).toHaveBeenCalledWith({ limit: 100, cursor: null });
    expect(page.data.favoriteTeamLogo).toBe("premier_league/Arsenal.png");
  });

  it("clears stale storage logo on onTeamLogoError and never caches PLACEHOLDER", async () => {
    const { page, listMatches, cache } = load({ "team_logo:broken": "bad.png" }, null, () => "placeholder.png");
    page.setData({ favoriteTeamId: "broken", favoriteTeamLogo: "bad.png" });
    page.onTeamLogoError();
    expect(page.data.favoriteTeamLogo).toBe("placeholder.png");
    expect(cache["team_logo:broken"]).toBeUndefined();

    listMatches.mockResolvedValueOnce({
      statusCode: 200,
      data: { items: [{ league_id: "premier_league", home_team: { team_id: "broken", name: "Unknown" } }] },
    });
    await page.loadFavoriteTeam("broken");
    expect(cache["team_logo:broken"]).toBeUndefined();
    expect(page.data.favoriteTeamLogo).toBe("placeholder.png");
  });

  it("stops scanning listMatches after the page cap for unregistered teams", async () => {
    const { page, listMatches } = load();
    let pageNo = 0;
    listMatches.mockImplementation(async () => {
      pageNo += 1;
      return {
        statusCode: 200,
        data: { items: [], page: { next_cursor: `cursor-${pageNo}` } },
      };
    });
    await page.loadFavoriteTeam("nonexistent-team");
    expect(listMatches).toHaveBeenCalledTimes(5);
  });

  it("overwrites a wrong cached logo and name for a registered favorite team", async () => {
    const { page, listMatches, cache } = load(
      { "team_logo:a": "wrong-logo.png", "team_name:a": "Wrong FC" },
      { league_id: "premier_league", source_name: "Arsenal", name_zh: "阿森纳" },
    );
    await page.loadFavoriteTeam("a");
    expect(listMatches).not.toHaveBeenCalled();
    expect(page.data.favoriteTeamText).toBe("阿森纳");
    expect(page.data.favoriteTeamLogo).toBe("premier_league/Arsenal.png");
    expect(cache["team_name:a"]).toBe("Arsenal");
    expect(cache["team_logo:a"]).toBe("premier_league/Arsenal.png");
  });

  it("[DATA-01] loads recent predictions from server team objects without per-match detail requests", async () => {
    const listMyPredictions = vi.fn(async () => ({
      statusCode: 200,
      data: {
        items: [{
          prediction_id: "pred-1",
          match_id: "match-1",
          league_id: "chinese_super_league",
          home_team_id: "changchun-id",
          away_team_id: "arsenal-id",
          home_team: { team_id: "changchun-id", name: "长春亚泰" },
          away_team: { team_id: "arsenal-id", name: "Arsenal FC" },
          kickoff_at: "2026-11-15T15:00:00.000Z",
          pred_home_score: 2,
          pred_away_score: 1,
          match_status: "finished",
          regular_home_score: 2,
          regular_away_score: 1,
          match_score: 12,
          wdl_hit: true,
          exact_hit: true,
        }],
      },
    }));
    const presentTeam = vi.fn((team) => ({
      teamId: team && team.team_id,
      nameZh: team && team.name ? team.name : "球队资料待补全",
      logo: team && team.name ? team.name + ".png" : "placeholder.png",
      missing: !team || !team.name,
    }));
    const { page, getMatchDetail } = load({}, null, null, { listMyPredictions, presentTeam });
    await page.loadRecentPredictions();
    expect(getMatchDetail).not.toHaveBeenCalled();
    expect(page.data.recentState).toBe("ready");
    expect(page.data.recentPredictions[0]).toMatchObject({
      homeNameZh: "长春亚泰",
      awayNameZh: "Arsenal FC",
      homeLogo: "长春亚泰.png",
      awayLogo: "Arsenal FC.png",
    });
  });

  it("[UX-04] shows cancellation copy in recent predictions without pending settlement", async () => {
    const listMyPredictions = vi.fn(async () => ({
      statusCode: 200,
      data: {
        items: [{
          prediction_id: "pred-cancelled",
          match_id: "match-cancelled",
          league_id: "premier_league",
          home_team_id: "arsenal-id",
          away_team_id: "chelsea-id",
          home_team: { team_id: "arsenal-id", name: "Arsenal FC" },
          away_team: { team_id: "chelsea-id", name: "Chelsea FC" },
          kickoff_at: "2026-11-15T15:00:00.000Z",
          pred_home_score: 2,
          pred_away_score: 1,
          match_status: "cancelled",
          regular_home_score: 2,
          regular_away_score: 1,
          match_score: 12,
          wdl_hit: true,
          exact_hit: true,
        }],
      },
    }));
    const presentTeam = (team) => ({
      teamId: team && team.team_id,
      nameZh: team && team.name,
      logo: "",
      missing: false,
    });
    const { page } = load({}, null, null, { listMyPredictions, presentTeam });
    await page.loadRecentPredictions();
    expect(page.data.recentPredictions[0]).toMatchObject({
      actualText: "—",
      pointsText: "不计分",
      resultText: "比赛取消 · 不计分",
    });
  });
});
