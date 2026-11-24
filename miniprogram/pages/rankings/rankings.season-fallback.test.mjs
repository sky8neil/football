import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const PAGE = new URL("./rankings.js", import.meta.url);
const CONFIG = new URL("../../config.js", import.meta.url);
const COPY = new URL("../../utils/rankings-copy.js", import.meta.url);
const MODEL = new URL("../../utils/rankings-view-model.js", import.meta.url);
const LEVEL_SEASON = new URL("../../utils/level-season.js", import.meta.url);

function loadCommonJs(url, dependencies = {}) {
  const module = { exports: {} };
  runInNewContext(readFileSync(url, "utf8"), {
    module,
    exports: module.exports,
    require: (name) => dependencies[name],
  });
  return module.exports;
}

const copy = loadCommonJs(COPY);
const viewModel = loadCommonJs(MODEL, {
  "../config.js": loadCommonJs(CONFIG),
  "./rankings-copy.js": copy,
});

function loadPage({
  mockFirstPage = true,
  storage = new Map(),
  serviceOverrides = {},
  getLoginGeneration = () => 0,
} = {}) {
  let definition;
  const services = {
    rankings: { listRankings: vi.fn(async () => ({ statusCode: 200, data: {} })) },
    profile: { getMyProfile: vi.fn() },
    levels: { getMyLevels: vi.fn() },
    groups: { listMyGroups: vi.fn() },
    ...serviceOverrides,
  };
  const dependencies = {
    "../../services/rankings.js": services.rankings,
    "../../services/profile.js": services.profile,
    "../../services/levels.js": services.levels,
    "../../services/groups.js": services.groups,
    "../../utils/rankings-view-model.js": viewModel,
    "../../utils/ui-layout.js": { headerHeight: () => 88 },
    "../../utils/rankings-copy.js": copy,
    "../../utils/level-season.js": loadCommonJs(LEVEL_SEASON),
    "../../services/auth.js": { getLoginGeneration },
  };
  const wx = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => { storage.set(key, value); },
    removeStorageSync: (key) => { storage.delete(key); },
  };
  runInNewContext(readFileSync(PAGE, "utf8"), {
    Page: (value) => { definition = value; },
    require: (name) => dependencies[name],
    wx,
  });
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(patch, callback) {
      Object.assign(this.data, patch);
      if (callback) callback();
    },
  };
  page.onLoad();
  if (mockFirstPage) page.loadFirstPage = vi.fn(() => page.fetchRankings(true));
  page.setData({ board: "season", scope: "global" });
  return { page, services, storage };
}

function seasonPayload({
  levelSeasonId = "2026_2027",
  availableLevelSeasons = ["2025_2026", "2024_2025"],
  items = [],
  availableBoards = ["week", "season"],
} = {}) {
  return {
    server_now: "2026-08-20T00:00:00.000Z",
    level_season_id: levelSeasonId,
    available_level_seasons: availableLevelSeasons,
    available_boards: availableBoards,
    entry_count: items.length,
    items,
    page: { has_more: false, next_cursor: null },
  };
}

function weekPayload() {
  return {
    server_now: "2026-08-20T00:00:00.000Z",
    period_key: "2026-W34",
    first_period_key: "2026-W34",
    available_boards: ["week"],
    available_level_seasons: ["2025_2026", "2024_2025", "2026_2027"],
    entry_count: 0,
    items: [],
    me: { status: "not_participated" },
    page: { has_more: false, next_cursor: null },
  };
}

function loadFullPage({ storage = new Map(), rankings, getLoginGeneration } = {}) {
  return loadPage({
    mockFirstPage: false,
    storage,
    getLoginGeneration,
    serviceOverrides: {
      rankings: rankings || { listRankings: vi.fn(async () => ({ statusCode: 200, data: seasonPayload() })) },
      profile: { getMyProfile: vi.fn(async () => ({ statusCode: 200, data: { user_id: "user-1", nickname: "玩家" } })) },
      levels: { getMyLevels: vi.fn(async () => ({ statusCode: 200, data: { season: { valid_predictions: 3 } } })) },
      groups: { listMyGroups: vi.fn(async () => ({ statusCode: 200, data: { items: [] } })) },
    },
  });
}

