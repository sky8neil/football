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

function loadPage(serviceOverrides = {}, { storage = new Map(), getLoginGeneration = () => 0 } = {}) {
  let definition;
  const services = {
    rankings: {
      listRankings: vi.fn(async (query) => weekResult({
        period_key: query.periodKey || "2026-W48",
        current_period_key: "2026-W48",
        first_period_key: "2026-W46",
      })),
    },
    profile: {
      getMyProfile: vi.fn(async () => ({
        statusCode: 200,
        data: { user_id: "user-1", nickname: "测试用户" },
      })),
    },
    levels: {
      getMyLevels: vi.fn(async () => ({
        statusCode: 200,
        data: { season: { valid_predictions: 4 } },
      })),
    },
    groups: {
      listMyGroups: vi.fn(async () => ({ statusCode: 200, data: { items: [] } })),
    },
    ...serviceOverrides,
  };
  runInNewContext(readFileSync(PAGE, "utf8"), {
    Page: (value) => { definition = value; },
    require: (name) => {
      if (name.includes("services/rankings.js")) return services.rankings;
      if (name.includes("services/profile.js")) return services.profile;
      if (name.includes("services/levels.js")) return services.levels;
      if (name.includes("services/groups.js")) return services.groups;
      if (name.includes("services/auth.js")) return { getLoginGeneration };
      if (name.includes("rankings-view-model")) return viewModel;
      if (name.includes("rankings-copy")) return copy;
      if (name.includes("ui-layout")) return { headerHeight: () => 88 };
      if (name.includes("level-season")) return { formatLevelSeasonLabel: () => "" };
      return {};
    },
    wx: {
      getStorageSync: (key) => storage.get(key),
      setStorageSync: (key, value) => { storage.set(key, value); },
      removeStorageSync: (key) => { storage.delete(key); },
    },
  });
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(patch, callback) {
      Object.assign(this.data, patch);
      if (callback) callback();
    },
  };
  page.setData({ board: "week" });
  return page;
}

function weekResult(data) {
  return {
    statusCode: 200,
    data: {
      board: "week",
      available_boards: ["week", "career", "strength"],
      entry_count: 1,
      me: { status: "ranked", rank: 1, period_score: 12, valid_predictions: 4, exact_hits: 1 },
      items: [{
        user_id: "user-1",
        rank: 1,
        display_name: "Player",
        favorite_team_id: null,
        career_level: 1,
        period_score: 12,
        valid_predictions: 4,
        exact_hits: 1,
      }],
      ...data,
    },
  };
}

