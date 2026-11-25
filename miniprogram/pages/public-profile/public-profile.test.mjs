import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const PAGE_URL = new URL("./public-profile.js", import.meta.url);
const WXML_URL = new URL("./public-profile.wxml", import.meta.url);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function loadPage({
  getPublicProfile = vi.fn(),
  findTeam = () => null,
  presentTeam = (team) => ({ nameZh: team && (team.name_zh || team.name), logo: "logo.png" }),
  storage = {},
} = {}) {
  let definition;
  const navs = [];
  const wx = {
    getStorageSync: (key) => storage[key],
    navigateTo: (options) => navs.push(["navigateTo", options.url]),
    navigateBack: (options) => {
      navs.push(["navigateBack", options && options.delta]);
      if (options && typeof options.fail === "function") options.fail();
    },
    switchTab: (options) => navs.push(["switchTab", options.url]),
  };
  runInNewContext(readFileSync(PAGE_URL, "utf8"), {
    Page: (value) => { definition = value; },
    wx,
    require: (id) => {
      if (id === "../../services/profile.js") return { getPublicProfile };
      if (id === "../../utils/team-registry.js") return { findTeam };
      if (id === "../../utils/team-presentation.js") return { presentTeam };
      if (id === "../../utils/logo-registry.js") return { PLACEHOLDER: "placeholder.png" };
      throw new Error("Unexpected require: " + id);
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
  return { page, getPublicProfile, navs };
}

describe("public-profile page (A-S6-01)", () => {
  it("renders normal public profile with nickname, level/title, favorite team, and career/season stats without predictions", async () => {
    const wxml = readFileSync(WXML_URL, "utf8");
    expect(wxml).toContain("{{displayName}}");
    expect(wxml).toContain("Lv.{{careerLevel}} {{careerLevelName}}");
    expect(wxml).toContain("{{favoriteTeamText}}");
    expect(wxml).toContain("{{careerPoints}}");
    expect(wxml).toContain("{{careerValidPredictions}}");
    expect(wxml).toContain("{{careerExactHits}}");
    expect(wxml).toContain("Lv.{{careerBestLevel}} {{careerBestLevelName}}");
    expect(wxml).toContain("Lv.{{seasonLevel}} {{seasonLevelName}}");
    expect(wxml).not.toContain("pred_home_score");
    expect(wxml).not.toContain("recentPredictions");

    const getPublicProfile = vi.fn(async () => ({
      statusCode: 200,
      data: {
        user_id: "00000000-0000-4000-8000-000000000001",
        display_name: "⚽️球王",
        favorite_team_id: "arsenal-id",
        career_points: 188,
        career_valid_predictions: 42,
        career_exact_hits: 9,
        career_level: 4,
        career_best_level: 5,
        season_level: 3,
      },
    }));
    const { page } = loadPage({
      getPublicProfile,
      findTeam: (id) => id === "arsenal-id"
        ? { league_id: "premier_league", source_name: "Arsenal FC", name_zh: "阿森纳" }
        : null,
      presentTeam: () => ({ nameZh: "阿森纳", logo: "arsenal.png" }),
    });

    await page.onLoad({ user_id: "00000000-0000-4000-8000-000000000001" });

    expect(getPublicProfile).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001");
    expect(page.data.state).toBe("ready");
    expect(page.data.displayName).toBe("⚽️球王");
    expect(page.data.avatarInitial).toBe("⚽");
    expect(page.data.isDeleted).toBe(false);
    expect(page.data.favoriteTeamText).toBe("阿森纳");
    expect(page.data.favoriteTeamLogo).toBe("arsenal.png");
    expect(page.data.careerPoints).toBe("188");
    expect(page.data.careerValidPredictions).toBe("42");
    expect(page.data.careerExactHits).toBe("9");
    expect(page.data.careerLevel).toBe("4");
    expect(page.data.careerLevelName).toBe("坐稳主力");
    expect(page.data.careerBestLevel).toBe("5");
    expect(page.data.careerBestLevelName).toBe("球队核心");
    expect(page.data.seasonLevel).toBe("3");
    expect(page.data.seasonLevelName).toBe("崭露头角");
  });

  it("renders masked state for a deleted user", async () => {
    const { page } = loadPage({
      getPublicProfile: vi.fn(async () => ({
        statusCode: 200,
        data: {
          user_id: "00000000-0000-4000-8000-000000000002",
          display_name: "已注销用户",
          favorite_team_id: null,
          career_points: 50,
          career_valid_predictions: 10,
          career_exact_hits: 2,
          career_level: 2,
          career_best_level: 3,
          season_level: 1,
        },
      })),
    });

    await page.onLoad({ user_id: "00000000-0000-4000-8000-000000000002" });
    expect(page.data.state).toBe("ready");
    expect(page.data.displayName).toBe("已注销用户");
    expect(page.data.isDeleted).toBe(true);
    expect(page.data.hasFavoriteTeam).toBe(false);
    expect(page.data.favoriteTeamText).toBe("未设置");
  });

  it("handles 404, 422, missing user_id, 429 rate limit, and network retry", async () => {
    const getPublicProfile = vi.fn()
      .mockResolvedValueOnce({ statusCode: 404, code: "USER_NOT_FOUND", message: "用户不存在" })
      .mockResolvedValueOnce({ statusCode: 429, code: "RATE_LIMITED", message: "请求过于频繁" })
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({
        statusCode: 200,
        data: {
          user_id: "u1",
          display_name: "Sky",
          favorite_team_id: null,
          career_points: 0,
          career_valid_predictions: 0,
          career_exact_hits: 0,
          career_level: 1,
          career_best_level: 1,
          season_level: 1,
        },
      });
    const { page } = loadPage({ getPublicProfile });

    await page.onLoad({});
    expect(page.data.state).toBe("validationError");
    expect(getPublicProfile).not.toHaveBeenCalled();

    await page.onLoad({ user_id: "u1" });
    expect(page.data.state).toBe("notFound");
    await page.onRetry();
    expect(getPublicProfile).toHaveBeenCalledTimes(1);

    await page.onLoad({ user_id: "u1" });
    expect(page.data.state).toBe("rateLimited");
    await page.onRetry();
    expect(getPublicProfile).toHaveBeenCalledTimes(2);

    await page.onLoad({ user_id: "u1" });
    expect(page.data.state).toBe("error");
    await page.onRetry();
    expect(page.data.state).toBe("ready");
    expect(page.data.displayName).toBe("Sky");
  });

  it("guards against out-of-order responses and rejections with requestSerial", async () => {
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const fourth = deferred();
    const getPublicProfile = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => third.promise)
      .mockImplementationOnce(() => fourth.promise);
    const { page } = loadPage({ getPublicProfile });

    const p1 = page.onLoad({ user_id: "u-stale" });
    const p2 = page.onLoad({ user_id: "u-fresh" });
    second.resolve({
      statusCode: 200,
      data: {
        user_id: "u-fresh",
        display_name: "Fresh",
        favorite_team_id: null,
        career_points: 10,
        career_valid_predictions: 2,
        career_exact_hits: 0,
        career_level: 1,
        career_best_level: 1,
        season_level: 1,
      },
    });
    await p2;
    first.resolve({ statusCode: 404, code: "USER_NOT_FOUND", message: "旧请求404" });
    await p1;

    expect(page.data.state).toBe("ready");
    expect(page.data.displayName).toBe("Fresh");
    expect(page.data.userId).toBe("u-fresh");

    const p3 = page.onRetry();
    const p4 = page.onRetry();
    fourth.resolve({
      statusCode: 200,
      data: {
        user_id: "u-fresh",
        display_name: "FreshRetry",
        favorite_team_id: null,
        career_points: 12,
        career_valid_predictions: 3,
        career_exact_hits: 0,
        career_level: 1,
        career_best_level: 1,
        season_level: 1,
      },
    });
    await p4;
    third.reject(new Error("network"));
    await p3;
    expect(page.data.state).toBe("ready");
    expect(page.data.displayName).toBe("FreshRetry");
  });
});
