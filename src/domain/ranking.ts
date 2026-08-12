/**
 * 排行榜比较与门槛（规范第 19 节）。
 *
 * 唯一实现入口（规范 0.4）：compare_ranking_entry(a, b)。
 *
 * 排序严格按（19.4）：
 *   period_score DESC
 *   wdl 准确率 DESC（交叉乘法，禁止比较浮点缓存）
 *   exact_hits DESC
 *   last_scoring_match_at ASC（null 排在最后）
 *   user_id ASC
 */
import { FIXED_CONFIG_V1, MIN_RANK_PREDICTIONS } from "./config.js";
import { validationError } from "./errors.js";

export interface RankingComparable {
  period_score: number;
  valid_predictions: number;
  wdl_hits: number;
  exact_hits: number;
  last_scoring_match_at: Date | null;
  user_id: string;
}

/**
 * 比较两个排名条目。
 * 返回负数表示 a 排在 b 之前；返回正数表示 b 排在 a 之前；0 表示完全一致（理论上不存在）。
 */
export function compareRankingEntry(
  a: RankingComparable,
  b: RankingComparable,
): number {
  assertComparable(a);
  assertComparable(b);

  if (a.period_score !== b.period_score) {
    return b.period_score - a.period_score;
  }

  const accuracyDiff = compareAccuracy(a, b);
  if (accuracyDiff !== 0) {
    return accuracyDiff;
  }

  if (a.exact_hits !== b.exact_hits) {
    return b.exact_hits - a.exact_hits;
  }

  const lastScoringDiff = compareLastScoring(a.last_scoring_match_at, b.last_scoring_match_at);
  if (lastScoringDiff !== 0) {
    return lastScoringDiff;
  }

  return a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0;
}

/**
 * 准确率比较：A.wdl_hits * B.valid_predictions vs B.wdl_hits * A.valid_predictions（19.4）。
 * 返回负数表示 a 准确率更高。
 */
function compareAccuracy(a: RankingComparable, b: RankingComparable): number {
  const lhs = a.wdl_hits * b.valid_predictions;
  const rhs = b.wdl_hits * a.valid_predictions;
  if (lhs === rhs) {
    return 0;
  }
  return lhs > rhs ? -1 : 1;
}

/** last_scoring_match_at ASC；非 null 优先于 null（19.5）。 */
function compareLastScoring(
  a: Date | null,
  b: Date | null,
): number {
  if (a !== null && b !== null) {
    return a.getTime() - b.getTime();
  }
  if (a === null && b === null) {
    return 0;
  }
  return a !== null ? -1 : 1;
}

/** 入榜最低场次（19.3）：valid_predictions >= 3。 */
export function isRankEligible(validPredictions: number): boolean {
  if (!Number.isInteger(validPredictions) || validPredictions < 0) {
    throw validationError("valid_predictions 必须为非负整数", {
      valid_predictions: validPredictions,
    });
  }
  return validPredictions >= MIN_RANK_PREDICTIONS;
}

/**
 * 计算 global_rank（19.2 / 19.6）：
 * 不符合最低场次 => null；符合 => 排序位置。
 */
export function rankForPosition(
  validPredictions: number,
  position: number,
): number | null {
  if (!isRankEligible(validPredictions)) {
    return null;
  }
  if (!Number.isInteger(position) || position < 1) {
    throw validationError("rank position 必须为正整数", { position });
  }
  return position;
}

/**
 * last_scoring_match_at 规则（19.5）：
 * period_score = 0 时强制为 null。
 */
export function lastScoringForPeriodScore(
  periodScore: number,
  lastScoringMatchAt: Date | null,
): Date | null {
  if (!Number.isInteger(periodScore) || periodScore < 0) {
    throw validationError("period_score 必须为非负整数", { period_score: periodScore });
  }
  if (periodScore === 0) {
    return null;
  }
  return lastScoringMatchAt;
}

export function globalMinPredictions(): number {
  return FIXED_CONFIG_V1.GLOBAL_WEEK_MIN_PREDICTIONS;
}

function assertComparable(entry: RankingComparable): void {
  if (
    !Number.isInteger(entry.period_score) ||
    entry.period_score < 0 ||
    !Number.isInteger(entry.valid_predictions) ||
    entry.valid_predictions < 0 ||
    !Number.isInteger(entry.wdl_hits) ||
    entry.wdl_hits < 0 ||
    !Number.isInteger(entry.exact_hits) ||
    entry.exact_hits < 0
  ) {
    throw validationError("排行统计必须为非负整数");
  }
  if (
    entry.exact_hits > entry.wdl_hits ||
    entry.wdl_hits > entry.valid_predictions
  ) {
    throw validationError("排行命中不变量被破坏");
  }
}