describe("ranking week options from first_period_key", () => {
  it("prefers GET /v1/rankings first_period_key over the local config fallback", () => {
    const page = loadPage();
    page.applyListResult(weekResult({
      current_period_key: "2026-W47",
      period_key: "2026-W47",
      first_period_key: "2026-W45",
    }), true);
    expect(page.data.weekOptions.map((item) => item.key)).toEqual([
      "2026-W47",
      "2026-W46",
      "2026-W45",
    ]);
  });

  it("falls back to rankingFirstPeriodKey when the old payload omits first_period_key", () => {
    const page = loadPage();
    page.applyListResult(weekResult({
      current_period_key: "2026-W32",
      period_key: "2026-W32",
    }), true);
    expect(page.data.weekOptions.map((item) => item.key)).toEqual(["2026-W32", "2026-W31"]);
  });

  it("falls back when first_period_key is null or empty", () => {
    const missing = loadPage();
    missing.applyListResult(weekResult({
      current_period_key: "2026-W32",
      period_key: "2026-W32",
      first_period_key: null,
    }), true);
    const empty = loadPage();
    empty.applyListResult(weekResult({
      current_period_key: "2026-W32",
      period_key: "2026-W32",
      first_period_key: "",
    }), true);
    expect(missing.data.weekOptions.map((item) => item.key)).toEqual(["2026-W32", "2026-W31"]);
    expect(empty.data.weekOptions.map((item) => item.key)).toEqual(["2026-W32", "2026-W31"]);
  });

  it("keeps ISO weeks across a year boundary from the payload first_period_key", () => {
    const page = loadPage();
    page.applyListResult(weekResult({
      current_period_key: "2027-W02",
      period_key: "2027-W02",
      first_period_key: "2026-W53",
    }), true);
    expect(page.data.weekOptions.map((item) => item.key)).toEqual([
      "2027-W02",
      "2027-W01",
      "2026-W53",
    ]);
    expect(page.data.weekOptionLabels[0]).toBe("本周");
  });

  it("passes the latest default week instead of a pinned key on onShow", async () => {
    const listRankings = vi.fn(async (query) => weekResult({
      period_key: query.periodKey || "2026-W48",
      current_period_key: "2026-W48",
      first_period_key: "2026-W46",
    }));
    const page = loadPage({ rankings: { listRankings } });
    page.onLoad();
    await page.onShow();
    expect(page.data.selectedPeriodKey).toBe("2026-W48");

    await page.onShow();
    expect(listRankings).toHaveBeenLastCalledWith(expect.objectContaining({
      periodKey: null,
    }));
  });

  it("keeps an explicitly selected historical week across onShow", async () => {
    const listRankings = vi.fn(async (query) => weekResult({
      period_key: query.periodKey || "2026-W48",
      current_period_key: "2026-W48",
      first_period_key: "2026-W46",
    }));
    const page = loadPage({ rankings: { listRankings } });
    page.onLoad();
    await page.onShow();
    await page.onWeekChange({ detail: { value: "1" } });
    expect(page.data.selectedPeriodKey).toBe("2026-W47");
    expect(page.userSelectedWeek).toBe(true);
    await page.onShow();
    expect(listRankings).toHaveBeenLastCalledWith(expect.objectContaining({
      periodKey: "2026-W47",
    }));
  });

  it("clears a stale selected week and retries after a 422", async () => {
    const listRankings = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 422,
        code: "VALIDATION_ERROR",
        message: "period_key 超出窗口",
      })
      .mockImplementation(async (query) => weekResult({
        period_key: query.periodKey || "2026-W48",
        current_period_key: "2026-W48",
        first_period_key: "2026-W46",
      }));
    const page = loadPage({ rankings: { listRankings } });
    page.onLoad();
    page.setData({ selectedPeriodKey: "2026-W01" });
    page.userSelectedWeek = true;
    await page.loadFirstPage();
    expect(page.data.state).toBe("validationError");

    await page.onRetry();
    expect(page.data.state).toBe("list");
    expect(listRankings).toHaveBeenLastCalledWith(expect.objectContaining({
      periodKey: null,
    }));
  });
});

describe("ranking login generation reset", () => {
  it("clears the old group name and selection before a pending group profile failure", async () => {
    let generation = 0;
    const storage = new Map([["pending_ranking_group_id", "group-new"]]);
    const getMyProfile = vi.fn(async () => ({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "读取个人资料失败",
    }));
    const page = loadPage(
      { profile: { getMyProfile } },
      { storage, getLoginGeneration: () => generation },
    );
    page.onLoad();
    page.setData({
      scope: "group",
      groupId: "group-old-b",
      groups: [
        { group_id: "group-old-a", display_name: "旧账号群 A" },
        { group_id: "group-old-b", display_name: "旧账号群 B" },
      ],
      groupNames: ["旧账号群 A", "旧账号群 B"],
      selectedGroupIndex: 1,
    });
    generation = 1;

    await page.onShow();
    await vi.waitFor(() => expect(page.data.state).toBe("error"));

    expect(getMyProfile).toHaveBeenCalledTimes(1);
    expect(page.data.groups).toEqual([]);
    expect(page.data.groupNames).toEqual([]);
    expect(page.data.selectedGroupIndex).toBe(0);
    expect(page.data.scope).toBe("group");
    expect(page.data.groupId).toBe("group-new");
    expect(storage.has("pending_ranking_group_id")).toBe(false);
  });
});
