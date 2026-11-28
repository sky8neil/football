import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const savedPage = Object.getOwnPropertyDescriptor(globalThis, "Page");
const savedWx = Object.getOwnPropertyDescriptor(globalThis, "wx");

function loadCommonJs(file, requires) {
  const module = { exports: {} };
  const factory = runInThisContext(`(function(module, exports, require) {\n${readFileSync(file, "utf8")}\n})`, { filename: file });
  factory(module, module.exports, (id) => {
    if (Object.hasOwn(requires, id)) return requires[id];
    throw new Error(`Unexpected require: ${id}`);
  });
  return module.exports;
}

function loadPage({ detail, crowd, submit, getLoginGeneration } = {}) {
  const pageConfig = {};
  let loginGeneration = 0;
  const authRestoredListeners = new Set();
  Object.defineProperty(globalThis, "Page", { value: (config) => Object.assign(pageConfig, config), configurable: true });
  const getMatchCrowd = vi.fn(crowd || (async () => ({ statusCode: 200, data: { status: "available", distribution: { home: 50, draw: 25, away: 25 }, granularity: 5, min_predictions: 20 } })));
  const getMatchDetail = vi.fn(detail || (async () => ({ statusCode: 200, data: {
    match_id: "match-1", match_status: "live", can_predict_reason: "CLOSED",
    regular_home_score: null, regular_away_score: null,
    home_team: {}, away_team: {},
  } })));
  const submitPrediction = vi.fn(submit || (async () => ({ statusCode: 201 })));
  let keyCounter = 0;
  const copy = loadCommonJs(join(HERE, "..", "..", "utils", "crowd-copy.js"), {});
  const vm = loadCommonJs(join(HERE, "..", "..", "utils", "crowd-view-model.js"), { "./crowd-copy.js": copy });
  const presentation = loadCommonJs(join(HERE, "..", "..", "utils", "match-presentation.js"), {});
  loadCommonJs(join(HERE, "match-detail.js"), {
    "../../services/matches.js": { getMatchDetail, getMatchCrowd },
    "../../services/predictions.js": { createUuidV4: () => `uuid-${++keyCounter}`, submitPrediction },
    "../../services/auth.js": {
      getLoginGeneration: getLoginGeneration || (() => loginGeneration),
      onAuthRestored(listener) {
        authRestoredListeners.add(listener);
        return () => authRestoredListeners.delete(listener);
      },
    },
    "../../utils/logo-registry.js": { getTeamLogo: () => "" },
    "../../utils/team-presentation.js": {
      presentTeam: (team) => ({
        teamId: team && team.team_id,
        nameZh: "球队资料待补全",
        logo: "",
        missing: true,
      }),
    },
    "../../utils/crowd-view-model.js": vm,
    "../../utils/crowd-copy.js": copy,
    "../../utils/match-presentation.js": presentation,
  });
  const page = Object.assign({}, pageConfig, {
    data: JSON.parse(JSON.stringify(pageConfig.data)),
    setData(patch) { Object.assign(this.data, patch); },
  });
  return {
    page,
    getMatchCrowd,
    getMatchDetail,
    submitPrediction,
    authRestoredListeners,
    triggerAuthRestored() {
      for (const listener of [...authRestoredListeners]) listener({ statusCode: 200 });
    },
    bumpLoginGeneration() { loginGeneration += 1; },
  };
}

