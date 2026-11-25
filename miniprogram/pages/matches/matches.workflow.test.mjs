import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const MATCHES_JS = join(HERE, "matches.js");
const MATCHES_WXML = join(HERE, "matches.wxml");
const LEAGUE_UTIL = join(HERE, "..", "..", "utils", "matches-default-league.js");
const savedGlobals = {
  Page: Object.getOwnPropertyDescriptor(globalThis, "Page"),
  wx: Object.getOwnPropertyDescriptor(globalThis, "wx"),
};

const match = (id) => ({
  match_id: id,
  league_id: "premier_league",
  kickoff_at: "2026-09-01T10:00:00.000Z",
  match_status: "scheduled",
  can_predict: true,
  can_predict_reason: null,
  regular_home_score: null,
  regular_away_score: null,
  home_team: { team_id: "arsenal", name: "阿森纳" },
  away_team: { team_id: "chelsea", name: "切尔西" },
});

function loadCommonJs(file, requires) {
  const module = { exports: {} };
  const factory = runInThisContext(`(function (module, exports, require) {\n${readFileSync(file, "utf8")}\n})`, {
    filename: file,
  });
  factory(module, module.exports, requires);
  return module.exports;
}

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function loadPage({
  matchesResult,
  submitResult,
  listMatches: listMatchesOverride,
  getLeagueStatus: getLeagueStatusOverride,
  getMyLeagueSummary: getMyLeagueSummaryOverride,
  getLoginGeneration,
} = {}) {
  let loginGeneration = 0;
  const listMatches = listMatchesOverride || vi.fn(async () => matchesResult || ({
    statusCode: 200,
    data: { items: [], page: { has_more: false, next_cursor: null } },
  }));
  const getLeagueStatus = getLeagueStatusOverride || vi.fn(async () => ({ statusCode: 200, data: { items: [] } }));
  const getMyLeagueSummary = getMyLeagueSummaryOverride || vi.fn(async () => ({
    statusCode: 200,
    data: { availability: "not_available", reason: "not_available", summary: null },
  }));
  const submitPrediction = vi.fn(async () => submitResult || ({ statusCode: 201 }));
  const pageConfig = {};
  const storage = new Map();
  const switchTab = vi.fn();
  Object.defineProperty(globalThis, "Page", {
    value: (config) => Object.assign(pageConfig, config),
    configurable: true,
  });
  Object.defineProperty(globalThis, "wx", {
    value: {
      getStorageSync: (key) => storage.get(key),
      setStorageSync: (key, value) => { storage.set(key, value); },
      removeStorageSync: (key) => { storage.delete(key); },
      switchTab,
      stopPullDownRefresh: vi.fn(),
    },
    configurable: true,
  });
  const logoRegistry = { getTeamLogo: () => "team.png", getLeagueLogo: () => "league.png" };
  const nickname = { resolveNickname: () => "球友", truncateNickname: (value) => value };
  loadCommonJs(MATCHES_JS, (id) => {
    if (id === "../../services/auth.js") {
      return { getLoginGeneration: getLoginGeneration || (() => loginGeneration) };
    }
    if (id === "../../utils/logo-registry.js") return logoRegistry;
    if (id === "../../utils/team-presentation.js") {
      return {
        presentTeam: (team, leagueId) => ({
          teamId: team && team.team_id,
          nameZh: "球队资料待补全",
          logo: logoRegistry.getTeamLogo(leagueId, team),
          missing: true,
        }),
      };
    }
    if (id === "../../utils/nickname.js") return nickname;
    if (id === "../../services/matches.js") return { listMatches };
    if (id === "../../services/leagues.js") return { getLeagueStatus };
    if (id === "../../utils/matches-default-league.js") {
      return loadCommonJs(LEAGUE_UTIL, () => { throw new Error("Unexpected league utility dependency"); });
    }
    if (id === "../../services/predictions.js") {
      return { createUuidV4: () => "00000000-0000-4000-8000-000000000001", submitPrediction, getMyLeagueSummary };
    }
    if (id === "../../utils/crowd-copy.js") return { COPY: { homeLink: "大家怎么选 ›" } };
    if (id === "../../utils/ui-layout.js") return { headerHeight: () => 88 };
    if (id === "../../utils/match-presentation.js") {
      return loadCommonJs(join(HERE, "..", "..", "utils", "match-presentation.js"), () => {
        throw new Error("match-presentation has no dependencies");
      });
    }
    if (id === "../../utils/match-card-state.js") {
      return loadCommonJs(join(HERE, "..", "..", "utils", "match-card-state.js"), () => {
        throw new Error("match-card-state has no dependencies");
      });
    }
    if (id === "../../utils/rankings-view-model.js") return { currentSeasonId: () => "2026_2027" };
    if (id === "../../utils/level-season.js") {
      return loadCommonJs(join(HERE, "..", "..", "utils", "level-season.js"), () => {
        throw new Error("level-season has no dependencies");
      });
    }
    throw new Error(`Unexpected require: ${id}`);
  });
  const page = Object.assign({}, pageConfig, {
    data: JSON.parse(JSON.stringify(pageConfig.data)),
    setData(patch) { Object.assign(this.data, patch); },
  });
  return {
    page,
    listMatches,
    submitPrediction,
    getLeagueStatus,
    getMyLeagueSummary,
    storage,
    switchTab,
    bumpLoginGeneration() { loginGeneration += 1; },
  };
}

function predictedMatch(id, home, away) {
  return {
    ...match(id),
    can_predict: false,
    can_predict_reason: "ALREADY_SUBMITTED",
    my_prediction: { pred_home_score: home, pred_away_score: away, match_score: null },
  };
}

function listResult(items, page = { has_more: false, next_cursor: null }) {
  return { statusCode: 200, data: { items, page } };
}

function queuePromises(entries) {
  let calls = 0;
  return vi.fn(() => entries[Math.min(calls++, entries.length - 1)].promise);
}

