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
  const factory = runInThisContext(
    `(function(module, exports, require) {\n${readFileSync(file, "utf8")}\n})`,
    { filename: file },
  );
  factory(module, module.exports, (id) => {
    if (Object.hasOwn(requires, id)) return requires[id];
    throw new Error(`Unexpected require: ${id}`);
  });
  return module.exports;
}

function loadPage({ detail, crowd, submit, getLoginGeneration } = {}) {
  const pageConfig = {};
  let loginGeneration = 0;
  Object.defineProperty(globalThis, "Page", {
    value: (config) => Object.assign(pageConfig, config),
    configurable: true,
  });
  const getMatchCrowd = vi.fn(
    crowd ||
      (async () => ({
        statusCode: 200,
        data: {
          status: "available",
          distribution: { home: 50, draw: 25, away: 25 },
          granularity: 5,
          min_predictions: 20,
        },
      })),
  );
  const getMatchDetail = vi.fn(
    detail ||
      (async () => ({
        statusCode: 200,
        data: {
          match_id: "match-1",
          match_status: "scheduled",
          can_predict: true,
          can_predict_reason: null,
          regular_home_score: null,
          regular_away_score: null,
          my_prediction: null,
          home_team: { team_id: "t1", name: "Arsenal FC", name_zh: "阿森纳", logo_url: null },
          away_team: { team_id: "t2", name: "Chelsea FC", name_zh: "切尔西", logo_url: null },
        },
      })),
  );
  const submitPrediction = vi.fn(submit || (async () => ({ statusCode: 201 })));
  let keyCounter = 0;
  const copy = loadCommonJs(join(HERE, "..", "..", "utils", "crowd-copy.js"), {});
  const vm = loadCommonJs(join(HERE, "..", "..", "utils", "crowd-view-model.js"), { "./crowd-copy.js": copy });
  const presentation = loadCommonJs(join(HERE, "..", "..", "utils", "match-presentation.js"), {});
  loadCommonJs(join(HERE, "match-detail.js"), {
    "../../services/matches.js": { getMatchDetail, getMatchCrowd },
    "../../services/predictions.js": { createUuidV4: () => `uuid-${++keyCounter}`, submitPrediction },
    "../../services/auth.js": { getLoginGeneration: getLoginGeneration || (() => loginGeneration) },
    "../../utils/team-presentation.js": {
      presentTeam: (team) => ({
        teamId: team && team.team_id,
        nameZh: (team && (team.name_zh || team.name)) || "球队",
        logo: "",
        missing: false,
      }),
    },
    "../../utils/crowd-view-model.js": vm,
    "../../utils/crowd-copy.js": copy,
    "../../utils/match-presentation.js": presentation,
  });
  const page = Object.assign({}, pageConfig, {
    data: JSON.parse(JSON.stringify(pageConfig.data)),
    setData(patch) {
      Object.assign(this.data, patch);
    },
  });
  return {
    page,
    getMatchCrowd,
    getMatchDetail,
    submitPrediction,
    bumpLoginGeneration() {
      loginGeneration += 1;
    },
  };
}

