import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const PAGE_JS = join(HERE, "share-card.js");

const SHARER_ID = "11111111-2222-3333-4444-555555555555";
const SELF_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const originals = {
  Page: Object.getOwnPropertyDescriptor(globalThis, "Page"),
  wx: Object.getOwnPropertyDescriptor(globalThis, "wx"),
  getCurrentPages: Object.getOwnPropertyDescriptor(globalThis, "getCurrentPages"),
};

afterEach(() => {
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
    enumerable: true,
  });
}

function loadCommonJs(filePath, requireShim) {
  const module = { exports: {} };
  const factory = runInThisContext(`(function (module, exports, require) {\n${readFileSync(filePath, "utf8")}\n})`, {
    filename: filePath,
  });
  factory(module, module.exports, requireShim);
  return module.exports;
}

function capturePageConfig(requireShim) {
  let config = null;
  setGlobal("Page", (value) => {
    config = value;
  });
  loadCommonJs(PAGE_JS, requireShim);
  if (!config) throw new Error("share-card.js 未调用 Page()");
  return config;
}

function instantiate(config) {
  const page = Object.assign({}, config);
  page.data = JSON.parse(JSON.stringify(config.data || {}));
  page.setData = function setData(patch) {
    Object.assign(this.data, patch);
  };
  return page;
}

const AUTH_SESSION_STORAGE_KEY = "auth_session";
const ACTIVE_SESSION = {
  access_token: "opaque-token",
  expires_at: "2099-01-01T00:00:00.000Z",
};

function installWxStub({ stored, pages } = {}) {
  const navs = [];
  const shareMenus = [];
  const store = new Map(Object.entries(stored || {}));
  setGlobal("wx", {
    redirectTo(options) {
      navs.push(["redirectTo", options && options.url]);
      if (options && typeof options.success === "function") options.success();
    },
    navigateTo(options) {
      navs.push(["navigateTo", options && options.url]);
      if (options && typeof options.success === "function") options.success();
    },
    navigateBack(options) {
      navs.push(["navigateBack", options && options.delta]);
    },
    hideShareMenu(options) {
      shareMenus.push(["hideShareMenu", options && options.menus]);
    },
    showShareMenu(options) {
      shareMenus.push(["showShareMenu", options && options.menus]);
    },
    getStorageSync(key) {
      return store.get(key);
    },
    setStorageSync(key, value) {
      store.set(key, value);
    },
    removeStorageSync(key) {
      store.delete(key);
    },
  });
  setGlobal("getCurrentPages", () => pages || []);
  return { navs, store, shareMenus };
}

function loadUtil(relativePath, requireShim) {
  return loadCommonJs(join(ROOT, "utils", relativePath), requireShim);
}

function shareCardData(overrides = {}) {
  return {
    user_id: SELF_ID,
    display_name: "Sky",
    favorite_team_id: null,
    season_level: 3,
    league_id: "premier_league",
    season_id: "2026_2027",
    season_label: "2026/2027",
    round_id: "12",
    round_predictions: 8,
    round_wdl_hits: 5,
    round_exact_hits: 2,
    round_score: 21,
    career_points: 180,
    level_season_id: "2026_2027",
    generated_at: "2026-11-15T15:00:00.000Z",
    pending_predictions: 0,
    ...overrides,
  };
}

function catalogItems() {
  return [
    { league_id: "premier_league", season_id: "2026_2027", season_label: "2026/27", round_ids: ["12", "01"] },
    { league_id: "premier_league", season_id: "2025_2026", season_label: "2025/26", round_ids: ["01"] },
    { league_id: "la_liga", season_id: "2026_2027", season_label: "2026/27", round_ids: ["03"] },
  ];
}

