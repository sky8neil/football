import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const PAGE = new URL("./rankings.js", import.meta.url);
const WXML = new URL("./rankings.wxml", import.meta.url);
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

function rankingPayload() {
  return {
    statusCode: 200,
    data: {
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
      page: { has_more: false, next_cursor: null },
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function loadPage(serviceOverrides = {}, options = {}) {
  let definition;
  const services = {
    rankings: {
      listRankings: vi.fn(async () => rankingPayload()),
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
  const dependencies = {
    "../../services/rankings.js": services.rankings,
    "../../services/profile.js": services.profile,
    "../../services/levels.js": services.levels,
    "../../services/groups.js": services.groups,
    "../../utils/rankings-view-model.js": viewModel,
    "../../utils/ui-layout.js": { headerHeight: () => 88 },
    "../../utils/rankings-copy.js": copy,
    "../../utils/level-season.js": loadCommonJs(LEVEL_SEASON),
    "../../services/auth.js": {
      getLoginGeneration: options.getLoginGeneration || (() => 0),
    },
  };
  runInNewContext(readFileSync(PAGE, "utf8"), {
    Page: (value) => { definition = value; },
    require: (name) => dependencies[name],
    wx: {
      getStorageSync: () => undefined,
      setStorageSync: () => {},
      removeStorageSync: () => {},
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
  page.onLoad();
  return { page, services };
}

describe("ranking first-load rate limit retry", () => {
  it("keeps a retry action on the rate-limited first-load panel", () => {
    const wxml = readFileSync(WXML, "utf8");
    const errorBlock = wxml.match(/state !== 'list'[\s\S]*?(?=<block wx:else>)/)[0];
    expect(errorBlock).toContain('bindtap="onRetry"');
    expect(errorBlock).toMatch(/state === 'rateLimited'|state === \"rateLimited\"/);
  });

  it("lets the user retry after a first-load 429", async () => {
    const { page, services } = loadPage({
      rankings: {
        listRankings: vi.fn()
          .mockResolvedValueOnce({
            statusCode: 429,
            code: "RATE_LIMITED",
            message: "请求过于频繁，请稍后重试",
          })
          .mockResolvedValue(rankingPayload()),
      },
    });

    await page.loadFirstPage();

    expect(page.data.state).toBe("rateLimited");
    expect(page.data.items).toEqual([]);
    expect(page.data.errorMessage).toBe("请求过于频繁，请稍后重试");

    await page.onRetry();

    expect(page.data.state).toBe("list");
    expect(page.data.standingValue).toBe(12);
    expect(page.data.errorMessage).toBe("");
    expect(services.rankings.listRankings).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["groups", "listMyGroups", 401, "UNAUTHORIZED", "guest"],
    ["levels", "getMyLevels", 409, "USER_DELETED", "userDeleted"],
    ["rankings", "listRankings", 401, "UNAUTHORIZED", "guest"],
    ["rankings", "listRankings", 409, "USER_DELETED", "userDeleted"],
  ])("maps sub-request %s HTTP %s %s to state=%s", async (serviceKey, method, statusCode, code, expectedState) => {
    const { page } = loadPage({
      [serviceKey]: {
        [method]: vi.fn(async () => ({ statusCode, code, message: code })),
      },
    });
    await page.loadFirstPage();
    expect(page.data.state).toBe(expectedState);
  });

  it("keeps list items when pagination fails instead of clearing the page to error", async () => {
    const { page } = loadPage({
      rankings: {
        listRankings: vi.fn()
          .mockResolvedValueOnce({
            statusCode: 200,
            data: {
              ...rankingPayload().data,
              page: { has_more: true, next_cursor: "next-1" },
            },
          })
          .mockResolvedValueOnce({ statusCode: 500, code: "INTERNAL_ERROR", message: "boom" }),
      },
    });
    await page.loadFirstPage();
    expect(page.data.state).toBe("list");
    expect(page.data.items).toHaveLength(1);

    await page.onMore();
    expect(page.data.state).toBe("list");
    expect(page.data.items).toHaveLength(1);
    expect(page.data.loadingMore).toBe(false);
    expect(page.data.errorMessage).toBe("暂时无法读取排行榜数据，请稍后重试");
  });

  it("recovers from a rejected first page instead of staying loading", async () => {
    const { page } = loadPage({
      rankings: {
        listRankings: vi.fn(async () => {
          throw new Error("network");
        }),
      },
    });
    await page.loadFirstPage();
    expect(page.data.state).toBe("error");
    expect(page.data.loadingMore).toBe(false);
    expect(page.data.errorMessage).toBe("暂时无法读取排行榜数据，请稍后重试");
  });

  it("recovers loadingMore when a pagination request rejects", async () => {
    const listRankings = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 200,
        data: {
          ...rankingPayload().data,
          page: { has_more: true, next_cursor: "next-1" },
        },
      })
      .mockRejectedValueOnce(new Error("network"));
    const { page } = loadPage({ rankings: { listRankings } });
    await page.loadFirstPage();
    expect(page.data.state).toBe("list");

    await page.onMore();
    expect(page.data.state).toBe("list");
    expect(page.data.items).toHaveLength(1);
    expect(page.data.loadingMore).toBe(false);
    expect(page.data.errorMessage).toBe("暂时无法读取排行榜数据，请稍后重试");
  });

  it("resets nickname, user id, group scope and board when the login generation changes", async () => {
    let generation = 0;
    const pendingProfile = deferred();
    const { page } = loadPage({
      profile: {
        getMyProfile: vi.fn(() => pendingProfile.promise),
      },
    }, { getLoginGeneration: () => generation });
    page.setData({
      nickname: "旧用户",
      avatarText: "旧",
      currentUserId: "old-user",
      scope: "group",
      groupId: "group-1",
      board: "season",
      selectedLevelSeasonId: "2025_2026",
      selectedPeriodKey: "2026-W01",
      groups: [{ group_id: "group-1" }],
    });

    generation = 1;
    page.onShow();

    expect(page.data.nickname).toBe("");
    expect(page.data.avatarText).toBe("球");
    expect(page.data.currentUserId).toBe("");
    expect(page.data.scope).toBe("global");
    expect(page.data.groupId).toBeNull();
    expect(page.data.board).toBe("week");
    expect(page.data.selectedLevelSeasonId).toBeNull();
    expect(page.data.selectedPeriodKey).toBeNull();

    pendingProfile.resolve({
      statusCode: 200,
      data: { user_id: "user-new", nickname: "新用户" },
    });
    await vi.waitFor(() => expect(page.data.nickname).toBe("新用户"));
  });

  it("clears stale nickname and user id when the board falls back to guest", async () => {
    const { page } = loadPage({
      rankings: {
        listRankings: vi.fn(async () => ({ statusCode: 401, code: "UNAUTHORIZED" })),
      },
    });
    page.setData({ nickname: "旧用户", avatarText: "旧", currentUserId: "old-user" });

    await page.loadFirstPage();

    expect(page.data.state).toBe("guest");
    expect(page.data.nickname).toBe("");
    expect(page.data.avatarText).toBe("球");
    expect(page.data.currentUserId).toBe("");
  });
});
