import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTLEMENT_TODO_BATCH,
  SETTLEMENT_FALLBACK_INTERVAL_MS,
  settlementTodoBatch,
  shouldRunFallback,
} from "./settlement-todo-batch.js";

const TWELVE_HOURS = 12 * 60 * 60 * 1000;
const NOW = new Date("2026-08-09T12:00:00.000Z");

describe("settlementTodoBatch", () => {
  it("空 env 回落默认值", () => {
    expect(settlementTodoBatch({})).toBe(DEFAULT_SETTLEMENT_TODO_BATCH);
    expect(settlementTodoBatch({})).toBe(50);
  });

  it('合法覆盖 FOOTBALL_SETTLEMENT_TODO_BATCH="7" → 7', () => {
    expect(settlementTodoBatch({ FOOTBALL_SETTLEMENT_TODO_BATCH: "7" })).toBe(7);
  });

  it('非法值 "0" / "-3" / "abc" / "" 回落默认值', () => {
    for (const raw of ["0", "-3", "abc", ""]) {
      expect(settlementTodoBatch({ FOOTBALL_SETTLEMENT_TODO_BATCH: raw })).toBe(
        DEFAULT_SETTLEMENT_TODO_BATCH,
      );
    }
  });
});

describe("shouldRunFallback", () => {
  it("last_run_at 为 null → true", () => {
    expect(shouldRunFallback(null, NOW, TWELVE_HOURS)).toBe(true);
  });

  it("now - last = 11h → false", () => {
    const last = new Date(NOW.getTime() - 11 * 60 * 60 * 1000);
    expect(shouldRunFallback(last, NOW, TWELVE_HOURS)).toBe(false);
  });

  it("now - last = 12h → true", () => {
    const last = new Date(NOW.getTime() - TWELVE_HOURS);
    expect(shouldRunFallback(last, NOW, TWELVE_HOURS)).toBe(true);
    expect(SETTLEMENT_FALLBACK_INTERVAL_MS).toBe(TWELVE_HOURS);
  });
});