function loadPage({ getMyShareCard, getShareCardForUser, listLeagueSeasons, stored, pages, transport = "http" } = {}) {
  const wxStub = installWxStub({ stored, pages });
  const getMyShareCardFn = getMyShareCard || vi.fn(async () => ({
    statusCode: 200,
    data: shareCardData(),
  }));
  const getShareCardForUserFn = getShareCardForUser || vi.fn(async () => ({
    statusCode: 200,
    data: shareCardData({ user_id: SHARER_ID, display_name: "Sharer" }),
  }));
  const listLeagueSeasonsFn = listLeagueSeasons || vi.fn(async () => ({
    statusCode: 200,
    data: { items: catalogItems() },
  }));
  const matchPresentation = loadUtil("match-presentation.js", () => {
    throw new Error("match-presentation has no dependencies");
  });
  const authStorage = loadUtil("auth-storage.js", () => {
    throw new Error("auth-storage has no dependencies");
  });
  const config = capturePageConfig((id) => {
    if (id === "../../config.js") return { transport };
    if (id === "../../services/share-card.js") {
      return { getMyShareCard: getMyShareCardFn, getShareCardForUser: getShareCardForUserFn };
    }
    if (id === "../../services/league-seasons.js") return { listLeagueSeasons: listLeagueSeasonsFn };
    if (id === "../../utils/match-presentation.js") return matchPresentation;
    if (id === "../../utils/auth-storage.js") return authStorage;
    throw new Error(`Unexpected require: ${id}`);
  });
  return {
    page: instantiate(config),
    getMyShareCard: getMyShareCardFn,
    getShareCardForUser: getShareCardForUserFn,
    listLeagueSeasons: listLeagueSeasonsFn,
    ...wxStub,
  };
}

const QUERY = {
  league_id: "premier_league",
  season_id: "2026_2027",
  round_id: "12",
};

