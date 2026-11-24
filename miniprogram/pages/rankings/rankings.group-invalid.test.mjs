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

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function rankingPayload(overrides = {}) {
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
      ...overrides,
    },
  };
}

function loadPage(serviceOverrides = {}, { delaySetDataCallbacks = false, storage = new Map() } = {}) {
  let definition;
  const delayedSetData = [];
  const wx = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => { storage.set(key, value); },
    removeStorageSync: (key) => { storage.delete(key); },
  };
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
    "../../services/auth.js": { getLoginGeneration: () => 0 },
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
      if (!callback) return;
      if (delaySetDataCallbacks) {
        delayedSetData.push(callback.bind(this));
        return;
      }
      callback();
    },
    flushSetData() {
      const queued = delayedSetData.splice(0, delayedSetData.length);
      for (const callback of queued) callback();
    },
    flushNextSetData() {
      const callback = delayedSetData.shift();
      if (callback) callback();
    },
    flushLastSetData() {
      const callback = delayedSetData.pop();
      if (callback) callback();
    },
    pendingSetDataCount() {
      return delayedSetData.length;
    },
  };
  page.onLoad();
  return { page, services, storage };
}

describe("ranking invalid group recovery", () => {
  it("shows 切回全站榜 on the error panel without replacing retry", () => {
    const wxml = readFileSync(WXML, "utf8");
    const errorBlock = wxml.match(/state !== 'list'[\s\S]*?(?=<block wx:else>)/)[0];
    expect(errorBlock).toContain('bindtap="onSwitchToGlobal"');
    expect(errorBlock).toContain("切回全站榜");
    expect(errorBlock).toContain('wx:if="{{showSwitchToGlobal}}"');
    expect(errorBlock).toContain('bindtap="onRetry"');
  });

  it("clears groupId, refreshes groups, and stays in error when the selected group is gone", async () => {
    const remaining = [{ group_id: "group-alive", display_name: "还在的群", member_count: 3 }];
    const { page, services } = loadPage({
      groups: {
        listMyGroups: vi.fn(async () => ({ statusCode: 200, data: { items: remaining } })),
      },
      rankings: {
        listRankings: vi.fn(async () => rankingPayload({ entry_count: 2 })),
      },
    });
    page.setData({ scope: "group", groupId: "group-gone", selectedGroupIndex: 1 });

    await page.loadFirstPage();

    expect(page.data.state).toBe("error");
    expect(page.data.errorMessage).toBe(copy.groupMembershipChanged);
    expect(page.data.groupId).toBeNull();
    expect(page.data.scope).toBe("group");
    expect(page.data.groups).toEqual(remaining);
    expect(page.data.groupNames).toEqual(["还在的群"]);
    expect(page.data.showSwitchToGlobal).toBe(true);
    expect(page.data.items).toEqual([]);
    expect(services.rankings.listRankings).toHaveBeenCalledWith(expect.objectContaining({
      scope: "group",
      groupId: "group-gone",
    }));
  });

  it("does not send scope=group with an empty groupId after retry", async () => {
    const { page, services } = loadPage({
      groups: {
        listMyGroups: vi.fn(async () => ({ statusCode: 200, data: { items: [] } })),
      },
    });
    page.setData({ scope: "group", groupId: "group-gone" });
    await page.loadFirstPage();
    services.rankings.listRankings.mockClear();

    await page.onRetry();

    expect(page.data.groupId).toBeNull();
    expect(page.data.scope).toBe("group");
    expect(page.data.state).toBe("error");
    expect(page.data.showSwitchToGlobal).toBe(true);
    expect(page.data.errorMessage).toBe(copy.groupMembershipChanged);
    for (const [query] of services.rankings.listRankings.mock.calls) {
      expect(query.scope === "group" && (query.groupId == null || query.groupId === "")).toBe(false);
    }
  });

  it("retries into a remaining group instead of an empty groupId", async () => {
    const remaining = [{ group_id: "group-alive", display_name: "还在的群", member_count: 3 }];
    const { page, services } = loadPage({
      groups: {
        listMyGroups: vi.fn(async () => ({ statusCode: 200, data: { items: remaining } })),
      },
    });
    page.setData({ scope: "group", groupId: "group-gone", selectedGroupIndex: 1 });
    await page.loadFirstPage();
    services.rankings.listRankings.mockClear();

    await page.onRetry();

    expect(page.data.state).toBe("list");
    expect(page.data.groupId).toBe("group-alive");
    expect(page.data.scope).toBe("group");
    expect(page.data.showSwitchToGlobal).toBe(false);
    expect(services.rankings.listRankings).toHaveBeenCalledWith(expect.objectContaining({
      scope: "group",
      groupId: "group-alive",
    }));
    for (const [query] of services.rankings.listRankings.mock.calls) {
      expect(query.scope === "group" && (query.groupId == null || query.groupId === "")).toBe(false);
    }
  });

  it("switches back to the global board from the error action", async () => {
    const { page, services } = loadPage({
      groups: {
        listMyGroups: vi.fn(async () => ({
          statusCode: 200,
          data: { items: [{ group_id: "group-alive", display_name: "还在的群" }] },
        })),
      },
    });
    page.setData({ scope: "group", groupId: "group-gone" });
    await page.loadFirstPage();
    services.rankings.listRankings.mockClear();

    await page.onSwitchToGlobal();

    expect(page.data.scope).toBe("global");
    expect(page.data.groupId).toBeNull();
    expect(page.data.state).toBe("list");
    expect(page.data.showSwitchToGlobal).toBe(false);
    expect(page.data.standingValue).toBe(12);
    expect(services.rankings.listRankings).toHaveBeenCalledWith(expect.objectContaining({
      scope: "global",
      groupId: null,
    }));
  });

  it("resets userSelectedWeek on switch-to-global so a later onShow does not pin the old week", async () => {
    const listRankings = vi.fn(async (query) => rankingPayload({
      period_key: query.periodKey || "2026-W48",
      current_period_key: "2026-W48",
      first_period_key: "2026-W46",
    }));
    const { page, services } = loadPage({
      groups: {
        listMyGroups: vi.fn(async () => ({
          statusCode: 200,
          data: { items: [{ group_id: "group-1", display_name: "群一", member_count: 2 }] },
        })),
      },
      rankings: { listRankings },
    });
    page.setData({ scope: "group", groupId: "group-1" });
    await page.loadFirstPage();
    expect(page.data.state).toBe("list");

    await page.onWeekChange({ detail: { value: "1" } });
    expect(page.userSelectedWeek).toBe(true);
    expect(page.data.selectedPeriodKey).toBe("2026-W47");

    listRankings.mockResolvedValueOnce({
      statusCode: 404,
      code: "GROUP_NOT_FOUND",
      message: "群不存在",
    });
    await page.loadFirstPage();
    expect(page.data.showSwitchToGlobal).toBe(true);
    expect(page.userSelectedWeek).toBe(true);

    await page.onSwitchToGlobal();
    expect(page.data.scope).toBe("global");
    expect(page.data.state).toBe("list");

    listRankings.mockClear();
    listRankings.mockImplementation(async (query) => rankingPayload({
      period_key: query.periodKey || "2026-W49",
      current_period_key: "2026-W49",
      first_period_key: "2026-W46",
    }));

    page.onShow();
    await vi.waitFor(() => {
      expect(page.data.state).not.toBe("loading");
    });

    expect(page.userSelectedWeek).toBe(false);
    expect(listRankings).toHaveBeenNthCalledWith(1, expect.objectContaining({
      periodKey: null,
    }));
  });

  it("still renders a valid selected group list", async () => {
    const groups = [
      { group_id: "group-a", display_name: "群 A" },
      { group_id: "group-b", display_name: "群 B" },
    ];
    const { page, services } = loadPage({
      groups: {
        listMyGroups: vi.fn(async () => ({ statusCode: 200, data: { items: groups } })),
      },
    });
    page.setData({ scope: "group", groupId: "group-b" });

    await page.loadFirstPage();

    expect(page.data.state).toBe("list");
    expect(page.data.groupId).toBe("group-b");
    expect(page.data.selectedGroupIndex).toBe(1);
    expect(page.data.groups).toEqual(groups);
    expect(page.data.groupNames).toEqual(["群 A", "群 B"]);
    expect(page.data.showSwitchToGlobal).toBe(false);
    expect(page.data.items).toHaveLength(1);
    expect(services.rankings.listRankings).toHaveBeenCalledWith(expect.objectContaining({
      scope: "group",
      groupId: "group-b",
    }));
  });

  it("does not show 切回全站榜 for an ordinary load error", async () => {
    const { page } = loadPage({
      profile: {
        getMyProfile: vi.fn(async () => ({ statusCode: 500, code: "INTERNAL_ERROR" })),
      },
    });
    page.setData({ scope: "group", groupId: "group-gone" });

    await page.loadFirstPage();

    expect(page.data.state).toBe("error");
    expect(page.data.showSwitchToGlobal).toBe(false);
    expect(page.data.groupId).toBe("group-gone");
  });

  it("discards a stale invalid-group response after switching to global", async () => {
    const firstGroups = deferred();
    const alive = [{ group_id: "group-alive", display_name: "还在的群" }];
    const { page, services } = loadPage({
      groups: {
        listMyGroups: vi.fn()
          .mockImplementationOnce(() => firstGroups.promise)
          .mockResolvedValue({ statusCode: 200, data: { items: alive } }),
      },
    });
    page.setData({ scope: "group", groupId: "group-gone" });

    const pendingInvalid = page.loadFirstPage();
    await vi.waitFor(() => {
      expect(services.groups.listMyGroups).toHaveBeenCalledTimes(1);
    });
    const pendingGlobal = page.onSwitchToGlobal();
    firstGroups.resolve({ statusCode: 200, data: { items: [] } });
    await Promise.all([pendingInvalid, pendingGlobal]);

    expect(page.data.state).toBe("list");
    expect(page.data.scope).toBe("global");
    expect(page.data.groupId).toBeNull();
    expect(page.data.showSwitchToGlobal).toBe(false);
    expect(page.data.errorMessage).toBe("");
    expect(page.data.groups).toEqual(alive);
    expect(page.data.groupNames).toEqual(["还在的群"]);
    expect(services.rankings.listRankings).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: "global",
      groupId: null,
    }));
  });

  it("recovers when first-page rankings return GROUP_NOT_FOUND while groups still list the group", async () => {
    const stale = [
      { group_id: "group-gone", display_name: "已失效", member_count: 2 },
      { group_id: "group-alive", display_name: "还在的群", member_count: 3 },
    ];
    const refreshed = [{ group_id: "group-alive", display_name: "还在的群", member_count: 3 }];
    const { page, services } = loadPage({
      groups: {
        listMyGroups: vi.fn()
          .mockResolvedValueOnce({ statusCode: 200, data: { items: stale } })
          .mockResolvedValue({ statusCode: 200, data: { items: refreshed } }),
      },
      rankings: {
        listRankings: vi.fn(async () => ({
          statusCode: 404,
          code: "GROUP_NOT_FOUND",
          message: "群不存在",
        })),
      },
    });
    page.setData({ scope: "group", groupId: "group-gone" });

    await page.loadFirstPage();

    expect(page.data.state).toBe("error");
    expect(page.data.errorMessage).toBe(copy.groupMembershipChanged);
    expect(page.data.groupId).toBeNull();
    expect(page.data.scope).toBe("group");
    expect(page.data.groups).toEqual(refreshed);
    expect(page.data.groupNames).toEqual(["还在的群"]);
    expect(page.data.showSwitchToGlobal).toBe(true);
    expect(page.data.items).toEqual([]);
    expect(services.groups.listMyGroups.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("recovers when first-page rankings return FORBIDDEN for a group the list still shows", async () => {
    const stale = [{ group_id: "group-left", display_name: "刚退出的群", member_count: 4 }];
    const { page, services } = loadPage({
      groups: {
        listMyGroups: vi.fn()
          .mockResolvedValueOnce({ statusCode: 200, data: { items: stale } })
          .mockResolvedValue({ statusCode: 200, data: { items: [] } }),
      },
      rankings: {
        listRankings: vi.fn(async () => ({
          statusCode: 403,
          code: "FORBIDDEN",
          message: "仅群成员可查看群榜",
        })),
      },
    });
    page.setData({ scope: "group", groupId: "group-left" });

    await page.loadFirstPage();

    expect(page.data.state).toBe("error");
    expect(page.data.errorMessage).toBe(copy.groupMembershipChanged);
    expect(page.data.groupId).toBeNull();
    expect(page.data.groups).toEqual([]);
    expect(page.data.showSwitchToGlobal).toBe(true);
    expect(page.data.items).toEqual([]);
    expect(services.groups.listMyGroups.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not treat levels FORBIDDEN as group-board recovery", async () => {
    const { page } = loadPage({
      groups: {
        listMyGroups: vi.fn(async () => ({
          statusCode: 200,
          data: { items: [{ group_id: "group-b", display_name: "群 B" }] },
        })),
      },
      levels: {
        getMyLevels: vi.fn(async () => ({
          statusCode: 403,
          code: "FORBIDDEN",
          message: "仅群成员可查看群信息",
        })),
      },
    });
    page.setData({ scope: "group", groupId: "group-b" });

    await page.loadFirstPage();

    expect(page.data.state).toBe("error");
    expect(page.data.showSwitchToGlobal).toBe(false);
    expect(page.data.groupId).toBe("group-b");
    expect(page.data.errorMessage).not.toBe(copy.groupMembershipChanged);
  });

  it("does not treat global-board NOT_FOUND as group recovery", async () => {
    const { page } = loadPage({
      rankings: {
        listRankings: vi.fn(async () => ({
          statusCode: 404,
          code: "NOT_FOUND",
          message: "该赛季从未有数据",
        })),
      },
    });
    page.setData({ scope: "global", groupId: null, board: "season" });

    await page.loadFirstPage();

    expect(page.data.state).toBe("error");
    expect(page.data.showSwitchToGlobal).toBe(false);
    expect(page.data.errorMessage).not.toBe(copy.groupMembershipChanged);
  });

  it("enters group recovery when pagination returns GROUP_NOT_FOUND", async () => {
    const groups = [{ group_id: "group-b", display_name: "群 B" }];
    const { page, services } = loadPage({
      groups: {
        listMyGroups: vi.fn()
          .mockResolvedValueOnce({ statusCode: 200, data: { items: groups } })
          .mockResolvedValue({ statusCode: 200, data: { items: [] } }),
      },
    });
    page.setData({ scope: "group", groupId: "group-b" });
    await page.loadFirstPage();
    expect(page.data.state).toBe("list");
    services.rankings.listRankings.mockResolvedValueOnce({
      statusCode: 404,
      code: "GROUP_NOT_FOUND",
      message: "群不存在",
    });
    page.setData({ hasMore: true, nextCursor: "cursor-2", loadingMore: false });

    await page.onMore();

    expect(page.data.state).toBe("error");
    expect(page.data.errorMessage).toBe(copy.groupMembershipChanged);
    expect(page.data.groupId).toBeNull();
    expect(page.data.showSwitchToGlobal).toBe(true);
    expect(page.data.items).toEqual([]);
    expect(page.data.loadingMore).toBe(false);
  });

  it("does not let a stale group FORBIDDEN overwrite a newer global board", async () => {
    const firstRankings = deferred();
    const { page, services } = loadPage({
      groups: {
        listMyGroups: vi.fn()
          .mockResolvedValueOnce({
            statusCode: 200,
            data: { items: [{ group_id: "group-left", display_name: "刚退出的群" }] },
          })
          .mockResolvedValue({ statusCode: 200, data: { items: [] } }),
      },
      rankings: {
        listRankings: vi.fn()
          .mockImplementationOnce(() => firstRankings.promise)
          .mockResolvedValue(rankingPayload()),
      },
    });
    page.setData({ scope: "group", groupId: "group-left" });

    const pendingInvalid = page.loadFirstPage();
    await vi.waitFor(() => {
      expect(services.rankings.listRankings).toHaveBeenCalledTimes(1);
    });
    const pendingGlobal = page.onSwitchToGlobal();
    firstRankings.resolve({
      statusCode: 403,
      code: "FORBIDDEN",
      message: "仅群成员可查看群榜",
    });
    await Promise.all([pendingInvalid, pendingGlobal]);

    expect(page.data.state).toBe("list");
    expect(page.data.scope).toBe("global");
    expect(page.data.groupId).toBeNull();
    expect(page.data.showSwitchToGlobal).toBe(false);
    expect(page.data.errorMessage).toBe("");
    expect(page.data.standingValue).toBe(12);
    expect(services.rankings.listRankings).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: "global",
      groupId: null,
    }));
  });

  it.each([
    ["GROUP_NOT_FOUND", { statusCode: 404, code: "GROUP_NOT_FOUND", message: "群不存在" }],
    ["FORBIDDEN", { statusCode: 403, code: "FORBIDDEN", message: "仅群成员可查看群榜" }],
  ])("enters invalid-group recovery when rankings return %s even if parallel levels fail", async (_label, rankingError) => {
    const stale = [{ group_id: "group-gone", display_name: "已失效", member_count: 2 }];
    const { page, services } = loadPage({
      groups: {
        listMyGroups: vi.fn()
          .mockResolvedValueOnce({ statusCode: 200, data: { items: stale } })
          .mockResolvedValue({ statusCode: 200, data: { items: [] } }),
      },
      levels: {
        getMyLevels: vi.fn(async () => ({
          statusCode: 500,
          code: "INTERNAL_ERROR",
          message: "等级服务失败",
        })),
      },
      rankings: {
        listRankings: vi.fn(async () => rankingError),
      },
    });
    page.setData({ scope: "group", groupId: "group-gone" });

    await page.loadFirstPage();

    expect(page.data.state).toBe("error");
    expect(page.data.errorMessage).toBe(copy.groupMembershipChanged);
    expect(page.data.groupId).toBeNull();
    expect(page.data.showSwitchToGlobal).toBe(true);
    expect(page.data.items).toEqual([]);
    expect(services.groups.listMyGroups.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ["GROUP_NOT_FOUND", { statusCode: 404, code: "GROUP_NOT_FOUND", message: "群不存在" }],
    ["FORBIDDEN", { statusCode: 403, code: "FORBIDDEN", message: "仅群成员可查看群榜" }],
  ])("enters invalid-group recovery when rankings return %s even if parallel groups fail", async (_label, rankingError) => {
    const { page } = loadPage({
      groups: {
        listMyGroups: vi.fn(async () => ({
          statusCode: 500,
          code: "INTERNAL_ERROR",
          message: "群列表失败",
        })),
      },
      rankings: {
        listRankings: vi.fn(async () => rankingError),
      },
    });
    page.setData({ scope: "group", groupId: "group-gone" });

    await page.loadFirstPage();

    expect(page.data.state).toBe("error");
    expect(page.data.errorMessage).toBe(copy.groupMembershipChanged);
    expect(page.data.groupId).toBeNull();
    expect(page.data.showSwitchToGlobal).toBe(true);
    expect(page.data.items).toEqual([]);
  });

  it("does not auto-reselect a known-invalid group after a failed group-list refresh", async () => {
    const stale = [{ group_id: "group-gone", display_name: "已失效", member_count: 2 }];
    const { page, services } = loadPage({
      groups: {
        listMyGroups: vi.fn()
          .mockResolvedValueOnce({ statusCode: 200, data: { items: stale } })
          .mockResolvedValueOnce({
            statusCode: 500,
            code: "INTERNAL_ERROR",
            message: "群列表失败",
          })
          .mockResolvedValue({
            statusCode: 500,
            code: "INTERNAL_ERROR",
            message: "群列表失败",
          }),
      },
      rankings: {
        listRankings: vi.fn()
          .mockResolvedValueOnce({
            statusCode: 404,
            code: "GROUP_NOT_FOUND",
            message: "群不存在",
          })
          .mockResolvedValue(rankingPayload()),
      },
    });
    page.setData({ scope: "group", groupId: "group-gone", selectedGroupIndex: 0 });

    await page.loadFirstPage();
    expect(page.data.groupId).toBeNull();
    expect(page.data.state).toBe("error");
    expect(page.data.showSwitchToGlobal).toBe(true);
    services.rankings.listRankings.mockClear();

    await page.onRetry();

    expect(page.data.state).toBe("error");
    expect(page.data.errorMessage).toBe(copy.groupMembershipChanged);
    expect(page.data.groupId).toBeNull();
    expect(page.data.scope).toBe("group");
    expect(page.data.showSwitchToGlobal).toBe(true);
    expect(page.data.selectedGroupIndex).toBe(0);
    expect(page.data.groupNames).not.toContain("已失效");
    expect(page.data.groups.some((item) => item.group_id === "group-gone")).toBe(false);
    for (const [query] of services.rankings.listRankings.mock.calls) {
      expect(query.groupId).not.toBe("group-gone");
      expect(query.scope === "group" && (query.groupId == null || query.groupId === "")).toBe(false);
    }
  });

  it("clears invalidGroupIds when a later listMyGroups includes the rejoined group", async () => {
    const stale = [{ group_id: "group-gone", display_name: "曾失效的群", member_count: 2 }];
    const { page, services } = loadPage({
      groups: {
        listMyGroups: vi.fn()
          .mockResolvedValueOnce({ statusCode: 200, data: { items: stale } })
          .mockResolvedValueOnce({ statusCode: 200, data: { items: [] } })
          .mockResolvedValue({ statusCode: 200, data: { items: stale } }),
      },
      rankings: {
        listRankings: vi.fn()
          .mockResolvedValueOnce({
            statusCode: 404,
            code: "GROUP_NOT_FOUND",
            message: "群不存在",
          })
          .mockResolvedValue(rankingPayload()),
      },
    });
    page.setData({ scope: "group", groupId: "group-gone", selectedGroupIndex: 0 });
    await page.loadFirstPage();
    expect(page.data.groupId).toBeNull();
    expect(page.isKnownInvalidGroup("group-gone")).toBe(true);
    services.rankings.listRankings.mockClear();

    page.onShow();
    await vi.waitFor(() => {
      expect(page.data.state).toBe("list");
    });

    expect(page.isKnownInvalidGroup("group-gone")).toBe(false);
    expect(page.data.groupId).toBe("group-gone");
    expect(page.data.groups).toEqual(stale);
    expect(services.rankings.listRankings).toHaveBeenCalledWith(expect.objectContaining({
      scope: "group",
      groupId: "group-gone",
    }));
  });

  it("resets a historical season board when entering a group via pending_ranking_group_id", async () => {
    const { page, services, storage } = loadPage({
      groups: {
        listMyGroups: vi.fn(async () => ({
          statusCode: 200,
          data: { items: [{ group_id: "group-1", display_name: "群一", member_count: 2 }] },
        })),
      },
    });
    page.setData({
      scope: "global",
      groupId: null,
      board: "season",
      selectedLevelSeasonId: "2025_2026",
      selectedSeasonLabel: "2025—2026 赛季",
      selectedPeriodKey: "2026-W01",
    });
    page.userChangedSeason = true;
    page.autoSeasonFallback = true;
    page.userSelectedWeek = true;
    storage.set("pending_ranking_group_id", "group-1");

    page.onShow();
    await vi.waitFor(() => {
      expect(page.data.state).not.toBe("loading");
    });

    expect(page.data.scope).toBe("group");
    expect(page.data.groupId).toBe("group-1");
    expect(page.data.board).toBe("week");
    expect(page.userChangedSeason).toBe(false);
    expect(page.autoSeasonFallback).toBe(false);
    expect(page.userSelectedWeek).toBe(false);
    expect(services.rankings.listRankings).toHaveBeenCalledWith(expect.objectContaining({
      board: "week",
      scope: "group",
      groupId: "group-1",
      periodKey: null,
      levelSeasonId: null,
    }));
  });

  it("clears the invalid mark when onShow opens a rejoined group via pending_ranking_group_id", async () => {
    const rejoined = [{ group_id: "group-1", display_name: "重新加入的群", member_count: 2 }];
    const { page, services, storage } = loadPage({
      groups: {
        listMyGroups: vi.fn()
          .mockResolvedValueOnce({
            statusCode: 200,
            data: { items: [{ group_id: "group-1", display_name: "已失效", member_count: 2 }] },
          })
          .mockResolvedValueOnce({ statusCode: 200, data: { items: [] } })
          .mockResolvedValue({ statusCode: 200, data: { items: rejoined } }),
      },
      rankings: {
        listRankings: vi.fn()
          .mockResolvedValueOnce({
            statusCode: 404,
            code: "GROUP_NOT_FOUND",
            message: "群不存在",
          })
          .mockResolvedValue(rankingPayload()),
      },
    });
    page.setData({ scope: "group", groupId: "group-1" });
    await page.loadFirstPage();
    expect(page.data.state).toBe("error");
    expect(page.data.groupId).toBeNull();
    expect(page.isKnownInvalidGroup("group-1")).toBe(true);
    services.rankings.listRankings.mockClear();
    storage.set("pending_ranking_group_id", "group-1");

    page.onShow();
    await vi.waitFor(() => {
      expect(page.data.state).not.toBe("loading");
    });

    expect(page.data.state).toBe("list");
    expect(page.data.scope).toBe("group");
    expect(page.data.groupId).toBe("group-1");
    expect(page.data.groups).toEqual(rejoined);
    expect(page.data.groupNames).toEqual(["重新加入的群"]);
    expect(page.data.showSwitchToGlobal).toBe(false);
    expect(page.isKnownInvalidGroup("group-1")).toBe(false);
    expect(storage.has("pending_ranking_group_id")).toBe(false);
    expect(services.rankings.listRankings).toHaveBeenCalledWith(expect.objectContaining({
      scope: "group",
      groupId: "group-1",
    }));
    for (const [query] of services.rankings.listRankings.mock.calls) {
      expect(query.groupId).not.toBeNull();
    }
  });

  it("lets an explicit group pick reload that group after invalid recovery", async () => {
    const remaining = [{ group_id: "group-alive", display_name: "还在的群", member_count: 3 }];
    const { page, services } = loadPage({
      groups: {
        listMyGroups: vi.fn()
          .mockResolvedValueOnce({
            statusCode: 200,
            data: { items: [{ group_id: "group-gone", display_name: "已失效" }, ...remaining] },
          })
          .mockResolvedValue({ statusCode: 200, data: { items: remaining } }),
      },
      rankings: {
        listRankings: vi.fn()
          .mockResolvedValueOnce({
            statusCode: 404,
            code: "GROUP_NOT_FOUND",
            message: "群不存在",
          })
          .mockResolvedValue(rankingPayload()),
      },
    });
    page.setData({ scope: "group", groupId: "group-gone" });
    await page.loadFirstPage();
    expect(page.data.groupId).toBeNull();
    services.rankings.listRankings.mockClear();

    await page.onGroupChange({ detail: { value: "0" } });

    expect(page.data.state).toBe("list");
    expect(page.data.groupId).toBe("group-alive");
    expect(page.data.scope).toBe("group");
    expect(page.data.showSwitchToGlobal).toBe(false);
    expect(services.rankings.listRankings).toHaveBeenCalledWith(expect.objectContaining({
      scope: "group",
      groupId: "group-alive",
    }));
  });

  it("recovers invalid group when groups return empty 200 and levels return 500 even if rankings succeed", async () => {
    const { page } = loadPage({
      groups: {
        listMyGroups: vi.fn(async () => ({ statusCode: 200, data: { items: [] } })),
      },
      levels: {
        getMyLevels: vi.fn(async () => ({
          statusCode: 500,
          code: "INTERNAL_ERROR",
          message: "等级服务失败",
        })),
      },
      rankings: {
        listRankings: vi.fn(async () => rankingPayload()),
      },
    });
    page.setData({ scope: "group", groupId: "group-gone" });

    await page.loadFirstPage();

    expect(page.data.state).toBe("error");
    expect(page.data.errorMessage).toBe(copy.groupMembershipChanged);
    expect(page.data.groupId).toBeNull();
    expect(page.data.scope).toBe("group");
    expect(page.data.showSwitchToGlobal).toBe(true);
    expect(page.data.items).toEqual([]);
    expect(page.data.groups).toEqual([]);
  });

  it("does not let an older queueLoadFirstPage callback issue a request that expires the newer one", async () => {
    const week = deferred();
    const stale = deferred();
    const { page, services } = loadPage({
      rankings: {
        listRankings: vi.fn()
          .mockImplementationOnce(() => week.promise)
          .mockImplementationOnce(() => stale.promise),
      },
    }, { delaySetDataCallbacks: true });

    page.onBoardTap({ currentTarget: { dataset: { board: "career" } } });
    page.onBoardTap({ currentTarget: { dataset: { board: "week" } } });
    expect(page.data.board).toBe("week");
    expect(services.rankings.listRankings).not.toHaveBeenCalled();
    expect(page.pendingSetDataCount()).toBe(2);

    page.flushLastSetData();
    await vi.waitFor(() => {
      expect(services.rankings.listRankings).toHaveBeenCalledTimes(1);
    });
    expect(services.rankings.listRankings).toHaveBeenCalledWith(expect.objectContaining({
      board: "week",
    }));

    page.flushSetData();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(services.rankings.listRankings).toHaveBeenCalledTimes(1);
    expect(page.data.board).toBe("week");

    week.resolve(rankingPayload({
      me: { status: "ranked", rank: 1, period_score: 12, valid_predictions: 4, exact_hits: 1 },
      items: [{
        user_id: "user-1",
        rank: 1,
        display_name: "Week Player",
        favorite_team_id: null,
        career_level: 1,
        period_score: 12,
        valid_predictions: 4,
        exact_hits: 1,
      }],
    }));
    await vi.waitFor(() => {
      expect(page.pendingSetDataCount()).toBeGreaterThan(0);
    });
    page.flushSetData();

    expect(page.data.board).toBe("week");
    expect(page.data.state).toBe("list");
    expect(page.data.items[0].display_name).toBe("Week Player");
    expect(page.data.errorMessage).toBe("");
  });

  it("does not apply a stale first-page success after a delayed setData filter switch", async () => {
    const week = deferred();
    const career = deferred();
    const { page, services } = loadPage({
      rankings: {
        listRankings: vi.fn()
          .mockImplementationOnce(() => week.promise)
          .mockImplementationOnce(() => career.promise),
      },
    }, { delaySetDataCallbacks: true });

    page.loadFirstPage();
    await vi.waitFor(() => {
      expect(services.rankings.listRankings).toHaveBeenCalledTimes(1);
    });
    week.resolve(rankingPayload({
      available_boards: ["week", "career", "strength"],
      entry_count: 1,
      me: { status: "ranked", rank: 1, period_score: 12, valid_predictions: 4, exact_hits: 1 },
      items: [{
        user_id: "user-1",
        rank: 1,
        display_name: "Week Player",
        favorite_team_id: null,
        career_level: 1,
        period_score: 12,
        valid_predictions: 4,
        exact_hits: 1,
      }],
    }));
    await vi.waitFor(() => {
      expect(page.pendingSetDataCount()).toBeGreaterThan(0);
    });

    page.onBoardTap({ currentTarget: { dataset: { board: "career" } } });
    expect(page.data.board).toBe("career");
    page.flushNextSetData();

    expect(page.data.board).toBe("career");
    expect(page.data.items.some((item) => item && item.display_name === "Week Player")).toBe(false);
    expect(page.data.state).not.toBe("list");

    page.flushSetData();
    await vi.waitFor(() => {
      expect(services.rankings.listRankings).toHaveBeenCalledTimes(2);
    });
    career.resolve({
      statusCode: 200,
      data: {
        available_boards: ["week", "career", "strength"],
        entry_count: 1,
        me: { status: "ranked", rank: 1, career_points: 88, career_valid_predictions: 20, exact_hits: 4 },
        items: [{
          user_id: "user-1",
          rank: 1,
          display_name: "Career Player",
          favorite_team_id: null,
          career_level: 1,
          career_points: 88,
          career_valid_predictions: 20,
          exact_hits: 4,
        }],
        page: { has_more: false, next_cursor: null },
      },
    });
    await vi.waitFor(() => {
      expect(page.pendingSetDataCount()).toBeGreaterThan(0);
    });
    page.flushSetData();

    expect(page.data.board).toBe("career");
    expect(page.data.state).toBe("list");
    expect(page.data.items[0].display_name).toBe("Career Player");
    expect(page.data.standingValue).toBe(88);
  });

  it("does not apply a stale first-page failure after a delayed setData filter switch", async () => {
    const week = deferred();
    const career = deferred();
    const { page, services } = loadPage({
      rankings: {
        listRankings: vi.fn()
          .mockImplementationOnce(() => week.promise)
          .mockImplementationOnce(() => career.promise),
      },
    }, { delaySetDataCallbacks: true });

    page.loadFirstPage();
    await vi.waitFor(() => {
      expect(services.rankings.listRankings).toHaveBeenCalledTimes(1);
    });
    week.resolve({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "周榜失败",
    });
    await vi.waitFor(() => {
      expect(page.pendingSetDataCount()).toBeGreaterThan(0);
    });

    page.onBoardTap({ currentTarget: { dataset: { board: "career" } } });
    expect(page.data.board).toBe("career");
    page.flushNextSetData();

    expect(page.data.board).toBe("career");
    expect(page.data.state).not.toBe("error");
    expect(page.data.errorMessage).not.toBe("暂时无法读取排行榜数据，请稍后重试");

    page.flushSetData();
    await vi.waitFor(() => {
      expect(services.rankings.listRankings).toHaveBeenCalledTimes(2);
    });
    career.resolve(rankingPayload({
      available_boards: ["week", "career", "strength"],
      entry_count: 1,
      me: { status: "ranked", rank: 1, career_points: 88, career_valid_predictions: 20, exact_hits: 4 },
      items: [{
        user_id: "user-1",
        rank: 1,
        display_name: "Career Player",
        favorite_team_id: null,
        career_level: 1,
        career_points: 88,
        career_valid_predictions: 20,
        exact_hits: 4,
      }],
    }));
    await vi.waitFor(() => {
      expect(page.pendingSetDataCount()).toBeGreaterThan(0);
    });
    page.flushSetData();

    expect(page.data.board).toBe("career");
    expect(page.data.items[0].display_name).toBe("Career Player");
    expect(page.data.errorMessage).toBe("");
  });

  it("does not apply a stale pagination success after a delayed setData filter switch", async () => {
    const first = deferred();
    const more = deferred();
    const career = deferred();
    const { page, services } = loadPage({
      rankings: {
        listRankings: vi.fn()
          .mockImplementationOnce(() => first.promise)
          .mockImplementationOnce(() => more.promise)
          .mockImplementationOnce(() => career.promise),
      },
    }, { delaySetDataCallbacks: true });

    page.loadFirstPage();
    first.resolve(rankingPayload({
      page: { has_more: true, next_cursor: "cursor-2" },
      items: [{
        user_id: "user-1",
        rank: 1,
        display_name: "Week One",
        favorite_team_id: null,
        career_level: 1,
        period_score: 12,
        valid_predictions: 4,
        exact_hits: 1,
      }],
    }));
    await vi.waitFor(() => {
      expect(page.pendingSetDataCount()).toBeGreaterThan(0);
    });
    page.flushSetData();
    expect(page.data.hasMore).toBe(true);

    page.onMore();
    await vi.waitFor(() => {
      expect(services.rankings.listRankings).toHaveBeenCalledTimes(2);
    });

    page.onBoardTap({ currentTarget: { dataset: { board: "career" } } });
    expect(page.data.board).toBe("career");

    more.resolve(rankingPayload({
      items: [{
        user_id: "user-2",
        rank: 2,
        display_name: "Week Two",
        favorite_team_id: null,
        career_level: 1,
        period_score: 9,
        valid_predictions: 3,
        exact_hits: 0,
      }],
      page: { has_more: false, next_cursor: null },
    }));
    await Promise.resolve();
    await Promise.resolve();
    page.flushNextSetData();

    expect(page.data.board).toBe("career");
    expect(page.data.items.some((item) => item.display_name === "Week Two")).toBe(false);

    page.flushSetData();
    await vi.waitFor(() => {
      expect(services.rankings.listRankings).toHaveBeenCalledTimes(3);
    });
    career.resolve({
      statusCode: 200,
      data: {
        available_boards: ["week", "career", "strength"],
        entry_count: 1,
        me: { status: "ranked", rank: 1, career_points: 88, career_valid_predictions: 20, exact_hits: 4 },
        items: [{
          user_id: "user-1",
          rank: 1,
          display_name: "Career Player",
          favorite_team_id: null,
          career_level: 1,
          career_points: 88,
          career_valid_predictions: 20,
          exact_hits: 4,
        }],
        page: { has_more: false, next_cursor: null },
      },
    });
    await vi.waitFor(() => {
      expect(page.pendingSetDataCount()).toBeGreaterThan(0);
    });
    page.flushSetData();

    expect(page.data.items.map((item) => item.display_name)).toEqual(["Career Player"]);
    expect(page.data.board).toBe("career");
  });

  it("does not apply a stale pagination failure after a delayed setData filter switch", async () => {
    const first = deferred();
    const more = deferred();
    const career = deferred();
    const { page, services } = loadPage({
      rankings: {
        listRankings: vi.fn()
          .mockImplementationOnce(() => first.promise)
          .mockImplementationOnce(() => more.promise)
          .mockImplementationOnce(() => career.promise),
      },
    }, { delaySetDataCallbacks: true });

    page.loadFirstPage();
    first.resolve(rankingPayload({
      page: { has_more: true, next_cursor: "cursor-2" },
    }));
    await vi.waitFor(() => {
      expect(page.pendingSetDataCount()).toBeGreaterThan(0);
    });
    page.flushSetData();

    page.onMore();
    await vi.waitFor(() => {
      expect(services.rankings.listRankings).toHaveBeenCalledTimes(2);
    });

    page.onBoardTap({ currentTarget: { dataset: { board: "career" } } });
    expect(page.data.board).toBe("career");

    more.resolve({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "分页失败",
    });
    await Promise.resolve();
    await Promise.resolve();
    page.flushNextSetData();

    expect(page.data.board).toBe("career");
    expect(page.data.state).not.toBe("error");
    expect(page.data.errorMessage).not.toBe("暂时无法读取排行榜数据，请稍后重试");

    page.flushSetData();
    await vi.waitFor(() => {
      expect(services.rankings.listRankings).toHaveBeenCalledTimes(3);
    });
    career.resolve(rankingPayload({
      available_boards: ["week", "career", "strength"],
      me: { status: "ranked", rank: 1, career_points: 88, career_valid_predictions: 20, exact_hits: 4 },
      items: [{
        user_id: "user-1",
        rank: 1,
        display_name: "Career Player",
        favorite_team_id: null,
        career_level: 1,
        career_points: 88,
        career_valid_predictions: 20,
        exact_hits: 4,
      }],
    }));
    await vi.waitFor(() => {
      expect(page.pendingSetDataCount()).toBeGreaterThan(0);
    });
    page.flushSetData();

    expect(page.data.items[0].display_name).toBe("Career Player");
    expect(page.data.errorMessage).toBe("");
  });

  it("ignores delayed setData fallback callbacks when requestSerial has moved on", async () => {
    const career = deferred();
    const { page, services } = loadPage({
      rankings: {
        listRankings: vi.fn()
          .mockImplementationOnce(() => career.promise)
          .mockResolvedValue(rankingPayload()),
      },
    }, { delaySetDataCallbacks: true });

    page.setData({ board: "career" });
    page.loadFirstPage();
    await vi.waitFor(() => expect(services.rankings.listRankings).toHaveBeenCalledTimes(1));

    career.resolve(rankingPayload({ available_boards: ["week"] }));
    await vi.waitFor(() => expect(page.pendingSetDataCount()).toBeGreaterThan(0));

    // User switches board before the delayed setData callback runs
    page.onBoardTap({ currentTarget: { dataset: { board: "week" } } });
    // Flush the stale fallback callback from career -> week
    page.flushNextSetData();
    expect(services.rankings.listRankings).toHaveBeenCalledTimes(1);

    // Flush the newer onBoardTap callback
    page.flushSetData();
    await vi.waitFor(() => expect(services.rankings.listRankings).toHaveBeenCalledTimes(2));
  });
});
