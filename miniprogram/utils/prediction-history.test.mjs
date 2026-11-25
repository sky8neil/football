import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const module = { exports: {} };
runInNewContext(readFileSync(new URL("./prediction-history.js", import.meta.url), "utf8"), {
  module,
  exports: module.exports,
  Date,
});
const { formatShanghaiKickoff, groupPredictionsByWeek, isoWeekKey } = module.exports;

const originalLocaleString = Date.prototype.toLocaleString;
const originalLocaleDateString = Date.prototype.toLocaleDateString;

afterEach(() => {
  Date.prototype.toLocaleString = originalLocaleString;
  Date.prototype.toLocaleDateString = originalLocaleDateString;
});

function disableLocaleFormatting() {
  Date.prototype.toLocaleString = () => {
    throw new RangeError("locale data missing");
  };
  Date.prototype.toLocaleDateString = () => {
    throw new RangeError("locale data missing");
  };
}

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

  it("formats kickoff using the Beijing time zone without locale APIs", () => {
    disableLocaleFormatting();
    expect(formatShanghaiKickoff("2026-10-06T04:00:00.000Z")).toBe("10月6日周二 12:00");
    expect(formatShanghaiKickoff("2026-10-06T16:05:00.000Z")).toBe("10月7日周三 00:05");
    expect(formatShanghaiKickoff("not-a-date")).toBe("");
  });

  it("[A-S2-06] sorts week groups descending by ISO week even when late and early rounds are submitted out of order", () => {
    const groups = groupPredictionsByWeek([
      { prediction_id: "w40-first", kickoff_at: "2026-10-04T15:59:59.000Z" },
      { prediction_id: "unknown-1", kickoff_at: null },
      { prediction_id: "w42-later", kickoff_at: "2026-10-15T12:00:00.000Z" },
      { prediction_id: "w40-second", kickoff_at: "2026-10-03T12:00:00.000Z" },
      { prediction_id: "w41-middle", kickoff_at: "2026-10-05T12:00:00.000Z" },
    ]);
    expect(groups.map((g) => g.key)).toEqual(["2026-W42", "2026-W41", "2026-W40", "unknown"]);
    expect(groups.map((g) => g.label)).toEqual(["2026 第42周", "2026 第41周", "2026 第40周", "比赛周次未知"]);
  });
});
