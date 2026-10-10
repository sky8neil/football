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

function loadPage({ detail, crowd } = {}) {
  const pageConfig = {};
  Object.defineProperty(globalThis, "Page", { value: (config) => Object.assign(pageConfig, config), configurable: true });
  const getMatchCrowd = vi.fn(crowd || (async () => ({ statusCode: 200, data: { status: "available", distribution: { home: 50, draw: 25, away: 25 }, granularity: 5, min_predictions: 20 } })));
  const getMatchDetail = vi.fn(detail || (async () => ({ statusCode: 200, data: {
    match_id: "match-1", match_status: "live", can_predict_reason: "CLOSED",
    regular_home_score: null, regular_away_score: null,
    home_team: {}, away_team: {},
  } })));
  const copy = loadCommonJs(join(HERE, "..", "..", "utils", "crowd-copy.js"), {});
  const vm = loadCommonJs(join(HERE, "..", "..", "utils", "crowd-view-model.js"), { "./crowd-copy.js": copy });
  loadCommonJs(join(HERE, "match-detail.js"), {
    "../../services/matches.js": { getMatchDetail, getMatchCrowd },
    "../../services/predictions.js": { createUuidV4: () => "uuid", submitPrediction: vi.fn() },
    "../../utils/logo-registry.js": { getTeamLogo: () => "" },
    "../../utils/crowd-view-model.js": vm,
    "../../utils/crowd-copy.js": copy,
  });
  const page = Object.assign({}, pageConfig, {
    data: JSON.parse(JSON.stringify(pageConfig.data)),
    setData(patch) { Object.assign(this.data, patch); },
  });
  return { page, getMatchCrowd, getMatchDetail };
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
});
