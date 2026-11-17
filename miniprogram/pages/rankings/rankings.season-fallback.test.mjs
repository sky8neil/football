import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const PAGE = new URL("./rankings.js", import.meta.url);
const CONFIG = new URL("../../config.js", import.meta.url);
const COPY = new URL("../../utils/rankings-copy.js", import.meta.url);
const MODEL = new URL("../../utils/rankings-view-model.js", import.meta.url);

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

function loadPage() {
  let definition;
  const services = {
    rankings: { listRankings: vi.fn(async () => ({ statusCode: 200, data: {} })) },
    profile: { getMyProfile: vi.fn() },
    levels: { getMyLevels: vi.fn() },
    groups: { listMyGroups: vi.fn() },
  };
  const dependencies = {
    "../../services/rankings.js": services.rankings,
    "../../services/profile.js": services.profile,
    "../../services/levels.js": services.levels,
    "../../services/groups.js": services.groups,
    "../../utils/rankings-view-model.js": viewModel,
    "../../utils/ui-layout.js": { headerHeight: () => 88 },
    "../../utils/rankings-copy.js": copy,
  };
  runInNewContext(readFileSync(PAGE, "utf8"), {
    Page: (value) => { definition = value; },
    require: (name) => dependencies[name],
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
  page.loadFirstPage = vi.fn(() => page.fetchRankings(true));
  page.setData({ board: "season", scope: "global" });
  return { page, services };
}

function seasonPayload({
  levelSeasonId = "2026_2027",
  availableLevelSeasons = ["2025_2026", "2024_2025"],
  items = [],
} = {}) {
  return {
    server_now: "2026-08-20T00:00:00.000Z",
    level_season_id: levelSeasonId,
    available_level_seasons: availableLevelSeasons,
    available_boards: ["week", "season"],
    entry_count: items.length,
    items,
    page: { has_more: false, next_cursor: null },
  };
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
