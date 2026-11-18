import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const module = { exports: {} };
runInNewContext(readFileSync(new URL("./prediction-history.js", import.meta.url), "utf8"), {
  module,
  exports: module.exports,
});
const { formatShanghaiKickoff, groupPredictionsByWeek, isoWeekKey } = module.exports;

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
