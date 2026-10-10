import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

function loadCommonJs(file, requireShim) {
  const module = { exports: {} };
  const factory = runInThisContext(`(function(module, exports, require) {\n${readFileSync(file, "utf8")}\n})`, { filename: file });
  factory(module, module.exports, requireShim);
  return module.exports;
}

const copy = loadCommonJs(join(HERE, "crowd-copy.js"), () => { throw new Error("Unexpected require"); });
const vm = loadCommonJs(join(HERE, "crowd-view-model.js"), (id) => {
  if (id === "./crowd-copy.js") return copy;
  throw new Error(`Unexpected require: ${id}`);
});

const match = (overrides = {}) => ({
  match_status: "live",
  can_predict_reason: "CLOSED",
  regular_home_score: null,
  regular_away_score: null,
  ...overrides,
});

describe("crowd view model", () => {
  it("applies the local status priority before requesting", () => {
    for (const status of ["postponed", "cancelled", "abandoned"]) {
      expect(vm.crowdPlan({ match: match({ match_status: status }), identityMissing: true })).toBe("hidden");
    }
    expect(vm.crowdPlan({ match: match(), identityMissing: true })).toBe("guest");
    expect(vm.crowdPlan({ match: match({ match_status: "scheduled", can_predict_reason: null }), identityMissing: false })).toBe("locked");
    expect(vm.crowdPlan({ match: match({ match_status: "scheduled", can_predict_reason: "ALREADY_SUBMITTED" }), identityMissing: false })).toBe("locked");
    expect(vm.crowdPlan({ match: match({ match_status: "scheduled", can_predict_reason: "CLOSED" }), identityMissing: false })).toBe("fetch");
    expect(vm.crowdPlan({ match: match({ match_status: "finished" }), identityMissing: false })).toBe("fetch");
  });

  it("maps each API status and builds proportional visible segments", () => {
    expect(vm.crowdCard({ response: { status: "not_closed", min_predictions: 20 } })).toMatchObject({ kind: "locked", message: "比赛截止后可看，达到最低参与人数后显示" });
    expect(vm.crowdCard({ response: { status: "insufficient", min_predictions: 24 } })).toMatchObject({ kind: "insufficient", message: expect.stringContaining("24") });
    expect(vm.crowdCard({ response: { status: "unavailable" } })).toEqual({ kind: "hidden" });
    const card = vm.crowdCard({
      response: { status: "available", distribution: { home: 0, draw: 35, away: 65 }, granularity: 5 },
      match: match(),
      myPrediction: { derived_result: "AWAY" },
    });
    expect(card.segments.map(({ key }) => key)).toEqual(["draw", "away"]);
    expect(card.segments.reduce((sum, item) => sum + Number(item.width.slice(0, -1)), 0)).toBe(100);
    expect(card.segments[1].selected).toBe(true);
    expect(card.granularity).toBe(5);
  });

  it("creates finished-match comparisons and omits them without an actual score", () => {
    const distribution = { home: 45, draw: 20, away: 35 };
    expect(vm.crowdComparison({ distribution, myChoice: "HOME", actualResult: "HOME", matchStatus: "finished" }).text).toContain("约 45%");
    expect(vm.crowdComparison({ distribution, myChoice: "AWAY", actualResult: "HOME", matchStatus: "finished" }).text).toContain("约 35%");
    expect(vm.crowdComparison({ distribution, myChoice: null, actualResult: "HOME", matchStatus: "finished" }).text).toContain("约 45%");
    expect(vm.crowdComparison({ distribution, myChoice: "HOME", actualResult: null, matchStatus: "finished" })).toBeNull();
    expect(vm.crowdComparison({ distribution, myChoice: "HOME", actualResult: "HOME", matchStatus: "live" })).toBeNull();
    const card = vm.crowdCard({
      response: { status: "available", distribution, granularity: 5 },
      match: match({ match_status: "finished", regular_home_score: 2, regular_away_score: 1 }),
      myPrediction: { derived_result: "HOME" },
    });
    expect(card.segments.find(({ key }) => key === "home")).toMatchObject({ selected: true, actual: true });
    expect(card.comparisonText).toContain("约 45%");
  });

  it("keeps required copy in the copy module", () => {
    expect(copy.COPY.footer).toBeTruthy();
    expect(copy.COPY.locked).toBe("比赛截止后可看，达到最低参与人数后显示");
    expect(copy.COPY.insufficient(24)).toContain("24");
    expect(copy.COPY.retry).toBeTruthy();
    expect(copy.COPY.yourChoice).toBeTruthy();
  });
});
