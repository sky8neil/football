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

function loadPage({ listMyPredictions, listMatches } = {}) {
  const wxStub = installWxStub();
  const listMatchesFn = listMatches || vi.fn(async () => {
    throw new Error("listMatches must not be called");
  });
  const listMyPredictionsFn = listMyPredictions || vi.fn(async () => ({
    statusCode: 200,
    data: { items: [], page: { has_more: false, next_cursor: null } },
  }));
  const registry = loadUtil("team-registry.js", () => {
    throw new Error("team-registry has no dependencies");
  });
  const logos = loadUtil("logo-registry.js", () => {
    throw new Error("logo-registry has no dependencies");
  });
  const presentation = loadUtil("team-presentation.js", (id) => {
    if (id === "./team-registry.js") return registry;
    if (id === "./logo-registry.js") return logos;
    throw new Error(`Unexpected team-presentation require: ${id}`);
  });
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
    if (id === "../../services/matches.js") return { listMatches: listMatchesFn };
    if (id === "../../utils/rankings-copy.js") return copy;
    if (id === "../../utils/logo-registry.js") return logos;
    if (id === "../../utils/team-presentation.js") return presentation;
    if (id === "../../utils/prediction-history.js") return history;
    if (id === "../../utils/match-presentation.js") return matchPresentation;
    throw new Error(`Unexpected require: ${id}`);
  });
  return { page: instantiate(config), listMyPredictions: listMyPredictionsFn, listMatches: listMatchesFn, ...wxStub };
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
    expect(listMyPredictions).toHaveBeenNthCalledWith(1, { limit: 20 });
    expect(listMyPredictions).toHaveBeenNthCalledWith(2, { cursor: "page-2" });
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