describe("share-card page", () => {
  it("preview mode onLoad calls getMyShareCard and not getShareCardForUser", async () => {
    const { page, getMyShareCard, getShareCardForUser } = loadPage();
    await page.onLoad({ ...QUERY });
    expect(page.data.mode).toBe("preview");
    expect(page.data.sharerId).toBeNull();
    expect(getMyShareCard).toHaveBeenCalledTimes(1);
    expect(getMyShareCard).toHaveBeenCalledWith({
      leagueId: "premier_league",
      seasonId: "2026_2027",
      roundId: "12",
    });
    expect(getShareCardForUser).toHaveBeenCalledTimes(0);
  });

  it("receiver mode onLoad calls getShareCardForUser with the sharer id and not getMyShareCard", async () => {
    const { page, getMyShareCard, getShareCardForUser } = loadPage();
    await page.onLoad({ user_id: SHARER_ID, ...QUERY });
    expect(page.data.mode).toBe("receiver");
    expect(page.data.sharerId).toBe(SHARER_ID);
    expect(getShareCardForUser).toHaveBeenCalledTimes(1);
    expect(getShareCardForUser).toHaveBeenCalledWith(SHARER_ID, {
      leagueId: "premier_league",
      seasonId: "2026_2027",
      roundId: "12",
    });
    expect(getMyShareCard).toHaveBeenCalledTimes(0);
  });

  it("maps a 200 response onto card state fields", async () => {
    const { page } = loadPage();
    await page.onLoad({ ...QUERY });
    expect(page.data.state).toBe("card");
    expect(page.data.card.settledCount).toBe(8);
    expect(page.data.card.roundScore).toBe(21);
    expect(page.data.card.displayName).toBe("Sky");
  });

  it("keeps pendingCount when pending_predictions is greater than 0", async () => {
    const getMyShareCard = vi.fn(async () => ({
      statusCode: 200,
      data: shareCardData({ pending_predictions: 3, round_predictions: 5 }),
    }));
    const { page } = loadPage({ getMyShareCard });
    await page.onLoad({ ...QUERY });
    expect(page.data.state).toBe("card");
    expect(page.data.card.pendingCount).toBe(3);
    expect(page.data.card.settledCount).toBe(5);
  });

  it("share path keeps the original sharer and season/round in receiver mode", async () => {
    const getShareCardForUser = vi.fn(async () => ({
      statusCode: 200,
      data: shareCardData({
        user_id: SHARER_ID,
        display_name: "Sharer",
        pending_predictions: 2,
        round_predictions: 6,
      }),
    }));
    const { page, getMyShareCard } = loadPage({ getShareCardForUser });
    await page.onLoad({ user_id: SHARER_ID, ...QUERY });
    expect(getMyShareCard).toHaveBeenCalledTimes(0);
    const share = page.onShareAppMessage();
    expect(share.path).toContain(`user_id=${SHARER_ID}`);
    expect(share.path).toContain("league_id=premier_league");
    expect(share.path).toContain("season_id=2026_2027");
    expect(share.path).toContain("round_id=12");
    expect(share.path).toMatch(/^\/pages\/share-card\/share-card\?/);
    expect(share.title).toContain("Sharer");
    expect(share.title).toContain("已结算 6 场");
    expect(share.title).not.toMatch(/未结算/);
  });

  it("maps 404 ROUND to roundNotFound and clears the card", async () => {
    const getMyShareCard = vi.fn(async () => ({
      statusCode: 404,
      code: "ROUND",
      message: "round missing",
    }));
    const { page } = loadPage({ getMyShareCard });
    await page.onLoad({ ...QUERY });
    expect(page.data.state).toBe("error");
    expect(page.data.errorKind).toBe("roundNotFound");
    expect(page.data.errorMessage).toBe("这个轮次还没有接入，换个轮次看看");
    expect(page.data.card).toBeNull();
  });

  it("maps 409 USER_DELETED to userUnavailable and clears the card", async () => {
    const getShareCardForUser = vi.fn(async () => ({
      statusCode: 409,
      code: "USER_DELETED",
      message: "用户已注销",
    }));
    const { page } = loadPage({ getShareCardForUser });
    await page.onLoad({ user_id: SHARER_ID, ...QUERY });
    expect(page.data.state).toBe("error");
    expect(page.data.errorKind).toBe("userUnavailable");
    expect(page.data.errorMessage).toBe("这位用户已注销");
    expect(page.data.card).toBeNull();
  });

  it("maps a non-200 like 500 to failed with card null instead of a zero-score card", async () => {
    const getMyShareCard = vi.fn(async () => ({
      statusCode: 500,
      code: "INTERNAL",
      message: "boom",
    }));
    const { page } = loadPage({ getMyShareCard });
    await page.onLoad({ ...QUERY });
    expect(page.data.state).toBe("error");
    expect(page.data.errorKind).toBe("failed");
    expect(page.data.errorMessage).toBe("boom");
    expect(page.data.card).toBeNull();
    expect(JSON.stringify(page.data)).not.toMatch(/"roundScore":0/);
    expect(JSON.stringify(page.data)).not.toMatch(/"settledCount":0/);
  });

  it("maps a network failure result to network instead of failed", async () => {
    const getMyShareCard = vi.fn(async () => ({
      statusCode: 0,
      code: "NETWORK_ERROR",
      message: "网络异常",
    }));
    const { page } = loadPage({ getMyShareCard });
    await page.onLoad({ ...QUERY });
    expect(page.data.state).toBe("error");
    expect(page.data.errorKind).toBe("network");
    expect(page.data.errorMessage).toBe("网络异常，请重试");
    expect(page.data.card).toBeNull();
  });

  it("does not map a server 500 to network", async () => {
    const getMyShareCard = vi.fn(async () => ({
      statusCode: 500,
      code: "INTERNAL",
      message: "boom",
    }));
    const { page } = loadPage({ getMyShareCard });
    await page.onLoad({ ...QUERY });
    expect(page.data.state).toBe("error");
    expect(page.data.errorKind).toBe("failed");
    expect(page.data.errorKind).not.toBe("network");
    expect(page.data.errorMessage).toBe("boom");
    expect(page.data.card).toBeNull();
  });

  it("maps a thrown service error to network and error state", async () => {
    const getMyShareCard = vi.fn(async () => {
      throw new Error("offline");
    });
    const { page } = loadPage({ getMyShareCard });
    await page.onLoad({ ...QUERY });
    expect(page.data.state).toBe("error");
    expect(page.data.errorKind).toBe("network");
    expect(page.data.errorMessage).toBe("网络异常，请重试");
    expect(page.data.card).toBeNull();
  });

  it("maps preview 401 to unauthorized so the login button condition is true", async () => {
    const getMyShareCard = vi.fn(async () => ({
      statusCode: 401,
      code: "UNAUTHORIZED",
      message: "需要重新登录",
    }));
    const { page } = loadPage({ getMyShareCard });
    await page.onLoad({ ...QUERY });
    expect(page.data.state).toBe("error");
    expect(page.data.errorKind).toBe("unauthorized");
    expect(page.data.errorMessage).toBe("登录后才能查看自己的成绩单");
    expect(page.data.card).toBeNull();
    expect(page.data.errorKind === "unauthorized").toBe(true);
  });

  it("onLoginTap navigates to session with return_to=share-card", async () => {
    const getMyShareCard = vi.fn(async () => ({
      statusCode: 401,
      code: "UNAUTHORIZED",
    }));
    const { page, navs } = loadPage({ getMyShareCard });
    await page.onLoad({ ...QUERY });
    page.onLoginTap();
    expect(navs).toContainEqual(["navigateTo", "/pages/session/session?return_to=share-card"]);
  });

  it("onShow after login retries the card with the same league/season/round", async () => {
    const getMyShareCard = vi.fn(async () => ({
      statusCode: 401,
      code: "UNAUTHORIZED",
    }));
    const { page, getMyShareCard: getMy, store } = loadPage({ getMyShareCard });
    await page.onLoad({ ...QUERY });
    expect(getMy).toHaveBeenCalledTimes(1);
    page.onLoginTap();
    getMy.mockResolvedValueOnce({ statusCode: 200, data: shareCardData() });
    store.set(AUTH_SESSION_STORAGE_KEY, ACTIVE_SESSION);
    await page.onShow();
    expect(getMy).toHaveBeenCalledTimes(2);
    expect(getMy).toHaveBeenLastCalledWith({
      leagueId: "premier_league",
      seasonId: "2026_2027",
      roundId: "12",
    });
    expect(page.data.state).toBe("card");
  });

  it("onShow after login without a session does not retry and keeps the error", async () => {
    const getMyShareCard = vi.fn(async () => ({
      statusCode: 401,
      code: "UNAUTHORIZED",
    }));
    const { page, getMyShareCard: getMy } = loadPage({ getMyShareCard });
    await page.onLoad({ ...QUERY });
    page.onLoginTap();
    await page.onShow();
    expect(getMy).toHaveBeenCalledTimes(1);
    expect(page.data.state).toBe("error");
    expect(page.data.errorKind).toBe("unauthorized");
  });

  it("receiver login return still requests the original sharer id", async () => {
    const getShareCardForUser = vi.fn(async () => ({
      statusCode: 401,
      code: "UNAUTHORIZED",
    }));
    const { page, getMyShareCard, getShareCardForUser: getForUser, store } = loadPage({ getShareCardForUser });
    await page.onLoad({ user_id: SHARER_ID, ...QUERY });
    expect(getForUser).toHaveBeenCalledTimes(1);
    expect(getMyShareCard).toHaveBeenCalledTimes(0);
    expect(page.data.errorKind).toBe("unauthorized");
    page.onLoginTap();
    getForUser.mockResolvedValueOnce({
      statusCode: 200,
      data: shareCardData({ user_id: SHARER_ID, display_name: "Sharer" }),
    });
    store.set(AUTH_SESSION_STORAGE_KEY, ACTIVE_SESSION);
    await page.onShow();
    expect(getMyShareCard).toHaveBeenCalledTimes(0);
    expect(getForUser).toHaveBeenCalledTimes(2);
    expect(getForUser).toHaveBeenLastCalledWith(SHARER_ID, {
      leagueId: "premier_league",
      seasonId: "2026_2027",
      roundId: "12",
    });
    expect(page.data.mode).toBe("receiver");
    expect(page.data.sharerId).toBe(SHARER_ID);
  });

  it("resets the selected round and returns to picker after changing league", async () => {
    const { page, getMyShareCard } = loadPage();
    await page.onLoad({});
    expect(page.data.state).toBe("picker");
    expect(getMyShareCard).toHaveBeenCalledTimes(0);
    page.onLeagueChange({ detail: { value: "1" } });
    page.onSeasonChange({ detail: { value: "1" } });
    await page.onRoundChange({ detail: { value: "1" } });
    expect(page.data.selectedLeagueId).toBe("premier_league");
    expect(page.data.selectedSeasonId).toBe("2026_2027");
    expect(page.data.selectedRoundId).toBe("01");
    expect(page.data.state).toBe("card");
    page.onLeagueChange({ detail: { value: "2" } });
    expect(page.data.selectedRoundId).toBeNull();
    expect(page.data.roundIndex).toBe(0);
    expect(page.data.seasonIndex).toBe(0);
    expect(page.data.state).toBe("picker");
    expect(page.data.card).toBeNull();
  });

  it("hides the share menu and does not share empty identity params before a card is ready", async () => {
    const { page, shareMenus } = loadPage();
    await page.onLoad({});
    expect(page.data.state).toBe("picker");
    expect(page.data.card).toBeNull();
    expect(shareMenus).toContainEqual(["hideShareMenu", ["shareAppMessage", "shareTimeline"]]);
    const share = page.onShareAppMessage();
    expect(share.path).toBe("/pages/matches/matches");
    expect(share.path).not.toContain("user_id=");
    expect(share.path).not.toContain("league_id=");
  });

  it("shows the share menu and uses loaded card params even if pickers later diverge", async () => {
    const { page, shareMenus } = loadPage();
    await page.onLoad({ ...QUERY });
    expect(page.data.state).toBe("card");
    expect(shareMenus).toContainEqual(["showShareMenu", ["shareAppMessage", "shareTimeline"]]);
    page.setData({
      selectedLeagueId: "la_liga",
      selectedSeasonId: "2025_2026",
      selectedRoundId: "03",
    });
    const share = page.onShareAppMessage();
    expect(share.path).toContain(`user_id=${SELF_ID}`);
    expect(share.path).toContain("league_id=premier_league");
    expect(share.path).toContain("season_id=2026_2027");
    expect(share.path).toContain("round_id=12");
    expect(share.path).not.toContain("league_id=la_liga");
  });

  it("hides the share menu again after a failed load and after changing filters", async () => {
    const getMyShareCard = vi.fn(async () => ({
      statusCode: 500,
      code: "INTERNAL",
      message: "boom",
    }));
    const failed = loadPage({ getMyShareCard });
    await failed.page.onLoad({ ...QUERY });
    expect(failed.page.data.state).toBe("error");
    expect(failed.shareMenus.at(-1)).toEqual(["hideShareMenu", ["shareAppMessage", "shareTimeline"]]);

    const loaded = loadPage();
    await loaded.page.onLoad({ ...QUERY });
    expect(loaded.shareMenus.at(-1)[0]).toBe("showShareMenu");
    loaded.page.onLeagueChange({ detail: { value: "2" } });
    expect(loaded.page.data.state).toBe("picker");
    expect(loaded.shareMenus.at(-1)).toEqual(["hideShareMenu", ["shareAppMessage", "shareTimeline"]]);
  });

  it("navigates back to my-predictions when that page is already on the stack", () => {
    const { page, navs } = loadPage({
      pages: [
        { route: "pages/my-predictions/my-predictions" },
        { route: "pages/share-card/share-card" },
      ],
    });
    page.onBackToPredictions();
    expect(navs).toContainEqual(["navigateBack", 1]);
    expect(navs.some((entry) => entry[0] === "redirectTo")).toBe(false);
  });

  it("redirects to my-predictions when that page is not on the stack", () => {
    const { page, navs } = loadPage({ pages: [{ route: "pages/share-card/share-card" }] });
    page.onBackToPredictions();
    expect(navs).toContainEqual(["redirectTo", "/pages/my-predictions/my-predictions"]);
    expect(navs.some((entry) => entry[0] === "navigateBack")).toBe(false);
  });

  it("onShow after login in CloudBase transport retries without checking HTTP auth_session", async () => {
    const getMyShareCard = vi.fn(async () => ({
      statusCode: 401,
      code: "UNAUTHORIZED",
    }));
    const { page, getMyShareCard: getMy } = loadPage({ getMyShareCard, transport: "cloud" });
    await page.onLoad({ ...QUERY });
    page.onLoginTap();
    getMy.mockResolvedValueOnce({ statusCode: 200, data: shareCardData() });
    await page.onShow();
    expect(getMy).toHaveBeenCalledTimes(2);
    expect(page.data.state).toBe("card");
  });

  it("onReselect after userUnavailable resets receiver mode to preview and clears sharerId", async () => {
    const getShareCardForUser = vi.fn(async () => ({
      statusCode: 409,
      code: "USER_DELETED",
      message: "用户已注销",
    }));
    const { page, getMyShareCard, getShareCardForUser: getForUser } = loadPage({ getShareCardForUser });
    await page.onLoad({ user_id: SHARER_ID, ...QUERY });
    expect(page.data.errorKind).toBe("userUnavailable");
    page.onReselect();
    expect(page.data.state).toBe("picker");
    expect(page.data.mode).toBe("preview");
    expect(page.data.sharerId).toBeNull();
    await page.onRoundChange({ detail: { value: "1" } });
    expect(getForUser).toHaveBeenCalledTimes(1);
    expect(getMyShareCard).toHaveBeenCalledTimes(1);
  });

  it("resets roundIndex when reselecting so the same round can be picked again", async () => {
    const { page } = loadPage();
    await page.onLoad({});
    page.setData({
      roundIndex: 1,
      selectedRoundId: "01",
      selectedLeagueId: "premier_league",
      selectedSeasonId: "2026_2027",
      state: "card",
    });

    page.onReselect();

    expect(page.data.roundIndex).toBe(0);
    expect(page.data.selectedRoundId).toBeNull();
    expect(page.data.selectedLeagueId).toBe("premier_league");
    expect(page.data.selectedSeasonId).toBe("2026_2027");
    expect(page.data.state).toBe("picker");
  });

  it("formats generated_at in UTC+8 regardless of device timezone", async () => {
    vi.stubEnv("TZ", "UTC");
    try {
      const { page } = loadPage();
      await page.onLoad({ ...QUERY });
      // 2026-11-15T15:00:00.000Z == 2026-11-15 23:00 UTC+8
      expect(page.data.card.generatedAtText).toBe("2026-11-15 23:00");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
