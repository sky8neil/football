import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const PAGE_URL = new URL("./public-profile.js", import.meta.url);
const WXML_URL = new URL("./public-profile.wxml", import.meta.url);

const originals = {
  wx: Object.getOwnPropertyDescriptor(globalThis, "wx"),
};

afterEach(() => {
  if (originals.wx) Object.defineProperty(globalThis, "wx", originals.wx);
  else delete globalThis.wx;
});

function loadCommonJs(filePath, requireShim, globals = {}) {
  const module = { exports: {} };
  const factory = runInNewContext(
    `(function(module, exports, require) {\n${readFileSync(filePath, "utf8")}\n})`,
    { ...globals },
    { filename: filePath },
  );
  factory(module, module.exports, requireShim);
  return module.exports;
}

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
  listTeams = vi.fn(async () => ({ statusCode: 200, data: { items: [] } })),
  useRealTeamPresentation = false,
  storage = {},
} = {}) {
  let definition;
  const navs = [];
  const wx = {
    getStorageSync: (key) => storage[key],
    setStorageSync: (key, value) => { storage[key] = value; },
    navigateTo: (options) => navs.push(["navigateTo", options.url]),
    navigateBack: (options) => {
      navs.push(["navigateBack", options && options.delta]);
      if (options && typeof options.fail === "function") options.fail();
    },
    switchTab: (options) => navs.push(["switchTab", options.url]),
  };
  Object.defineProperty(globalThis, "wx", {
    value: wx,
    configurable: true,
    writable: true,
    enumerable: true,
  });
  const realTeamRegistry = loadCommonJs(join(ROOT, "utils", "team-registry.js"), () => {
    throw new Error("team-registry has no dependencies");
  });
  const realLogoRegistry = loadCommonJs(join(ROOT, "utils", "logo-registry.js"), (id) => {
    if (id === "./team-registry.js") return realTeamRegistry;
    throw new Error("Unexpected require: " + id);
  });
  const realTeamPresentation = loadCommonJs(join(ROOT, "utils", "team-presentation.js"), (id) => {
    if (id === "./team-registry.js") return realTeamRegistry;
    if (id === "./logo-registry.js") return realLogoRegistry;
    throw new Error("Unexpected require: " + id);
  });
  const teamsService = loadCommonJs(
    join(ROOT, "services", "teams.js"),
    (id) => {
      if (id === "./api.js") return { request: (options) => listTeams(options) };
      throw new Error("Unexpected require: " + id);
    },
    { wx },
  );

  runInNewContext(readFileSync(PAGE_URL, "utf8"), {
    Page: (value) => { definition = value; },
    wx,
    require: (id) => {
      if (id === "../../services/profile.js") return { getPublicProfile };
      if (id === "../../services/teams.js") return teamsService;
      if (id === "../../utils/team-registry.js") {
        return useRealTeamPresentation ? realTeamRegistry : { findTeam };
      }
      if (id === "../../utils/team-presentation.js") {
        return useRealTeamPresentation ? realTeamPresentation : { presentTeam };
      }
      if (id === "../../utils/logo-registry.js") {
        return useRealTeamPresentation ? realLogoRegistry : { PLACEHOLDER: "placeholder.png" };
      }
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
  return { page, getPublicProfile, listTeams, teamsService, storage, navs };
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
    expect(page.data.displayName).toBe("历史用户");
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

  it("[CR43-06] receiver with empty local cache resolves out-of-bundle favorite team via /v1/teams and caches it", async () => {
    const promotedId = "00000000-0000-4000-8000-000000000999";
    const getPublicProfile = vi.fn(async () => ({
      statusCode: 200,
      data: {
        user_id: "00000000-0000-4000-8000-000000000099",
        display_name: "升班马粉丝",
        favorite_team_id: promotedId,
        career_points: 60,
        career_valid_predictions: 10,
        career_exact_hits: 2,
        career_level: 2,
        career_best_level: 3,
        season_level: 2,
      },
    }));
    const listTeams = vi.fn(async () => ({
      statusCode: 200,
      data: {
        items: [
          {
            team_id: promotedId,
            league_id: "premier_league",
            name: "Promoted Athletic",
            name_zh: "升班马竞技",
            logo_url: "https://cdn.example.com/promoted-athletic.png",
          },
        ],
      },
    }));
    const { page, storage, listTeams: requestSpy } = loadPage({
      getPublicProfile,
      listTeams,
      useRealTeamPresentation: true,
      storage: {},
    });

    await page.onLoad({ user_id: "00000000-0000-4000-8000-000000000099" });

    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).toHaveBeenCalledWith({ method: "GET", path: "/v1/teams", auth: "optional" });
    expect(page.data.state).toBe("ready");
    expect(page.data.favoriteTeamId).toBe(promotedId);
    expect(page.data.favoriteTeamText).toBe("升班马竞技");
    expect(page.data.favoriteTeamLogo).toBe("https://cdn.example.com/promoted-athletic.png");
    expect(storage[`team_name:${promotedId}`]).toBe("升班马竞技");
    expect(storage[`team_logo:${promotedId}`]).toBe("https://cdn.example.com/promoted-athletic.png");
  });

  it("[CR43-06] prevents stale /v1/teams update after switching user or unloading and tolerates lookup failure", async () => {
    const promotedId = "00000000-0000-4000-8000-000000000777";
    const teamsDeferred = deferred();
    const getPublicProfile = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 200,
        data: {
          user_id: "u-promoted",
          display_name: "PromotedFan",
          favorite_team_id: promotedId,
          career_points: 10,
          career_valid_predictions: 2,
          career_exact_hits: 0,
          career_level: 1,
          career_best_level: 1,
          season_level: 1,
        },
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        data: {
          user_id: "u-plain",
          display_name: "PlainFan",
          favorite_team_id: null,
          career_points: 20,
          career_valid_predictions: 4,
          career_exact_hits: 1,
          career_level: 2,
          career_best_level: 2,
          season_level: 2,
        },
      });
    const listTeams = vi.fn(() => teamsDeferred.promise);
    const { page } = loadPage({
      getPublicProfile,
      listTeams,
      useRealTeamPresentation: true,
      storage: {},
    });

    const p1 = page.onLoad({ user_id: "u-promoted" });
    await Promise.resolve();
    await Promise.resolve();
    expect(page.data.state).toBe("ready");
    expect(page.data.favoriteTeamText).toBe("已选择球队");

    // Switch to another profile before /v1/teams resolves
    await page.onLoad({ user_id: "u-plain" });
    expect(page.data.displayName).toBe("PlainFan");
    expect(page.data.favoriteTeamText).toBe("未设置");

    teamsDeferred.resolve({
      statusCode: 200,
      data: {
        items: [
          {
            team_id: promotedId,
            league_id: "premier_league",
            name: "Late FC",
            name_zh: "迟到升班马",
            logo_url: "https://cdn.example.com/late.png",
          },
        ],
      },
    });
    await p1;
    expect(page.data.displayName).toBe("PlainFan");
    expect(page.data.favoriteTeamText).toBe("未设置");

    // Unload guard + failure fallback
    const failLoad = loadPage({
      getPublicProfile: vi.fn(async () => ({
        statusCode: 200,
        data: {
          user_id: "u-promoted-2",
          display_name: "Fan2",
          favorite_team_id: promotedId,
          career_points: 0,
          career_valid_predictions: 0,
          career_exact_hits: 0,
          career_level: 1,
          career_best_level: 1,
          season_level: 1,
        },
      })),
      listTeams: vi.fn(async () => {
        throw new Error("network");
      }),
      useRealTeamPresentation: true,
      storage: {},
    });
    await failLoad.page.onLoad({ user_id: "u-promoted-2" });
    expect(failLoad.page.data.state).toBe("ready");
    expect(failLoad.page.data.favoriteTeamText).toBe("已选择球队");
    expect(failLoad.page.data.favoriteTeamLogo).toContain("team-placeholder.png");

    // Verify onUnload blocks late setData
    const lateDeferred = deferred();
    const unloadCase = loadPage({
      getPublicProfile: vi.fn(async () => ({
        statusCode: 200,
        data: {
          user_id: "u-promoted-3",
          display_name: "Fan3",
          favorite_team_id: promotedId,
          career_points: 0,
          career_valid_predictions: 0,
          career_exact_hits: 0,
          career_level: 1,
          career_best_level: 1,
          season_level: 1,
        },
      })),
      listTeams: vi.fn(() => lateDeferred.promise),
      useRealTeamPresentation: true,
      storage: {},
    });
    const setDataSpy = vi.spyOn(unloadCase.page, "setData");
    const p3 = unloadCase.page.onLoad({ user_id: "u-promoted-3" });
    await Promise.resolve();
    await Promise.resolve();
    const beforeUnloadCalls = setDataSpy.mock.calls.length;
    unloadCase.page.onUnload();
    lateDeferred.resolve({
      statusCode: 200,
      data: {
        items: [{ team_id: promotedId, league_id: "premier_league", name: "Late", name_zh: "迟到", logo_url: "https://cdn.example.com/x.png" }],
      },
    });
    await p3;
    expect(setDataSpy.mock.calls.length).toBe(beforeUnloadCalls);
  });

  it("[CR44-02] refreshes cached out-of-bundle favorite team name_zh and logo_url after in-memory cache clears", async () => {
    const promotedId = "00000000-0000-4000-8000-000000000991";
    let version = 1;
    const getPublicProfile = vi.fn(async () => ({
      statusCode: 200,
      data: {
        user_id: "00000000-0000-4000-8000-000000000091",
        display_name: "升班马粉丝",
        favorite_team_id: promotedId,
        career_points: 60,
        career_valid_predictions: 10,
        career_exact_hits: 2,
        career_level: 2,
        career_best_level: 3,
        season_level: 2,
      },
    }));
    const listTeams = vi.fn(async () => ({
      statusCode: 200,
      data: {
        items: [
          version === 1
            ? {
              team_id: promotedId,
              league_id: "premier_league",
              name: "Promoted FC",
              name_zh: null,
              logo_url: "https://cdn.example.com/logo-v1.png",
            }
            : {
              team_id: promotedId,
              league_id: "premier_league",
              name: "Promoted FC",
              name_zh: "升班马竞技",
              logo_url: "https://cdn.example.com/logo-v2.png",
            },
        ],
      },
    }));
    const { page, storage, teamsService, listTeams: requestSpy } = loadPage({
      getPublicProfile,
      listTeams,
      useRealTeamPresentation: true,
      storage: {},
    });

    await page.onLoad({ user_id: "00000000-0000-4000-8000-000000000091" });
    expect(page.data.favoriteTeamText).toBe("Promoted FC");
    expect(page.data.favoriteTeamLogo).toBe("https://cdn.example.com/logo-v1.png");
    expect(storage[`team_name:${promotedId}`]).toBe("Promoted FC");
    expect(storage[`team_logo:${promotedId}`]).toBe("https://cdn.example.com/logo-v1.png");

    // Admin updates name_zh and logo_url; keep wx storage but clear in-memory cache
    version = 2;
    teamsService.clearTeamsCache();

    await page.onLoad({ user_id: "00000000-0000-4000-8000-000000000091" });
    expect(requestSpy).toHaveBeenCalledTimes(2);
    expect(page.data.favoriteTeamText).toBe("升班马竞技");
    expect(page.data.favoriteTeamLogo).toBe("https://cdn.example.com/logo-v2.png");
    expect(storage[`team_name:${promotedId}`]).toBe("升班马竞技");
    expect(storage[`team_logo:${promotedId}`]).toBe("https://cdn.example.com/logo-v2.png");
  });

  it("[CR44-03] resolves inactive out-of-bundle favorite team via /v1/teams/:team_id on a fresh device", async () => {
    const inactiveId = "00000000-0000-4000-8000-000000000992";
    const getPublicProfile = vi.fn(async () => ({
      statusCode: 200,
      data: {
        user_id: "00000000-0000-4000-8000-000000000092",
        display_name: "老球迷",
        favorite_team_id: inactiveId,
        career_points: 120,
        career_valid_predictions: 20,
        career_exact_hits: 5,
        career_level: 3,
        career_best_level: 4,
        season_level: 3,
      },
    }));
    const listTeams = vi.fn(async (options) => {
      if (options.path === "/v1/teams") {
        return { statusCode: 200, data: { items: [] } };
      }
      if (options.path === `/v1/teams/${inactiveId}`) {
        return {
          statusCode: 200,
          data: {
            team_id: inactiveId,
            league_id: "premier_league",
            name: "Relegated Athletic",
            name_zh: "已停用老牌队",
            logo_url: "https://cdn.example.com/relegated-athletic.png",
          },
        };
      }
      return { statusCode: 404, code: "TEAM_NOT_FOUND" };
    });
    const { page, storage, listTeams: requestSpy } = loadPage({
      getPublicProfile,
      listTeams,
      useRealTeamPresentation: true,
      storage: {},
    });

    await page.onLoad({ user_id: "00000000-0000-4000-8000-000000000092" });

    expect(requestSpy).toHaveBeenCalledWith({ method: "GET", path: "/v1/teams", auth: "optional" });
    expect(requestSpy).toHaveBeenCalledWith({ method: "GET", path: `/v1/teams/${inactiveId}`, auth: "optional" });
    expect(page.data.state).toBe("ready");
    expect(page.data.favoriteTeamId).toBe(inactiveId);
    expect(page.data.favoriteTeamText).toBe("已停用老牌队");
    expect(page.data.favoriteTeamLogo).toBe("https://cdn.example.com/relegated-athletic.png");
    expect(storage[`team_name:${inactiveId}`]).toBe("已停用老牌队");
    expect(storage[`team_logo:${inactiveId}`]).toBe("https://cdn.example.com/relegated-athletic.png");
  });

  it("displays gender badge for male/female and hides it for undisclosed, null, or deleted users", async () => {
    const wxml = readFileSync(WXML_URL, "utf8");
    expect(wxml).toContain("/assets/images/baseline-pitch.webp");
    expect(wxml).toContain("emblem-ring");
    expect(wxml).toContain("dark-hero");
    expect(wxml).toContain("gender-badge is-male");
    expect(wxml).toContain("gender-badge is-female");
    expect(wxml).not.toContain("预言家公开档案");
    expect(wxml).not.toContain("每周一 10:00 按窗口表现与积分联合评估");
    expect(wxml).not.toMatch(/<svg[\s>]/i);

    const makeProfile = (overrides = {}) => ({
      statusCode: 200,
      data: {
        user_id: "00000000-0000-4000-8000-000000000100",
        display_name: "北伦敦预言家",
        favorite_team_id: null,
        career_points: 100,
        career_valid_predictions: 20,
        career_exact_hits: 3,
        career_level: 3,
        career_best_level: 4,
        season_level: 3,
        ...overrides,
      },
    });

    const getPublicProfile = vi.fn()
      .mockResolvedValueOnce(makeProfile({ gender: "male" }))
      .mockResolvedValueOnce(makeProfile({ gender: "female" }))
      .mockResolvedValueOnce(makeProfile({ gender: "undisclosed" }))
      .mockResolvedValueOnce(makeProfile({ gender: null }))
      .mockResolvedValueOnce(makeProfile({ display_name: "已注销用户", gender: "male" }));

    const { page } = loadPage({ getPublicProfile });

    await page.onLoad({ user_id: "u-male" });
    expect(page.data.gender).toBe("male");
    expect(page.data.isDeleted).toBe(false);

    await page.onLoad({ user_id: "u-female" });
    expect(page.data.gender).toBe("female");

    await page.onLoad({ user_id: "u-undisclosed" });
    expect(page.data.gender).toBe("");

    await page.onLoad({ user_id: "u-null" });
    expect(page.data.gender).toBe("");

    await page.onLoad({ user_id: "u-deleted" });
    expect(page.data.isDeleted).toBe(true);
    expect(page.data.gender).toBe("");
  });
});
