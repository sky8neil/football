/**
 * 等级计算（规范第 17 节）。
 *
 * 唯一实现入口（规范 0.4）：calculate_level(scope, valid_predictions, wdl_hits)。
 *
 * 规则：
 * - 准确率理论等级按真实比例比较，必须使用整数交叉乘法，禁止使用四舍五入后的显示值（17.2、17.4）。
 * - 最终等级 = min(accuracy_level, sample_size_level)（17.5）。
 */
import { LevelScope, type LevelScope as LevelScopeType } from "./enums.js";
import { validationError } from "./errors.js";

export const LEVEL_MIN = 1;
export const LEVEL_MAX = 8;

interface AccuracyThreshold {
  level: number;
  /** 百分比阈值，wdl * 100 >= valid * threshold 即达到该档 */
  minPercent: number;
}

/** 理论档位从高到低：达到最高档即停止。 */
const ACCURACY_THRESHOLDS: readonly AccuracyThreshold[] = [
  { level: 8, minPercent: 70 },
  { level: 7, minPercent: 65 },
  { level: 6, minPercent: 60 },
  { level: 5, minPercent: 55 },
  { level: 4, minPercent: 50 },
  { level: 3, minPercent: 45 },
] as const;

interface SampleCap {
  level: number;
  /** 该档要求的最大样本数（含） */
  upTo: number;
}

const SEASON_SAMPLE_CAPS: readonly SampleCap[] = [
  { level: 1, upTo: 9 },
  { level: 2, upTo: 14 },
  { level: 3, upTo: 19 },
  { level: 4, upTo: 29 },
  { level: 5, upTo: 39 },
  { level: 6, upTo: 49 },
  { level: 7, upTo: 69 },
  { level: 8, upTo: Number.POSITIVE_INFINITY },
] as const;

const CAREER_SAMPLE_CAPS: readonly SampleCap[] = [
  { level: 1, upTo: 19 },
  { level: 2, upTo: 39 },
  { level: 3, upTo: 59 },
  { level: 4, upTo: 99 },
  { level: 5, upTo: 149 },
  { level: 6, upTo: 249 },
  { level: 7, upTo: 399 },
  { level: 8, upTo: Number.POSITIVE_INFINITY },
] as const;

/** 准确率理论等级；样本为 0 时理论值无意义，最终由样本上限限制为 1。 */
export function theoreticalAccuracyLevel(
  validPredictions: number,
  wdlHits: number,
): number {
  assertStats(validPredictions, wdlHits);
  if (validPredictions === 0) {
    return LEVEL_MIN;
  }
  for (const threshold of ACCURACY_THRESHOLDS) {
    if (wdlHits * 100 >= validPredictions * threshold.minPercent) {
      return threshold.level;
    }
  }
  return 2;
}

/** 样本量上限等级（17.3 / 17.4）。 */
export function sampleSizeLevel(
  scope: LevelScopeType,
  validPredictions: number,
): number {
  if (validPredictions < 0 || !Number.isInteger(validPredictions)) {
    throw validationError("valid_predictions 必须为非负整数", {
      valid_predictions: validPredictions,
    });
  }
  if (scope !== LevelScope.Season && scope !== LevelScope.Career) {
    throw validationError("未知等级 scope", { scope });
  }
  const caps =
    scope === LevelScope.Season ? SEASON_SAMPLE_CAPS : CAREER_SAMPLE_CAPS;
  for (const cap of caps) {
    if (validPredictions <= cap.upTo) {
      return cap.level;
    }
  }
  return LEVEL_MAX;
}

/**
 * 唯一实现入口：calculate_level(scope, valid_predictions, wdl_hits)。
 */
export function calculateLevel(
  scope: LevelScopeType,
  validPredictions: number,
  wdlHits: number,
): number {
  const accuracyLevel = theoreticalAccuracyLevel(validPredictions, wdlHits);
  const sampleLevel = sampleSizeLevel(scope, validPredictions);
  return Math.min(accuracyLevel, sampleLevel);
}

/**
 * 17.7：只有 from_level != to_level 才写 level_history。
 */
export function shouldRecordLevelChange(
  fromLevel: number,
  toLevel: number,
): boolean {
  return fromLevel !== toLevel;
}

/**
 * 17.6：best_level 只增不减（career / season 均适用）。
 */
export function nextBestLevel(oldBestLevel: number, newLevel: number): number {
  return Math.max(oldBestLevel, newLevel);
}

function assertStats(validPredictions: number, wdlHits: number): void {
  if (
    !Number.isInteger(validPredictions) ||
    validPredictions < 0 ||
    !Number.isInteger(wdlHits) ||
    wdlHits < 0
  ) {
    throw validationError("等级统计必须为非负整数", {
      valid_predictions: validPredictions,
      wdl_hits: wdlHits,
    });
  }
  if (wdlHits > validPredictions) {
    throw validationError("wdl_hits 不能大于 valid_predictions", {
      valid_predictions: validPredictions,
      wdl_hits: wdlHits,
    });
  }
}
