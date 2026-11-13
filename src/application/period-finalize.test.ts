import { describe, expect, it } from "vitest";
import { PeriodType } from "../domain/enums.js";
import type { RankingEntry } from "../domain/types.js";
import { periodEndAt } from "../domain/time.js";
import { finalizeRankingEntry, listDueWeekPeriodKeys } from "./period-finalize.js";

const WEEK_ENTRY: RankingEntry = {
  schema_version: 1,
  period_type: PeriodType.Week,
  period_key: "2026-W32",
  user_id: "user-1",
  period_score: 12,
  valid_predictions: 1,
  wdl_hits: 1,
  exact_hits: 1,
  last_scoring_match_at: new Date("2026-08-08T06:00:00.000Z"),
  global_rank: null,
  is_final: false,
  created_at: new Date("2026-08-08T06:00:00.000Z"),
  updated_at: new Date("2026-08-08T06:00:00.000Z"),
};

describe("period finalization", () => {
  it("computes week end at Beijing midnight", () => {
    expect(periodEndAt(PeriodType.Week, "2026-W32").toISOString()).toBe(
      "2026-08-09T16:00:00.000Z",
    );
  });

  it("finalizes at the inclusive period end boundary", () => {
    const before = new Date("2026-08-09T15:59:59.999Z");
    const atEnd = new Date("2026-08-09T16:00:00.000Z");

    expect(finalizeRankingEntry(WEEK_ENTRY, before)).toBe(WEEK_ENTRY);
    expect(finalizeRankingEntry(WEEK_ENTRY, atEnd)).toMatchObject({
      is_final: true,
      updated_at: WEEK_ENTRY.updated_at,
    });
  });

  it("never reopens a finalized ranking", () => {
    const finalized = { ...WEEK_ENTRY, is_final: true };

    expect(finalizeRankingEntry(finalized, new Date("2026-08-01T00:00:00.000Z"))).toBe(
      finalized,
    );
  });

  it("rejects an invalid period key", () => {
    expect(() => periodEndAt(PeriodType.Week, "2026-08")).toThrowError(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
  });

  it("enumerates ended unfinalized week keys and skips current or already-final weeks", () => {
    const now = new Date("2026-08-10T16:00:00.000Z");
    const keys = listDueWeekPeriodKeys([
      WEEK_ENTRY,
      { ...WEEK_ENTRY, user_id: "user-2", period_key: "2026-W31", is_final: true },
      { ...WEEK_ENTRY, user_id: "user-3", period_key: "2026-W33", is_final: false },
      { ...WEEK_ENTRY, user_id: "user-4", period_key: "2026-W31", is_final: false },
    ], now);
    expect(keys).toEqual(["2026-W31", "2026-W32"]);
  });
});
