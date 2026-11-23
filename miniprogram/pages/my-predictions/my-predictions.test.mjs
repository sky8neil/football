import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const PAGE_JS = join(HERE, "my-predictions.js");
const PAGE_SOURCE = readFileSync(PAGE_JS, "utf8");

const ARSENAL_ID = "f490a3bf-b29f-42ce-a5bc-3cb67ad2baee";
const CHELSEA_ID = "e575463d-244b-461b-9b17-dd49f90adb4c";
const REAL_MADRID_ID = "393c67e2-45f7-48a2-b3cd-9684901614ef";
const ALAVES_ID = "00235af4-869b-4953-a3b7-afc3f8024d81";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

const originals = {
  Page: Object.getOwnPropertyDescriptor(globalThis, "Page"),
  wx: Object.getOwnPropertyDescriptor(globalThis, "wx"),
};

afterEach(() => {
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
    enumerable: true,
  });
}

function loadCommonJs(filePath, requireShim) {
  const module = { exports: {} };
  const factory = runInThisContext(`(function (module, exports, require) {\n${readFileSync(filePath, "utf8")}\n})`, {
    filename: filePath,
  });
  factory(module, module.exports, requireShim);
  return module.exports;
}

function capturePageConfig(requireShim) {
  let config = null;
  setGlobal("Page", (value) => {
    config = value;
  });
  loadCommonJs(PAGE_JS, requireShim);
  if (!config) throw new Error("my-predictions.js 未调用 Page()");
  return config;
}

function instantiate(config) {
  const page = Object.assign({}, config);
  page.data = JSON.parse(JSON.stringify(config.data || {}));
  page.setData = function setData(patch) {
    Object.assign(this.data, patch);
  };
  return page;
}

function installWxStub() {
  const navs = [];
  setGlobal("wx", {
    navigateTo(options) {
      navs.push(["navigateTo", options && options.url]);
    },
    switchTab(options) {
      navs.push(["switchTab", options && options.url]);
    },
  });
  return { navs };
}

function loadUtil(relativePath, requireShim) {
  return loadCommonJs(join(ROOT, "utils", relativePath), requireShim);
}

function prediction(overrides = {}) {
  return {
    prediction_id: "pred-1",
    match_id: "match-1",
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: 12,
    home_team_id: ARSENAL_ID,
    away_team_id: CHELSEA_ID,
    kickoff_at: "2026-11-15T15:00:00.000Z",
    pred_home_score: 2,
    pred_away_score: 1,
    match_status: "finished",
    regular_home_score: 2,
    regular_away_score: 1,
    match_score: 12,
    wdl_hit: true,
    exact_hit: true,
    ...overrides,
  };
}

function loadPage({ listMyPredictions, listMatches, listLeagueSeasons } = {}) {
  const wxStub = installWxStub();
  const listMatchesFn = listMatches || vi.fn(async () => {
    throw new Error("listMatches must not be called");
  });
  const listMyPredictionsFn = listMyPredictions || vi.fn(async () => ({
    statusCode: 200,
    data: { items: [], page: { has_more: false, next_cursor: null } },
  }));
  const listLeagueSeasonsFn = listLeagueSeasons || vi.fn(async () => ({
    statusCode: 200,
    data: { items: [] },
  }));
  const registry = loadUtil("team-registry.js", () => {
    throw new Error("team-registry has no dependencies");
  });
  const logos = loadUtil("logo-registry.js", (id) => {
    if (id === "./team-registry.js") return registry;
    throw new Error(`Unexpected logo-registry require: ${id}`);
  });
  const realPresentTeam = loadUtil("team-presentation.js", (id) => {
    if (id === "./team-registry.js") return registry;
    if (id === "./logo-registry.js") return logos;
    throw new Error(`Unexpected team-presentation require: ${id}`);
  }).presentTeam;
  const presentTeamCalls = [];
  const presentation = {
    presentTeam(team, leagueId) {
      presentTeamCalls.push([team, leagueId]);
      return realPresentTeam(team, leagueId);
    },
  };
  const copy = loadUtil("rankings-copy.js", () => {
    throw new Error("rankings-copy has no dependencies");
  });
  const history = loadUtil("prediction-history.js", () => {
    throw new Error("prediction-history has no dependencies");
  });
  const matchPresentation = loadUtil("match-presentation.js", () => {
    throw new Error("match-presentation has no dependencies");
  });
  const config = capturePageConfig((id) => {
    if (id === "../../services/predictions.js") return { listMyPredictions: listMyPredictionsFn };
    if (id === "../../services/league-seasons.js") return { listLeagueSeasons: listLeagueSeasonsFn };
    if (id === "../../services/matches.js") return { listMatches: listMatchesFn };
    if (id === "../../utils/rankings-copy.js") return copy;
    if (id === "../../utils/logo-registry.js") return logos;
    if (id === "../../utils/team-registry.js") return registry;
    if (id === "../../utils/team-presentation.js") return presentation;
    if (id === "../../utils/prediction-history.js") return history;
    if (id === "../../utils/match-presentation.js") return matchPresentation;
    throw new Error(`Unexpected require: ${id}`);
  });
  return {
    page: instantiate(config),
    listMyPredictions: listMyPredictionsFn,
    listMatches: listMatchesFn,
    listLeagueSeasons: listLeagueSeasonsFn,
    presentTeamCalls,
    logos,
    ...wxStub,
  };
}

