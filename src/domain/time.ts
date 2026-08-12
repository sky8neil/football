/**
 * 时间 / 周期领域工具（规范 6、7）。
 *
 * - 业务判断只允许使用可信服务端时间 server_now（规范 2.3）。
 * - 周期归属只使用 period_anchor_at，禁止使用结算/预测/round 日期（规范 7.3）。
 * - 展示周期时区：Asia/Shanghai（UTC+8，无 DST），周期边界为北京时间。
 */
import { FIXED_CONFIG_V1 } from "./config.js";
import { PeriodType, type PeriodType as PeriodTypeValue } from "./enums.js";
import { validationError } from "./errors.js";

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function assertValidDate(date: Date): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw validationError("时间必须是有效时间");
  }
}

export interface ShanghaiParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Monday ... 6 = Sunday（北京时间本地） */
  weekday: number;
}

/** 将 UTC instant 转为北京时间墙钟各部分。 */
export function toShanghaiParts(date: Date): ShanghaiParts {
  assertValidDate(date);
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  const weekday = (shifted.getUTCDay() + 6) % 7;
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday,
  };
}

/** ISO 周编号（ISO 8601），输入为“北京时间”拆解出的日历日期（内部按 UTC 计算）。 */
function isoWeekFromCalendar(
  year: number,
  month: number,
  day: number,
): { isoYear: number; isoWeek: number } {
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayNum = (date.getUTCDay() + 6) % 7; // Monday=0 .. Sunday=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // 定位本周周四
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const daysSinceYearStart = (date.getTime() - yearStart.getTime()) / 86400000;
  const isoWeek = Math.floor(daysSinceYearStart / 7) + 1;
  return { isoYear, isoWeek };
}

/** 周周期 key：基于 period_anchor_at 的北京时间日期计算 ISO week-year，例如 2026-W32。 */
export function weekPeriodKey(periodAnchorAt: Date): string {
  const p = toShanghaiParts(periodAnchorAt);
  const { isoYear, isoWeek } = isoWeekFromCalendar(p.year, p.month, p.day);
  return `${isoYear}-W${String(isoWeek).padStart(2, "0")}`;
}

/** 月周期 key：北京时间自然月，例如 2026-08。 */
export function monthPeriodKey(periodAnchorAt: Date): string {
  const p = toShanghaiParts(periodAnchorAt);
  return `${p.year}-${String(p.month).padStart(2, "0")}`;
}

/**
 * 唯一实现入口（规范 0.4）：
 * calculate_period_key(period_type, period_anchor_at)
 */
export function calculatePeriodKey(
  periodType: PeriodTypeValue,
  periodAnchorAt: Date,
): string {
  if (periodType === PeriodType.Week) {
    return weekPeriodKey(periodAnchorAt);
  }
  if (periodType === PeriodType.Month) {
    return monthPeriodKey(periodAnchorAt);
  }
  throw validationError("未知 period_type", { period_type: periodType });
}

/**
 * 返回周期结束边界（北京时间 00:00 的 UTC instant）。
 * 周期结束时刻属于下一周期，因此封榜判断使用 server_now >= 此值。
 */
export function periodEndAt(
  periodType: PeriodTypeValue,
  periodKey: string,
): Date {
  if (!isValidPeriodKey(periodType, periodKey)) {
    throw validationError("period_key 格式与 period_type 不匹配", {
      period_type: periodType,
      period_key: periodKey,
    });
  }

  if (periodType === PeriodType.Month) {
    const [year, month] = periodKey.split("-").map(Number);
    return new Date(Date.UTC(year!, month!, 1) - SHANGHAI_OFFSET_MS);
  }

  const match = /^(\d{4})-W(\d{2})$/.exec(periodKey);
  if (match === null) {
    throw validationError("period_key 格式与 period_type 不匹配", {
      period_type: periodType,
      period_key: periodKey,
    });
  }

  const isoYear = Number(match[1]);
  const isoWeek = Number(match[2]);
  const januaryFourth = new Date(Date.UTC(isoYear, 0, 4));
  const januaryFourthWeekday = (januaryFourth.getUTCDay() + 6) % 7;
  const endDayOfJanuary = 4 - januaryFourthWeekday + isoWeek * 7;
  return new Date(
    Date.UTC(isoYear, 0, endDayOfJanuary) - SHANGHAI_OFFSET_MS,
  );
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function weekdayOfJanuaryFirst(year: number): number {
  const date = new Date(0);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCFullYear(year, 0, 1);
  return date.getUTCDay();
}

/** 校验 API 使用的 week/month period_key 形状与可用范围。 */
export function isValidPeriodKey(
  periodType: PeriodTypeValue,
  periodKey: string,
): boolean {
  if (typeof periodKey !== "string") {
    return false;
  }
  if (periodType === PeriodType.Month) {
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(periodKey);
  }
  if (periodType === PeriodType.Week) {
    const match = /^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$/.exec(periodKey);
    if (match === null) {
      return false;
    }
    const year = Number(match[1]);
    const week = Number(match[2]);
    const januaryFirst = weekdayOfJanuaryFirst(year);
    const hasWeek53 = januaryFirst === 4 || (isLeapYear(year) && januaryFirst === 3);
    return week <= 52 || hasWeek53;
  }
  return false;
}

export function addMinutes(date: Date, minutes: number): Date {
  assertValidDate(date);
  return new Date(date.getTime() + minutes * 60 * 1000);
}

/**
 * 计算 prediction_deadline_at（规范 6.2）：
 * kickoff_confirmed=true  => kickoff_at - PREDICTION_LOCK_MINUTES
 * kickoff_confirmed=false => null
 */
export function computePredictionDeadline(
  kickoffAt: Date,
  kickoffConfirmed: boolean,
  lockMinutes: number = FIXED_CONFIG_V1.PREDICTION_LOCK_MINUTES,
): Date | null {
  assertValidDate(kickoffAt);
  if (!kickoffConfirmed) {
    return null;
  }
  return addMinutes(kickoffAt, -lockMinutes);
}

/**
 * 首次正式结算最早可开始时间（规范 13.2）：
 * finish_detected_at + SETTLEMENT_WAIT_MINUTES
 */
export function settlementEarliestStart(
  finishDetectedAt: Date,
  waitMinutes: number = FIXED_CONFIG_V1.SETTLEMENT_WAIT_MINUTES,
): Date {
  return addMinutes(finishDetectedAt, waitMinutes);
}
