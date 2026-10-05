/**
 * 排行榜比较与门槛（规范第 19 节）。
 *
 * 唯一实现入口（规范 0.4）：compare_ranking_entry(board, a, b)。
 *
 * week/career（同一比较器，19.5）：
 *   period_score DESC → exact_hits DESC → valid_predictions ASC
 *   → last_scoring_match_at ASC（非 null 优先于 null）→ user_id ASC
 *
 * strength（另一比较器，不得与上面共用逻辑）：
 *   s 交叉乘法 DESC（P0/K 同源 levels.ts）→ 窗口 n DESC → user_id ASC
 *
 * month 或未知 board → validationError（K85 domain 侧预备）。
 */
import { FIXED_CONFIG_V1 } from "./config.js";
import { RankingBoard } from "./enums.js";
import { validationError } from "./errors.js";
import { compareStrengthIndex } from "./levels.js";

export interface RankingComparable {
  period_score: number;
  valid_predictions: number;
  exact_hits: number;
  last_scoring_match_at: Date | null;
  user_id: string;
  wdl_hits?: number;
}

export interface StrengthRankingComparable {
  window_score_sum: number;
  window_n: number;
  user_id: string;
}

/**
 * 公开分派入口。week/career 走分数比较器；strength 走独立 s 比较器。
 * month / 未知 board 拒绝。
 */
export function compareRankingEntry(
  board: string,
  a: RankingComparable | StrengthRankingComparable,
  b: RankingComparable | StrengthRankingComparable,
): number {
  if (board === RankingBoard.Week || board === RankingBoard.Career) {
    return compareWeekCareerEntry(a as RankingComparable, b as RankingComparable);
  }
  if (board === RankingBoard.Strength) {
    return compareStrengthEntry(
      a as StrengthRankingComparable,
      b as StrengthRankingComparable,
    );
  }
  throw validationError("非法 board", { board });
}

/**
 * week/career 子比较器。
 * month 写路径保留到 S4：settlement 月榜重排临时沿用本函数（month 已废弃，S4 拆除）。
 */
export function compareWeekCareerEntry(
  a: RankingComparable,
  b: RankingComparable,
): number {
  assertWeekCareerComparable(a);
  assertWeekCareerComparable(b);

  if (a.period_score !== b.period_score) {
    return b.period_score - a.period_score;
  }
  if (a.exact_hits !== b.exact_hits) {
    return b.exact_hits - a.exact_hits;
  }
  if (a.valid_predictions !== b.valid_predictions) {
    return a.valid_predictions - b.valid_predictions;
  }
  const lastScoringDiff = compareLastScoring(a.last_scoring_match_at, b.last_scoring_match_at);
  if (lastScoringDiff !== 0) {
    return lastScoringDiff;
  }
  return compareUserId(a.user_id, b.user_id);
}

function compareStrengthEntry(
  a: StrengthRankingComparable,
  b: StrengthRankingComparable,
): number {
  assertStrengthComparable(a);
  assertStrengthComparable(b);

  const sDiff = compareStrengthIndex(
    { S: a.window_score_sum, n: a.window_n },
    { S: b.window_score_sum, n: b.window_n },
  );
  if (sDiff !== 0) {
    return sDiff;
  }
  if (a.window_n !== b.window_n) {
    return b.window_n - a.window_n;
  }
  return compareUserId(a.user_id, b.user_id);
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

function compareUserId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 入榜最低场次（19.1）：valid_predictions >= WEEK_BOARD_MIN_VALID（=1）。 */
export function isRankEligible(validPredictions: number): boolean {
  if (!Number.isInteger(validPredictions) || validPredictions < 0) {
    throw validationError("valid_predictions 必须为非负整数", {
      valid_predictions: validPredictions,
    });
  }
  return validPredictions >= FIXED_CONFIG_V1.WEEK_BOARD_MIN_VALID;
}

/** 实力榜资格：窗口 n >= STRENGTH_BOARD_MIN_WINDOW_N（=50）。 */
export function isStrengthRankEligible(windowN: number): boolean {
  if (!Number.isInteger(windowN) || windowN < 0) {
    throw validationError("window_n 必须为非负整数", { window_n: windowN });
  }
  return windowN >= FIXED_CONFIG_V1.STRENGTH_BOARD_MIN_WINDOW_N;
}

/**
 * 计算 global_rank（19.2 / 19.5）：
 * 不符合最低场次 => null；符合 => 排序位置。1 场即可有名次。
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

function assertWeekCareerComparable(entry: RankingComparable): void {
  if (
    !Number.isInteger(entry.period_score) ||
    entry.period_score < 0 ||
    !Number.isInteger(entry.valid_predictions) ||
    entry.valid_predictions < 0 ||
    !Number.isInteger(entry.exact_hits) ||
    entry.exact_hits < 0
  ) {
    throw validationError("排行统计必须为非负整数");
  }
  if (entry.exact_hits > entry.valid_predictions) {
    throw validationError("排行命中不变量被破坏");
  }
  if (entry.wdl_hits !== undefined) {
    if (!Number.isInteger(entry.wdl_hits) || entry.wdl_hits < 0) {
      throw validationError("排行统计必须为非负整数");
    }
    if (entry.exact_hits > entry.wdl_hits || entry.wdl_hits > entry.valid_predictions) {
      throw validationError("排行命中不变量被破坏");
    }
  }
}

function assertStrengthComparable(entry: StrengthRankingComparable): void {
  if (
    !Number.isInteger(entry.window_score_sum) ||
    entry.window_score_sum < 0 ||
    !Number.isInteger(entry.window_n) ||
    entry.window_n < 0
  ) {
    throw validationError("实力榜统计必须为非负整数");
  }
}