function catalogItems() {
  return [
    { league_id: "premier_league", season_id: "2026_2027", season_label: "2026/27", round_ids: [1] },
    { league_id: "premier_league", season_id: "2025_2026", season_label: "2025/26", round_ids: [1] },
    { league_id: "la_liga", season_id: "2026_2027", season_label: "2026/27", round_ids: [1] },
  ];
}

describe("DATA-01 my-predictions registry names", () => {
  it("does not require or call listMatches", async () => {
    expect(PAGE_SOURCE).not.toMatch(/listMatches/);
    expect(PAGE_SOURCE).not.toMatch(/resolveMatchFacts/);
    expect(PAGE_SOURCE).not.toMatch(/MATCH_QUERY_WINDOW_MS/);
    const listMatches = vi.fn(async () => ({ statusCode: 200, data: { items: [] } }));
    const listMyPredictions = vi.fn(async () => ({
      statusCode: 200,
      data: { items: [prediction()], page: { has_more: false, next_cursor: null } },
    }));
    const { page, listMatches: injected } = loadPage({ listMyPredictions, listMatches });
    await page.loadFirstPage();
    expect(injected).toHaveBeenCalledTimes(0);
    expect(listMatches).toHaveBeenCalledTimes(0);
  });

  it("renders registered Chinese names from history team_id fields", async () => {
    const listMatches = vi.fn();
    const listMyPredictions = vi.fn(async () => ({
      statusCode: 200,
      data: {
        items: [prediction({
          regular_home_score: 3,
          regular_away_score: 0,
          match_score: 3,
          exact_hit: false,
          wdl_hit: true,
        })],
        page: { has_more: false, next_cursor: null },
      },
    }));
    const { page } = loadPage({ listMyPredictions, listMatches });
    await page.loadFirstPage();
    expect(listMatches).toHaveBeenCalledTimes(0);
    expect(page.data.state).toBe("list");
    expect(page.data.items).toHaveLength(1);
    expect(page.data.items[0].homeNameZh).toBe("阿森纳");
    expect(page.data.items[0].awayNameZh).toBe("切尔西");
    expect(page.data.items[0].actualText).toBe("3 : 0");
    expect(page.data.items[0].pointsText).toBe("+3");
    expect(page.data.items[0].resultText).toBe("赛果命中");
    expect(page.data.items[0].statusText).toBe("已完场");
    expect(page.data.weeks.length).toBeGreaterThan(0);
    expect(page.data.weeks[0].items).toHaveLength(1);
  });

  it("shows 球队资料待补全 for unknown team_id and never falls back to 主队/客队", async () => {
    const listMatches = vi.fn();
    const listMyPredictions = vi.fn(async () => ({
      statusCode: 200,
      data: {
        items: [
          prediction({
            prediction_id: "unknown-both",
            home_team_id: UNKNOWN_ID,
            away_team_id: UNKNOWN_ID,
          }),
          prediction({
            prediction_id: "missing-ids",
            home_team_id: undefined,
            away_team_id: undefined,
          }),
        ],
        page: { has_more: false, next_cursor: null },
      },
    }));
    const { page } = loadPage({ listMyPredictions, listMatches });
    await page.loadFirstPage();
    expect(listMatches).toHaveBeenCalledTimes(0);
    expect(page.data.items).toHaveLength(2);
    for (const item of page.data.items) {
      expect(item.homeNameZh).toBe("球队资料待补全");
      expect(item.awayNameZh).toBe("球队资料待补全");
      expect(item.homeNameZh).not.toBe("主队");
      expect(item.awayNameZh).not.toBe("客队");
    }
    const serialized = JSON.stringify(page.data);
    expect(serialized).not.toContain("主队");
    expect(serialized).not.toContain("客队");
    expect(serialized).toContain("球队资料待补全");
  });

  it("passes full source names with team_id and resolves packaged crests from history ids", async () => {
    const listMyPredictions = vi.fn(async () => ({
      statusCode: 200,
      data: {
        items: [
          prediction(),
          prediction({
            prediction_id: "pred-madrid-alaves",
            match_id: "match-madrid-alaves",
            league_id: "la_liga",
            home_team_id: REAL_MADRID_ID,
            away_team_id: ALAVES_ID,
          }),
          prediction({
            prediction_id: "pred-unknown-league",
            match_id: "match-unknown-league",
            league_id: "unknown_league",
            home_team_id: ARSENAL_ID,
            away_team_id: UNKNOWN_ID,
          }),
        ],
        page: { has_more: false, next_cursor: null },
      },
    }));
    const { page, presentTeamCalls, logos } = loadPage({ listMyPredictions });
    await page.loadFirstPage();
    expect(presentTeamCalls).toEqual([
      [{ team_id: ARSENAL_ID, name: "Arsenal FC" }, "premier_league"],
      [{ team_id: CHELSEA_ID, name: "Chelsea FC" }, "premier_league"],
      [{ team_id: REAL_MADRID_ID, name: "Real Madrid CF" }, "la_liga"],
      [{ team_id: ALAVES_ID, name: "Deportivo Alavés" }, "la_liga"],
      [{ team_id: ARSENAL_ID, name: "Arsenal FC" }, "unknown_league"],
      [{ team_id: UNKNOWN_ID, name: undefined }, "unknown_league"],
    ]);
    expect(page.data.items[0].homeLogo).toBe(logos.MANIFEST.premier_league.teams.arsenal);
    expect(page.data.items[0].awayLogo).toBe(logos.MANIFEST.premier_league.teams.chelsea);
    expect(page.data.items[1].homeNameZh).toBe("皇家马德里");
    expect(page.data.items[1].homeLogo).toBe(logos.MANIFEST.la_liga.teams["real-madrid"]);
    expect(page.data.items[1].awayNameZh).toBe("阿拉维斯");
    expect(page.data.items[1].awayLogo).toBe(logos.PLACEHOLDER);
    expect(page.data.items[2].homeLogo).toBe(logos.MANIFEST.premier_league.teams.arsenal);
    expect(page.data.items[2].awayNameZh).toBe("球队资料待补全");
    expect(page.data.items[2].awayLogo).toBe(logos.PLACEHOLDER);
  });

  it("loads only the first page until the user taps 加载更多, then assigns Chinese names to every record", async () => {
    const listMatches = vi.fn();
    const firstPage = Array.from({ length: 20 }, (_, index) => prediction({
      prediction_id: `pred-${index + 1}`,
      match_id: `match-${index + 1}`,
      kickoff_at: new Date(Date.UTC(2026, 10, 18, 12) - index * 3600000).toISOString(),
    }));
    const secondPage = Array.from({ length: 5 }, (_, index) => prediction({
      prediction_id: `pred-${index + 21}`,
      match_id: `match-${index + 21}`,
      kickoff_at: new Date(Date.UTC(2026, 10, 17, 12) - index * 3600000).toISOString(),
    }));
    const listMyPredictions = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 200,
        data: { items: firstPage, page: { has_more: true, next_cursor: "page-2" } },
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        data: { items: secondPage, page: { has_more: false, next_cursor: null } },
      });
    const { page } = loadPage({ listMyPredictions, listMatches });
    await page.loadFirstPage();
    expect(listMyPredictions).toHaveBeenCalledTimes(1);
    expect(page.data.items).toHaveLength(20);
    expect(page.data.hasMore).toBe(true);
    expect(page.data.nextCursor).toBe("page-2");
    page.onMore();
    await vi.waitFor(() => expect(page.data.items).toHaveLength(25));
    expect(listMatches).toHaveBeenCalledTimes(0);
    expect(listMyPredictions).toHaveBeenNthCalledWith(1, {
      leagueId: undefined,
      seasonId: undefined,
      limit: 20,
    });
    expect(listMyPredictions).toHaveBeenNthCalledWith(2, {
      leagueId: undefined,
      seasonId: undefined,
      cursor: "page-2",
    });
    expect(listMyPredictions).toHaveBeenCalledTimes(2);
    expect(page.data.hasMore).toBe(false);
    expect(page.data.nextCursor).toBeNull();
    for (const item of page.data.items) {
      expect(item.homeNameZh).toBe("阿森纳");
      expect(item.awayNameZh).toBe("切尔西");
      expect(item.homeNameZh).not.toBe("主队");
      expect(item.awayNameZh).not.toBe("客队");
    }
    expect(page.data.weeks.length).toBeGreaterThan(0);
    expect(page.data.weeks.reduce((count, week) => count + week.items.length, 0)).toBe(25);
  });
});

