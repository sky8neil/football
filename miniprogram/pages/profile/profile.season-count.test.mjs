import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function loadCopy() {
  const module = { exports: {} };
  runInNewContext(readFileSync(new URL("../../utils/rankings-copy.js", import.meta.url), "utf8"), {
    module,
    exports: module.exports,
    require() { throw new Error("rankings-copy has no dependencies"); },
  });
  return module.exports;
}

function memberGroup(index, role = "member") {
  return {
    group_id: `g${index}`,
    display_name: `群${index}`,
    role,
    member_count: role === "owner" ? 1 : 4,
  };
}

function loadPage({ profile, season, groups, listMyGroupsImpl } = {}) {
  let definition;
  const getMyProfile = vi.fn(async () => ({
    statusCode: 200,
    data: {
      user_id: "u1",
      nickname: "Sky",
      favorite_team_id: null,
      career_points: 10,
      career_valid_predictions: 4,
      career_exact_hits: 1,
      career_level: 2,
      career_best_level: 2,
      season_level: 2,
      previous_season: null,
      ...profile,
    },
  }));
  const getMyLevels = vi.fn(async () => ({
    statusCode: 200,
    data: {
      season: {
        level_season_id: "2026_2027",
        valid_predictions: 3,
        best_level: 2,
        ...season,
      },
      career: {
        b_points: 10,
        is_rated: true,
        remaining_to_rated: 0,
        valid_predictions: 4,
        level: 2,
        best_level: 2,
      },
    },
  }));
  const listMyGroups = vi.fn(listMyGroupsImpl ?? (async () => ({
    statusCode: 200,
    data: { items: groups ?? [] },
  })));
  const createGroup = vi.fn(async () => ({
    statusCode: 201,
    data: { group_id: "created-group" },
  }));
  const navigateTo = vi.fn();
  const copy = loadCopy();
  runInNewContext(readFileSync(new URL("./profile.js", import.meta.url), "utf8"), {
    Page: (value) => { definition = value; },
    require: (name) => {
      if (name.includes("services/profile.js")) return { getMyProfile };
      if (name.includes("services/levels.js")) return { getMyLevels };
      if (name.includes("services/groups.js")) return { listMyGroups, createGroup };
      if (name.includes("services/matches.js")) return { getMatchDetail: vi.fn(), listMatches: vi.fn() };
      if (name.includes("services/predictions.js")) {
        return { listMyPredictions: vi.fn(async () => ({ statusCode: 200, data: { items: [] } })) };
      }
      if (name.includes("logo-registry")) return { PLACEHOLDER: "placeholder.png", getTeamLogo: () => "logo.png" };
      if (name.includes("level-presentation")) {
        return { buildLevelView: () => ({ state: "rated", title: "", detail: "", progressPercent: 0, showProgress: false }) };
      }
      if (name.includes("team-presentation")) return { presentTeam: () => ({ nameZh: "", logo: "" }) };
      if (name.includes("team-registry")) return { findTeam: () => null };
      if (name.includes("prediction-history")) return { formatShanghaiKickoff: () => "" };
      if (name.includes("rankings-copy")) return copy;
      if (name.includes("ui-layout")) return { headerHeight: () => 88 };
      throw new Error("unexpected require " + name);
    },
    wx: {
      navigateTo,
      getStorageSync: () => "",
      setStorageSync: () => {},
    },
  });
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(value) { Object.assign(this.data, value); },
  };
  return { page, listMyGroups, createGroup, navigateTo };
}

