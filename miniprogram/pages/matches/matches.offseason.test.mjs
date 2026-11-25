import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(join(HERE, "matches.wxml"), "utf8");
const saved = Object.fromEntries(["Page", "wx"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const status = (league_id, phase, extra = {}) => ({ league_id, phase, active_season_id: "2026", has_live_match: false, next_kickoff_at: null, next_matchday: null, next_season_kickoff_at: null, ...extra });
const response = (data) => ({ statusCode: 200, data });
const summary = (extra = {}) => response({ availability: "available", league_id: "chinese_super_league", season_id: "2025", summary: { predicted_matches: 10, wdl_hits: 6, exact_hits: 2, is_provisional: false }, ...extra });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function createPage({ statuses = [status("chinese_super_league", "completed"), status("la_liga", "in_season")], getLeagueStatus, getMyLeagueSummary, listMatches } = {}) {
  let definition;
  const switchTab = vi.fn();
  const navigateTo = vi.fn();
  const storage = new Map();
  Object.defineProperty(globalThis, "Page", { value: (value) => { definition = value; }, configurable: true });
  Object.defineProperty(globalThis, "wx", {
    value: {
      switchTab,
      navigateTo,
      stopPullDownRefresh: vi.fn(),
      getStorageSync: (key) => storage.get(key),
      setStorageSync: (key, value) => { storage.set(key, value); },
      removeStorageSync: (key) => { storage.delete(key); },
    },
    configurable: true,
  });
  const requests = {
    getLeagueStatus: getLeagueStatus || vi.fn(async () => response({ items: statuses })),
    getMyLeagueSummary: getMyLeagueSummary || vi.fn(async () => summary()),
    listMatches: listMatches || vi.fn(async () => response({ items: [] })),
  };
  const factory = runInThisContext(`(function(module, exports, require) {\n${readFileSync(join(HERE, "matches.js"), "utf8")}\n})`);
  const module = { exports: {} };
  factory(module, module.exports, (id) => {
    if (id === "../../utils/ui-layout.js") return { headerHeight: () => 88 };
    if (id === "../../utils/logo-registry.js") return { getTeamLogo: () => "", getLeagueLogo: () => "" };
    if (id === "../../utils/team-presentation.js") {
      return { presentTeam: (team) => ({ teamId: team && team.team_id, nameZh: "球队资料待补全", logo: "", missing: true }) };
    }
    if (id === "../../utils/nickname.js") return { resolveNickname: () => "", truncateNickname: (value) => value };
    if (id === "../../services/matches.js") return { listMatches: requests.listMatches };
    if (id === "../../services/leagues.js") return { getLeagueStatus: requests.getLeagueStatus };
    if (id === "../../utils/matches-default-league.js") {
      const util = { exports: {} };
      runInThisContext(`(function(module, exports) {\n${readFileSync(join(HERE, "../../utils/matches-default-league.js"), "utf8")}\n})`)(util, util.exports);
      return util.exports;
    }
    if (id === "../../services/predictions.js") return { createUuidV4: () => "", submitPrediction: vi.fn(), getMyLeagueSummary: requests.getMyLeagueSummary };
    if (id === "../../utils/crowd-copy.js") return { COPY: { homeLink: "" } };
    if (id === "../../utils/match-presentation.js") {
      const util = { exports: {} };
      runInThisContext(`(function(module, exports) {\n${readFileSync(join(HERE, "../../utils/match-presentation.js"), "utf8")}\n})`)(util, util.exports);
      return util.exports;
    }
    if (id === "../../utils/match-card-state.js") {
      const util = { exports: {} };
      runInThisContext(`(function(module, exports) {\n${readFileSync(join(HERE, "../../utils/match-card-state.js"), "utf8")}\n})`)(util, util.exports);
      return util.exports;
    }
    if (id === "../../utils/rankings-view-model.js") return { currentSeasonId: () => "2026_2027" };
    if (id === "../../utils/level-season.js") {
      const util = { exports: {} };
      runInThisContext(`(function(module, exports) {\n${readFileSync(join(HERE, "../../utils/level-season.js"), "utf8")}\n})`)(util, util.exports);
      return util.exports;
    }
    if (id === "../../services/auth.js") return { getLoginGeneration: () => 0 };
    throw new Error(`Unexpected require: ${id}`);
  });
  const page = Object.assign({}, definition, { data: structuredClone(definition.data), setData(update) { Object.assign(this.data, update); } });
  page.data.selectedLeague = "chinese_super_league";
  page.data.selectedDate = "2026-11-16";
  page.data.dates = module.exports.buildDates(new Date());
  page.data.leagues = ["chinese_super_league", "la_liga"].map((id) => ({ id }));
  return { page, requests, switchTab, navigateTo, storage };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-15T16:00:00Z")); });
afterEach(() => { vi.useRealTimers(); for (const [key, value] of Object.entries(saved)) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; } });

describe("league status and personal summary", () => {
  it.each(["in_season", "break"])("does not show an offseason card for %s", async (phase) => {
    const { page, requests } = createPage({ statuses: [status("chinese_super_league", phase, { next_matchday: { date: "2026-11-20", kickoff_at: "2026-11-20T12:00:00+08:00" } })] });
    await page.loadFirstPage();
    expect(page.data.leagues[0].offSeason).toBe(false);
    expect(page.data.state).toBe("no-match");
    expect(page.data.nextMatch.date).toBe("2026-11-20");
    expect(page.data.emptyIsBreak).toBe(phase === "break");
    expect(requests.getMyLeagueSummary).not.toHaveBeenCalled();
    expect(requests.listMatches).toHaveBeenCalledTimes(1);
  });

  it.each(["completed", "between_seasons"])("shows the confirmed %s card and summary", async (phase) => {
    const { page, requests, switchTab, storage } = createPage({ statuses: [status("chinese_super_league", phase, { next_season_kickoff_at: "2026-12-08T12:00:00+08:00" }), status("la_liga", "in_season")] });
    await page.loadFirstPage();
    expect(page.data.leagues[0].offSeason).toBe(true);
    expect(page.data.state).toBe("offseason");
    expect(page.data.summarySeasonId).toBe("2025");
    expect(page.data.summarySeasonLabel).toBe("2025");
    expect(page.data.leagueSummary).toEqual({ predicted_matches: 10, wdl_hits: 6, exact_hits: 2, is_provisional: false });
    expect(page.data.offseasonInfo.countdownDays).toBe(phase === "between_seasons" ? 22 : null);
    expect(requests.getMyLeagueSummary).toHaveBeenCalledWith({ leagueId: "chinese_super_league" });
    page.onRankingsTap();
    expect(switchTab).toHaveBeenCalledWith({ url: "/pages/rankings/rankings" });
    expect(storage.get("pending_ranking_target")).toEqual({
      board: "season",
    });
    expect(template).toContain("查看 {{levelSeasonLabel}}榜 →");
    expect(template).toContain("查看赛季排行榜 →");
  });

  it("formats a cross-year summary season with slashes", async () => {
    const { page } = createPage({ getMyLeagueSummary: vi.fn(async () => summary({ season_id: "2026_2027" })) });
    await page.loadFirstPage();
    expect(page.data.summarySeasonId).toBe("2026_2027");
    expect(page.data.summarySeasonLabel).toBe("2026/2027");
    expect(template).toContain("{{summarySeasonLabel ? summarySeasonLabel + ' 赛季 · ' : ''}}");
  });

  it.each([
    [{ predicted_matches: 0, wdl_hits: 0, exact_hits: 0, is_provisional: false }, "你本赛季还没有参与该联赛预测"],
    [{ predicted_matches: 3, wdl_hits: 0, exact_hits: 0, is_provisional: true }, "结算更新中"],
  ])("retains the correct zero and provisional data", async (stats, text) => {
    const { page } = createPage({ getMyLeagueSummary: vi.fn(async () => summary({ summary: stats })) });
    await page.loadFirstPage();
    expect(page.data.leagueSummary).toEqual(stats);
    expect(template).toContain(text);
    expect(template).toContain("leagueSummary.predicted_matches > 0");
    expect(template).toContain("{{leagueSummary.wdl_hits}}");
    expect(template).toContain("{{leagueSummary.exact_hits}}");
  });

  it.each([["data_conflict", "数据核对中"], ["not_available", "小结暂不可用"]])("shows unavailable reason %s without statistics", async (reason, text) => {
    const { page } = createPage({ getMyLeagueSummary: vi.fn(async () => summary({ availability: "not_available", summary: null, reason })) });
    await page.loadFirstPage();
    expect(page.data.state).toBe("offseason");
    expect(page.data.summaryReason).toBe(reason);
    expect(page.data.leagueSummary).toBeNull();
    expect(template).toContain(text);
  });

  it("keeps the card on failure and retries only the summary", async () => {
    const getMyLeagueSummary = vi.fn().mockResolvedValueOnce({ statusCode: 503 }).mockResolvedValueOnce(summary());
    const { page, requests } = createPage({ getMyLeagueSummary });
    await page.loadFirstPage();
    expect(page.data.state).toBe("offseason");
    expect(page.data.summaryState).toBe("error");
    expect(template).toContain("小结暂时加载失败，重试");
    await page.onSummaryRetry();
    expect(page.data.summaryState).toBe("ready");
    expect(requests.listMatches).toHaveBeenCalledTimes(1);
    expect(requests.getLeagueStatus).toHaveBeenCalledTimes(1);
    expect(getMyLeagueSummary).toHaveBeenCalledTimes(2);
  });

  it("clears old statistics during loading and rereads on pull-to-refresh", async () => {
    const pending = deferred();
    const getMyLeagueSummary = vi.fn().mockResolvedValueOnce(summary()).mockReturnValueOnce(pending.promise);
    const { page, requests } = createPage({ getMyLeagueSummary });
    await page.loadFirstPage();
    const refreshing = page.onPullDownRefresh();
    expect(page.data.leagueSummary).toBeNull();
    await vi.waitFor(() => expect(getMyLeagueSummary).toHaveBeenCalledTimes(2));
    expect(page.data.summaryState).toBe("loading");
    expect(template).toContain("正在加载个人小结");
    pending.resolve(summary());
    await refreshing;
    expect(requests.getLeagueStatus).toHaveBeenCalledTimes(2);
    expect(requests.listMatches).toHaveBeenCalledTimes(2);
    expect(wx.stopPullDownRefresh).toHaveBeenCalledTimes(1);
  });

  it("selects a live default league without probing each league's matches", async () => {
    const { page, requests } = createPage({ statuses: [status("la_liga", "in_season", { has_live_match: true }), status("chinese_super_league", "between_seasons")] });
    await page.loadFirstPage(true);
    expect(page.data.selectedLeague).toBe("la_liga");
    expect(requests.listMatches).toHaveBeenCalledTimes(1);
    expect(requests.listMatches.mock.calls[0][0].league_id).toBe("la_liga");
  });

  it("reloads on re-entry even if the initial status request is still pending", async () => {
    const pending = deferred();
    const getLeagueStatus = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(response({ items: [status("chinese_super_league", "in_season", { has_live_match: true })] }));
    const { page } = createPage({ getLeagueStatus });
    page.onLoad();
    page.onShow();
    expect(getLeagueStatus).toHaveBeenCalledTimes(1);
    page.onShow();
    expect(getLeagueStatus).toHaveBeenCalledTimes(2);
    pending.resolve(response({ items: [status("chinese_super_league", "completed")] }));
    await vi.waitFor(() => expect(page.data.state).toBe("no-match"));
    expect(page.data.selectedLeague).toBe("chinese_super_league");
    expect(page.data.leagueStatusById.chinese_super_league.phase).toBe("in_season");
  });

  it("discards stale status and summary responses after a league switch", async () => {
    const oldStatus = deferred(); const oldSummary = deferred();
    const getLeagueStatus = vi.fn().mockResolvedValueOnce(response({ items: [status("chinese_super_league", "completed")] })).mockReturnValueOnce(oldStatus.promise).mockResolvedValue(response({ items: [status("la_liga", "in_season")] }));
    const getMyLeagueSummary = vi.fn().mockReturnValueOnce(oldSummary.promise);
    const { page } = createPage({ getLeagueStatus, getMyLeagueSummary });
    const first = page.loadFirstPage();
    await vi.waitFor(() => expect(getMyLeagueSummary).toHaveBeenCalledTimes(1));
    const second = page.loadFirstPage();
    page.onLeagueTap({ currentTarget: { dataset: { id: "la_liga" } } });
    await vi.advanceTimersByTimeAsync(180);
    oldStatus.resolve(response({ items: [status("chinese_super_league", "completed")] }));
    oldSummary.resolve(summary());
    await Promise.all([first, second]);
    expect(page.data.selectedLeague).toBe("la_liga");
    expect(page.data.state).toBe("no-match");
    expect(page.data.leagueSummary).toBeNull();
    expect(page.data.leagueStatusById.la_liga.phase).toBe("in_season");
  });

  it("builds the empty-schedule next matchday without locale timezone APIs", async () => {
    const toLocaleString = Date.prototype.toLocaleString;
    const toLocaleDateString = Date.prototype.toLocaleDateString;
    Date.prototype.toLocaleString = function toLocaleStringMock() {
      throw new Error("toLocaleString should not be used");
    };
    Date.prototype.toLocaleDateString = function toLocaleDateStringMock() {
      throw new Error("toLocaleDateString should not be used");
    };
    try {
      const { page } = createPage({
        statuses: [status("chinese_super_league", "in_season", {
          next_matchday: { date: "2026-11-20", kickoff_at: "2026-11-20T12:00:00+08:00" },
        })],
      });
      await page.loadFirstPage();
      expect(page.data.state).toBe("no-match");
      expect(page.data.nextMatch).toEqual({
        date: "2026-11-20",
        label: "11月20日（周五）",
        daysUntil: 4,
        inDateStrip: true,
        displayText: "跳到下一轮比赛日：11月20日（周五）→",
      });
    } finally {
      Date.prototype.toLocaleString = toLocaleString;
      Date.prototype.toLocaleDateString = toLocaleDateString;
    }
  });

  it("uses the current in-season status after the next season starts", async () => {
    const { page, requests } = createPage({ statuses: [status("chinese_super_league", "in_season", { active_season_id: "2027" })] });
    await page.loadFirstPage();
    expect(page.data.state).toBe("no-match");
    expect(page.data.leagueStatusById.chinese_super_league.active_season_id).toBe("2027");
    expect(requests.getMyLeagueSummary).not.toHaveBeenCalled();
  });

  it.each([
    ["401 UNAUTHORIZED", { statusCode: 401, code: "UNAUTHORIZED" }],
    ["409 USER_DELETED", { statusCode: 409, code: "USER_DELETED" }],
  ])("[A-S7-06] renders guest prompt and login action instead of error when offseason summary returns %s", async (_label, errorResponse) => {
    const { page, navigateTo } = createPage({
      getMyLeagueSummary: vi.fn(async () => errorResponse),
    });
    await page.loadFirstPage();
    expect(page.data.state).toBe("offseason");
    expect(page.data.summaryState).toBe("guest");
    expect(page.data.leagueSummary).toBeNull();
    expect(template).toContain("登录后查看本赛季个人小结");
    expect(template).toContain("去登录");
    page.onSummaryLoginTap();
    expect(navigateTo).toHaveBeenCalledWith({ url: "/pages/session/session" });
  });

  it("[A-S7-11] keeps needsDefaultLeague enabled when initial getLeagueStatus fails and applies default league on retry", async () => {
    const getLeagueStatus = vi.fn()
      .mockResolvedValueOnce({ statusCode: 503 })
      .mockResolvedValueOnce(response({ items: [status("la_liga", "in_season", { has_live_match: true }), status("premier_league", "completed")] }));
    const { page } = createPage({ getLeagueStatus });
    await page.loadFirstPage(true);
    expect(page.needsDefaultLeague).toBe(true);
    expect(page.data.selectedLeague).toBe("chinese_super_league");

    await page.onRetry();
    expect(page.needsDefaultLeague).toBe(false);
    expect(page.data.selectedLeague).toBe("la_liga");
  });
});
