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
    "../../services/auth.js": { getLoginGeneration: getLoginGeneration || (() => loginGeneration) },
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
});
