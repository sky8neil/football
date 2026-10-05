import { describe, expect, it } from "vitest";
import {
  calculatePeriodKey,
  computePredictionDeadline,
  isMondayLevelEvalAt,
  isValidPeriodKey,
  levelProtectionEndAsOf,
  levelSeasonOf,
  nextMondayEvalAt,
  periodEndAt,
  settlementEarliestStart,
} from "./time.js";
import { PeriodType } from "./enums.js";

describe("K. 排行榜 - 周期 key（规范 7 / 44-K）", () => {
  it("K88 北京时间周日/周一边界正确", () => {
    const sunday2359 = new Date("2026-08-16T15:59:00Z"); // 北京 2026-08-16 23:59 周日
    const monday0000 = new Date("2026-08-16T16:00:00Z"); // 北京 2026-08-17 00:00 周一
    expect(calculatePeriodKey(PeriodType.Week, sunday2359)).toBe("2026-W33");
    expect(calculatePeriodKey(PeriodType.Week, monday0000)).toBe("2026-W34");
  });

  it("K88 ISO week-year 跨年正确", () => {
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

  it("K88 年初周四所在的第一周不应被算成第二周", () => {
    // 北京 2025-01-01（周三）属于 2025-W01。
    const jan1Beijing = new Date("2024-12-31T16:00:00Z");
    expect(calculatePeriodKey(PeriodType.Week, jan1Beijing)).toBe("2025-W01");
  });

  it("S10：month 周期 key 不再支持", () => {
    const anchor = new Date("2026-08-31T15:59:00Z");
    expect(() => calculatePeriodKey(PeriodType.Month, anchor)).toThrow(/未知 period_type/);
    expect(isValidPeriodKey(PeriodType.Month, "2026-08")).toBe(false);
    expect(() => periodEndAt(PeriodType.Month, "2026-08")).toThrow(
      /period_key 格式与 period_type 不匹配/,
    );
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

describe("S0 等级赛季（规范 17.8.1）", () => {
  it("L109 等级赛季边界：6/30 23:59 北京 → 旧等级赛季，7/1 00:00 → 新赛季", () => {
    const june30 = new Date("2026-06-30T15:59:00Z");
    const july1 = new Date("2026-06-30T16:00:00Z");
    expect(levelSeasonOf(june30)).toBe("2025_2026");
    expect(levelSeasonOf(july1)).toBe("2026_2027");
  });
});

describe("17.6.2 周一 10:00 Asia/Shanghai 评估时刻", () => {
  it("nextMondayEvalAt 对齐最近的周一 10:00 上海（含恰好该时刻）", () => {
    const monday1000 = new Date("2026-08-03T02:00:00.000Z");
    expect(isMondayLevelEvalAt(monday1000)).toBe(true);
    expect(nextMondayEvalAt(monday1000).toISOString()).toBe(
      monday1000.toISOString(),
    );
    const sunday = new Date("2026-08-02T15:59:00.000Z");
    expect(nextMondayEvalAt(sunday).toISOString()).toBe(monday1000.toISOString());
    const monday0959 = new Date("2026-08-03T01:59:59.000Z");
    expect(nextMondayEvalAt(monday0959).toISOString()).toBe(
      monday1000.toISOString(),
    );
    const monday1001 = new Date("2026-08-03T02:00:01.000Z");
    expect(nextMondayEvalAt(monday1001).toISOString()).toBe(
      "2026-08-10T02:00:00.000Z",
    );
  });

  it("levelProtectionEndAsOf = 首次周评估起第 13 个周一 10:00", () => {
    const first = new Date("2026-08-03T02:00:00.000Z");
    const end = levelProtectionEndAsOf(first);
    expect(end.toISOString()).toBe("2026-11-02T02:00:00.000Z");
    expect(isMondayLevelEvalAt(end)).toBe(true);
  });
});