afterEach(() => {
  for (const [key, descriptor] of [["Page", savedPage], ["wx", savedWx]]) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

describe("match detail crowd card", () => {
  it("does not request for guest, pre-deadline, or unavailable matches", async () => {
    const { page, getMatchCrowd } = loadPage();
    page.data.matchId = "match-1";
    page.applyMatch({ match_id: "match-1", match_status: "scheduled", can_predict_reason: null, my_prediction: null, home_team: {}, away_team: {} });
    page.applyMatch({ match_id: "match-1", match_status: "live", can_predict_reason: "CLOSED", my_prediction: null, home_team: {}, away_team: {} });
    page.setData({ identityMissing: true });
    page.applyMatch({ match_id: "match-1", match_status: "live", can_predict_reason: "AUTH_REQUIRED", my_prediction: null, home_team: {}, away_team: {} });
    page.applyMatch({ match_id: "match-1", match_status: "postponed", can_predict_reason: "CLOSED", my_prediction: null, home_team: {}, away_team: {} });
    await Promise.resolve();
    expect(getMatchCrowd).toHaveBeenCalledOnce();
  });

  it("isolates a failed crowd request from the prediction detail", async () => {
    const { page } = loadPage({ crowd: async () => ({ statusCode: 0 }) });
    page.data.matchId = "match-1";
    page.applyMatch({ match_id: "match-1", match_status: "live", can_predict_reason: "CLOSED", my_prediction: { pred_home_score: 1, pred_away_score: 0 }, home_team: {}, away_team: {} });
    await vi.waitFor(() => expect(page.data.crowdState).toBe("error"));
    expect(page.data.state).toBe("ready");
    expect(page.data.myPrediction).toBeTruthy();
  });

  it("[UX-04] renders cancellation, postponement and abandonment copy", () => {
    const { page } = loadPage();
    page.data.matchId = "match-1";
    page.applyMatch({
      match_id: "match-1",
      match_status: "cancelled",
      settlement_status: "voided",
      can_predict_reason: "CLOSED",
      my_prediction: {
        pred_home_score: 1,
        pred_away_score: 0,
        submitted_at: "2026-11-14T12:00:00.000Z",
        match_score: null,
        wdl_hit: null,
        exact_hit: null,
      },
      home_team: {},
      away_team: {},
    });
    expect(page.data.predictionPointsText).toBe("不计分");
    expect(page.data.predictionResultText).toBe("比赛取消 · 不计分");
    expect(page.data.myMatchScoreText).toBe("—");

    page.applyMatch({
      match_id: "match-1",
      match_status: "postponed",
      can_predict_reason: "CLOSED",
      my_prediction: {
        pred_home_score: 1,
        pred_away_score: 0,
        submitted_at: "2026-11-14T12:00:00.000Z",
        match_score: null,
        wdl_hit: null,
        exact_hit: null,
      },
      home_team: {},
      away_team: {},
    });
    expect(page.data.predictionResultText).toBe("比赛延期");

    page.applyMatch({
      match_id: "match-1",
      match_status: "abandoned",
      can_predict_reason: "CLOSED",
      my_prediction: {
        pred_home_score: 1,
        pred_away_score: 0,
        submitted_at: "2026-11-14T12:00:00.000Z",
        match_score: null,
        wdl_hit: null,
        exact_hit: null,
      },
      home_team: {},
      away_team: {},
    });
    expect(page.data.predictionResultText).toBe("比赛腰斩");
  });

  it("loads once on the first show and refreshes on later shows unless submitting", async () => {
    const { page, getMatchDetail } = loadPage();
    page.onLoad({ id: "match-1" });
    await vi.waitFor(() => expect(page.data.state).toBe("ready"));
    expect(getMatchDetail).toHaveBeenCalledTimes(1);

    page.onShow();
    await Promise.resolve();
    expect(getMatchDetail).toHaveBeenCalledTimes(1);
    expect(page.initialized).toBeUndefined();

    page.onShow();
    await vi.waitFor(() => expect(getMatchDetail).toHaveBeenCalledTimes(2));

    page.setData({ submitting: true });
    page.onShow();
    await Promise.resolve();
    expect(getMatchDetail).toHaveBeenCalledTimes(2);
  });

  it("refreshes detail and crowd after a 409 PREDICTION_LOCKED", async () => {
    const { page, getMatchDetail, getMatchCrowd } = loadPage();
    page.onLoad({ id: "match-1" });
    await vi.waitFor(() => expect(page.data.state).toBe("ready"));
    await vi.waitFor(() => expect(getMatchCrowd).toHaveBeenCalledTimes(1));

    page.applySubmitResult({
      statusCode: 409,
      code: "PREDICTION_LOCKED",
      message: "预测已截止",
    });

    await vi.waitFor(() => expect(getMatchDetail).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(getMatchCrowd).toHaveBeenCalledTimes(2));
  });

  it("maps 401 to guest state and discards a stale response", async () => {
    const pending = [];
    const { page } = loadPage({ crowd: () => new Promise((resolve) => pending.push(resolve)) });
    page.data.matchId = "match-1";
    const match = { match_id: "match-1", match_status: "live", can_predict_reason: "CLOSED", home_team: {}, away_team: {} };
    page.applyMatch(match);
    page.loadCrowd(match);
    pending[0]({ statusCode: 200, data: { status: "available", distribution: { home: 100, draw: 0, away: 0 }, granularity: 5 } });
    await Promise.resolve();
    expect(page.data.crowdKind).toBe("loading");
    pending[1]({ statusCode: 401, code: "UNAUTHORIZED" });
    await vi.waitFor(() => expect(page.data.crowdKind).toBe("guest"));
    expect(page.data.identityMissing).toBe(true);
  });

  it("[A-S2-02] guards detail races, resets loading/submitting on rejections, handles loginGeneration changes, and updates scoreCaption", async () => {
    let resolveFirst;
    let resolveSecond;
    const getMatchDetail = vi.fn()
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }))
      .mockRejectedValueOnce(new Error("detail network boom"))
      .mockResolvedValue({
        statusCode: 200,
        data: {
          match_id: "match-1",
          match_status: "scheduled",
          can_predict: true,
          can_predict_reason: null,
          home_team: {},
          away_team: {},
        },
      });
    const getMatchCrowd = vi.fn().mockRejectedValueOnce(new Error("crowd boom"));
    const submitPrediction = vi.fn()
      .mockRejectedValueOnce(new Error("submit boom"))
      .mockResolvedValueOnce({ statusCode: 409, code: "IDEMPOTENCY_KEY_REUSED", message: "key reused" })
      .mockResolvedValueOnce({ statusCode: 201 });
    const storage = new Map();
    Object.defineProperty(globalThis, "wx", {
      value: {
        setStorageSync: (k, v) => storage.set(k, v),
        getStorageSync: (k) => storage.get(k),
        removeStorageSync: (k) => storage.delete(k),
        navigateTo: vi.fn(),
      },
      configurable: true,
    });

    const { page, bumpLoginGeneration } = loadPage({ detail: getMatchDetail, crowd: getMatchCrowd, submit: submitPrediction });
    expect(page.refreshAfterSession).toBeUndefined();
    page.onSessionTap();
    expect(page.refreshAfterSession).toBeUndefined();

    page.data.matchId = "match-1";
    page.rememberLoginGeneration();
    const first = page.loadDetail();
    const second = page.loadDetail();
    resolveSecond({
      statusCode: 200,
      data: { match_id: "match-1", match_status: "postponed", can_predict_reason: "CLOSED", home_team: {}, away_team: {} },
    });
    await second;
    expect(page.data.scoreCaption).toBe("比赛延期");
    resolveFirst({
      statusCode: 200,
      data: { match_id: "match-1", match_status: "scheduled", can_predict_reason: null, home_team: {}, away_team: {} },
    });
    await first;
    expect(page.data.match.match_status).toBe("postponed");

    page.applyMatch({ match_id: "match-1", match_status: "abandoned", can_predict_reason: "CLOSED", home_team: {}, away_team: {} });
    expect(page.data.scoreCaption).toBe("比赛腰斩");
    page.applyMatch({ match_id: "match-1", match_status: "cancelled", can_predict_reason: "CLOSED", home_team: {}, away_team: {} });
    expect(page.data.scoreCaption).toBe("比赛取消");

    await page.loadDetail();
    expect(page.data.state).toBe("error");
    expect(page.data.errorMessage).toBe("detail network boom");

    page.applyMatch({ match_id: "match-1", match_status: "live", can_predict_reason: "CLOSED", home_team: {}, away_team: {} });
    await vi.waitFor(() => expect(page.data.crowdState).toBe("error"));

    await page.loadDetail();
    expect(page.data.canSubmit).toBe(true);
    page.setData({ homeScore: 2, awayScore: 1 });
    await page.onSubmit();
    expect(page.data.submitting).toBe(false);
    expect(page.data.formError).toBe("submit boom");
    const firstKey = page.idempotencyKey;

    await page.onSubmit();
    expect(page.data.submitting).toBe(false);
    expect(page.data.formError).toBe("key reused");
    expect(page.idempotencyKey).not.toBe(firstKey);
    expect(page.lastPayload).toBeNull();

    await page.onSubmit();
    expect(storage.get("my_predictions_dirty")).toBe(true);

    page.applyMatch({ match_id: "match-1", match_status: "scheduled", can_predict: true, can_predict_reason: null, home_team: {}, away_team: {} });
    page.setData({ homeScore: 3, awayScore: 0 });
    bumpLoginGeneration();
    page.rememberLoginGeneration();
    expect(page.data.homeScore).toBe(0);
    expect(page.idempotencyKey).toBeNull();

    const wxml = readFileSync(join(HERE, "match-detail.wxml"), "utf8");
    expect(wxml).toContain("!identityMissing && !userDeleted && (canSubmit || !submitDisabledReason)");
  });

  it("[CR50-04] reloads from anonymous guest state on onAuthRestored and ignores late anonymous response", async () => {
    let resolveAnon;
    let resolveAuthed;
    const getMatchDetail = vi.fn()
      .mockImplementationOnce(() => new Promise((r) => { resolveAnon = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveAuthed = r; }));
    const { page, triggerAuthRestored } = loadPage({ detail: getMatchDetail });

    page.onLoad({ id: "match-1" });
    expect(getMatchDetail).toHaveBeenCalledTimes(1);

    // Auth restores while anonymous request is still in flight
    triggerAuthRestored();
    expect(getMatchDetail).toHaveBeenCalledTimes(2);

    // Logged-in response returns first
    resolveAuthed({
      statusCode: 200,
      data: {
        match_id: "match-1",
        match_status: "scheduled",
        can_predict: true,
        can_predict_reason: null,
        my_prediction: null,
        home_team: {},
        away_team: {},
      },
    });
    await vi.waitFor(() => expect(page.data.state).toBe("ready"));
    expect(page.data.canSubmit).toBe(true);
    expect(page.data.identityMissing).toBe(false);

    // Late anonymous response arrives after logged-in response — must NOT overwrite
    resolveAnon({
      statusCode: 200,
      data: {
        match_id: "match-1",
        match_status: "scheduled",
        can_predict: false,
        can_predict_reason: "AUTH_REQUIRED",
        my_prediction: null,
        home_team: {},
        away_team: {},
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(page.data.canSubmit).toBe(true);
    expect(page.data.identityMissing).toBe(false);
  });

  it("[CR50-04] reloads cold-start anonymous guest detail when onAuthRestored fires after guest render", async () => {
    const getMatchDetail = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 200,
        data: {
          match_id: "match-1",
          match_status: "scheduled",
          can_predict: false,
          can_predict_reason: "AUTH_REQUIRED",
          my_prediction: null,
          home_team: {},
          away_team: {},
        },
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        data: {
          match_id: "match-1",
          match_status: "scheduled",
          can_predict: true,
          can_predict_reason: null,
          my_prediction: null,
          home_team: {},
          away_team: {},
        },
      });
    const { page, triggerAuthRestored } = loadPage({ detail: getMatchDetail });

    page.onLoad({ id: "match-1" });
    await vi.waitFor(() => expect(page.data.state).toBe("ready"));
    expect(page.data.identityMissing).toBe(true);
    expect(page.data.canSubmit).toBe(false);

    triggerAuthRestored();
    await vi.waitFor(() => expect(page.data.canSubmit).toBe(true));
    expect(page.data.identityMissing).toBe(false);
    expect(getMatchDetail).toHaveBeenCalledTimes(2);
  });

  it("[CR50-04] unsubscribes onAuthRestored and invalidates in-flight detail/crowd/submit callbacks on onUnload", async () => {
    let resolveSecondDetail;
    let resolveCrowd;
    let resolveSubmit;
    const getMatchDetail = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 200,
        data: {
          match_id: "match-1",
          match_status: "scheduled",
          can_predict: true,
          can_predict_reason: null,
          my_prediction: null,
          home_team: {},
          away_team: {},
        },
      })
      .mockImplementationOnce(() => new Promise((r) => { resolveSecondDetail = r; }));
    const getMatchCrowd = vi.fn(() => new Promise((r) => { resolveCrowd = r; }));
    const submitPrediction = vi.fn(() => new Promise((r) => { resolveSubmit = r; }));
    const { page, triggerAuthRestored, authRestoredListeners } = loadPage({
      detail: getMatchDetail,
      crowd: getMatchCrowd,
      submit: submitPrediction,
    });

    page.onLoad({ id: "match-1" });
    await vi.waitFor(() => expect(page.data.state).toBe("ready"));
    expect(authRestoredListeners.size).toBe(1);

    // Trigger reload via onAuthRestored, plus an in-flight crowd request, then immediately unload
    triggerAuthRestored();
    expect(getMatchDetail).toHaveBeenCalledTimes(2);

    page.loadCrowd({ match_id: "match-1", match_status: "live", can_predict_reason: "CLOSED" });
    expect(getMatchCrowd).toHaveBeenCalledTimes(1);

    const setDataSpy = vi.spyOn(page, "setData");
    page.onUnload();
    expect(page.unloaded).toBe(true);
    expect(page.unsubscribeAuthRestored).toBeNull();
    expect(authRestoredListeners.size).toBe(0);

    // Subsequent onAuthRestored must not fire loadDetail
    triggerAuthRestored();
    expect(getMatchDetail).toHaveBeenCalledTimes(2);

    // Resolving in-flight detail & crowd after unload must not call setData or issue /crowd
    resolveSecondDetail({
      statusCode: 200,
      data: {
        match_id: "match-1",
        match_status: "live",
        can_predict: false,
        can_predict_reason: "CLOSED",
        my_prediction: null,
        home_team: {},
        away_team: {},
      },
    });
    resolveCrowd({
      statusCode: 200,
      data: { status: "available", distribution: { home: 50, draw: 25, away: 25 }, granularity: 5, min_predictions: 20 },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(setDataSpy).not.toHaveBeenCalled();
    expect(getMatchCrowd).toHaveBeenCalledTimes(1);

    // Also verify in-flight submit resolution after unload does not call setData
    const { page: submitPage } = loadPage({
      detail: async () => ({
        statusCode: 200,
        data: {
          match_id: "match-1",
          match_status: "scheduled",
          can_predict: true,
          can_predict_reason: null,
          my_prediction: null,
          home_team: {},
          away_team: {},
        },
      }),
      submit: submitPrediction,
    });
    submitPage.onLoad({ id: "match-1" });
    await vi.waitFor(() => expect(submitPage.data.canSubmit).toBe(true));
    const submitPromise = submitPage.onSubmit();
    const submitSetDataSpy = vi.spyOn(submitPage, "setData");
    submitPage.onUnload();
    resolveSubmit({ statusCode: 201 });
    await submitPromise;
    expect(submitSetDataSpy).not.toHaveBeenCalled();
  });

  it("[CR50-18] enters ready instead of sticking in loading when loginGeneration changes mid-request before next onShow", async () => {
    let resolveOld;
    let resolveNew;
    const getMatchDetail = vi.fn()
      .mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveNew = r; }));
    const { page, bumpLoginGeneration } = loadPage({ detail: getMatchDetail });

    page.onLoad({ id: "match-1" });
    expect(page.data.state).toBe("loading");
    expect(getMatchDetail).toHaveBeenCalledTimes(1);

    // loginGeneration changes while old detail request is still in flight (before any onShow)
    bumpLoginGeneration();

    // Old response arrives -> handleStaleLoginGeneration triggers loadDetail()
    resolveOld({
      statusCode: 200,
      data: {
        match_id: "match-1",
        match_status: "scheduled",
        can_predict: false,
        can_predict_reason: "AUTH_REQUIRED",
        my_prediction: null,
        home_team: {},
        away_team: {},
      },
    });
    await vi.waitFor(() => expect(getMatchDetail).toHaveBeenCalledTimes(2));

    // New request succeeds -> must NOT be discarded as stale; page must enter ready
    resolveNew({
      statusCode: 200,
      data: {
        match_id: "match-1",
        match_status: "scheduled",
        can_predict: true,
        can_predict_reason: null,
        my_prediction: null,
        home_team: {},
        away_team: {},
      },
    });
    await vi.waitFor(() => expect(page.data.state).toBe("ready"));
    expect(page.data.canSubmit).toBe(true);
    expect(page.data.identityMissing).toBe(false);
  });

  it("[CR50-16] hides crowd consistently across detail reason, crowd 409, and submit 409 USER_DELETED and ignores late crowd", async () => {
    // 1) Detail reason === USER_DELETED
    const detailDeleted = loadPage({
      detail: async () => ({
        statusCode: 200,
        data: {
          match_id: "match-1",
          match_status: "live",
          can_predict: false,
          can_predict_reason: "USER_DELETED",
          is_prediction_closed: true,
          my_prediction: null,
          home_team: {},
          away_team: {},
        },
      }),
    });
    detailDeleted.page.onLoad({ id: "match-1" });
    await vi.waitFor(() => expect(detailDeleted.page.data.state).toBe("ready"));
    expect(detailDeleted.page.data.userDeleted).toBe(true);
    expect(detailDeleted.page.data.canSubmit).toBe(false);
    expect(detailDeleted.page.data.submitDisabledReason).toBe("当前不可预测");
    expect(detailDeleted.page.data.crowdKind).toBe("hidden");
    expect(detailDeleted.getMatchCrowd).not.toHaveBeenCalled();

    // 2) loadCrowd receives 409 USER_DELETED
    const crowdDeleted = loadPage({
      detail: async () => ({
        statusCode: 200,
        data: {
          match_id: "match-1",
          match_status: "live",
          can_predict: false,
          can_predict_reason: "CLOSED",
          my_prediction: null,
          home_team: {},
          away_team: {},
        },
      }),
      crowd: async () => ({ statusCode: 409, code: "USER_DELETED", message: "账号已注销" }),
    });
    crowdDeleted.page.onLoad({ id: "match-1" });
    await vi.waitFor(() => expect(crowdDeleted.page.data.userDeleted).toBe(true));
    expect(crowdDeleted.page.data.crowdKind).toBe("hidden");
    expect(crowdDeleted.page.data.crowdState).toBe("idle");
    expect(crowdDeleted.page.data.canSubmit).toBe(false);
    expect(crowdDeleted.page.data.submitDisabledReason).toBe("当前不可预测");
    expect(crowdDeleted.page.data.match.can_predict_reason).toBe("USER_DELETED");

    // 3) submitPrediction receives 409 USER_DELETED while an in-flight crowd request is pending
    let resolveLateCrowd;
    const submitDeleted = loadPage({
      detail: async () => ({
        statusCode: 200,
        data: {
          match_id: "match-1",
          match_status: "scheduled",
          can_predict: true,
          can_predict_reason: null,
          my_prediction: null,
          home_team: {},
          away_team: {},
        },
      }),
      crowd: () => new Promise((r) => { resolveLateCrowd = r; }),
      submit: async () => ({ statusCode: 409, code: "USER_DELETED", message: "账号已注销" }),
    });
    submitDeleted.page.onLoad({ id: "match-1" });
    await vi.waitFor(() => expect(submitDeleted.page.data.canSubmit).toBe(true));
    // Start an in-flight crowd request before submit completes
    submitDeleted.page.loadCrowd({
      match_id: "match-1",
      match_status: "live",
      can_predict_reason: "CLOSED",
      is_prediction_closed: true,
    });
    expect(submitDeleted.getMatchCrowd).toHaveBeenCalledTimes(1);
    const serialBeforeSubmit = submitDeleted.page.crowdRequestSerial;

    await submitDeleted.page.onSubmit();
    expect(submitDeleted.page.crowdRequestSerial).toBe(serialBeforeSubmit + 1);
    expect(submitDeleted.page.data.userDeleted).toBe(true);
    expect(submitDeleted.page.data.canSubmit).toBe(false);
    expect(submitDeleted.page.data.submitDisabledReason).toBe("当前不可预测");
    expect(submitDeleted.page.data.crowdKind).toBe("hidden");
    expect(submitDeleted.page.data.crowdState).toBe("idle");
    expect(submitDeleted.page.data.match.can_predict_reason).toBe("USER_DELETED");

    // Late crowd 200 arrives — must be discarded and NOT overwrite hidden state
    resolveLateCrowd({
      statusCode: 200,
      data: { status: "available", distribution: { home: 60, draw: 20, away: 20 }, granularity: 5, min_predictions: 20 },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(submitDeleted.page.data.crowdKind).toBe("hidden");
    expect(submitDeleted.page.data.crowdState).toBe("idle");

    // 4) Ordinary 500 retry and idempotent 200 replay remain unaffected
    const retryPage = loadPage({
      detail: async () => ({
        statusCode: 200,
        data: {
          match_id: "match-1",
          match_status: "scheduled",
          can_predict: true,
          can_predict_reason: null,
          my_prediction: null,
          home_team: {},
          away_team: {},
        },
      }),
      submit: vi.fn()
        .mockResolvedValueOnce({ statusCode: 500, code: "INTERNAL", message: "server error" })
        .mockResolvedValueOnce({ statusCode: 200 }),
    });
    retryPage.page.onLoad({ id: "match-1" });
    await vi.waitFor(() => expect(retryPage.page.data.canSubmit).toBe(true));
    retryPage.page.setData({ homeScore: 2, awayScore: 1 });
    await retryPage.page.onSubmit();
    expect(retryPage.page.data.submitting).toBe(false);
    expect(retryPage.page.data.formError).toBe("server error");
    const retryKey = retryPage.page.idempotencyKey;
    expect(retryKey).toBeTruthy();

    await retryPage.page.onSubmit();
    expect(retryPage.submitPrediction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey: retryKey, homeScore: 2, awayScore: 1 }),
    );
    expect(retryPage.page.data.formError).toBe("");
  });
});