describe("profile season report card and owned group count", () => {
  it("binds season.season_points and season.exact_hits in the report card", async () => {
    const wxml = readFileSync(new URL("./profile.wxml", import.meta.url), "utf8");
    expect(wxml).toContain("{{statScope === 'career' ? careerPoints : seasonPoints}}");
    expect(wxml).toContain("{{statScope === 'career' ? careerExactHits : seasonExactHits}}");
    expect(wxml).not.toMatch(/careerPoints : '—'/);
    expect(wxml).not.toMatch(/careerExactHits : '—'/);

    const { page } = loadPage({ season: { season_points: 24, exact_hits: 2 } });
    page.loadPage();
    await vi.waitFor(() => expect(page.data.state).toBe("ready"));
    expect(page.data.seasonPoints).toBe("24");
    expect(page.data.seasonExactHits).toBe("2");
  });

  it("keeps a season score of 0 instead of the missing placeholder", async () => {
    const { page } = loadPage({ season: { season_points: 0, exact_hits: 0 } });
    page.loadPage();
    await vi.waitFor(() => expect(page.data.state).toBe("ready"));
    expect(page.data.seasonPoints).toBe("0");
    expect(page.data.seasonExactHits).toBe("0");
  });

  it("keeps the existing empty placeholder when season points or exact hits are missing", async () => {
    const { page } = loadPage({ season: {} });
    page.loadPage();
    await vi.waitFor(() => expect(page.data.state).toBe("ready"));
    expect(page.data.seasonPoints).toBe("—");
    expect(page.data.seasonExactHits).toBe("—");
  });

  it("passes ownedCount + 1 after creating a group from the already-loaded list", async () => {
    const { page, listMyGroups, createGroup, navigateTo } = loadPage({
      groups: [
        { group_id: "g1", display_name: "甲", role: "owner", member_count: 1 },
        { group_id: "g2", display_name: "乙", role: "member", member_count: 4 },
        { group_id: "g3", display_name: "丙", role: "owner", member_count: 2 },
      ],
    });
    page.loadPage();
    await vi.waitFor(() => expect(page.data.state).toBe("ready"));
    expect(listMyGroups).toHaveBeenCalledWith({ limit: 20 });
    expect(page.data.ownedCount).toBe(2);
    await page.onCreateGroupTap();
    expect(createGroup).toHaveBeenCalledOnce();
    expect(navigateTo).toHaveBeenCalledWith({
      url: "/pages/groups/detail?group_id=created-group&created=1&owned_count=3",
    });
  });

  it("passes owned_count=1 when the loaded list has no owned groups", async () => {
    const { page, navigateTo } = loadPage({
      groups: [{ group_id: "g2", display_name: "乙", role: "member", member_count: 4 }],
    });
    page.loadPage();
    await vi.waitFor(() => expect(page.data.state).toBe("ready"));
    await page.onCreateGroupTap();
    expect(navigateTo).toHaveBeenCalledWith({
      url: "/pages/groups/detail?group_id=created-group&created=1&owned_count=1",
    });
  });

  it("counts an owner on page 2 of /v1/groups/me instead of stopping at limit 20", async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => memberGroup(index + 1));
    const { page, listMyGroups, createGroup, navigateTo } = loadPage({
      listMyGroupsImpl: async ({ limit, cursor } = {}) => {
        if (cursor === "page-2") {
          return {
            statusCode: 200,
            data: {
              items: [memberGroup(21, "owner")],
              page: { has_more: false, next_cursor: null },
            },
          };
        }
        return {
          statusCode: 200,
          data: {
            items: firstPage,
            page: { has_more: true, next_cursor: "page-2" },
          },
        };
      },
    });
    page.loadPage();
    await vi.waitFor(() => expect(page.data.state).toBe("ready"));
    expect(listMyGroups).toHaveBeenNthCalledWith(1, { limit: 20 });
    expect(listMyGroups).toHaveBeenNthCalledWith(2, { limit: 20, cursor: "page-2" });
    expect(page.data.ownedCount).toBe(1);
    expect(page.data.groups).toHaveLength(21);
    await page.onCreateGroupTap();
    expect(createGroup).toHaveBeenCalledOnce();
    expect(navigateTo).toHaveBeenCalledWith({
      url: "/pages/groups/detail?group_id=created-group&created=1&owned_count=2",
    });
  });

  it("does not invent ownedCount when a later /v1/groups/me page fails", async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => memberGroup(index + 1, index === 0 ? "owner" : "member"));
    const { page, listMyGroups, createGroup, navigateTo } = loadPage({
      listMyGroupsImpl: async ({ cursor } = {}) => {
        if (cursor === "page-2") {
          return { statusCode: 500, code: "INTERNAL_ERROR", message: "暂时无法读取群列表" };
        }
        return {
          statusCode: 200,
          data: {
            items: firstPage,
            page: { has_more: true, next_cursor: "page-2" },
          },
        };
      },
    });
    page.loadPage();
    await vi.waitFor(() => expect(page.data.state).toBe("error"));
    expect(listMyGroups).toHaveBeenNthCalledWith(1, { limit: 20 });
    expect(listMyGroups).toHaveBeenNthCalledWith(2, { limit: 20, cursor: "page-2" });
    expect(page.data.ownedCount).toBe(0);
    await page.onCreateGroupTap();
    expect(createGroup).not.toHaveBeenCalled();
    expect(navigateTo).not.toHaveBeenCalled();
  });
});
