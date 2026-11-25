import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function loadCommonJs(filePath, requireShim) {
  const module = { exports: {} };
  runInNewContext(readFileSync(filePath, "utf8"), {
    module,
    exports: module.exports,
    require: requireShim,
  });
  return module.exports;
}

const COPY = loadCommonJs(new URL("../../utils/rankings-copy.js", import.meta.url), () => {
  throw new Error("rankings-copy has no dependencies");
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function profile(userId, nickname) {
  return {
    statusCode: 200,
    data: {
      user_id: userId,
      nickname,
      favorite_team_id: null,
      career_points: 10,
      career_valid_predictions: 4,
      career_exact_hits: 1,
      career_level: 2,
      career_best_level: 2,
      season_level: 2,
      previous_season: null,
    },
  };
}

function recentItem(predictionId, name) {
  return {
    prediction_id: predictionId,
    match_id: "match-" + predictionId,
    league_id: "premier_league",
    home_team: { team_id: "home-" + predictionId, name },
    away_team: { team_id: "away-" + predictionId, name },
    kickoff_at: "2026-11-15T15:00:00.000Z",
    pred_home_score: 1,
    pred_away_score: 0,
    match_status: "finished",
    regular_home_score: 1,
    regular_away_score: 0,
    match_score: 12,
    wdl_hit: true,
    exact_hit: true,
  };
}

function loadProfilePage({ getMyProfile, getMyLevels, listMyGroups, listMyPredictions, listMatches, createGroup, getLoginGeneration } = {}) {
  let definition;
  const navs = [];
  const levels = getMyLevels || vi.fn(async () => ({
    statusCode: 200,
    data: {
      season: { level_season_id: "2026_2027", valid_predictions: 3, best_level: 2 },
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
  const groups = listMyGroups || vi.fn(async () => ({ statusCode: 200, data: { items: [] } }));
  const create = createGroup || vi.fn();
  const matches = listMatches || vi.fn(async () => ({ statusCode: 200, data: { items: [], page: {} } }));
  const auth = {
    getLoginGeneration: typeof getLoginGeneration === "function" ? getLoginGeneration : () => 0,
  };
  runInNewContext(readFileSync(new URL("./profile.js", import.meta.url), "utf8"), {
    Page: (value) => { definition = value; },
    require: (name) => {
      if (name.includes("services/profile.js")) return { getMyProfile };
      if (name.includes("services/levels.js")) return { getMyLevels: levels };
      if (name.includes("services/groups.js")) {
        return { listMyGroups: groups, createGroup: create };
      }
      if (name.includes("services/matches.js")) {
        return { listMatches: matches, getMatchDetail: vi.fn() };
      }
      if (name.includes("services/predictions.js")) return { listMyPredictions };
      if (name.includes("services/auth.js")) return auth;
      if (name.includes("logo-registry")) {
        return { PLACEHOLDER: "placeholder.png", getTeamLogo: () => "logo.png" };
      }
      if (name.includes("level-presentation")) {
        return { buildLevelView: () => ({ state: "rated", title: "", detail: "", progressPercent: 0, showProgress: false }) };
      }
      if (name.includes("team-presentation")) {
        return { presentTeam: (team) => ({ nameZh: team && team.name, logo: "" }) };
      }
      if (name.includes("team-registry")) return { findTeam: () => null };
      if (name.includes("prediction-history")) return { formatShanghaiKickoff: () => "" };
      if (name.includes("rankings-copy")) return COPY;
      if (name.includes("ui-layout")) return { headerHeight: () => 88 };
      throw new Error("unexpected require " + name);
    },
    wx: {
      navigateTo: (options) => navs.push(options.url),
      getStorageSync: () => "",
      setStorageSync: () => {},
      removeStorageSync: () => {},
    },
  });
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(value) { Object.assign(this.data, value); },
  };
  page._navs = navs;
  return page;
}

describe("profile recent predictions identity isolation", () => {
  it("keeps the list empty while B loads and ignores late A success or rejection", async () => {
    const aSuccess = deferred();
    const aReject = deferred();
    const bRecent = deferred();
    const getMyProfile = vi.fn()
      .mockResolvedValueOnce(profile("user-a", "A"))
      .mockResolvedValueOnce(profile("user-a", "A"))
      .mockResolvedValueOnce(profile("user-a", "A"))
      .mockResolvedValueOnce(profile("user-b", "B"));
    const listMyPredictions = vi.fn()
      .mockResolvedValueOnce({ statusCode: 200, data: { items: [recentItem("a-1", "A队")] } })
      .mockImplementationOnce(() => aSuccess.promise)
      .mockImplementationOnce(() => aReject.promise)
      .mockImplementationOnce(() => bRecent.promise);
    const page = loadProfilePage({ getMyProfile, listMyPredictions });

    page.onShow();
    await vi.waitFor(() => expect(page.data.recentState).toBe("ready"));
    expect(page.data.nickname).toBe("A");
    expect(page.data.recentPredictions.map((item) => item.prediction_id)).toEqual(["a-1"]);

    page.onShow();
    await vi.waitFor(() => expect(page.data.recentState).toBe("loading"));
    page.onShow();
    await vi.waitFor(() => expect(page.data.recentState).toBe("loading"));
    page.onShow();
    await vi.waitFor(() => expect(page.data.nickname).toBe("B"));
    expect(page.data.state).toBe("ready");
    expect(page.data.recentState).toBe("loading");
    expect(page.data.recentPredictions).toEqual([]);

    aSuccess.resolve({ statusCode: 200, data: { items: [recentItem("a-2", "A队")] } });
    await Promise.resolve();
    aReject.reject(new Error("network"));
    await Promise.resolve();
    expect(page.data.recentState).toBe("loading");
    expect(page.data.recentPredictions).toEqual([]);
    expect(page.data.errorMessage).toBe("");

    bRecent.resolve({ statusCode: 200, data: { items: [recentItem("b-1", "B队")] } });
    await vi.waitFor(() => expect(page.data.recentState).toBe("ready"));
    expect(page.data.recentPredictions.map((item) => item.prediction_id)).toEqual(["b-1"]);
  });

  it("clears identity and recent predictions immediately when the login generation changes", async () => {
    let generation = 0;
    const bProfile = deferred();
    const bRecent = deferred();
    const getMyProfile = vi.fn()
      .mockResolvedValueOnce(profile("user-a", "A"))
      .mockImplementationOnce(() => bProfile.promise);
    const listMyPredictions = vi.fn()
      .mockResolvedValueOnce({ statusCode: 200, data: { items: [recentItem("a-1", "A队")] } })
      .mockImplementationOnce(() => bRecent.promise);
    const page = loadProfilePage({
      getMyProfile,
      listMyPredictions,
      getLoginGeneration: () => generation,
    });

    page.onShow();
    await vi.waitFor(() => expect(page.data.nickname).toBe("A"));
    await vi.waitFor(() => expect(page.data.recentState).toBe("ready"));
    expect(page.data.userId).toBe("user-a");

    generation = 1;
    page.onShow();
    expect(page.data.nickname).toBe("");
    expect(page.data.userId).toBe("");
    expect(page.data.avatarText).toBe("球");
    expect(page.data.recentPredictions).toEqual([]);
    expect(page.data.recentState).toBe("loading");

    bProfile.resolve(profile("user-b", "B"));
    bRecent.resolve({ statusCode: 200, data: { items: [recentItem("b-1", "B队")] } });
    await vi.waitFor(() => expect(page.data.recentState).toBe("ready"));
    expect(page.data.nickname).toBe("B");
    expect(page.data.recentPredictions.map((item) => item.prediction_id)).toEqual(["b-1"]);
  });

  it("clears identity and recent predictions when loadPage enters an error state", async () => {
    const getMyProfile = vi.fn()
      .mockResolvedValueOnce(profile("user-a", "A"))
      .mockResolvedValueOnce({ statusCode: 401, code: "UNAUTHORIZED" });
    const listMyPredictions = vi.fn(async () => ({
      statusCode: 200,
      data: { items: [recentItem("a-1", "A队")] },
    }));
    const page = loadProfilePage({ getMyProfile, listMyPredictions });

    page.onShow();
    await vi.waitFor(() => expect(page.data.recentState).toBe("ready"));
    expect(page.data.nickname).toBe("A");
    expect(page.data.recentPredictions).toHaveLength(1);

    await page.loadPage();
    expect(page.data.state).toBe("unauthorized");
    expect(page.data.nickname).toBe("");
    expect(page.data.userId).toBe("");
    expect(page.data.avatarText).toBe("球");
    expect(page.data.recentPredictions).toEqual([]);
    expect(page.data.recentState).toBe("loading");
  });

  it("only renders the recent prediction list in the ready state", () => {
    const wxml = readFileSync(new URL("./profile.wxml", import.meta.url), "utf8");
    expect(wxml).toContain('<block wx:else><view wx:for="{{recentPredictions}}"');
  });

  it("P-1: preserves identity, recent predictions, and recentRequestSerial on ordinary loadPage errors", async () => {
    const getMyProfile = vi.fn()
      .mockResolvedValueOnce(profile("user-a", "A"))
      .mockResolvedValueOnce({ statusCode: 500, code: "INTERNAL_ERROR" })
      .mockResolvedValueOnce(profile("user-a", "A"))
      .mockResolvedValueOnce(profile("user-a", "A"))
      .mockResolvedValueOnce(profile("user-a", "A"));
    const getMyLevels = vi.fn()
      .mockResolvedValueOnce({ statusCode: 200, data: { season: {}, career: {} } })
      .mockResolvedValueOnce({ statusCode: 200, data: { season: {}, career: {} } })
      .mockResolvedValueOnce({ statusCode: 429, code: "RATE_LIMITED", message: "请求过于频繁" })
      .mockResolvedValueOnce({ statusCode: 200, data: { season: {}, career: {} } })
      .mockResolvedValueOnce({ statusCode: 200, data: { season: {}, career: {} } });
    const listMyGroups = vi.fn()
      .mockResolvedValueOnce({ statusCode: 200, data: { items: [] } })
      .mockResolvedValueOnce({ statusCode: 200, data: { items: [] } })
      .mockResolvedValueOnce({ statusCode: 200, data: { items: [] } })
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({
        statusCode: 200,
        data: { items: [], page: { has_more: true, next_cursor: "" } },
      });
    const listMyPredictions = vi.fn(async () => ({
      statusCode: 200,
      data: { items: [recentItem("a-1", "A队")] },
    }));
    const page = loadProfilePage({ getMyProfile, getMyLevels, listMyGroups, listMyPredictions });

    page.onShow();
    await vi.waitFor(() => expect(page.data.recentState).toBe("ready"));
    const initialSerial = page.recentRequestSerial;

    await page.loadPage();
    expect(page.data.state).toBe("error");
    expect(page.data.userId).toBe("user-a");
    expect(page.data.nickname).toBe("A");
    expect(page.data.recentPredictions.map((item) => item.prediction_id)).toEqual(["a-1"]);
    expect(page.recentRequestSerial).toBe(initialSerial);

    await page.loadPage();
    expect(page.data.state).toBe("rateLimited");
    expect(page.data.errorMessage).toBe("请求过于频繁");
    expect(page.data.userId).toBe("user-a");
    expect(page.recentRequestSerial).toBe(initialSerial);

    await page.loadPage();
    expect(page.data.state).toBe("error");
    expect(page.data.userId).toBe("user-a");
    expect(page.recentRequestSerial).toBe(initialSerial);

    await page.loadPage();
    expect(page.data.state).toBe("error");
    expect(page.data.userId).toBe("user-a");
    expect(page.data.recentPredictions.map((item) => item.prediction_id)).toEqual(["a-1"]);
    expect(page.recentRequestSerial).toBe(initialSerial);
  });

  it("P-2: does not invalidate in-flight recent predictions when main loadPage fails with 500", async () => {
    const recent = deferred();
    const getMyProfile = vi.fn().mockResolvedValueOnce({ statusCode: 500, code: "INTERNAL_ERROR" });
    const listMyPredictions = vi.fn(() => recent.promise);
    const page = loadProfilePage({ getMyProfile, listMyPredictions });

    page.onShow();
    await vi.waitFor(() => expect(page.data.state).toBe("error"));
    expect(page.data.recentState).toBe("loading");

    recent.resolve({ statusCode: 200, data: { items: [recentItem("a-1", "A队")] } });
    await vi.waitFor(() => expect(page.data.recentState).toBe("ready"));
    expect(page.data.state).toBe("error");
    expect(page.data.recentPredictions.map((item) => item.prediction_id)).toEqual(["a-1"]);
  });

  it("P-3: onRetry reloads both main profile and recent predictions without staying loading", async () => {
    const getMyProfile = vi.fn()
      .mockResolvedValueOnce({ statusCode: 500, code: "INTERNAL_ERROR" })
      .mockResolvedValueOnce(profile("user-a", "A"))
      .mockResolvedValueOnce(profile("user-a", "A"));
    const listMyPredictions = vi.fn()
      .mockResolvedValueOnce({ statusCode: 200, data: { items: [recentItem("a-1", "A队")] } })
      .mockResolvedValueOnce({ statusCode: 200, data: { items: [recentItem("a-2", "A队")] } })
      .mockRejectedValueOnce(new Error("network"));
    const page = loadProfilePage({ getMyProfile, listMyPredictions });

    page.onShow();
    await vi.waitFor(() => expect(page.data.state).toBe("error"));
    expect(listMyPredictions).toHaveBeenCalledTimes(1);

    await page.onRetry();
    expect(page.data.state).toBe("ready");
    expect(page.data.recentState).toBe("ready");
    expect(page.data.recentPredictions.map((item) => item.prediction_id)).toEqual(["a-2"]);
    expect(listMyPredictions).toHaveBeenCalledTimes(2);

    await page.onRetry();
    expect(page.data.state).toBe("ready");
    expect(page.data.recentState).toBe("error");
    expect(listMyPredictions).toHaveBeenCalledTimes(3);
  });

  it("P-4: does not send any requests when onRetry is called in rateLimited state", async () => {
    const getMyProfile = vi.fn().mockResolvedValueOnce({
      statusCode: 429,
      code: "RATE_LIMITED",
      message: "请求过于频繁",
    });
    const getMyLevels = vi.fn(async () => ({ statusCode: 200, data: { season: {}, career: {} } }));
    const listMyGroups = vi.fn(async () => ({ statusCode: 200, data: { items: [] } }));
    const listMyPredictions = vi.fn(async () => ({ statusCode: 200, data: { items: [] } }));
    const page = loadProfilePage({ getMyProfile, getMyLevels, listMyGroups, listMyPredictions });

    await page.loadPage();
    expect(page.data.state).toBe("rateLimited");

    await page.onRetry();
    expect(getMyProfile).toHaveBeenCalledTimes(1);
    expect(getMyLevels).toHaveBeenCalledTimes(1);
    expect(listMyGroups).toHaveBeenCalledTimes(1);
    expect(listMyPredictions).not.toHaveBeenCalled();
  });

  it("[A-S6-03] exposes 解锁记录 entry in utility card and navigates to /pages/unlocks/unlocks", () => {
    const wxml = readFileSync(new URL("./profile.wxml", import.meta.url), "utf8");
    const utilityBlock = wxml.match(/<view class="card utility">[\s\S]*?<\/view>/)[0];
    expect(utilityBlock).toContain('bindtap="onUnlocksTap"');
    expect(utilityBlock).toContain("解锁记录");
    expect(utilityBlock).not.toMatch(/穿戴|装扮|佩戴|更换/);

    const page = loadProfilePage({
      getMyProfile: vi.fn(async () => profile("user-a", "A")),
      listMyPredictions: vi.fn(async () => ({ statusCode: 200, data: { items: [] } })),
    });
    page.onUnlocksTap();
    expect(page._navs).toEqual(["/pages/unlocks/unlocks"]);
  });

  it("[A-S6-07] cancels in-flight favorite team lookup and resets favorite team fields on identity change", async () => {
    let generation = 0;
    const delayedMatches = deferred();
    const bProfile = deferred();
    const getMyProfile = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 200,
        data: { ...profile("user-a", "A").data, favorite_team_id: "team-a" },
      })
      .mockImplementationOnce(() => bProfile.promise);
    const listMatches = vi.fn(() => delayedMatches.promise);
    const listMyPredictions = vi.fn(async () => ({ statusCode: 200, data: { items: [] } }));
    const page = loadProfilePage({
      getMyProfile,
      listMyPredictions,
      listMatches,
      getLoginGeneration: () => generation,
    });

    page.onShow();
    await vi.waitFor(() => expect(listMatches).toHaveBeenCalledTimes(1));
    expect(page.data.favoriteTeamId).toBe("team-a");
    const priorFavReqId = page.favoriteTeamRequestId;

    generation = 1;
    page.onShow();
    expect(page.favoriteTeamRequestId).toBeGreaterThan(priorFavReqId);
    expect(page.data.favoriteTeamId).toBeNull();
    expect(page.data.favoriteTeamText).toBe("");
    expect(page.data.favoriteTeamLogo).toBe("placeholder.png");

    delayedMatches.resolve({
      statusCode: 200,
      data: {
        items: [{ league_id: "premier_league", home_team: { team_id: "team-a", name: "Team A" } }],
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(page.data.favoriteTeamId).toBeNull();
    expect(page.data.favoriteTeamText).toBe("");
    expect(page.data.favoriteTeamLogo).toBe("placeholder.png");

    bProfile.resolve(profile("user-b", "B"));
    await vi.waitFor(() => expect(page.data.nickname).toBe("B"));
    expect(page.data.favoriteTeamText).toBe("未设置");
  });

  it("[CR-25] onCreateGroupTap 校验 loginGeneration、收口 401/409 并映射 GROUP_JOIN_LIMIT_REACHED", async () => {
    let generation = 0;
    const delayed = deferred();
    const createGroup = vi.fn()
      .mockImplementationOnce(() => delayed.promise)
      .mockResolvedValueOnce({ statusCode: 409, code: "GROUP_JOIN_LIMIT_REACHED", message: "limit" })
      .mockResolvedValueOnce({ statusCode: 401, code: "UNAUTHORIZED", message: "请先登录" });
    const page = loadProfilePage({
      getMyProfile: vi.fn(async () => profile("user-a", "A")),
      listMyPredictions: vi.fn(async () => ({ statusCode: 200, data: { items: [] } })),
      createGroup,
      getLoginGeneration: () => generation,
    });
    page.setData({ state: "ready" });

    const first = page.onCreateGroupTap();
    generation = 1;
    delayed.resolve({ statusCode: 201, data: { group_id: "stale-group" } });
    await first;
    expect(page.data.groupCreating).toBe(false);
    expect(page._navs).toEqual([]);

    await page.onCreateGroupTap();
    expect(page.data.errorMessage).toBe(COPY.groupJoinErrors.GROUP_JOIN_LIMIT_REACHED);

    await page.onCreateGroupTap();
    expect(page.data.state).toBe("unauthorized");
  });
});