describe("my-predictions league/season filters", () => {
  it("does not send league_id or season_id on the default first page", async () => {
    const listMyPredictions = vi.fn(async () => ({
      statusCode: 200,
      data: { items: [prediction()], page: { has_more: false, next_cursor: null } },
    }));
    const { page } = loadPage({ listMyPredictions });
    await page.onLoad();
    expect(listMyPredictions).toHaveBeenCalledTimes(1);
    expect(listMyPredictions.mock.calls[0][0].leagueId).toBeUndefined();
    expect(listMyPredictions.mock.calls[0][0].seasonId).toBeUndefined();
    expect(listMyPredictions.mock.calls[0][0].limit).toBe(20);
  });

  it("resets season and reloads the list after changing league", async () => {
    const listMyPredictions = vi.fn(async () => ({
      statusCode: 200,
      data: { items: [prediction()], page: { has_more: false, next_cursor: null } },
    }));
    const listLeagueSeasons = vi.fn(async () => ({
      statusCode: 200,
      data: { items: catalogItems() },
    }));
    const { page } = loadPage({ listMyPredictions, listLeagueSeasons });
    await page.onLoad();
    await page.onLeagueChange({ detail: { value: "1" } });
    expect(page.data.seasonIndex).toBe(0);
    expect(page.data.selectedSeasonId).toBeNull();
    expect(page.data.selectedLeagueId).toBe("premier_league");
    expect(page.data.seasonOptions).toEqual(["全部赛季", "2026/27", "2025/26"]);
    expect(page.data.items).toHaveLength(1);
    expect(listMyPredictions).toHaveBeenLastCalledWith({
      leagueId: "premier_league",
      seasonId: undefined,
      limit: 20,
    });
  });

  it("keeps the current leagueId and seasonId when loading the next page", async () => {
    const listMyPredictions = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 200,
        data: { items: [prediction()], page: { has_more: true, next_cursor: "page-2" } },
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        data: { items: [prediction({ prediction_id: "pred-2", match_id: "match-2" })], page: { has_more: false, next_cursor: null } },
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        data: { items: [prediction({ prediction_id: "pred-3", match_id: "match-3" })], page: { has_more: true, next_cursor: "page-2" } },
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        data: { items: [prediction({ prediction_id: "pred-4", match_id: "match-4" })], page: { has_more: false, next_cursor: null } },
      });
    const listLeagueSeasons = vi.fn(async () => ({
      statusCode: 200,
      data: { items: catalogItems() },
    }));
    const { page } = loadPage({ listMyPredictions, listLeagueSeasons });
    await page.onLoad();
    await page.onLeagueChange({ detail: { value: "1" } });
    await page.onSeasonChange({ detail: { value: "1" } });
    expect(page.data.hasMore).toBe(true);
    expect(page.data.nextCursor).toBe("page-2");
    page.onMore();
    await vi.waitFor(() => expect(page.data.items).toHaveLength(2));
    expect(listMyPredictions).toHaveBeenLastCalledWith({
      leagueId: "premier_league",
      seasonId: "2026_2027",
      cursor: "page-2",
    });
  });

  it("discards a stale success response after a newer filter request", async () => {
    let resolveA;
    const listMyPredictions = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveA = resolve;
      }))
      .mockResolvedValueOnce({
        statusCode: 200,
        data: { items: [prediction({ prediction_id: "pred-b", match_id: "match-b" })], page: { has_more: false, next_cursor: null } },
      });
    const listLeagueSeasons = vi.fn(async () => ({
      statusCode: 200,
      data: { items: catalogItems() },
    }));
    const { page } = loadPage({ listMyPredictions, listLeagueSeasons });
    await page.loadFilters();
    const pendingA = page.loadFirstPage();
    await page.onLeagueChange({ detail: { value: "1" } });
    expect(page.data.items[0].prediction_id).toBe("pred-b");
    resolveA({
      statusCode: 200,
      data: { items: [prediction({ prediction_id: "pred-a", match_id: "match-a" })], page: { has_more: false, next_cursor: null } },
    });
    await pendingA;
    expect(page.data.items).toHaveLength(1);
    expect(page.data.items[0].prediction_id).toBe("pred-b");
    expect(page.data.state).toBe("list");
  });

  it("discards a stale error response after a newer filter request succeeds", async () => {
    let resolveA;
    const listMyPredictions = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveA = resolve;
      }))
      .mockResolvedValueOnce({
        statusCode: 200,
        data: { items: [prediction({ prediction_id: "pred-b", match_id: "match-b" })], page: { has_more: false, next_cursor: null } },
      });
    const listLeagueSeasons = vi.fn(async () => ({
      statusCode: 200,
      data: { items: catalogItems() },
    }));
    const { page } = loadPage({ listMyPredictions, listLeagueSeasons });
    await page.loadFilters();
    const pendingA = page.loadFirstPage();
    await page.onLeagueChange({ detail: { value: "1" } });
    expect(page.data.state).toBe("list");
    resolveA({ statusCode: 500, message: "boom", code: "INTERNAL" });
    await pendingA;
    expect(page.data.state).toBe("list");
    expect(page.data.items[0].prediction_id).toBe("pred-b");
    expect(page.data.errorMessage).toBe("");
  });

  it("still shows the prediction list when the catalog request fails", async () => {
    const listMyPredictions = vi.fn(async () => ({
      statusCode: 200,
      data: { items: [prediction()], page: { has_more: false, next_cursor: null } },
    }));
    const listLeagueSeasons = vi.fn(async () => ({
      statusCode: 500,
      message: "catalog failed",
    }));
    const { page } = loadPage({ listMyPredictions, listLeagueSeasons });
    await page.onLoad();
    expect(page.data.state).toBe("list");
    expect(page.data.items).toHaveLength(1);
    expect(page.data.filterError).toBe("筛选选项加载失败");
    expect(page.data.filterReady).toBe(false);
  });

  it("uses a season-specific empty message only when a filter is selected", async () => {
    const listMyPredictions = vi.fn(async () => ({
      statusCode: 200,
      data: { items: [], page: { has_more: false, next_cursor: null } },
    }));
    const listLeagueSeasons = vi.fn(async () => ({
      statusCode: 200,
      data: { items: catalogItems() },
    }));
    const { page } = loadPage({ listMyPredictions, listLeagueSeasons });
    await page.onLoad();
    expect(page.data.state).toBe("empty");
    expect(page.data.emptyText).toBe("还没有预测记录");
    await page.onLeagueChange({ detail: { value: "1" } });
    expect(page.data.state).toBe("empty");
    expect(page.data.emptyText).toBe("你在这个赛季还没有预测记录");
  });

  it("shows a readable network error instead of a bare 0", async () => {
    const listMyPredictions = vi.fn(async () => ({
      statusCode: 0,
      code: "NETWORK_ERROR",
      message: undefined,
    }));
    const { page } = loadPage({ listMyPredictions });
    await page.loadFirstPage();
    expect(page.data.state).toBe("error");
    expect(page.data.errorMessage).toBe("网络异常，请重试");
    expect(page.data.errorMessage).not.toMatch(/\b0\b/);
  });

  it("opens the share card page without filters by default", async () => {
    const listMyPredictions = vi.fn(async () => ({
      statusCode: 200,
      data: { items: [prediction()], page: { has_more: false, next_cursor: null } },
    }));
    const listLeagueSeasons = vi.fn(async () => ({
      statusCode: 200,
      data: { items: catalogItems() },
    }));
    const { page, navs } = loadPage({ listMyPredictions, listLeagueSeasons });
    await page.onLoad();
    page.onShareCardTap();
    expect(navs).toEqual([["navigateTo", "/pages/share-card/share-card"]]);
  });

  it("passes the current league and season to the share card page", async () => {
    const listMyPredictions = vi.fn(async () => ({
      statusCode: 200,
      data: { items: [prediction()], page: { has_more: false, next_cursor: null } },
    }));
    const listLeagueSeasons = vi.fn(async () => ({
      statusCode: 200,
      data: { items: catalogItems() },
    }));
    const { page, navs } = loadPage({ listMyPredictions, listLeagueSeasons });
    await page.onLoad();
    await page.onLeagueChange({ detail: { value: "1" } });
    await page.onSeasonChange({ detail: { value: "1" } });
    page.onShareCardTap();
    expect(navs).toEqual([
      ["navigateTo", "/pages/share-card/share-card?league_id=premier_league&season_id=2026_2027"],
    ]);
  });
});
