import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function loadPage(path, overrides = {}) {
  const wx = { navigateTo: vi.fn(), switchTab: vi.fn() };
  const services = {
    profile: { getMyProfile: vi.fn(async () => ({ statusCode: 200, data: {
      nickname: "测试用户",
      previous_season: { points: 48, best_level: 3, valid_predictions: 21 },
    } })) },
    levels: { getMyLevels: vi.fn(async () => ({ statusCode: 200, data: { season: {}, career: {} } })) },
    groups: {
      listMyGroups: vi.fn(async () => ({ statusCode: 200, data: { items: [] } })),
      createGroup: vi.fn(async () => ({ statusCode: 201, data: { group_id: "created-group" } })),
    },
    rankings: { listRankings: vi.fn() },
    predictions: { listMyPredictions: vi.fn() },
    matches: { listMatches: vi.fn(async () => ({ statusCode: 200, data: { items: [], page: { has_more: false } } })) },
    ...overrides,
  };
  const mocks = new Map(Object.entries(services).map(([name, value]) => [resolve(ROOT, "services", `${name}.js`), value]));
  mocks.set(resolve(ROOT, "utils/logo-registry.js"), {
    getTeamLogo: () => "/team.png", getLeagueLogo: () => "/league.png",
  });
  let config;
  function load(file) {
    if (mocks.has(file)) return mocks.get(file);
    const module = { exports: {} };
    runInNewContext(readFileSync(file, "utf8"), {
      module, exports: module.exports, wx,
      Page: (value) => { config = value; },
      require: (name) => load(resolve(file, "..", name)),
    }, { filename: file });
    return module.exports;
  }
  load(resolve(ROOT, "pages", path));
  const page = {
    ...config,
    data: structuredClone(config.data),
    setData(patch, callback) { Object.assign(this.data, patch); callback?.(); },
  };
  return { page, services, wx };
}

describe("compliance review functional regressions", () => {
  it("keeps the previous season global even when it is the first available season", () => {
    const { page, services } = loadPage("rankings/rankings.js");
    page.setData({ board: "season", scope: "global", groups: [{ group_id: "g1" }] });
    page.applyListResult({ statusCode: 200, data: {
      server_now: "2026-10-09T04:00:00.000Z",
      level_season_id: "2025_2026",
      available_level_seasons: ["2025_2026"],
      available_boards: ["week", "season"],
      entry_count: 1,
      items: [],
    } }, true);
    expect(page.data.showGroupScope).toBe(false);
    expect(page.data.currentLevelSeasonId).toBe("2026_2027");
    page.onScopeTap({ currentTarget: { dataset: { scope: "group" } } });
    expect(page.data.scope).toBe("global");
    expect(services.rankings.listRankings).not.toHaveBeenCalled();

    page.setData({ scope: "group", groupId: "g1", selectedLevelSeasonId: "2026_2027" });
    page.loadFirstPage = vi.fn();
    page.onSeasonChange({ detail: { value: "0" } });
    expect(page.data.scope).toBe("global");
    expect(page.data.groupId).toBeNull();
  });

  it("shows recap valid predictions and directly opens group creation and joining from the profile", async () => {
    const { page, wx, services } = loadPage("profile/profile.js");
    page.loadPage();
    await vi.waitFor(() => expect(page.data.state).toBe("ready"));
    expect(page.data.previousSeasonRecap).toContain("有效预测 21 场");
    expect(page.data.hasGroups).toBe(false);
    page.onJoinGroupTap();
    expect(wx.navigateTo).toHaveBeenCalledWith({ url: "/pages/groups/join" });
    await page.onCreateGroupTap();
    expect(services.groups.createGroup).toHaveBeenCalledOnce();
    expect(wx.navigateTo).toHaveBeenCalledWith({ url: "/pages/groups/detail?group_id=created-group&created=1&owned_count=1" });
  });

  it("continues history paging to the end and exposes the terminal message", async () => {
    const prediction = (id) => ({
      prediction_id: id, match_id: id, kickoff_at: new Date().toISOString(),
      league_id: "premier_league", match_status: "finished", match_score: 3,
    });
    const listMyPredictions = vi.fn()
      .mockResolvedValueOnce({ statusCode: 200, data: {
        items: [prediction("p1")], page: { has_more: true, next_cursor: "next-page" },
      } })
      .mockResolvedValueOnce({ statusCode: 200, data: {
        items: [prediction("p2")], page: { has_more: false, next_cursor: null },
      } });
    const { page } = loadPage("my-predictions/my-predictions.js", { predictions: { listMyPredictions } });
    page.onLoad();
    await vi.waitFor(() => expect(page.data.items).toHaveLength(2));
    expect(listMyPredictions).toHaveBeenLastCalledWith({ cursor: "next-page" });
    expect(page.data.hasMore).toBe(false);
    expect(page.data.endText).toBe("没有更早的预测了");
    page.onMore();
    expect(listMyPredictions).toHaveBeenCalledTimes(2);
  });
});