describe("ranking season empty-board fallback", () => {
  it("requests the nearest earlier season after an empty current-season first page", () => {
    const { page, services } = loadPage();

    page.applyListResult({ statusCode: 200, data: seasonPayload() }, true);

    expect(page.autoSeasonFallback).toBe(true);
    expect(page.data.availableLevelSeasons).toEqual(["2025_2026", "2024_2025", "2026_2027"]);
    expect(page.data.selectedLevelSeasonId).toBe("2025_2026");
    expect(page.data.selectedSeasonIndex).toBe(0);
    expect(page.loadFirstPage).toHaveBeenCalledOnce();
    expect(services.rankings.listRankings).toHaveBeenCalledWith(expect.objectContaining({
      board: "season",
      levelSeasonId: "2025_2026",
      cursor: null,
    }));
  });

  it("keeps the empty current season available for a manual switch back", () => {
    const { page, services } = loadPage();

    page.applyListResult({ statusCode: 200, data: seasonPayload() }, true);
    page.onSeasonChange({ detail: { value: "2" } });

    expect(page.userChangedSeason).toBe(true);
    expect(page.data.selectedLevelSeasonId).toBe("2026_2027");
    expect(services.rankings.listRankings).toHaveBeenLastCalledWith(expect.objectContaining({
      board: "season",
      levelSeasonId: "2026_2027",
      cursor: null,
    }));
  });

  it("does not fall back after the user manually chooses a season", () => {
    const { page, services } = loadPage();
    page.setData({
      availableLevelSeasons: ["2026_2027", "2025_2026"],
      selectedLevelSeasonId: "2026_2027",
      currentLevelSeasonId: "2026_2027",
    });
    page.onSeasonChange({ detail: { value: "0" } });

    page.applyListResult({
      statusCode: 200,
      data: seasonPayload({ availableLevelSeasons: ["2026_2027", "2025_2026"] }),
    }, true);

    expect(page.userChangedSeason).toBe(true);
    expect(page.autoSeasonFallback).toBe(false);
    expect(page.data.selectedLevelSeasonId).toBe("2026_2027");
    expect(services.rankings.listRankings).not.toHaveBeenCalled();
  });

  it("keeps the current season selected when its first page has data", () => {
    const { page, services } = loadPage();

    page.applyListResult({
      statusCode: 200,
      data: seasonPayload({
        availableLevelSeasons: ["2026_2027", "2025_2026"],
        items: [{
          user_id: "user-1",
          rank: 1,
          display_name: "Player",
          favorite_team_id: null,
          career_level: 1,
          season_points: 24,
          season_valid_predictions: 12,
        }],
      }),
    }, true);

    expect(page.autoSeasonFallback).toBe(false);
    expect(page.data.selectedLevelSeasonId).toBe("2026_2027");
    expect(page.data.items).toHaveLength(1);
    expect(services.rankings.listRankings).not.toHaveBeenCalled();
  });

  it("stays empty without repeating the fallback when the earlier season is empty", () => {
    const { page, services } = loadPage();

    page.applyListResult({ statusCode: 200, data: seasonPayload() }, true);
    page.applyListResult({
      statusCode: 200,
      data: seasonPayload({
        levelSeasonId: "2025_2026",
        availableLevelSeasons: ["2025_2026", "2024_2025"],
      }),
    }, true);

    expect(page.autoSeasonFallback).toBe(true);
    expect(page.data.selectedLevelSeasonId).toBe("2025_2026");
    expect(page.data.items).toEqual([]);
    expect(page.loadFirstPage).toHaveBeenCalledOnce();
    expect(services.rankings.listRankings).toHaveBeenCalledOnce();
  });

  it("does not fall back when the empty board is a group-scope board", () => {
    const { page, services } = loadPage();
    page.setData({ scope: "group", groupId: "group-1" });

    page.applyListResult({ statusCode: 200, data: seasonPayload() }, true);

    expect(page.autoSeasonFallback).toBe(false);
    expect(page.data.scope).toBe("group");
    expect(page.data.selectedLevelSeasonId).toBe("2026_2027");
    expect(page.loadFirstPage).not.toHaveBeenCalled();
    expect(services.rankings.listRankings).not.toHaveBeenCalled();
  });

  it("does not fall back when the request fails", () => {
    const { page, services } = loadPage();

    page.applyListResult({ statusCode: 500, code: "INTERNAL_ERROR", message: "boom" }, true);

    expect(page.autoSeasonFallback).toBe(false);
    expect(page.data.selectedLevelSeasonId).toBe(null);
    expect(page.data.state).toBe("error");
    expect(page.loadFirstPage).not.toHaveBeenCalled();
    expect(services.rankings.listRankings).not.toHaveBeenCalled();
  });

  it("does not fall back for a paginated response", () => {
    const { page, services } = loadPage();
    page.setData({
      availableLevelSeasons: ["2025_2026", "2024_2025"],
      selectedLevelSeasonId: "2026_2027",
      currentLevelSeasonId: "2026_2027",
    });

    page.applyListResult({ statusCode: 200, data: seasonPayload() }, false);

    expect(page.autoSeasonFallback).toBe(false);
    expect(page.data.selectedLevelSeasonId).toBe("2026_2027");
    expect(page.loadFirstPage).not.toHaveBeenCalled();
    expect(services.rankings.listRankings).not.toHaveBeenCalled();
  });
});

