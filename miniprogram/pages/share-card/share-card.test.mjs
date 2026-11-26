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
    share_token: "share-token-v1-default",
    matches: [],
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

function loadPage({
  getMyShareCard,
  getShareCardForUser,
  listLeagueSeasons,
  listTeams,
  stored,
  pages,
  transport = "http",
} = {}) {
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
  const listTeamsFn = listTeams || vi.fn(async () => ({
    statusCode: 200,
    data: { items: [] },
  }));
  const teamsService = loadCommonJs(join(ROOT, "services", "teams.js"), (id) => {
    if (id === "./api.js") {
      return {
        request: (options) => listTeamsFn(options),
      };
    }
    throw new Error(`Unexpected require: ${id}`);
  });
  const matchPresentation = loadUtil("match-presentation.js", () => {
    throw new Error("match-presentation has no dependencies");
  });
  const teamRegistry = loadUtil("team-registry.js", () => {
    throw new Error("team-registry has no dependencies");
  });
  const logoRegistry = loadUtil("logo-registry.js", (id) => {
    if (id === "./team-registry.js") return teamRegistry;
    throw new Error(`Unexpected require: ${id}`);
  });
  const teamPresentation = loadUtil("team-presentation.js", (id) => {
    if (id === "./team-registry.js") return teamRegistry;
    if (id === "./logo-registry.js") return logoRegistry;
    throw new Error(`Unexpected require: ${id}`);
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
    if (id === "../../services/teams.js") return teamsService;
    if (id === "../../utils/match-presentation.js") return matchPresentation;
    if (id === "../../utils/team-presentation.js") return teamPresentation;
    if (id === "../../utils/team-registry.js") return teamRegistry;
    if (id === "../../utils/logo-registry.js") return logoRegistry;
    if (id === "../../utils/auth-storage.js") return authStorage;
    throw new Error(`Unexpected require: ${id}`);
  });
  return {
    page: instantiate(config),
    getMyShareCard: getMyShareCardFn,
    getShareCardForUser: getShareCardForUserFn,
    listLeagueSeasons: listLeagueSeasonsFn,
    listTeams: listTeamsFn,
    teamsService,
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

  it("switches summary and title by settledCount > 3 vs <= 3 and removes pendingCount copy", async () => {
    const wxml = readFileSync(join(HERE, "share-card.wxml"), "utf8");
    expect(wxml).toContain("/assets/images/baseline-pitch.webp");
    expect(wxml).not.toContain("home-pitch-bg.webp");
    expect(wxml).not.toContain("pendingCount");
    expect(wxml).not.toContain("没有结算");
    expect(wxml).toContain("{{card.careerPoints}}");
    const fullSummaryBlock = wxml.match(/<block wx:if="\{\{card\.showFullSummary\}\}">[\s\S]*?<\/block>/);
    expect(fullSummaryBlock).not.toBeNull();
    expect(fullSummaryBlock[0]).not.toContain("careerPoints");

    const getMyShareCard = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 200,
        data: shareCardData({ round_predictions: 3, round_score: 12, career_points: 180 }),
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        data: shareCardData({ round_predictions: 4, round_score: 15, career_points: 195 }),
      });
    const { page } = loadPage({ getMyShareCard });

    await page.onLoad({ ...QUERY });
    expect(page.data.state).toBe("card");
    expect(page.data.card.settledCount).toBe(3);
    expect(page.data.card.showFullSummary).toBe(false);
    expect(page.data.card.careerPoints).toBe(180);
    expect(page.data.card.cardTitle).toContain("晒预测");
    expect(page.data.card).not.toHaveProperty("pendingCount");
    expect(page.onShareAppMessage().title).toBe("Sky 晒出了英超第12轮预测");
    expect(page.onShareTimeline().title).toBe("Sky 晒出了英超第12轮预测");

    await page.onLoad({ ...QUERY });
    expect(page.data.card.settledCount).toBe(4);
    expect(page.data.card.showFullSummary).toBe(true);
    expect(page.data.card.cardTitle).toContain("战绩");
    expect(page.onShareAppMessage().title).toBe("Sky 英超第12轮战绩：已拿 15 分");
    expect(page.onShareTimeline().title).toBe("Sky 英超第12轮战绩：已拿 15 分");
  });

  it("share path and onShareTimeline keep sharer, season/round, and share_token in receiver mode", async () => {
    const getShareCardForUser = vi.fn(async () => ({
      statusCode: 200,
      data: shareCardData({
        user_id: SHARER_ID,
        display_name: "Sharer",
        round_predictions: 6,
        round_score: 21,
        share_token: "signed_tok_6",
      }),
    }));
    const { page, getMyShareCard } = loadPage({ getShareCardForUser });
    await page.onLoad({ user_id: SHARER_ID, ...QUERY, share_token: "signed_tok_6" });
    expect(getMyShareCard).toHaveBeenCalledTimes(0);
    expect(getShareCardForUser).toHaveBeenCalledWith(SHARER_ID, {
      leagueId: "premier_league",
      seasonId: "2026_2027",
      roundId: "12",
      shareToken: "signed_tok_6",
    });

    const share = page.onShareAppMessage();
    expect(share.path).toContain(`user_id=${SHARER_ID}`);
    expect(share.path).toContain("league_id=premier_league");
    expect(share.path).toContain("season_id=2026_2027");
    expect(share.path).toContain("round_id=12");
    expect(share.path).toContain("share_token=signed_tok_6");
    expect(share.path).toMatch(/^\/pages\/share-card\/share-card\?/);
    expect(share.title).toBe("Sharer 英超第12轮战绩：已拿 21 分");
    expect(share.title).not.toMatch(/未结算/);

    const timeline = page.onShareTimeline();
    expect(timeline.title).toBe(share.title);
    expect(timeline.query).toContain(`user_id=${SHARER_ID}`);
    expect(timeline.query).toContain("league_id=premier_league");
    expect(timeline.query).toContain("season_id=2026_2027");
    expect(timeline.query).toContain("round_id=12");
    expect(timeline.query).toContain("share_token=signed_tok_6");
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

  it("[Q-PLAN-3 / D-S6-01] renders round matches using presentTeam and navigates with prefill only for open scheduled matches", async () => {
    const getShareCardForUser = vi.fn(async () => ({
      statusCode: 200,
      data: shareCardData({
        user_id: SHARER_ID,
        display_name: "大神",
        favorite_team_id: "f490a3bf-b29f-42ce-a5bc-3cb67ad2baee",
        round_predictions: 2,
        round_score: 12,
        share_token: "tok-copy-bet",
        matches: [
          {
            match_id: "match-open",
            home_team: { team_id: "t-new", name: "Promoted FC", name_zh: "升班马联", logo_url: "https://cdn.example.com/p.png" },
            away_team: { team_id: "e575463d-244b-461b-9b17-dd49f90adb4c", name: "Chelsea FC", name_zh: "切尔西", logo_url: null },
            kickoff_at: "2026-11-16T19:00:00.000Z",
            match_status: "scheduled",
            settlement_status: "not_ready",
            is_prediction_closed: false,
            pred_home_score: 2,
            pred_away_score: 1,
            regular_home_score: null,
            regular_away_score: null,
            match_score: null,
            wdl_hit: null,
            exact_hit: null,
          },
          {
            match_id: "match-live",
            home_team: { team_id: "f490a3bf-b29f-42ce-a5bc-3cb67ad2baee", name: "Arsenal FC", name_zh: "阿森纳", logo_url: null },
            away_team: { team_id: "9f2d9c9d-585a-4f7f-9805-59b65775d267", name: "Liverpool FC", name_zh: "利物浦", logo_url: null },
            kickoff_at: "2026-11-15T19:00:00.000Z",
            match_status: "live",
            settlement_status: "not_ready",
            is_prediction_closed: true,
            pred_home_score: 1,
            pred_away_score: 1,
            regular_home_score: 1,
            regular_away_score: 0,
            match_score: null,
            wdl_hit: null,
            exact_hit: null,
          },
          {
            match_id: "match-settled",
            home_team: { team_id: "f490a3bf-b29f-42ce-a5bc-3cb67ad2baee", name: "Arsenal FC", name_zh: "阿森纳", logo_url: null },
            away_team: { team_id: "e575463d-244b-461b-9b17-dd49f90adb4c", name: "Chelsea FC", name_zh: "切尔西", logo_url: null },
            kickoff_at: "2026-11-14T19:00:00.000Z",
            match_status: "finished",
            settlement_status: "settled",
            is_prediction_closed: true,
            pred_home_score: 3,
            pred_away_score: 0,
            regular_home_score: 3,
            regular_away_score: 0,
            match_score: 12,
            wdl_hit: true,
            exact_hit: true,
          },
          {
            match_id: "match-cancelled",
            home_team: { team_id: "f490a3bf-b29f-42ce-a5bc-3cb67ad2baee", name: "Arsenal FC", name_zh: "阿森纳", logo_url: null },
            away_team: { team_id: "e575463d-244b-461b-9b17-dd49f90adb4c", name: "Chelsea FC", name_zh: "切尔西", logo_url: null },
            kickoff_at: "2026-11-14T15:00:00.000Z",
            match_status: "cancelled",
            settlement_status: "voided",
            is_prediction_closed: true,
            pred_home_score: 0,
            pred_away_score: 0,
            regular_home_score: null,
            regular_away_score: null,
            match_score: null,
            wdl_hit: null,
            exact_hit: null,
          },
        ],
      }),
    }));
    const { page, navs } = loadPage({ getShareCardForUser });

    await page.onLoad({ user_id: SHARER_ID, ...QUERY, share_token: "tok-copy-bet" });
    expect(page.data.card.favoriteTeamText).toBe("阿森纳");
    expect(page.data.card.hasFavoriteTeam).toBe(true);
    expect(page.data.card.matches).toHaveLength(4);

    const [openItem, liveItem, settledItem, cancelledItem] = page.data.card.matches;
    expect(openItem).toMatchObject({
      matchId: "match-open",
      homeNameZh: "升班马联",
      homeLogo: "https://cdn.example.com/p.png",
      awayNameZh: "切尔西",
      canFollow: true,
      predictionText: "2 : 1",
    });
    expect(openItem.statusText).toContain("未开赛");
    expect(liveItem).toMatchObject({ canFollow: false });
    expect(liveItem.statusText).toContain("进行中");
    expect(settledItem).toMatchObject({ canFollow: false, pointsText: "+12" });
    expect(settledItem.statusText).toContain("精确命中");
    expect(cancelledItem).toMatchObject({ canFollow: false, actualText: "—", pointsText: "不计分" });
    expect(cancelledItem.statusText).toContain("取消");

    page.onFollowTap({
      currentTarget: {
        dataset: {
          matchId: "match-open",
          prefillHome: openItem.predHomeScore,
          prefillAway: openItem.predAwayScore,
        },
      },
    });
    expect(navs.at(-1)).toEqual([
      "navigateTo",
      "/pages/match-detail/match-detail?match_id=match-open&prefill_home=2&prefill_away=1",
    ]);

    page.onMatchTap({
      currentTarget: {
        dataset: {
          matchId: "match-settled",
          canFollow: false,
          prefillHome: settledItem.predHomeScore,
          prefillAway: settledItem.predAwayScore,
        },
      },
    });
    expect(navs.at(-1)).toEqual([
      "navigateTo",
      "/pages/match-detail/match-detail?match_id=match-settled",
    ]);
  });

  it("[D-S1-03] renders masked deleted-user card cleanly when GET /v1/share-card/{user_id} returns 200", async () => {
    const getShareCardForUser = vi.fn(async () => ({
      statusCode: 200,
      data: shareCardData({
        user_id: SHARER_ID,
        display_name: "已注销用户",
        favorite_team_id: null,
        share_token: null,
        round_predictions: 1,
        matches: [],
      }),
    }));
    const { page } = loadPage({ getShareCardForUser });

    await page.onLoad({ user_id: SHARER_ID, ...QUERY });
    expect(page.data.state).toBe("card");
    expect(page.data.card.displayName).toBe("已注销用户");
    expect(page.data.card.isDeleted).toBe(true);
    expect(page.data.card.hasFavoriteTeam).toBe(false);
    expect(page.onShareAppMessage().path).not.toContain("share_token=");
  });

  it("[A-S6-08] maps 429 RATE_LIMITED to rateLimited without retry button and disables onRetry", async () => {
    const wxml = readFileSync(join(HERE, "share-card.wxml"), "utf8");
    expect(wxml).toContain("errorKind === 'network' || errorKind === 'failed'");

    const getShareCardForUser = vi.fn(async () => ({
      statusCode: 429,
      code: "RATE_LIMITED",
      message: "请求过于频繁，请稍后再试",
    }));
    const { page } = loadPage({ getShareCardForUser });

    await page.onLoad({ user_id: SHARER_ID, ...QUERY });
    expect(page.data.state).toBe("error");
    expect(page.data.errorKind).toBe("rateLimited");
    expect(page.data.errorKind === "network" || page.data.errorKind === "failed").toBe(false);

    await page.onRetry();
    expect(getShareCardForUser).toHaveBeenCalledTimes(1);
  });

  it("[A-S6-04] onShareTimeline returns empty query before card is ready", async () => {
    const { page } = loadPage();
    await page.onLoad({});
    const timeline = page.onShareTimeline();
    expect(timeline.query).toBe("");
    expect(timeline.query).not.toContain("user_id=");
  });

  it("[CR43-06] receiver with empty local cache resolves out-of-bundle favorite team via /v1/teams and caches it", async () => {
    const promotedId = "00000000-0000-4000-8000-000000000999";
    const getShareCardForUser = vi.fn(async () => ({
      statusCode: 200,
      data: shareCardData({
        user_id: SHARER_ID,
        display_name: "Sharer",
        favorite_team_id: promotedId,
      }),
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
    const { page, store, listTeams: requestSpy } = loadPage({
      getShareCardForUser,
      listTeams,
      stored: {},
    });

    await page.onLoad({ user_id: SHARER_ID, ...QUERY });

    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).toHaveBeenCalledWith({ method: "GET", path: "/v1/teams", auth: "optional" });
    expect(page.data.state).toBe("card");
    expect(page.data.card.favoriteTeamId).toBe(promotedId);
    expect(page.data.card.favoriteTeamText).toBe("升班马竞技");
    expect(page.data.card.favoriteTeamLogo).toBe("https://cdn.example.com/promoted-athletic.png");
    expect(store.get(`team_name:${promotedId}`)).toBe("升班马竞技");
    expect(store.get(`team_logo:${promotedId}`)).toBe("https://cdn.example.com/promoted-athletic.png");
  });

  it("[CR43-06] guards against late /v1/teams responses after round switch or page unload and falls back cleanly on error", async () => {
    const promotedId = "00000000-0000-4000-8000-000000000777";
    let finishTeams;
    const listTeams = vi.fn(() => new Promise((resolve) => {
      finishTeams = resolve;
    }));
    const getShareCardForUser = vi.fn(async () => ({
      statusCode: 200,
      data: shareCardData({
        user_id: SHARER_ID,
        display_name: "Sharer",
        favorite_team_id: promotedId,
      }),
    }));
    const { page } = loadPage({ getShareCardForUser, listTeams, stored: {} });

    const setDataSpy = vi.spyOn(page, "setData");
    const pendingLoad = page.onLoad({ user_id: SHARER_ID, ...QUERY });
    // Flush microtasks so share card renders immediately while /v1/teams is still in flight
    await Promise.resolve();
    await Promise.resolve();
    expect(page.data.state).toBe("card");
    expect(page.data.card.favoriteTeamText).toBe("已选择球队");

    // Unload before /v1/teams returns -> stale callback must not call setData
    const callsBeforeUnload = setDataSpy.mock.calls.length;
    page.onUnload();
    finishTeams({
      statusCode: 200,
      data: {
        items: [
          {
            team_id: promotedId,
            league_id: "premier_league",
            name: "Promoted FC",
            name_zh: "迟到升班马",
            logo_url: "https://cdn.example.com/late.png",
          },
        ],
      },
    });
    await pendingLoad;
    expect(setDataSpy.mock.calls.length).toBe(callsBeforeUnload);

    // Failure of /v1/teams must keep the share card rendered with fallback text/placeholder
    const failedTeams = vi.fn(async () => ({ statusCode: 500, code: "INTERNAL" }));
    const fallbackCase = loadPage({ getShareCardForUser, listTeams: failedTeams, stored: {} });
    await fallbackCase.page.onLoad({ user_id: SHARER_ID, ...QUERY });
    expect(fallbackCase.page.data.state).toBe("card");
    expect(fallbackCase.page.data.card.favoriteTeamText).toBe("已选择球队");
    expect(fallbackCase.page.data.card.favoriteTeamLogo).toContain("team-placeholder.png");
  });

  it("[CR44-02] refreshes cached out-of-bundle favorite team name_zh and logo_url after in-memory cache clears", async () => {
    const promotedId = "00000000-0000-4000-8000-000000000991";
    let version = 1;
    const getShareCardForUser = vi.fn(async () => ({
      statusCode: 200,
      data: shareCardData({
        user_id: SHARER_ID,
        display_name: "Sharer",
        favorite_team_id: promotedId,
      }),
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
    const { page, store, teamsService, listTeams: requestSpy } = loadPage({
      getShareCardForUser,
      listTeams,
      stored: {},
    });

    await page.onLoad({ user_id: SHARER_ID, ...QUERY });
    expect(page.data.card.favoriteTeamText).toBe("Promoted FC");
    expect(page.data.card.favoriteTeamLogo).toBe("https://cdn.example.com/logo-v1.png");
    expect(store.get(`team_name:${promotedId}`)).toBe("Promoted FC");
    expect(store.get(`team_logo:${promotedId}`)).toBe("https://cdn.example.com/logo-v1.png");

    // Admin updates name_zh and logo_url; keep wx storage but clear in-memory cache
    version = 2;
    teamsService.clearTeamsCache();

    await page.onLoad({ user_id: SHARER_ID, ...QUERY });
    expect(requestSpy).toHaveBeenCalledTimes(2);
    expect(page.data.card.favoriteTeamText).toBe("升班马竞技");
    expect(page.data.card.favoriteTeamLogo).toBe("https://cdn.example.com/logo-v2.png");
    expect(store.get(`team_name:${promotedId}`)).toBe("升班马竞技");
    expect(store.get(`team_logo:${promotedId}`)).toBe("https://cdn.example.com/logo-v2.png");
  });

  it("[CR44-03] resolves inactive out-of-bundle favorite team via /v1/teams/:team_id on a fresh device", async () => {
    const inactiveId = "00000000-0000-4000-8000-000000000992";
    const getShareCardForUser = vi.fn(async () => ({
      statusCode: 200,
      data: shareCardData({
        user_id: SHARER_ID,
        display_name: "Sharer",
        favorite_team_id: inactiveId,
      }),
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
    const { page, store, listTeams: requestSpy } = loadPage({
      getShareCardForUser,
      listTeams,
      stored: {},
    });

    await page.onLoad({ user_id: SHARER_ID, ...QUERY });

    expect(requestSpy).toHaveBeenCalledWith({ method: "GET", path: "/v1/teams", auth: "optional" });
    expect(requestSpy).toHaveBeenCalledWith({ method: "GET", path: `/v1/teams/${inactiveId}`, auth: "optional" });
    expect(page.data.state).toBe("card");
    expect(page.data.card.favoriteTeamId).toBe(inactiveId);
    expect(page.data.card.favoriteTeamText).toBe("已停用老牌队");
    expect(page.data.card.favoriteTeamLogo).toBe("https://cdn.example.com/relegated-athletic.png");
    expect(store.get(`team_name:${inactiveId}`)).toBe("已停用老牌队");
    expect(store.get(`team_logo:${inactiveId}`)).toBe("https://cdn.example.com/relegated-athletic.png");
  });
});