afterEach(() => {
  for (const [key, descriptor] of Object.entries(savedGlobals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

describe("matches page gateway workflows", () => {
  it("renders supported league tabs with their registered logos", () => {
    const { page } = loadPage();
    page.onLoad();

    expect(page.data.leagues.map(({ id, name, logo }) => [id, name, logo])).toEqual([
      ["premier_league", "英超", "league.png"],
      ["la_liga", "西甲", "league.png"],
      ["serie_a", "意甲", "league.png"],
      ["bundesliga", "德甲", "league.png"],
      ["ligue_1", "法甲", "league.png"],
      ["chinese_super_league", "中超", "league.png"],
    ]);
  });

  it("loads matches for the selected league and Beijing calendar date", async () => {
    const { page, listMatches } = loadPage({
      matchesResult: { statusCode: 200, data: { items: [match("match-1")] } },
    });
    page.setData({ selectedLeague: "la_liga", selectedDate: "2026-09-01" });

    await page.loadFirstPage();

    expect(listMatches).toHaveBeenCalledWith({
      from: "2026-08-31T16:00:00.000Z",
      to: "2026-09-01T16:00:00.000Z",
      league_id: "la_liga",
      limit: 100,
    });
    expect(page.data.state).toBe("list");
    expect(page.data.items.map((item) => item.match_id)).toEqual(["match-1"]);
  });

  it("loads the next page using the API cursor and appends matches", async () => {
    const { page, listMatches } = loadPage({
      matchesResult: {
        statusCode: 200,
        data: { items: [match("match-2")], page: { has_more: false, next_cursor: null } },
      },
    });
    page.setData({
      selectedLeague: "premier_league",
      selectedDate: "2026-09-01",
      items: [page.decorateItem(match("match-1"))],
      hasMore: true,
      nextCursor: "next-page",
    });

    page.onMore();
    await vi.waitFor(() => expect(page.data.loadingMore).toBe(false));

    expect(listMatches).toHaveBeenCalledWith(expect.objectContaining({ cursor: "next-page" }));
    expect(page.data.items.map((item) => item.match_id)).toEqual(["match-1", "match-2"]);
  });

  it("submits the edited score with a UUID and locks the submitted prediction", async () => {
    const { page, submitPrediction } = loadPage();
    const item = match("match-1");
    const key = "premier_league:2026-09-01:match-1";
    page.setData({ selectedLeague: "premier_league", selectedDate: "2026-09-01", items: [item] });
    page.drafts[key] = { home: 2, away: 1 };
    page.uiStates[key] = "editing";

    page.onSubmitTap({ currentTarget: { dataset: { matchId: "match-1" } } });
    await vi.waitFor(() => expect(submitPrediction).toHaveBeenCalledOnce());

    expect(submitPrediction).toHaveBeenCalledWith({
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
      matchId: "match-1",
      homeScore: 2,
      awayScore: 1,
    });
    await vi.waitFor(() => expect(page.uiStates[key]).toBe("submitted_locked"));
    expect(page.submittedMap[key]).toEqual({ home: 2, away: 1, generation: 0 });
  });

  it("prefers server my_prediction over a conflicting local submittedMap", () => {
    const { page } = loadPage();
    const key = "premier_league:2026-09-01:match-1";
    page.setData({ selectedLeague: "premier_league", selectedDate: "2026-09-01" });
    page.submittedMap[key] = { home: 2, away: 1 };
    const decorated = page.decorateItem({
      ...match("match-1"),
      can_predict: false,
      can_predict_reason: "ALREADY_SUBMITTED",
      my_prediction: { pred_home_score: 1, pred_away_score: 0, match_score: null },
    });
    expect(decorated.predText).toBe("已提交 1 : 0 · 不可修改");
    expect(decorated.uiState).toBe("submitted_locked");
    expect(decorated.showPredict).toBe(false);
  });

  it("uses local submittedMap only when server my_prediction is missing or empty", () => {
    const { page } = loadPage();
    const key = "premier_league:2026-09-01:match-1";
    page.setData({ selectedLeague: "premier_league", selectedDate: "2026-09-01" });
    page.submittedMap[key] = { home: 2, away: 1 };
    const missing = page.decorateItem(match("match-1"));
    const empty = page.decorateItem({ ...match("match-1"), my_prediction: null });
    const blank = page.decorateItem({ ...match("match-1"), my_prediction: {} });
    expect(missing.predText).toBe("已提交 2 : 1 · 不可修改");
    expect(empty.predText).toBe("已提交 2 : 1 · 不可修改");
    expect(blank.predText).toBe("已提交 2 : 1 · 不可修改");
    expect(missing.uiState).toBe("submitted_locked");
  });

  it("keeps optimistic local prediction after reload when the list still has empty my_prediction", async () => {
    const { page, submitPrediction } = loadPage({
      matchesResult: {
        statusCode: 200,
        data: { items: [match("match-1")], page: { has_more: false, next_cursor: null } },
      },
    });
    const key = "premier_league:2026-09-01:match-1";
    page.setData({
      selectedLeague: "premier_league",
      selectedDate: "2026-09-01",
      items: [page.decorateItem(match("match-1"))],
    });
    page.drafts[key] = { home: 2, away: 1 };
    page.uiStates[key] = "editing";

    page.onSubmitTap({ currentTarget: { dataset: { matchId: "match-1" } } });
    await vi.waitFor(() => expect(submitPrediction).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(page.data.items[0] && page.data.items[0].predText).toBe("已提交 2 : 1 · 不可修改"));

    expect(page.data.items[0].uiState).toBe("submitted_locked");
    expect(page.data.doneCount).toBe(1);
    expect(page.data.openCount).toBe(0);
    expect(page.data.hintText).toContain("已预测 1 场");
  });

  it("lets a later server my_prediction replace the optimistic local scores on refresh", async () => {
    const { page } = loadPage({
      matchesResult: {
        statusCode: 200,
        data: {
          items: [{
            ...match("match-1"),
            can_predict: false,
            can_predict_reason: "ALREADY_SUBMITTED",
            my_prediction: { pred_home_score: 0, pred_away_score: 0, match_score: 0 },
          }],
          page: { has_more: false, next_cursor: null },
        },
      },
    });
    const key = "premier_league:2026-09-01:match-1";
    page.setData({ selectedLeague: "premier_league", selectedDate: "2026-09-01" });
    page.submittedMap[key] = { home: 2, away: 1 };

    await page.loadFirstPage();

    expect(page.data.items[0].predText).toBe("我的预测 0 : 0 · 得分 +0");
    expect(page.data.items[0].uiState).toBe("submitted_locked");
    expect(page.data.doneCount).toBe(1);
  });

  it("refreshItems keeps server my_prediction and resyncs submitted counts", () => {
    const { page } = loadPage();
    const key = "premier_league:2026-09-01:match-1";
    page.setData({ selectedLeague: "premier_league", selectedDate: "2026-09-01" });
    page.submittedMap[key] = { home: 3, away: 3 };
    page.setData({
      items: [page.decorateItem({
        ...match("match-1"),
        can_predict: false,
        can_predict_reason: "ALREADY_SUBMITTED",
        my_prediction: { pred_home_score: 1, pred_away_score: 1, match_score: null },
      })],
      openCount: 1,
      doneCount: 0,
    });

    page.refreshItems();

    expect(page.data.items[0].predText).toBe("已提交 1 : 1 · 不可修改");
    expect(page.data.items[0].uiState).toBe("submitted_locked");
    expect(page.data.doneCount).toBe(1);
    expect(page.data.openCount).toBe(0);
  });

  it("does not let another date or page's local prediction pollute the current list", async () => {
    const { page, listMatches } = loadPage({
      matchesResult: {
        statusCode: 200,
        data: { items: [match("match-2")], page: { has_more: false, next_cursor: null } },
      },
    });
    page.setData({
      selectedLeague: "premier_league",
      selectedDate: "2026-09-02",
      items: [page.decorateItem({ ...match("match-1"), match_id: "match-1" })],
      hasMore: true,
      nextCursor: "next-page",
    });
    page.submittedMap["premier_league:2026-09-01:match-1"] = { home: 4, away: 0 };
    page.submittedMap["premier_league:2026-09-02:match-2"] = { home: 1, away: 1 };

    page.onMore();
    await vi.waitFor(() => expect(page.data.loadingMore).toBe(false));

    expect(listMatches).toHaveBeenCalledWith(expect.objectContaining({ cursor: "next-page" }));
    expect(page.data.items.map((item) => item.match_id)).toEqual(["match-1", "match-2"]);
    expect(page.data.items[0].predText).toBe("");
    expect(page.data.items[0].showPredict).toBe(true);
    expect(page.data.items[1].predText).toBe("已提交 1 : 1 · 不可修改");
    expect(page.data.items[1].uiState).toBe("submitted_locked");
  });

  it("renders 0-0 scores and settled 0 points from the server prediction", () => {
    const { page } = loadPage();
    page.setData({ selectedLeague: "premier_league", selectedDate: "2026-09-01" });
    const decorated = page.decorateItem({
      ...match("match-1"),
      match_status: "finished",
      can_predict: false,
      can_predict_reason: "CLOSED",
      regular_home_score: 0,
      regular_away_score: 0,
      settlement_status: "settled",
      my_prediction: { pred_home_score: 1, pred_away_score: 0, match_score: 0 },
    });
    expect(decorated.scoreText).toBe("0 : 0");
    expect(decorated.scoreSub).toBe("FT");
    expect(decorated.predText).toBe("我的预测 1 : 0 · 得分 +0");
    expect(decorated.uiState).toBe("submitted_locked");
  });

  it("does not treat leftover submittedMap as the visitor prediction when AUTH_REQUIRED", () => {
    const { page } = loadPage();
    const key = "premier_league:2026-09-01:match-1";
    page.setData({ selectedLeague: "premier_league", selectedDate: "2026-09-01" });
    page.submittedMap[key] = { home: 2, away: 1 };
    page.uiStates[key] = "submitted_locked";
    const decorated = page.decorateItem({
      ...match("match-1"),
      can_predict: false,
      can_predict_reason: "AUTH_REQUIRED",
      my_prediction: null,
    });
    expect(decorated.predText).toBe("未预测");
    expect(decorated.chipText).toBe("需登录后预测");
    expect(decorated.uiState).toBe("collapsed");
    expect(decorated.editorVisible).toBe(false);
    expect(decorated.showPredict).toBe(false);
  });

  it("does not reuse submittedMap after login generation changes", () => {
    let generation = 0;
    const { page } = loadPage({ getLoginGeneration: () => generation });
    const key = "premier_league:2026-09-01:match-1";
    page.setData({ selectedLeague: "premier_league", selectedDate: "2026-09-01" });
    page.submittedMap[key] = { home: 2, away: 1, generation: 0 };
    page.uiStates[key] = "submitted_locked";
    generation = 1;
    const decorated = page.decorateItem({ ...match("match-1"), my_prediction: null });
    expect(decorated.predText).toBe("");
    expect(decorated.showPredict).toBe(true);
    expect(decorated.uiState).toBe("collapsed");
    expect(decorated.editorVisible).toBe(false);
  });

  it("ignores a late submit result after login generation changes", async () => {
    let settle;
    const pending = new Promise((resolve) => { settle = resolve; });
    const { page, submitPrediction, bumpLoginGeneration } = loadPage({ submitResult: pending });
    const key = "premier_league:2026-09-01:match-1";
    page.setData({
      selectedLeague: "premier_league",
      selectedDate: "2026-09-01",
      items: [page.decorateItem(match("match-1"))],
    });
    page.drafts[key] = { home: 2, away: 1 };
    page.uiStates[key] = "editing";
    page.onSubmitTap({ currentTarget: { dataset: { matchId: "match-1" } } });
    await vi.waitFor(() => expect(submitPrediction).toHaveBeenCalledOnce());
    bumpLoginGeneration();
    settle({ statusCode: 201 });
    await Promise.resolve();
    await Promise.resolve();
    expect(page.submittedMap[key]).toBeUndefined();
    const decorated = page.decorateItem({ ...match("match-1"), my_prediction: null });
    expect(decorated.predText).toBe("");
    expect(decorated.showPredict).toBe(true);
    expect(decorated.uiState).toBe("collapsed");
  });

  it("discards a late match list from a previous login generation after listMatches is issued", async () => {
    const pending = deferred();
    const nextList = deferred();
    let generation = 0;
    const listMatches = queuePromises([pending, nextList]);
    const { page, getLeagueStatus } = loadPage({ listMatches, getLoginGeneration: () => generation });
    page.setData({ selectedLeague: "premier_league", selectedDate: "2026-09-01" });
    const loading = page.loadFirstPage();
    await vi.waitFor(() => expect(getLeagueStatus).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(listMatches).toHaveBeenCalledTimes(1));
    generation = 1;
    pending.resolve(listResult([predictedMatch("match-1", 2, 1)]));
    await vi.waitFor(() => expect(listMatches).toHaveBeenCalledTimes(2));
    nextList.resolve(listResult([match("new-1")]));
    await loading;
    expect(page.data.items.map((item) => item.match_id)).toEqual(["new-1"]);
    expect(page.data.items[0].predText).toBe("");
    expect(page.data.state).toBe("list");
    expect(listMatches).toHaveBeenCalledTimes(2);
    expect(getLeagueStatus).toHaveBeenCalledTimes(2);
  });

  it("does not stay loading after generation changes once league status and listMatches are in flight", async () => {
    const status = deferred();
    const pendingList = deferred();
    const nextList = deferred();
    const { page, listMatches, getLeagueStatus, bumpLoginGeneration } = loadPage({
      getLeagueStatus: queuePromises([status, { promise: Promise.resolve({ statusCode: 200, data: { items: [] } }) }]),
      listMatches: queuePromises([pendingList, nextList]),
    });
    page.setData({ selectedLeague: "premier_league", selectedDate: "2026-09-01" });
    const loading = page.loadFirstPage();
    await vi.waitFor(() => expect(getLeagueStatus).toHaveBeenCalledTimes(1));
    status.resolve({ statusCode: 200, data: { items: [] } });
    await vi.waitFor(() => expect(listMatches).toHaveBeenCalledTimes(1));
    bumpLoginGeneration();
    pendingList.resolve(listResult([predictedMatch("old-1", 2, 1)]));
    await vi.waitFor(() => expect(getLeagueStatus).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(listMatches).toHaveBeenCalledTimes(2));
    expect(page.data.state).toBe("loading");
    expect(page.data.items).toEqual([]);
    nextList.resolve(listResult([match("new-1")]));
    await loading;
    expect(page.data.state).toBe("list");
    expect(page.data.items.map((item) => item.match_id)).toEqual(["new-1"]);
    expect(page.data.items[0].predText).toBe("");
    expect(listMatches).toHaveBeenCalledTimes(2);
    expect(getLeagueStatus).toHaveBeenCalledTimes(2);
  });

  it("does not reset a newer identity load when a previous list arrives late", async () => {
    const status = deferred();
    const pendingList = deferred();
    const nextList = deferred();
    const { page, listMatches, getLeagueStatus, bumpLoginGeneration } = loadPage({
      getLeagueStatus: queuePromises([
        status,
        { promise: Promise.resolve({ statusCode: 200, data: { items: [] } }) },
      ]),
      listMatches: queuePromises([pendingList, nextList]),
    });
    page.setData({ selectedLeague: "premier_league", selectedDate: "2026-09-01" });
    page.initialized = true;
    page.hasShown = true;
    const stale = page.loadFirstPage();
    await vi.waitFor(() => expect(getLeagueStatus).toHaveBeenCalledTimes(1));
    status.resolve({ statusCode: 200, data: { items: [] } });
    await vi.waitFor(() => expect(listMatches).toHaveBeenCalledTimes(1));
    bumpLoginGeneration();
    page.onShow();
    await vi.waitFor(() => expect(getLeagueStatus).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(listMatches).toHaveBeenCalledTimes(2));
    pendingList.resolve(listResult([predictedMatch("old-1", 2, 1)]));
    await stale;
    expect(page.data.state).toBe("loading");
    expect(page.data.items).toEqual([]);
    expect(listMatches).toHaveBeenCalledTimes(2);
    expect(getLeagueStatus).toHaveBeenCalledTimes(2);
    nextList.resolve(listResult([match("new-1")]));
    await vi.waitFor(() => expect(page.data.state).toBe("list"));
    expect(page.data.items.map((item) => item.match_id)).toEqual(["new-1"]);
    expect(page.data.items[0].predText).toBe("");
    expect(listMatches).toHaveBeenCalledTimes(2);
    expect(getLeagueStatus).toHaveBeenCalledTimes(2);
  });

  it("does not append a previous identity page or stay loading-more after login generation changes", async () => {
    const pendingMore = deferred();
    const nextList = deferred();
    const { page, listMatches, bumpLoginGeneration } = loadPage({
      listMatches: queuePromises([pendingMore, nextList]),
    });
    page.setData({
      selectedLeague: "premier_league",
      selectedDate: "2026-09-01",
      items: [page.decorateItem(match("match-1"))],
      state: "list",
      hasMore: true,
      nextCursor: "next-page",
    });
    page.loginGeneration = 0;
    page.onMore();
    await vi.waitFor(() => expect(listMatches).toHaveBeenCalledTimes(1));
    bumpLoginGeneration();
    pendingMore.resolve(listResult([predictedMatch("old-2", 4, 0)]));
    await vi.waitFor(() => expect(listMatches).toHaveBeenCalledTimes(2));
    expect(page.data.loadingMore).toBe(false);
    expect(page.data.items.some((item) => item.match_id === "old-2")).toBe(false);
    nextList.resolve(listResult([match("new-1")]));
    await vi.waitFor(() => expect(page.data.state).toBe("list"));
    expect(page.data.items.map((item) => item.match_id)).toEqual(["new-1"]);
    expect(page.data.items[0].predText).toBe("");
    expect(listMatches).toHaveBeenCalledTimes(2);
  });

  it("does not keep a previous identity summary after login generation changes", async () => {
    const pendingSummary = deferred();
    const nextSummary = deferred();
    const { page, getMyLeagueSummary, listMatches, bumpLoginGeneration } = loadPage({
      getMyLeagueSummary: queuePromises([pendingSummary, nextSummary]),
      listMatches: vi.fn(async () => listResult([])),
      getLeagueStatus: vi.fn(async () => ({
        statusCode: 200,
        data: { items: [{ league_id: "premier_league", phase: "completed", next_season_kickoff_at: null }] },
      })),
    });
    page.setData({ selectedLeague: "premier_league", selectedDate: "2026-09-01" });
    const stale = page.loadFirstPage();
    await vi.waitFor(() => expect(listMatches).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(getMyLeagueSummary).toHaveBeenCalledTimes(1));
    expect(page.data.state).toBe("offseason");
    expect(page.data.summaryState).toBe("loading");
    bumpLoginGeneration();
    pendingSummary.resolve({
      statusCode: 200,
      data: { availability: "available", season_id: "2025", summary: { predicted_matches: 9, wdl_hits: 4, exact_hits: 1, is_provisional: false } },
    });
    await vi.waitFor(() => expect(getMyLeagueSummary).toHaveBeenCalledTimes(2));
    expect(page.data.leagueSummary).toBeNull();
    nextSummary.resolve({
      statusCode: 200,
      data: { availability: "available", season_id: "2026", summary: { predicted_matches: 1, wdl_hits: 0, exact_hits: 0, is_provisional: false } },
    });
    await stale;
    expect(page.data.summaryState).toBe("ready");
    expect(page.data.summarySeasonId).toBe("2026");
    expect(page.data.leagueSummary).toEqual({ predicted_matches: 1, wdl_hits: 0, exact_hits: 0, is_provisional: false });
    expect(getMyLeagueSummary).toHaveBeenCalledTimes(2);
    expect(listMatches).toHaveBeenCalledTimes(2);
  });

  it("does not apply a late submit or reset a newer identity load after generation changes", async () => {
    const pendingSubmit = deferred();
    const pendingList = deferred();
    const { page, submitPrediction, listMatches, bumpLoginGeneration } = loadPage({
      submitResult: pendingSubmit.promise,
      listMatches: vi.fn(() => pendingList.promise),
    });
    const key = "premier_league:2026-09-01:match-1";
    page.setData({
      selectedLeague: "premier_league",
      selectedDate: "2026-09-01",
      items: [page.decorateItem(match("match-1"))],
      state: "list",
    });
    page.drafts[key] = { home: 2, away: 1 };
    page.uiStates[key] = "editing";
    page.onSubmitTap({ currentTarget: { dataset: { matchId: "match-1" } } });
    await vi.waitFor(() => expect(submitPrediction).toHaveBeenCalledOnce());
    expect(page.data.items[0].uiState).toBe("submitting");
    bumpLoginGeneration();
    const fresh = page.loadFirstPage();
    await vi.waitFor(() => expect(listMatches).toHaveBeenCalledTimes(1));
    pendingSubmit.resolve({ statusCode: 201 });
    await Promise.resolve();
    await Promise.resolve();
    expect(page.submittedMap[key]).toBeUndefined();
    expect(page.data.items).toEqual([]);
    expect(page.data.state).toBe("loading");
    expect(listMatches).toHaveBeenCalledTimes(1);
    pendingList.resolve(listResult([match("new-1")]));
    await fresh;
    expect(page.data.state).toBe("list");
    expect(page.data.items.map((item) => item.match_id)).toEqual(["new-1"]);
    expect(page.data.items[0].predText).toBe("");
    expect(page.data.items[0].uiState).not.toBe("submitting");
    expect(submitPrediction).toHaveBeenCalledTimes(1);
    expect(listMatches).toHaveBeenCalledTimes(1);
  });

  it("refreshItems does not restore already rendered previous-identity my_prediction after generation bump", () => {
    const { page, bumpLoginGeneration } = loadPage();
    page.setData({ selectedLeague: "premier_league", selectedDate: "2026-09-01" });
    page.setData({
      items: [page.decorateItem(predictedMatch("match-1", 2, 1))],
      state: "list",
    });
    expect(page.data.items[0].predText).toBe("已提交 2 : 1 · 不可修改");
    bumpLoginGeneration();
    page.refreshItems();
    expect(page.data.items).toEqual([]);
    expect(page.data.items.some((item) => item.my_prediction || (item.predText && item.predText.includes("2 : 1")))).toBe(false);
  });

  it("does not let a late previous pagination clear a newer list's loadingMore or retrigger onMore", async () => {
    const pendingA = deferred();
    const pendingB = deferred();
    const { page, listMatches } = loadPage({
      listMatches: queuePromises([pendingA, pendingB]),
    });
    page.setData({
      selectedLeague: "premier_league",
      selectedDate: "2026-09-01",
      items: [page.decorateItem(match("match-1"))],
      state: "list",
      hasMore: true,
      nextCursor: "cursor-a",
    });
    page.onMore();
    await vi.waitFor(() => expect(listMatches).toHaveBeenCalledTimes(1));
    expect(page.data.loadingMore).toBe(true);

    page.requestSerial += 1;
    page.setData({
      selectedLeague: "premier_league",
      selectedDate: "2026-09-02",
      items: [page.decorateItem(match("match-2"))],
      state: "list",
      hasMore: true,
      nextCursor: "cursor-b",
      loadingMore: false,
    });
    page.onMore();
    await vi.waitFor(() => expect(listMatches).toHaveBeenCalledTimes(2));
    expect(page.data.loadingMore).toBe(true);

    pendingA.resolve(listResult([match("late-a")]));
    await Promise.resolve();
    await Promise.resolve();

    expect(page.data.loadingMore).toBe(true);
    expect(page.data.items.map((item) => item.match_id)).toEqual(["match-2"]);
    page.onMore();
    expect(listMatches).toHaveBeenCalledTimes(2);

    pendingB.resolve(listResult([match("match-3")]));
    await vi.waitFor(() => expect(page.data.loadingMore).toBe(false));
    expect(page.data.items.map((item) => item.match_id)).toEqual(["match-2", "match-3"]);
    expect(listMatches).toHaveBeenCalledTimes(2);
  });

  it("clears already rendered previous-identity predictions and summary when generation changes", () => {
    const { page, bumpLoginGeneration } = loadPage();
    const key = "premier_league:2026-09-01:match-1";
    page.setData({ selectedLeague: "premier_league", selectedDate: "2026-09-01" });
    page.submittedMap[key] = { home: 2, away: 1, generation: 0 };
    page.uiStates[key] = "submitted_locked";
    page.setData({
      items: [page.decorateItem(predictedMatch("match-1", 2, 1))],
      state: "list",
      leagueSummary: { predicted_matches: 9, wdl_hits: 4, exact_hits: 1, is_provisional: false },
      summarySeasonId: "2025",
      summaryState: "ready",
    });
    expect(page.data.items[0].predText).toBe("已提交 2 : 1 · 不可修改");
    bumpLoginGeneration();
    page.rememberLoginGeneration();
    expect(page.submittedMap).toEqual({});
    expect(page.uiStates).toEqual({});
    expect(page.data.items).toEqual([]);
    expect(page.data.leagueSummary).toBeNull();
    expect(page.data.summarySeasonId).toBeNull();
  });

  it("does not submit a previous identity draft after refreshItems clears idempotency keys", async () => {
    const { page, submitPrediction, listMatches, getLeagueStatus, bumpLoginGeneration } = loadPage({
      matchesResult: listResult([match("new-1")]),
    });
    const key = "premier_league:2026-09-01:match-1";
    page.setData({
      selectedLeague: "premier_league",
      selectedDate: "2026-09-01",
      items: [page.decorateItem(match("match-1"))],
      state: "list",
    });
    page.drafts[key] = { home: 2, away: 1 };
    page.uiStates[key] = "editing";
    page.idempotencyKeys[key] = "old-identity-key";
    page.lastPayloads[key] = { home: 2, away: 1 };
    page.loginGeneration = 0;
    bumpLoginGeneration();

    page.onSubmitTap({ currentTarget: { dataset: { matchId: "match-1" } } });
    await Promise.resolve();

    expect(submitPrediction).not.toHaveBeenCalled();
    expect(page.idempotencyKeys[key]).toBeUndefined();
    expect(page.drafts[key]).toBeUndefined();
    expect(page.submittedMap[key]).toBeUndefined();

    await vi.waitFor(() => expect(getLeagueStatus).toHaveBeenCalled());
    await vi.waitFor(() => expect(listMatches).toHaveBeenCalled());
    await vi.waitFor(() => expect(page.data.state).toBe("list"));
    expect(page.data.items.map((item) => item.match_id)).toEqual(["new-1"]);
    expect(page.data.items[0].predText).toBe("");
    expect(submitPrediction).not.toHaveBeenCalled();
  });

  it("does not request a previous identity cursor after generation changes", async () => {
    const { page, listMatches, getLeagueStatus, bumpLoginGeneration } = loadPage({
      matchesResult: listResult([match("new-1")]),
    });
    page.setData({
      selectedLeague: "premier_league",
      selectedDate: "2026-09-01",
      items: [page.decorateItem(match("match-1"))],
      state: "list",
      hasMore: true,
      nextCursor: "old-identity-cursor",
    });
    page.loginGeneration = 0;
    bumpLoginGeneration();

    page.onMore();
    await Promise.resolve();

    expect(listMatches.mock.calls.some(([params]) => params && params.cursor === "old-identity-cursor")).toBe(false);

    await vi.waitFor(() => expect(getLeagueStatus).toHaveBeenCalled());
    await vi.waitFor(() => expect(listMatches).toHaveBeenCalled());
    await vi.waitFor(() => expect(page.data.state).toBe("list"));
    expect(page.data.items.map((item) => item.match_id)).toEqual(["new-1"]);
    expect(page.data.items[0].predText).toBe("");
    expect(page.data.loadingMore).toBe(false);
    expect(listMatches.mock.calls.some(([params]) => params && params.cursor === "old-identity-cursor")).toBe(false);
  });

  it("counts server-backed predictions in doneCount even when local submittedMap is empty", () => {
    const { page } = loadPage();
    page.setData({ selectedLeague: "premier_league", selectedDate: "2026-09-01" });
    page.applyListResult({
      statusCode: 200,
      data: {
        items: [{
          ...match("match-1"),
          can_predict: false,
          can_predict_reason: "ALREADY_SUBMITTED",
          my_prediction: { pred_home_score: 2, pred_away_score: 0, match_score: null },
        }],
        page: { has_more: false, next_cursor: null },
      },
    }, true);
    expect(page.data.items[0].predText).toBe("已提交 2 : 0 · 不可修改");
    expect(page.data.doneCount).toBe(1);
    expect(page.data.openCount).toBe(0);
  });

  it("debounces rapid league and date switches so only the final selection triggers listMatches", async () => {
    vi.useFakeTimers();
    try {
      const { page, listMatches } = loadPage();
      page.setData({ selectedLeague: "premier_league", selectedDate: "2026-09-01" });
      page.onLeagueTap({ currentTarget: { dataset: { id: "la_liga" } } });
      page.onLeagueTap({ currentTarget: { dataset: { id: "serie_a" } } });
      page.onDateTap({ currentTarget: { dataset: { key: "2026-09-02" } } });
      expect(page.data.hasMore).toBe(false);
      expect(page.data.nextCursor).toBeNull();
      expect(page.data.openCount).toBe(0);
      expect(page.data.doneCount).toBe(0);
      expect(page.data.hintText).toBe("");
      await vi.advanceTimersByTimeAsync(200);
      await vi.waitFor(() => expect(listMatches).toHaveBeenCalledTimes(1));
      expect(listMatches).toHaveBeenCalledWith(expect.objectContaining({
        league_id: "serie_a",
        from: "2026-09-01T16:00:00.000Z",
        to: "2026-09-02T16:00:00.000Z",
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a submitting card locked when opening another match editor", async () => {
    const pendingSubmit = deferred();
    const { page, submitPrediction } = loadPage({ submitResult: pendingSubmit.promise });
    const key1 = "premier_league:2026-09-01:match-1";
    const key2 = "premier_league:2026-09-01:match-2";
    page.setData({
      selectedLeague: "premier_league",
      selectedDate: "2026-09-01",
      items: [page.decorateItem(match("match-1")), page.decorateItem(match("match-2"))],
      state: "list",
    });
    page.drafts[key1] = { home: 2, away: 1 };
    page.uiStates[key1] = "editing";
    page.onSubmitTap({ currentTarget: { dataset: { matchId: "match-1" } } });
    await vi.waitFor(() => expect(submitPrediction).toHaveBeenCalledOnce());
    expect(page.uiStates[key1]).toBe("submitting");

    page.onPredictTap({ currentTarget: { dataset: { matchId: "match-2" } } });
    expect(page.uiStates[key1]).toBe("submitting");
    expect(page.drafts[key1]).toEqual({ home: 2, away: 1 });
    expect(page.uiStates[key2]).toBe("editing");
    expect(page.data.items[0].uiState).toBe("submitting");
    expect(page.data.items[1].uiState).toBe("editing");

    pendingSubmit.resolve({ statusCode: 201 });
    await vi.waitFor(() => expect(page.uiStates[key1]).toBe("submitted_locked"));
  });

  it("refreshes date strip across Beijing midnight and levelSeasonLabel across July 1 on onShow", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-30T15:59:00.000Z")); // Beijing 2026-06-30 23:59
      const currentSeasonId = (iso) => {
        const ms = Date.parse(iso) + 8 * 60 * 60 * 1000;
        const d = new Date(ms);
        const y = d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
        return `${y}_${y + 1}`;
      };
      const pageConfig = {};
      Object.defineProperty(globalThis, "Page", { value: (config) => Object.assign(pageConfig, config), configurable: true });
      loadCommonJs(MATCHES_JS, (id) => {
        if (id === "../../services/auth.js") return { getLoginGeneration: () => 0 };
        if (id === "../../utils/logo-registry.js") return { getTeamLogo: () => "team.png", getLeagueLogo: () => "league.png" };
        if (id === "../../utils/team-presentation.js") return { presentTeam: () => ({ nameZh: "Team", logo: "team.png", missing: false }) };
        if (id === "../../utils/nickname.js") return { resolveNickname: () => "球友", truncateNickname: (v) => v };
        if (id === "../../services/matches.js") return { listMatches: vi.fn(async () => listResult([])) };
        if (id === "../../services/leagues.js") return { getLeagueStatus: vi.fn(async () => ({ statusCode: 200, data: { items: [] } })) };
        if (id === "../../utils/matches-default-league.js") return loadCommonJs(LEAGUE_UTIL, () => { throw new Error("unexpected"); });
        if (id === "../../services/predictions.js") return { createUuidV4: () => "uuid", submitPrediction: vi.fn(), getMyLeagueSummary: vi.fn() };
        if (id === "../../utils/crowd-copy.js") return { COPY: { homeLink: "" } };
        if (id === "../../utils/ui-layout.js") return { headerHeight: () => 88 };
        if (id === "../../utils/match-presentation.js") return { formatRound: () => "" };
        if (id === "../../utils/match-card-state.js") return loadCommonJs(join(HERE, "..", "..", "utils", "match-card-state.js"), () => { throw new Error("unexpected"); });
        if (id === "../../utils/rankings-view-model.js") return { currentSeasonId };
        if (id === "../../utils/level-season.js") return loadCommonJs(join(HERE, "..", "..", "utils", "level-season.js"), () => { throw new Error("unexpected"); });
        throw new Error(`Unexpected require: ${id}`);
      });
      const page = Object.assign({}, pageConfig, {
        data: JSON.parse(JSON.stringify(pageConfig.data)),
        setData(patch) { Object.assign(this.data, patch); },
      });
      await page.onLoad();
      expect(page.data.dates).toHaveLength(23);
      expect(page.data.dates[11]).toEqual({ key: "2026-06-30", label: "今天", day: "30" });
      expect(page.data.selectedDate).toBe("2026-06-30");
      expect(page.data.dateScrollIntoView).toBe("date-2026-06-30");
      expect(page.data.levelSeasonLabel).toBe("2025—2026 赛季");

      page.onShow();
      vi.setSystemTime(new Date("2026-06-30T16:01:00.000Z")); // Beijing 2026-07-01 00:01
      await page.onShow();
      expect(page.data.dates[11]).toEqual({ key: "2026-07-01", label: "今天", day: "01" });
      expect(page.data.selectedDate).toBe("2026-07-01");
      expect(page.data.dateScrollIntoView).toBe("date-2026-07-01");
      expect(page.data.levelSeasonLabel).toBe("2026—2027 赛季");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["截单", { can_predict: false, can_predict_reason: "CLOSED" }],
    ["开球", { can_predict: false, can_predict_reason: "MATCH_STARTED", match_status: "live" }],
    ["取消", { can_predict: false, can_predict_reason: "NOT_SCHEDULED", match_status: "cancelled" }],
  ])("collapses an open editor after %s closes the prediction window", (_label, patch) => {
    const { page } = loadPage();
    const key = "premier_league:2026-09-01:match-1";
    page.setData({
      selectedLeague: "premier_league",
      selectedDate: "2026-09-01",
      submitErrors: { [key]: "旧错误" },
    });
    page.uiStates[key] = "editing";
    page.drafts[key] = { home: 2, away: 1 };

    page.applyListResult(listResult([{ ...match("match-1"), ...patch }]), true);

    expect(page.data.items[0].editorVisible).toBe(false);
    expect(page.data.items[0].uiState).toBe("collapsed");
    expect(page.uiStates[key]).toBe("collapsed");
    expect(page.drafts[key]).toBeUndefined();
    expect(page.data.submitErrors[key]).toBeUndefined();
  });

  it("clears the submit error when retrying and after a successful retry", async () => {
    const pending = deferred();
    const { page, submitPrediction } = loadPage({
      submitResult: pending.promise,
      matchesResult: listResult([predictedMatch("match-1", 2, 1)]),
    });
    const key = "premier_league:2026-09-01:match-1";
    page.setData({
      selectedLeague: "premier_league",
      selectedDate: "2026-09-01",
      items: [page.decorateItem(match("match-1"))],
      state: "list",
      submitErrors: { [key]: "网络错误" },
    });
    page.drafts[key] = { home: 2, away: 1 };
    page.uiStates[key] = "editing";
    page.refreshItems();
    expect(page.data.items[0].submitError).toBe("网络错误");

    page.onSubmitTap({ currentTarget: { dataset: { matchId: "match-1" } } });
    expect(page.data.submitErrors[key]).toBeUndefined();
    expect(page.data.items[0].submitError).toBe("");
    expect(submitPrediction).toHaveBeenCalledOnce();

    pending.resolve({ statusCode: 201 });
    await vi.waitFor(() => expect(page.uiStates[key]).toBe("submitted_locked"));
    expect(page.data.submitErrors[key]).toBeUndefined();
    await vi.waitFor(() => expect(page.data.items.some((item) => item.submitError)).toBe(false));
  });

  it("clears submit errors when editing, closing editors, or switching identity", () => {
    const { page, bumpLoginGeneration } = loadPage();
    const key1 = "premier_league:2026-09-01:match-1";
    const key2 = "premier_league:2026-09-01:match-2";
    page.setData({
      selectedLeague: "premier_league",
      selectedDate: "2026-09-01",
      items: [page.decorateItem(match("match-1")), page.decorateItem(match("match-2"))],
      submitErrors: { [key1]: "错误一", [key2]: "错误二" },
    });

    page.onPredictTap({ currentTarget: { dataset: { matchId: "match-1" } } });
    expect(page.data.submitErrors).toEqual({});

    page.setData({ submitErrors: { [key1]: "错误一", [key2]: "错误二" } });
    page.closeEditors();
    expect(page.data.submitErrors).toEqual({});

    page.setData({ submitErrors: { [key1]: "错误一" } });
    bumpLoginGeneration();
    page.rememberLoginGeneration();
    expect(page.data.submitErrors).toEqual({});
  });

  it("clears yesterday's counters and hint when the first page load fails", async () => {
    const { page } = loadPage({
      matchesResult: { statusCode: 500, message: "boom" },
    });
    page.setData({
      selectedLeague: "premier_league",
      selectedDate: "2026-09-01",
      items: [page.decorateItem(match("match-1"))],
      openCount: 4,
      doneCount: 3,
      hintText: "8 月 31 日 · 待预测 4 场 · 已预测 3 场",
    });

    await page.loadFirstPage();

    expect(page.data.state).toBe("error");
    expect(page.data.openCount).toBe(0);
    expect(page.data.doneCount).toBe(0);
    expect(page.data.hintText).toBe("");
  });

  it("clears counters on a non-pagination list error", () => {
    const { page } = loadPage();
    page.setData({
      selectedLeague: "premier_league",
      selectedDate: "2026-09-01",
      openCount: 2,
      doneCount: 1,
      hintText: "旧的统计",
    });

    page.applyListResult({ statusCode: 500, code: "INTERNAL_ERROR", message: "boom" }, true);

    expect(page.data.state).toBe("error");
    expect(page.data.openCount).toBe(0);
    expect(page.data.doneCount).toBe(0);
    expect(page.data.hintText).toBe("");
  });

  it("stores the target season before switching to the season rankings tab", () => {
    const { page, storage, switchTab } = loadPage();

    page.onRankingsTap();

    expect(storage.get("pending_ranking_target")).toEqual({
      board: "season",
    });
    expect(switchTab).toHaveBeenCalledWith({ url: "/pages/rankings/rankings" });
  });

  it("does not render a stale submit error on a submitted card", () => {
    const template = readFileSync(MATCHES_WXML, "utf8");
    expect(template).toContain("item.uiState !== 'submitted_locked' && item.submitError");
    expect(template).toContain('scroll-into-view="{{dateScrollIntoView}}"');
    expect(template).toContain('id="date-{{item.key}}"');
    expect(template).toContain('wx:if="{{errorMessage}}" class="more-error"');
  });

  it("[A-S2-01] enters error state instead of stalling in loading when listMatches rejects", async () => {
    const { page } = loadPage({
      listMatches: vi.fn(async () => {
        throw new Error("timeout");
      }),
    });
    page.setData({ selectedLeague: "premier_league", selectedDate: "2026-09-01" });

    await page.loadFirstPage();

    expect(page.data.state).toBe("error");
    expect(page.data.errorMessage).toBe("timeout");
    expect(page.data.loadingMore).toBe(false);
  });

  it("[A-S2-01] resets editing state on submit rejection and clears cached idempotency key on 409 IDEMPOTENCY_KEY_REUSED", async () => {
    let seq = 0;
    const keys = [];
    const submitPrediction = vi.fn(({ idempotencyKey }) => {
      keys.push(idempotencyKey);
      if (seq++ === 0) return Promise.reject(new Error("network drop"));
      if (seq === 2) return Promise.resolve({ statusCode: 409, code: "IDEMPOTENCY_KEY_REUSED", message: "幂等键冲突" });
      return Promise.resolve({ statusCode: 201 });
    });
    const pageConfig = {};
    let uuidSeq = 0;
    const storage = new Map();
    Object.defineProperty(globalThis, "Page", { value: (config) => Object.assign(pageConfig, config), configurable: true });
    Object.defineProperty(globalThis, "wx", {
      value: {
        getStorageSync: (k) => storage.get(k),
        setStorageSync: (k, v) => storage.set(k, v),
        removeStorageSync: (k) => storage.delete(k),
        switchTab: vi.fn(),
        stopPullDownRefresh: vi.fn(),
      },
      configurable: true,
    });
    loadCommonJs(MATCHES_JS, (id) => {
      if (id === "../../services/auth.js") return { getLoginGeneration: () => 0 };
      if (id === "../../utils/logo-registry.js") return { getTeamLogo: () => "team.png", getLeagueLogo: () => "league.png" };
      if (id === "../../utils/team-presentation.js") return { presentTeam: () => ({ nameZh: "Team", logo: "team.png", missing: false }) };
      if (id === "../../utils/nickname.js") return { resolveNickname: () => "球友", truncateNickname: (v) => v };
      if (id === "../../services/matches.js") return { listMatches: vi.fn(async () => listResult([predictedMatch("match-1", 2, 1)])) };
      if (id === "../../services/leagues.js") return { getLeagueStatus: vi.fn(async () => ({ statusCode: 200, data: { items: [] } })) };
      if (id === "../../utils/matches-default-league.js") return loadCommonJs(LEAGUE_UTIL, () => { throw new Error("unexpected"); });
      if (id === "../../services/predictions.js") return { createUuidV4: () => `uuid-${++uuidSeq}`, submitPrediction, getMyLeagueSummary: vi.fn() };
      if (id === "../../utils/crowd-copy.js") return { COPY: { homeLink: "" } };
      if (id === "../../utils/ui-layout.js") return { headerHeight: () => 88 };
      if (id === "../../utils/match-presentation.js") return { formatRound: () => "" };
      if (id === "../../utils/match-card-state.js") return loadCommonJs(join(HERE, "..", "..", "utils", "match-card-state.js"), () => { throw new Error("unexpected"); });
      if (id === "../../utils/rankings-view-model.js") return { currentSeasonId: () => "2026_2027" };
      if (id === "../../utils/level-season.js") return loadCommonJs(join(HERE, "..", "..", "utils", "level-season.js"), () => { throw new Error("unexpected"); });
      throw new Error(`Unexpected require: ${id}`);
    });
    const page = Object.assign({}, pageConfig, {
      data: JSON.parse(JSON.stringify(pageConfig.data)),
      setData(patch) { Object.assign(this.data, patch); },
    });
    const key = "premier_league:2026-09-01:match-1";
    page.setData({
      selectedLeague: "premier_league",
      selectedDate: "2026-09-01",
      state: "list",
      items: [page.decorateItem(match("match-1"))],
    });
    page.drafts[key] = { home: 2, away: 1 };
    page.uiStates[key] = "editing";

    await page.onSubmitTap({ currentTarget: { dataset: { matchId: "match-1" } } });
    expect(page.uiStates[key]).toBe("editing");
    expect(page.data.submitErrors[key]).toBe("network drop");
    expect(page.idempotencyKeys[key]).toBe("uuid-1");

    await page.onSubmitTap({ currentTarget: { dataset: { matchId: "match-1" } } });
    expect(page.uiStates[key]).toBe("editing");
    expect(page.data.submitErrors[key]).toBe("幂等键冲突");
    expect(page.idempotencyKeys[key]).toBeUndefined();
    expect(page.lastPayloads[key]).toBeUndefined();

    await page.onSubmitTap({ currentTarget: { dataset: { matchId: "match-1" } } });
    expect(keys).toEqual(["uuid-1", "uuid-1", "uuid-2"]);
    expect(page.uiStates[key]).toBe("submitted_locked");
    expect(storage.get("my_predictions_dirty")).toBe(true);
  });

  it("[A-S2-01 + A-S2-06] keeps list visible and ✓ submitted card during silent refresh, tolerating refresh errors", async () => {
    const listMatches = vi.fn()
      .mockRejectedValueOnce(new Error("temporary refresh failure"))
      .mockResolvedValueOnce(listResult([predictedMatch("match-1", 2, 1)]));
    const { page, storage } = loadPage({ listMatches });
    const key = "premier_league:2026-09-01:match-1";
    page.setData({
      selectedLeague: "premier_league",
      selectedDate: "2026-09-01",
      state: "list",
      items: [page.decorateItem(match("match-1")), page.decorateItem(match("match-2"))],
    });
    page.drafts[key] = { home: 2, away: 1 };
    page.uiStates[key] = "editing";

    await page.onSubmitTap({ currentTarget: { dataset: { matchId: "match-1" } } });

    expect(page.data.state).toBe("list");
    expect(page.data.items).toHaveLength(2);
    expect(page.data.items[0].uiState).toBe("submitted_locked");
    expect(page.data.items[0].editorVisible).toBe(true);
    expect(storage.get("my_predictions_dirty")).toBe(true);

    page.uiStates[key] = "editing";
    page.drafts[key] = { home: 2, away: 1 };
    await page.onSubmitTap({ currentTarget: { dataset: { matchId: "match-1" } } });
    expect(page.data.state).toBe("list");
    expect(page.data.items[0].uiState).toBe("submitted_locked");
    expect(page.data.items[0].editorVisible).toBe(true);
    expect(page.data.items[0].predText).toBe("已提交 2 : 1 · 不可修改");
  });

  it("[A-S2-01] surfaces pagination errors cleanly on onMore without clearing loaded items", async () => {
    const listMatches = vi.fn().mockRejectedValueOnce(new Error("page boom"));
    const { page } = loadPage({ listMatches });
    page.setData({
      selectedLeague: "premier_league",
      selectedDate: "2026-09-01",
      state: "list",
      items: [page.decorateItem(match("match-1"))],
      hasMore: true,
      nextCursor: "cursor-2",
    });

    await page.onMore();

    expect(page.data.state).toBe("list");
    expect(page.data.items).toHaveLength(1);
    expect(page.data.loadingMore).toBe(false);
    expect(page.data.hasMore).toBe(true);
    expect(page.data.errorMessage).toBe("page boom");
  });
});
