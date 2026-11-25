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

function loadPage(serviceOverrides = {}) {
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
    "../../services/auth.js": { getLoginGeneration: () => 0 },
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
});
