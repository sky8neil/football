/**
 * 时间 / 周期领域工具（规范 6、7）。
 *
 * - 业务判断只允许使用可信服务端时间 server_now（规范 2.3）。
 * - 周期归属只使用 period_anchor_at，禁止使用结算/预测/round 日期（规范 7.3）。
 * - 展示周期时区：Asia/Shanghai（UTC+8，无 DST），周期边界为北京时间。
 */
import { FIXED_CONFIG_V1 } from "./config.js";
import { PeriodType, type PeriodType as PeriodTypeValue } from "./enums.js";
import { DomainError, validationError } from "./errors.js";

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

/**
 * 唯一实现入口（规范 0.4）：
 * calculate_period_key(period_type, period_anchor_at)
 * 只支持 week 周期。
 */
export function calculatePeriodKey(
  periodType: PeriodTypeValue,
  periodAnchorAt: Date,
): string {
  if (periodType === PeriodType.Week) {
    return weekPeriodKey(periodAnchorAt);
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

/** 校验 week period_key 形状与可用范围。 */
export function isValidPeriodKey(
  periodType: PeriodTypeValue,
  periodKey: string,
): boolean {
  if (typeof periodKey !== "string") {
    return false;
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

/** 等级赛季 id：北京时间 7/1 00:00 切年，形如 "2026_2027"。 */
export function levelSeasonOf(periodAnchorAt: Date): string {
  const p = toShanghaiParts(periodAnchorAt);
  const year = p.month >= 7 ? p.year : p.year - 1;
  return `${year}_${year + 1}`;
}

/** 该等级赛季结束后第一次周一 10:00（北京时间）的最终评估时刻。 */
export function seasonFinalEvalAsOf(levelSeasonId: string): Date {
  const match = /^(\d{4})_(\d{4})$/.exec(levelSeasonId);
  if (match === null || Number(match[2]) !== Number(match[1]) + 1) {
    throw new DomainError("INVALID_LEDGER", `level_season_id 非法（level_season_id=${levelSeasonId}）`);
  }
  const seasonEnd = new Date(Date.UTC(Number(match[2]), 6, 1) - SHANGHAI_OFFSET_MS);
  return nextMondayEvalAt(seasonEnd);
}

function shanghaiWallToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
  second = 0,
): Date {
  return new Date(
    Date.UTC(year, month - 1, day, hour, minute, second) - SHANGHAI_OFFSET_MS,
  );
}

/** 是否恰好为周一 10:00:00.000 Asia/Shanghai（§17.6.2 评估时刻）。 */
export function isMondayLevelEvalAt(date: Date): boolean {
  const p = toShanghaiParts(date);
  return (
    p.weekday === 0 &&
    p.hour === 10 &&
    p.minute === 0 &&
    p.second === 0 &&
    date.getTime() % 1000 === 0
  );
}

/**
 * 大于等于 `from` 的最早「周一 10:00 Asia/Shanghai」评估时刻。
 * 若 `from` 恰好是该时刻，返回其本身。
 */
export function nextMondayEvalAt(from: Date): Date {
  const p = toShanghaiParts(from);
  const thisMonday = shanghaiWallToUtc(p.year, p.month, p.day - p.weekday, 10);
  if (from.getTime() <= thisMonday.getTime()) {
    return thisMonday;
  }
  return new Date(thisMonday.getTime() + 7 * 24 * 60 * 60 * 1000);
}

/**
 * 保护期结束时刻：首次周评估 as_of 起第 13 个周评估之后
 *（即 `firstEvalAsOf + 13 周`；前 13 次周评估 `as_of < end` 不降级不累计）。
 *
 * Q1：`LEVEL_FIRST_EVAL_AS_OF` 未登记。本函数只接受显式注入的首次周一，
 * 不得读取 null 配置去发明上线日。
 */
export function levelProtectionEndAsOf(firstEvalAsOf: Date): Date {
  if (!isMondayLevelEvalAt(firstEvalAsOf)) {
    throw validationError("首次周评估 as_of 必须是周一 10:00 Asia/Shanghai", {
      first_eval_as_of: firstEvalAsOf.toISOString(),
    });
  }
  return new Date(
    firstEvalAsOf.getTime() +
      FIXED_CONFIG_V1.LEVEL_PROTECTION_EVALS * 7 * 24 * 60 * 60 * 1000,
  );
}
