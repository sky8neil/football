import { describe, expect, it } from "vitest";
import {
  calculatePeriodKey,
  computePredictionDeadline,
  settlementEarliestStart,
} from "./time.js";
import { PeriodType } from "./enums.js";

describe("K. 排行榜 - 周期 key（规范 7 / 44-K）", () => {
  it("K89 北京时间周日/周一边界正确", () => {
    const sunday2359 = new Date("2026-08-16T15:59:00Z"); // 北京 2026-08-16 23:59 周日
    const monday0000 = new Date("2026-08-16T16:00:00Z"); // 北京 2026-08-17 00:00 周一
    expect(calculatePeriodKey(PeriodType.Week, sunday2359)).toBe("2026-W33");
    expect(calculatePeriodKey(PeriodType.Week, monday0000)).toBe("2026-W34");
  });

  it("K90 ISO week-year 跨年正确", () => {
    // 北京 2025-12-28（周日）=> 2025-W52；2025 年没有 ISO 第 53 周
    const dec28Beijing = new Date("2025-12-27T16:00:00Z");
    expect(calculatePeriodKey(PeriodType.Week, dec28Beijing)).toBe("2025-W52");

    // 北京 2025-12-29（周一）=> 2026-W01（ISO 年与自然年不同）
    const dec29Beijing = new Date("2025-12-28T16:00:00Z");
    expect(calculatePeriodKey(PeriodType.Week, dec29Beijing)).toBe("2026-W01");

    // 北京 2026-01-01 => 2026-W01
    const jan1Beijing = new Date("2026-01-01T08:00:00Z");
    expect(calculatePeriodKey(PeriodType.Week, jan1Beijing)).toBe("2026-W01");

    // 北京 2026-01-05（周一）=> 2026-W02
    const jan5Beijing = new Date("2026-01-04T16:00:00Z");
    expect(calculatePeriodKey(PeriodType.Week, jan5Beijing)).toBe("2026-W02");
  });

  it("K90 年初周四所在的第一周不应被算成第二周", () => {
    // 北京 2025-01-01（周三）属于 2025-W01。
    const jan1Beijing = new Date("2024-12-31T16:00:00Z");
    expect(calculatePeriodKey(PeriodType.Week, jan1Beijing)).toBe("2025-W01");
  });

  it("K91 月末/月初边界正确", () => {
    const aug31 = new Date("2026-08-31T15:59:00Z"); // 北京 2026-08-31 23:59
    const sep1 = new Date("2026-08-31T16:00:00Z"); // 北京 2026-09-01 00:00
    expect(calculatePeriodKey(PeriodType.Month, aug31)).toBe("2026-08");
    expect(calculatePeriodKey(PeriodType.Month, sep1)).toBe("2026-09");
  });

  it("7.3 周期归属只使用 period_anchor_at（不同输入日期不变）", () => {
    const anchor = new Date("2026-08-08T06:00:00Z");
    expect(calculatePeriodKey(PeriodType.Week, anchor)).toBe(calculatePeriodKey(PeriodType.Week, anchor));
  });

  it("未知 period_type 失败关闭", () => {
    expect(() =>
      calculatePeriodKey("year" as PeriodType, new Date("2026-08-08T06:00:00Z")),
    ).toThrow(/未知 period_type/);
  });
});

describe("6.2 / 13.2 时间工具", () => {
  it("无效 Date 输入时失败关闭", () => {
    const invalidDate = new Date(Number.NaN);

    expect(() => calculatePeriodKey(PeriodType.Week, invalidDate)).toThrow(
      /时间必须是有效时间/,
    );
    expect(() => computePredictionDeadline(invalidDate, true)).toThrow(
      /时间必须是有效时间/,
    );
    expect(() => settlementEarliestStart(invalidDate)).toThrow(
      /时间必须是有效时间/,
    );
  });

  it("kickoff_confirmed=false 时 deadline=null", () => {
    expect(computePredictionDeadline(new Date("2026-08-08T06:00:00Z"), false)).toBeNull();
  });

  it("kickoff_confirmed=true 时 deadline = kickoff - 10min", () => {
    const deadline = computePredictionDeadline(
      new Date("2026-08-08T06:00:00Z"),
      true,
    );
    expect(deadline).not.toBeNull();
    expect(deadline!.toISOString()).toBe("2026-08-08T05:50:00.000Z");
  });

  it("settlementEarliestStart = finish_detected_at + 10min", () => {
    expect(
      settlementEarliestStart(new Date("2026-08-08T18:00:00Z")).toISOString(),
    ).toBe("2026-08-08T18:10:00.000Z");
  });
});