describe("pending ranking target navigation", () => {
  it("opens the target season board for an eligible user", async () => {
    const storage = new Map([["pending_ranking_target", { board: "season", levelSeasonId: "2026_2027" }]]);
    const rankings = {
      listRankings: vi.fn(async () => ({
        statusCode: 200,
        data: seasonPayload({
          items: [{
            user_id: "user-1",
            rank: 1,
            display_name: "玩家",
            favorite_team_id: null,
            career_level: 1,
            season_points: 24,
            season_valid_predictions: 12,
            exact_hits: 2,
          }],
        }),
      })),
    };
    const { page, services } = loadFullPage({ storage, rankings });

    page.onShow();
    await vi.waitFor(() => expect(page.data.state).toBe("list"));

    expect(storage.has("pending_ranking_target")).toBe(false);
    expect(page.data.board).toBe("season");
    expect(page.data.scope).toBe("global");
    expect(page.data.groupId).toBeNull();
    expect(page.data.selectedLevelSeasonId).toBe("2026_2027");
    expect(page.explicitTargetSeasonId).toBe("2026_2027");
    expect(page.userChangedSeason).toBe(false);
    expect(page.autoSeasonFallback).toBe(false);
    expect(page.userSelectedWeek).toBe(false);
    expect(services.rankings.listRankings).toHaveBeenCalledWith(expect.objectContaining({
      board: "season",
      scope: "global",
      groupId: null,
      levelSeasonId: "2026_2027",
      cursor: null,
    }));
  });

  it("falls back to the week board when the user has no season board access", async () => {
    const storage = new Map([["pending_ranking_target", { board: "season", levelSeasonId: "2026_2027" }]]);
    const rankings = {
      listRankings: vi.fn()
        .mockResolvedValueOnce({
          statusCode: 200,
          data: seasonPayload({ availableBoards: ["week"] }),
        })
        .mockResolvedValue({ statusCode: 200, data: weekPayload() }),
    };
    const { page, services } = loadFullPage({ storage, rankings });

    page.onShow();
    await vi.waitFor(() => expect(page.data.state).toBe("list"));

    expect(storage.has("pending_ranking_target")).toBe(false);
    expect(page.data.board).toBe("week");
    expect(page.data.scope).toBe("global");
    expect(page.explicitTargetSeasonId).toBeNull();
    expect(page.data.showSeasonBoard).toBe(false);
    expect(services.rankings.listRankings).toHaveBeenLastCalledWith(expect.objectContaining({
      board: "week",
      scope: "global",
      levelSeasonId: null,
    }));
  });

  it("keeps an explicit target season empty instead of falling back to the previous season", () => {
    const { page, services } = loadPage();
    page.explicitTargetSeasonId = "2026_2027";
    page.setData({
      board: "season",
      scope: "global",
      selectedLevelSeasonId: "2026_2027",
      currentLevelSeasonId: "2026_2027",
      availableLevelSeasons: ["2026_2027", "2025_2026"],
    });

    page.applyListResult({
      statusCode: 200,
      data: seasonPayload({ levelSeasonId: "2026_2027" }),
    }, true);

    expect(page.autoSeasonFallback).toBe(false);
    expect(page.data.selectedLevelSeasonId).toBe("2026_2027");
    expect(page.data.items).toEqual([]);
    expect(page.loadFirstPage).not.toHaveBeenCalled();
    expect(services.rankings.listRankings).not.toHaveBeenCalled();
  });

  it("clears the explicit target on manual board, season, scope, or account changes", () => {
    const { page } = loadPage();
    page.setData({
      board: "season",
      scope: "global",
      selectedLevelSeasonId: "2026_2027",
      currentLevelSeasonId: "2026_2027",
      availableLevelSeasons: ["2026_2027", "2025_2026"],
      availableBoards: ["week", "season"],
      selectedSeasonIndex: 0,
      groups: [{ group_id: "group-1", display_name: "群一" }],
      selectedGroupIndex: 0,
    });

    page.explicitTargetSeasonId = "2026_2027";
    page.onSeasonChange({ detail: { value: "1" } });
    expect(page.explicitTargetSeasonId).toBeNull();

    page.explicitTargetSeasonId = "2026_2027";
    page.onBoardTap({ currentTarget: { dataset: { board: "week" } } });
    expect(page.explicitTargetSeasonId).toBeNull();

    page.setData({ board: "season", selectedLevelSeasonId: "2026_2027" });
    page.explicitTargetSeasonId = "2026_2027";
    page.onScopeTap({ currentTarget: { dataset: { scope: "group" } } });
    expect(page.explicitTargetSeasonId).toBeNull();

    page.explicitTargetSeasonId = "2026_2027";
    page.resetLoginGeneration();
    expect(page.explicitTargetSeasonId).toBeNull();
  });

  it("keeps the new account's pending season target after a login-generation switch", async () => {
    let generation = 1;
    const storage = new Map();
    const rankings = {
      listRankings: vi.fn(async (query) => {
        if (query.board === "season") {
          return {
            statusCode: 200,
            data: seasonPayload({
              levelSeasonId: "2026_2027",
              availableLevelSeasons: ["2025_2026", "2024_2025"],
              availableBoards: ["week", "season"],
            }),
          };
        }
        return { statusCode: 200, data: weekPayload() };
      }),
    };
    const { page, services } = loadFullPage({
      storage,
      rankings,
      getLoginGeneration: () => generation,
    });
    page.explicitTargetSeasonId = "2025_2026";
    page.setData({ board: "season", selectedLevelSeasonId: "2025_2026" });

    generation = 2;
    storage.set("pending_ranking_target", {
      board: "season",
      levelSeasonId: "2026_2027",
    });
    page.onShow();
    await vi.waitFor(() => expect(page.data.state).toBe("list"));

    expect(storage.has("pending_ranking_target")).toBe(false);
    expect(page.data.board).toBe("season");
    expect(page.data.scope).toBe("global");
    expect(page.data.selectedLevelSeasonId).toBe("2026_2027");
    expect(page.data.items).toEqual([]);
    expect(page.explicitTargetSeasonId).toBe("2026_2027");
    expect(page.autoSeasonFallback).toBe(false);
    expect(services.rankings.listRankings).toHaveBeenCalledTimes(1);
    expect(services.rankings.listRankings).toHaveBeenCalledWith(expect.objectContaining({
      board: "season",
      scope: "global",
      groupId: null,
      levelSeasonId: "2026_2027",
      cursor: null,
    }));
    expect(services.rankings.listRankings).not.toHaveBeenCalledWith(expect.objectContaining({
      levelSeasonId: "2025_2026",
    }));
  });

  it("lets pending group navigation win over a pending season target", () => {
    const storage = new Map([
      ["pending_ranking_group_id", "group-1"],
      ["pending_ranking_target", { board: "season", levelSeasonId: "2026_2027" }],
    ]);
    const { page } = loadPage({ storage });
    page.explicitTargetSeasonId = "2026_2027";

    page.onShow();

    expect(storage.has("pending_ranking_group_id")).toBe(false);
    expect(storage.has("pending_ranking_target")).toBe(false);
    expect(page.data.scope).toBe("group");
    expect(page.data.groupId).toBe("group-1");
    expect(page.data.board).toBe("week");
    expect(page.explicitTargetSeasonId).toBeNull();
  });
});
