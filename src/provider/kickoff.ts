/**
 * Fixture UTC kickoff 解析与校验（规范 31.2）。
 *
 * - 优先使用 Provider 的 UTC timestamp / 明确时间字段转为 UTC Date。
 * - 若 fixture.timestamp 与 fixture.date 解析结果偏差超过 60 秒：
 *   PROVIDER_DATA_INVALID anomaly，且不自动更新 kickoff（两者都不信任）。
 */
export const KICKOFF_TOLERANCE_MS = 60_000;

export interface KickoffParse {
  /** 解析出的 UTC kickoff；缺失或偏差超过容差时为 null。 */
  kickoffAt: Date | null;
  /** |timestamp - date| 毫秒数；仅当两者均可解析时非 null。 */
  deltaMs: number | null;
  /** timestamp 与 date 偏差超过容差。 */
  mismatch: boolean;
  /** 两个来源均缺失/不可用。 */
  missing: boolean;
  /** 至少一个已提供来源无法解析；此时必须整体 fail closed。 */
  invalid: boolean;
}

interface ParsedSource {
  date: Date | null;
  supplied: boolean;
  invalid: boolean;
}

function parseTimestamp(value: unknown): ParsedSource {
  if (value === undefined || value === null) {
    return { date: null, supplied: false, invalid: false };
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { date: null, supplied: true, invalid: true };
  }
  const milliseconds = value * 1000;
  if (!Number.isFinite(milliseconds)) {
    return { date: null, supplied: true, invalid: true };
  }
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime())
    ? { date, supplied: true, invalid: false }
    : { date: null, supplied: true, invalid: true };
}

function parseDate(value: unknown): ParsedSource {
  if (value === undefined || value === null || value === "") {
    return { date: null, supplied: false, invalid: false };
  }
  if (typeof value !== "string") {
    return { date: null, supplied: true, invalid: true };
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    return { date: null, supplied: true, invalid: true };
  }
  const date = new Date(time);
  return Number.isFinite(date.getTime())
    ? { date, supplied: true, invalid: false }
    : { date: null, supplied: true, invalid: true };
}

export function parseKickoff(
  timestamp: unknown,
  date: unknown,
  toleranceMs: number = KICKOFF_TOLERANCE_MS,
): KickoffParse {
  const fromTimestamp = parseTimestamp(timestamp);
  const fromDate = parseDate(date);

  if (fromTimestamp.invalid || fromDate.invalid) {
    return {
      kickoffAt: null,
      deltaMs: null,
      mismatch: false,
      missing: !fromTimestamp.supplied && !fromDate.supplied,
      invalid: true,
    };
  }

  if (!fromTimestamp.supplied && !fromDate.supplied) {
    return {
      kickoffAt: null,
      deltaMs: null,
      mismatch: false,
      missing: true,
      invalid: false,
    };
  }
  if (!fromTimestamp.supplied) {
    return {
      kickoffAt: fromDate.date,
      deltaMs: null,
      mismatch: false,
      missing: false,
      invalid: false,
    };
  }

  if (!fromDate.supplied) {
    return {
      kickoffAt: fromTimestamp.date,
      deltaMs: null,
      mismatch: false,
      missing: false,
      invalid: false,
    };
  }

  const timestampDate = fromTimestamp.date;
  const dateDate = fromDate.date;
  if (timestampDate === null || dateDate === null) {
    return {
      kickoffAt: null,
      deltaMs: null,
      mismatch: false,
      missing: false,
      invalid: true,
    };
  }

  const deltaMs = Math.abs(timestampDate.getTime() - dateDate.getTime());
  if (deltaMs > toleranceMs) {
    return {
      kickoffAt: null,
      deltaMs,
      mismatch: true,
      missing: false,
      invalid: false,
    };
  }

  return {
    kickoffAt: timestampDate,
    deltaMs,
    mismatch: false,
    missing: false,
    invalid: false,
  };
}