afterEach(() => {
  for (const [key, descriptor] of [["Page", savedPage], ["wx", savedWx]]) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

describe("match detail copy-bet prefill (Q-PLAN-3)", () => {
  it("accepts match_id query param and prefills valid 0..20 integer scores without auto-submitting", async () => {
    const { page, getMatchDetail, submitPrediction } = loadPage();
    await page.onLoad({ match_id: "match-1", prefill_home: "2", prefill_away: "1" });
    await vi.waitFor(() => expect(page.data.state).toBe("ready"));

    expect(getMatchDetail).toHaveBeenCalledWith("match-1");
    expect(page.data.canSubmit).toBe(true);
    expect(page.data.homeScore).toBe(2);
    expect(page.data.awayScore).toBe(1);
    expect(page.data.derivedResultText).toBe("主胜");
    expect(submitPrediction).not.toHaveBeenCalled();

    // User can still confirm and submit
    await page.onSubmit();
    expect(submitPrediction).toHaveBeenCalledWith(
      expect.objectContaining({
        matchId: "match-1",
        homeScore: 2,
        awayScore: 1,
      }),
    );
  });

  it("supports boundary values 0 and 20 and preserves id param compatibility", async () => {
    const { page } = loadPage();
    await page.onLoad({ id: "match-1", prefill_home: "0", prefill_away: "20" });
    await vi.waitFor(() => expect(page.data.state).toBe("ready"));

    expect(page.data.homeScore).toBe(0);
    expect(page.data.awayScore).toBe(20);
    expect(page.data.derivedResultText).toBe("客胜");
  });

  it.each([
    { prefill_home: "-1", prefill_away: "1" },
    { prefill_home: "21", prefill_away: "0" },
    { prefill_home: "1.5", prefill_away: "0" },
    { prefill_home: "abc", prefill_away: "2" },
    { prefill_home: "2", prefill_away: "" },
    { prefill_home: "2" },
    { prefill_away: "1" },
  ])("silently ignores invalid or incomplete prefill pair %j", async (prefill) => {
    const { page } = loadPage();
    await page.onLoad({ match_id: "match-1", ...prefill });
    await vi.waitFor(() => expect(page.data.state).toBe("ready"));

    expect(page.data.homeScore).toBe(0);
    expect(page.data.awayScore).toBe(0);
    expect(page.data.derivedResultText).toBe("平局");
    expect(page.data.formError).toBe("");
  });

  it("does not overwrite when user already submitted or match is closed", async () => {
    const alreadySubmitted = loadPage({
      detail: async () => ({
        statusCode: 200,
        data: {
          match_id: "match-1",
          match_status: "scheduled",
          can_predict: false,
          can_predict_reason: "ALREADY_SUBMITTED",
          my_prediction: {
            prediction_id: "p-1",
            pred_home_score: 0,
            pred_away_score: 0,
            derived_result: "DRAW",
            submitted_at: "2026-08-08T10:00:00.000Z",
            match_score: null,
            wdl_hit: null,
            exact_hit: null,
          },
          home_team: {},
          away_team: {},
        },
      }),
    });
    await alreadySubmitted.page.onLoad({ match_id: "match-1", prefill_home: "3", prefill_away: "2" });
    await vi.waitFor(() => expect(alreadySubmitted.page.data.state).toBe("ready"));
    expect(alreadySubmitted.page.data.canSubmit).toBe(false);
    expect(alreadySubmitted.page.data.homeScore).toBe(0);
    expect(alreadySubmitted.page.data.awayScore).toBe(0);
    expect(alreadySubmitted.page.data.myPredictionScore).toBe("0 - 0");

    const closed = loadPage({
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
    });
    await closed.page.onLoad({ match_id: "match-1", prefill_home: "3", prefill_away: "2" });
    await vi.waitFor(() => expect(closed.page.data.state).toBe("ready"));
    expect(closed.page.data.homeScore).toBe(0);
    expect(closed.page.data.awayScore).toBe(0);
  });

  it("preserves user score edits on onShow refresh and clears prefill draft when loginGeneration changes", async () => {
    const { page, bumpLoginGeneration } = loadPage();
    await page.onLoad({ match_id: "match-1", prefill_home: "2", prefill_away: "1" });
    await vi.waitFor(() => expect(page.data.state).toBe("ready"));
    expect(page.data.homeScore).toBe(2);
    expect(page.data.awayScore).toBe(1);

    // User tweaks score and triggers onShow refresh under same loginGeneration
    page.onScoreStep({ currentTarget: { dataset: { side: "home", delta: 1 } } });
    expect(page.data.homeScore).toBe(3);
    await page.onShow(); // first onShow marks hasShown
    await page.onShow(); // second onShow refreshes detail
    expect(page.data.homeScore).toBe(3);
    expect(page.data.awayScore).toBe(1);

    // Switching account increments loginGeneration and clears prefill draft
    bumpLoginGeneration();
    await page.onShow();
    expect(page.data.homeScore).toBe(0);
    expect(page.data.awayScore).toBe(0);
    expect(page.prefillScores).toBeNull();
  });

  it("clears pending unapplied prefill draft when loginGeneration changes before detail returns", async () => {
    let resolveDetail;
    const getMatchDetail = vi.fn()
      .mockImplementationOnce(() => new Promise((r) => { resolveDetail = r; }))
      .mockResolvedValue({
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
    const { page, bumpLoginGeneration } = loadPage({ detail: getMatchDetail });

    const first = page.onLoad({ match_id: "match-1", prefill_home: "4", prefill_away: "2" });
    bumpLoginGeneration();
    resolveDetail({
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
    await first;
    await vi.waitFor(() => expect(getMatchDetail).toHaveBeenCalledTimes(2));

    expect(page.data.homeScore).toBe(0);
    expect(page.data.awayScore).toBe(0);
  });
});
