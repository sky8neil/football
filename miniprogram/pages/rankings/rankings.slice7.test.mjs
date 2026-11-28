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

function loadPage(serviceOverrides = {}, { getLoginGeneration = () => 0 } = {}) {
  let definition;
  const navs = [];
  const storage = new Map();
  const services = {
    rankings: {
      listRankings: vi.fn(async () => ({
        statusCode: 200,
        data: {
          available_boards: ["week", "career", "strength"],
          entry_count: 0,
          items: [],
          page: { has_more: false, next_cursor: null },
        },
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
  runInNewContext(readFileSync(PAGE, "utf8"), {
    Page: (value) => { definition = value; },
    require: (name) => dependencies[name],
    wx: {
      navigateTo: (options) => navs.push(["navigateTo", options.url]),
      switchTab: (options) => navs.push(["switchTab", options.url]),
      getStorageSync: (key) => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: (key) => storage.delete(key),
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
  return { page, services, navs };
}

function entry(rank, name = `Player${rank}`) {
  return {
    user_id: `user-${rank}`,
    rank,
    display_name: name,
    favorite_team_id: null,
    career_level: 2,
    period_score: 100 - rank,
    valid_predictions: 10,
    exact_hits: 1,
  };
}

describe("rankings slice 7 fixes", () => {
  it("[A-S5-06] binds view.listTitle and listItems in WXML and hides list card when only podium exists", () => {
    const wxml = readFileSync(WXML, "utf8");
    expect(wxml).toContain("{{view.listTitle}}");
    expect(wxml).not.toContain("{{scope === 'group' ? '群内' : '全站'}}前 20");
    expect(wxml).toContain('wx:for="{{listItems}}"');
    expect(wxml).not.toContain('wx:for="{{items}}"');
    expect(wxml).toMatch(/wx:if="\{\{entryCount > 0 && listItems\.length > 0\}\}"[^>]*class="card rank-list"/);

    const { page } = loadPage();
    page.applyListResult({
      statusCode: 200,
      data: {
        available_boards: ["week"],
        entry_count: 3,
        items: [entry(1), entry(2), entry(3)],
      },
    }, true);
    expect(page.data.view.showPodium).toBe(true);
    expect(page.data.view.listTitle).toBe("全部 3 位预言家");
    expect(page.data.podiumItems).toHaveLength(3);
    expect(page.data.listItems).toEqual([]);

    page.applyListResult({
      statusCode: 200,
      data: {
        available_boards: ["week"],
        entry_count: 5,
        items: [entry(1), entry(2), entry(3), entry(4), entry(5)],
      },
    }, true);
    expect(page.data.view.listTitle).toBe("全部 5 位预言家");
    expect(page.data.listItems.map((item) => item.rank)).toEqual([4, 5]);
  });

  it("[D-S5-03] removes 已封榜 and 结算中 copy from rankings WXML", () => {
    const wxml = readFileSync(WXML, "utf8");
    expect(wxml).not.toContain("已封榜");
    expect(wxml).not.toContain("结算中");
    expect(wxml).toContain("{{selectedWeekIndex ? '历史周' : '预测进行中'}}");
  });

  it("[D-S5-04] renders guestBars blurred placeholder and hides welcome/tabs in guest state", () => {
    const wxml = readFileSync(WXML, "utf8");
    expect(wxml).toMatch(/wx:if="\{\{state !== 'guest'\}\}"[^>]*class="welcome"/);
    expect(wxml).toMatch(/wx:if="\{\{state !== 'guest'\}\}"[^>]*class="board-tabs"/);
    expect(wxml).toContain('wx:for="{{guestBars}}"');
    expect(wxml).toContain("{{guestText}}");
    expect(wxml).toContain('bindtap="onLoginTap"');

    const { page } = loadPage({
      profile: { getMyProfile: vi.fn(async () => ({ statusCode: 401, code: "UNAUTHORIZED" })) },
    });
    return page.loadFirstPage().then(() => {
      expect(page.data.state).toBe("guest");
      expect(page.data.guestBars).toHaveLength(4);
      expect(page.data.guestText).toBe("请登录查看榜单");
    });
  });

  it("[A-S5-10] keeps explicitly chosen current week across onShow and onRetry on Mondays", async () => {
    const listRankings = vi.fn(async (query) => ({
      statusCode: 200,
      data: {
        board: "week",
        available_boards: ["week"],
        current_period_key: "2026-W48",
        period_key: query.periodKey || "2026-W47",
        first_period_key: "2026-W46",
        entry_count: 1,
        items: [entry(1)],
        me: { status: "ranked", rank: 1, period_score: 10, valid_predictions: 1, exact_hits: 0 },
        page: { has_more: false, next_cursor: null },
      },
    }));
    const { page } = loadPage({ rankings: { listRankings } });

    await page.onShow();
    expect(page.data.selectedPeriodKey).toBe("2026-W47");
    expect(page.data.selectedWeekIndex).toBe(1);

    await page.onWeekChange({ detail: { value: "0" } });
    expect(page.userSelectedWeek).toBe(true);
    expect(page.data.selectedPeriodKey).toBe("2026-W48");
    expect(page.data.selectedWeekIndex).toBe(0);

    await page.onShow();
    expect(listRankings).toHaveBeenLastCalledWith(expect.objectContaining({
      periodKey: "2026-W48",
    }));

    await page.onRetry();
    expect(listRankings).toHaveBeenLastCalledWith(expect.objectContaining({
      periodKey: "2026-W48",
    }));
  });

  it("[A-S5-14(1)] precomputes code-point-safe avatarInitial for non-BMP emojis", () => {
    const wxml = readFileSync(WXML, "utf8");
    expect(wxml).not.toContain("display_name[0]");
    expect(wxml).toContain("{{item.avatarInitial}}");

    const { page } = loadPage();
    page.applyListResult({
      statusCode: 200,
      data: {
        available_boards: ["week"],
        entry_count: 4,
        items: [
          entry(1, "🏆冠军"),
          entry(2, "⚽️球王"),
          entry(3, ""),
          entry(4, "🐉龙哥"),
        ],
      },
    }, true);
    expect(page.data.podiumItems.map((item) => item.avatarInitial)).toEqual(["🏆", "⚽", ""]);
    expect(page.data.listItems.map((item) => item.avatarInitial)).toEqual(["🐉"]);
  });

  it("[A-S6-01] navigates to public-profile when tapping podium or list rows in global or group scope", () => {
    const wxml = readFileSync(WXML, "utf8");
    expect(wxml).toMatch(/class="podium-person[^"]*"[^>]*data-user-id="\{\{item\.user_id\}\}"[^>]*bindtap="onUserTap"/);
    expect(wxml).toMatch(/class="rank-row[^"]*"[^>]*data-user-id="\{\{item\.user_id\}\}"[^>]*bindtap="onUserTap"/);

    const { page, navs } = loadPage();
    page.setData({ scope: "global" });
    page.onUserTap({ currentTarget: { dataset: { userId: "user-123" } } });
    page.setData({ scope: "group", groupId: "group-1" });
    page.onUserTap({ currentTarget: { dataset: { userId: "user-456" } } });

    expect(navs).toEqual([
      ["navigateTo", "/pages/public-profile/public-profile?user_id=user-123"],
      ["navigateTo", "/pages/public-profile/public-profile?user_id=user-456"],
    ]);
  });

  it("[CR50-10] resets grouped derived fields on loginGeneration switch even when new account load fails", async () => {
    let generation = 0;
    const getMyProfile = vi.fn()
      .mockResolvedValueOnce({ statusCode: 200, data: { user_id: "user-a", nickname: "账号A" } })
      .mockResolvedValueOnce({ statusCode: 500, code: "INTERNAL_ERROR", message: "服务异常" });
    const listRankings = vi.fn(async () => ({
      statusCode: 200,
      data: {
        board: "season",
        available_boards: ["week", "season"],
        available_level_seasons: ["2024_2025", "2025_2026"],
        level_season_id: "2024_2025",
        current_level_season_id: "2025_2026",
        server_now: "2025-10-01T00:00:00Z",
        entry_count: 4,
        items: [entry(1), entry(2), entry(3), entry(4)],
        me: { status: "ranked", rank: 1, season_points: 30, season_valid_predictions: 10, exact_hits: 2 },
        page: { has_more: true, next_cursor: "cursor-a" },
      },
    }));
    const { page } = loadPage({
      profile: { getMyProfile },
      rankings: { listRankings },
    }, { getLoginGeneration: () => generation });

    page.setData({ board: "season", selectedLevelSeasonId: "2024_2025", scopeSheetOpen: true });
    await page.onShow();
    expect(page.data.showGroupScope).toBe(false);
    expect(page.data.showSeasonBoard).toBe(true);
    expect(page.data.showCareerBoard).toBe(false);
    expect(page.data.showStrengthBoard).toBe(false);
    expect(page.data.podiumItems).toHaveLength(3);
    expect(page.data.listItems).toHaveLength(1);
    expect(page.data.entryCount).toBe(4);

    // Switch to account B whose initial load fails
    generation = 1;
    page.setData({ scopeSheetOpen: true });
    await page.onShow();

    expect(page.data.state).toBe("error");
    expect(page.data.scopeSheetOpen).toBe(false);
    expect(page.data.showGroupScope).toBe(true);
    expect(page.data.availableBoards).toEqual(["week", "career", "strength"]);
    expect(page.data.showCareerBoard).toBe(true);
    expect(page.data.showStrengthBoard).toBe(true);
    expect(page.data.showSeasonBoard).toBe(false);
    expect(page.data.weekOptions).toEqual([]);
    expect(page.data.weekOptionLabels).toEqual([]);
    expect(page.data.selectedWeekIndex).toBe(0);
    expect(page.data.availableLevelSeasons).toEqual([]);
    expect(page.data.seasonOptionLabels).toEqual([]);
    expect(page.data.selectedSeasonLabel).toBe("");
    expect(page.data.selectedSeasonIndex).toBe(0);
    expect(page.data.currentLevelSeasonId).toBeNull();
    expect(page.data.showHistorySeasonEntry).toBe(false);
    expect(page.data.view).toEqual({});
    expect(page.data.items).toEqual([]);
    expect(page.data.listItems).toEqual([]);
    expect(page.data.podiumItems).toEqual([]);
    expect(page.data.entryCount).toBe(0);
    expect(page.data.me).toBeNull();
  });

  it("[CR50-10] drops in-flight profile, rankings, and pagination responses after loginGeneration changes before onShow", async () => {
    const deferred = () => {
      let resolve;
      let reject;
      const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
      return { promise, resolve, reject };
    };

    // 1) In-flight profile response arrives after generation changes (without onShow)
    let gen1 = 0;
    const profileReq = deferred();
    const first = loadPage({
      profile: { getMyProfile: vi.fn(() => profileReq.promise) },
    }, { getLoginGeneration: () => gen1 });
    const p1 = first.page.loadFirstPage();
    gen1 = 1;
    profileReq.resolve({ statusCode: 200, data: { user_id: "user-old", nickname: "旧账号" } });
    await p1;
    expect(first.page.data.nickname).toBe("");
    expect(first.page.data.currentUserId).toBe("");
    expect(first.page.data.state).toBe("loading");

    // 2) In-flight rankings response arrives after generation changes (without onShow)
    let gen2 = 0;
    const rankingsReq = deferred();
    const second = loadPage({
      profile: { getMyProfile: vi.fn(async () => ({ statusCode: 200, data: { user_id: "user-a", nickname: "账号A" } })) },
      rankings: { listRankings: vi.fn(() => rankingsReq.promise) },
    }, { getLoginGeneration: () => gen2 });
    const p2 = second.page.loadFirstPage();
    await vi.waitFor(() => expect(second.services.rankings.listRankings).toHaveBeenCalledTimes(1));
    gen2 = 1;
    rankingsReq.resolve({
      statusCode: 200,
      data: {
        available_boards: ["week"],
        entry_count: 1,
        items: [entry(1, "StaleWinner")],
        page: { has_more: false, next_cursor: null },
      },
    });
    await p2;
    expect(second.page.data.items).toEqual([]);
    expect(second.page.data.state).toBe("loading");

    // 3) In-flight pagination response arrives after generation changes (without onShow)
    let gen3 = 0;
    const moreReq = deferred();
    const listRankings3 = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 200,
        data: {
          available_boards: ["week"],
          entry_count: 2,
          items: [entry(1, "Page1")],
          page: { has_more: true, next_cursor: "c2" },
        },
      })
      .mockImplementationOnce(() => moreReq.promise);
    const third = loadPage({
      rankings: { listRankings: listRankings3 },
    }, { getLoginGeneration: () => gen3 });
    await third.page.loadFirstPage();
    expect(third.page.data.items.map((item) => item.display_name)).toEqual(["Page1"]);

    const pMore = third.page.onMore();
    gen3 = 1;
    moreReq.resolve({
      statusCode: 200,
      data: {
        available_boards: ["week"],
        entry_count: 2,
        items: [entry(2, "StalePage2")],
        page: { has_more: false, next_cursor: null },
      },
    });
    await pMore;
    expect(third.page.data.items.map((item) => item.display_name)).toEqual(["Page1"]);
  });
});
