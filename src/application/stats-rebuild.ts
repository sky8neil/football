/**
 * 统计纯重建函数（阶段 5 切片 G）。
 *
 * 从 applied settlement_items 账本重建用户 career/season 统计，作为旧聚合缓存的
 * 替代来源（禁止使用任何旧聚合缓存）。输入为调用方提供的 item 列表与
 * prediction_id -> season_id 映射；本模块不访问 repository / 数据库。
 *
 * 聚合规则（规范 9.x）：
 * - career_points            = sum(score_delta)
 * - career_valid_predictions = sum(valid_prediction_delta)
 * - career_wdl_hits          = sum(new_wdl_hit - old_wdl_hit)
 * - career_exact_hits        = sum(new_exact_hit - old_exact_hit)
 * - season stats 按 item.prediction_id 对应的 season_id 分组，字段同名聚合。
 *
 * 账本完整性校验（非法 ledger 抛 INVALID_LEDGER）：
 * - 所有 item 必须属于同一 user 且 status=applied
 * - score_delta 必须等于 new_score - old_score
 * - valid_prediction_delta 只能为 0/1
 * - 单 item 内 exact_hit 命中必须同时 wdl_hit 命中
 * - 每个 prediction 必须提供 season 映射
 * - 聚合结果必须满足 points>=0、counts>=0、exact_hits<=wdl_hits<=valid_predictions
 *
 * 空 ledger 返回全零 career 与空 seasons（user_id 为空串）。
 */
import { SettlementItemStatus } from "../domain/enums.js";
import { DomainError } from "../domain/errors.js";
import type { SettlementItem } from "../domain/types.js";

/** career 统计结果，字段对齐 User 文档。 */
export interface RebuiltCareerStats {
  user_id: string;
  career_points: number;
  career_valid_predictions: number;
  career_wdl_hits: number;
  career_exact_hits: number;
}

/** 单赛季统计结果，字段对齐 UserSeasonStats 文档。 */
export interface RebuiltSeasonStats {
  user_id: string;
  season_id: string;
  points: number;
  valid_predictions: number;
  wdl_hits: number;
  exact_hits: number;
}

export interface RebuiltStats {
  career: RebuiltCareerStats;
  seasons: RebuiltSeasonStats[];
}

export const INVALID_LEDGER = "INVALID_LEDGER" as const;

function invalidLedgerError(message: string): DomainError {
  return new DomainError(INVALID_LEDGER, message);
}

interface Accumulator {
  points: number;
  validPredictions: number;
  wdlHits: number;
  exactHits: number;
}

function zeroAccumulator(): Accumulator {
  return { points: 0, validPredictions: 0, wdlHits: 0, exactHits: 0 };
}

function hitDelta(newHit: boolean, oldHit: boolean): number {
  return (newHit ? 1 : 0) - (oldHit ? 1 : 0);
}

function assertInvariants(scope: string, acc: Accumulator, userId: string): void {
  if (acc.points < 0) {
    throw invalidLedgerError(
      `重建统计 points 为负（user=${userId} scope=${scope} points=${acc.points}）`,
    );
  }
  if (acc.validPredictions < 0 || acc.wdlHits < 0 || acc.exactHits < 0) {
    throw invalidLedgerError(
      `重建统计 counts 为负（user=${userId} scope=${scope} valid=${acc.validPredictions} wdl=${acc.wdlHits} exact=${acc.exactHits}）`,
    );
  }
  if (acc.exactHits > acc.wdlHits || acc.wdlHits > acc.validPredictions) {
    throw invalidLedgerError(
      `重建统计不满足 exact<=wdl<=valid（user=${userId} scope=${scope} exact=${acc.exactHits} wdl=${acc.wdlHits} valid=${acc.validPredictions}）`,
    );
  }
}

/**
 * 从 applied settlement_items 账本重建统计。items 必须属于同一 user；
 * seasonByPrediction 提供每个 prediction_id 所属 season_id。
 */
export function rebuildStatsFromLedger(
  items: readonly SettlementItem[],
  seasonByPrediction: ReadonlyMap<string, string>,
): RebuiltStats {
  if (items.length === 0) {
    return {
      career: {
        user_id: "",
        career_points: 0,
        career_valid_predictions: 0,
        career_wdl_hits: 0,
        career_exact_hits: 0,
      },
      seasons: [],
    };
  }

  const userId = items[0]?.user_id ?? "";
  const career = zeroAccumulator();
  const bySeason = new Map<string, Accumulator>();

  for (const item of items) {
    if (item.user_id !== userId) {
      throw invalidLedgerError(
        `ledger 混入多个 user：${userId} 与 ${item.user_id}（prediction_id=${item.prediction_id}）`,
      );
    }
    if (item.status !== SettlementItemStatus.Applied) {
      throw invalidLedgerError(
        `settlement_items.status 必须是 applied（prediction_id=${item.prediction_id}）`,
      );
    }
    if (item.score_delta !== item.new_score - item.old_score) {
      throw invalidLedgerError(
        `score_delta 与 (new_score-old_score) 不一致（prediction_id=${item.prediction_id}）`,
      );
    }
    if (item.valid_prediction_delta !== 0 && item.valid_prediction_delta !== 1) {
      throw invalidLedgerError(
        `valid_prediction_delta 非法（prediction_id=${item.prediction_id}）`,
      );
    }
    if (item.old_exact_hit && !item.old_wdl_hit) {
      throw invalidLedgerError(
        `old exact_hit 未同时命中 wdl（prediction_id=${item.prediction_id}）`,
      );
    }
    if (item.new_exact_hit && !item.new_wdl_hit) {
      throw invalidLedgerError(
        `new exact_hit 未同时命中 wdl（prediction_id=${item.prediction_id}）`,
      );
    }
    const seasonId = seasonByPrediction.get(item.prediction_id);
    if (seasonId === undefined) {
      throw invalidLedgerError(
        `缺少 prediction->season 映射（prediction_id=${item.prediction_id}）`,
      );
    }

    career.points += item.score_delta;
    career.validPredictions += item.valid_prediction_delta;
    career.wdlHits += hitDelta(item.new_wdl_hit, item.old_wdl_hit);
    career.exactHits += hitDelta(item.new_exact_hit, item.old_exact_hit);

    let season = bySeason.get(seasonId);
    if (season === undefined) {
      season = zeroAccumulator();
      bySeason.set(seasonId, season);
    }
    season.points += item.score_delta;
    season.validPredictions += item.valid_prediction_delta;
    season.wdlHits += hitDelta(item.new_wdl_hit, item.old_wdl_hit);
    season.exactHits += hitDelta(item.new_exact_hit, item.old_exact_hit);
  }

  assertInvariants("career", career, userId);
  for (const seasonId of bySeason.keys()) {
    const season = bySeason.get(seasonId);
    if (season !== undefined) {
      assertInvariants(seasonId, season, userId);
    }
  }

  const seasons: RebuiltSeasonStats[] = [...bySeason.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([seasonId, season]) => ({
      user_id: userId,
      season_id: seasonId,
      points: season.points,
      valid_predictions: season.validPredictions,
      wdl_hits: season.wdlHits,
      exact_hits: season.exactHits,
    }));

  return {
    career: {
      user_id: userId,
      career_points: career.points,
      career_valid_predictions: career.validPredictions,
      career_wdl_hits: career.wdlHits,
      career_exact_hits: career.exactHits,
    },
    seasons,
  };
}
