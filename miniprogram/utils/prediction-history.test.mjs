import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const module = { exports: {} };
runInNewContext(readFileSync(new URL("./prediction-history.js", import.meta.url), "utf8"), {
  module,
  exports: module.exports,
});
const { formatShanghaiKickoff, groupPredictionsByWeek, hasReachedEightWeekHistory, isoWeekKey } = module.exports;

describe("hasReachedEightWeekHistory", () => {
  const now = Date.parse("2026-10-06T00:00:00.000Z");
  const cutoff = now - 8 * 7 * 24 * 60 * 60 * 1000;

  it("stops at a prediction kicked off exactly eight weeks ago", () => {
    expect(hasReachedEightWeekHistory([
      { kickoff_at: new Date(cutoff).toISOString() },
    ], now)).toBe(true);
  });

  it("keeps paging when the oldest prediction is newer than eight weeks", () => {
    expect(hasReachedEightWeekHistory([
      { kickoff_at: new Date(cutoff + 1).toISOString() },
    ], now)).toBe(false);
  });
});

describe("prediction week grouping", () => {
  it("groups by the match kickoff's Beijing ISO week", () => {
    expect(isoWeekKey("2026-10-04T16:30:00.000Z")).toBe("2026-W41");
    expect(isoWeekKey("2026-10-04T15:59:59.000Z")).toBe("2026-W40");
    const groups = groupPredictionsByWeek([
      { prediction_id: "new", kickoff_at: "2026-10-04T16:30:00.000Z" },
      { prediction_id: "old", kickoff_at: "2026-10-04T15:59:59.000Z" },
    ]);
    expect(groups.map((group) => group.label)).toEqual(["2026 第41周", "2026 第40周"]);
  });

  it("formats kickoff using the Beijing time zone", () => {
    expect(formatShanghaiKickoff("2026-10-06T04:00:00.000Z")).toContain("12:00");
  });
});
