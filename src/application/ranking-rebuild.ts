/**
 * 排行榜周期纯重建函数（阶段 5 切片 I）。
 *
 * 从 applied settlement_items 账本与 prediction->period / prediction->period_anchor_at
 * 映射重建指定 week/month 周期 rankings，作为旧聚合缓存的替代来源
 * （禁止使用任何旧 rankings 缓存）。输入为调用方提供的 item 列表与映射；
 * 本模块不访问 repository / 数据库。
 *
 * 聚合规则（规范 19.x）：
 * - period_score      = sum(score_delta)
 * - valid_predictions = sum(valid_prediction_delta)
 * - wdl_hits          = sum(new_wdl_hit - old_wdl_hit)
 * - exact_hits        = sum(new_exact_hit - old_exact_hit)
 * - last_scoring_match_at = 每条 prediction 按最高 source_result_version 取
 *   applied item 且 new_score>0，作为该 match 的计分状态；取这些 match 的
 *   period_anchor_at 最大值；period_score=0 时按 domain lastScoringForPeriodScore
 *   强制 null。
 *
 * 排序唯一入口为 domain compareRankingEntry（规范 0.4 / 19.4）：
 *   period_score DESC -> wdl 准确率 DESC（交叉乘法，禁止浮点）-> exact_hits DESC
 *   -> last_scoring_match_at ASC（null 排后）-> user_id ASC。
 * global_rank（19.2 / 19.6）：valid_predictions < 3 为 null；>=3 为排序位置。
 *
 * 账本完整性校验（非法 ledger 抛 INVALID_LEDGER）：
 * - status=applied、score_delta=(new_score-old_score)、valid_prediction_delta∈{0,1}
 * - exact_hit 命中必须同时 wdl_hit（old/new）
 * - 每个 prediction 必须提供 period 与 anchor 映射
 * - 全部 item 必须属于同一 (period_type, period_key)；period_type 必须是 week/month
 *   （非法类型抛 INVALID_PERIOD_TYPE）
 * - 聚合结果满足 period_score>=0、counts>=0、exact<=wdl<=valid
 *
 * 空 ledger 返回空数组。
 */
import {
  compareRankingEntry,
  lastScoringForPeriodScore,
  rankForPosition,
  type RankingComparable,
} from "../domain/ranking.js";
import { PeriodType, SettlementItemStatus } from "../domain/enums.js";
import { DomainError } from "../domain/errors.js";
import type { SettlementItem } from "../domain/types.js";

export interface PeriodRef {
  period_type: PeriodType;
  period_key: string;
}

export interface RebuiltRankingEntry {
  period_type: PeriodType;
  period_key: string;
  user_id: string;
  period_score: number;
  valid_predictions: number;
  wdl_hits: number;
  exact_hits: number;
  last_scoring_match_at: Date | null;
  global_rank: number | null;
}

export const INVALID_LEDGER = "INVALID_LEDGER" as const;
export const INVALID_PERIOD_TYPE = "INVALID_PERIOD_TYPE" as const;

function invalidLedgerError(message: string): DomainError {
  return new DomainError(INVALID_LEDGER, message);
}

interface Accumulator {
  periodScore: number;
  validPredictions: number;
  wdlHits: number;
  exactHits: number;
}

interface LatestItemState {
  user_id: string;
  source_result_version: number;
  new_score: number;
}

function zeroAccumulator(): Accumulator {
  return { periodScore: 0, validPredictions: 0, wdlHits: 0, exactHits: 0 };
}

function hitDelta(newHit: boolean, oldHit: boolean): number {
  return (newHit ? 1 : 0) - (oldHit ? 1 : 0);
}

function assertPeriodType(periodType: PeriodType): void {
  if (periodType !== PeriodType.Week && periodType !== PeriodType.Month) {
    throw new DomainError(
      INVALID_PERIOD_TYPE,
      `period_type 必须是 week 或 month（收到 ${String(periodType)}）`,
      { period_type: periodType },
    );
  }
}

function assertInvariants(userId: string, acc: Accumulator): void {
  if (acc.periodScore < 0) {
    throw invalidLedgerError(
      `重建 rankings period_score 为负（user=${userId} period_score=${acc.periodScore}）`,
    );
  }
  if (acc.validPredictions < 0 || acc.wdlHits < 0 || acc.exactHits < 0) {
    throw invalidLedgerError(
      `重建 rankings counts 为负（user=${userId} valid=${acc.validPredictions} wdl=${acc.wdlHits} exact=${acc.exactHits}）`,
    );
  }
  if (acc.exactHits > acc.wdlHits || acc.wdlHits > acc.validPredictions) {
    throw invalidLedgerError(
      `重建 rankings 不满足 exact<=wdl<=valid（user=${userId} exact=${acc.exactHits} wdl=${acc.wdlHits} valid=${acc.validPredictions}）`,
    );
  }
}

/**
 * 从 applied settlement_items 账本重建指定周期 rankings。
 * items 必须全部属于同一 (period_type, period_key)；periodByPrediction 提供每个
 * prediction_id 的周期，anchorByPrediction 提供每个 prediction_id 对应 match 的
 * period_anchor_at。
 */
export function rebuildPeriodRankings(
  items: readonly SettlementItem[],
  periodByPrediction: ReadonlyMap<string, PeriodRef>,
  anchorByPrediction: ReadonlyMap<string, Date>,
): RebuiltRankingEntry[] {
  if (items.length === 0) {
    return [];
  }

  let period: { period_type: PeriodType; period_key: string } | null = null;
  const byUser = new Map<string, Accumulator>();
  const latestByPrediction = new Map<string, LatestItemState>();

  for (const item of items) {
    const ref = periodByPrediction.get(item.prediction_id);
    if (ref === undefined) {
      throw invalidLedgerError(
        `缺少 prediction->period 映射（prediction_id=${item.prediction_id}）`,
      );
    }
    assertPeriodType(ref.period_type);
    if (period === null) {
      period = { period_type: ref.period_type, period_key: ref.period_key };
    } else if (
      period.period_type !== ref.period_type ||
      period.period_key !== ref.period_key
    ) {
      throw invalidLedgerError(
        `ledger 混入多个周期（${period.period_key} 与 ${ref.period_key}，prediction_id=${item.prediction_id}）`,
      );
    }

    if (anchorByPrediction.get(item.prediction_id) === undefined) {
      throw invalidLedgerError(
        `缺少 prediction->period_anchor_at 映射（prediction_id=${item.prediction_id}）`,
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

    let acc = byUser.get(item.user_id);
    if (acc === undefined) {
      acc = zeroAccumulator();
      byUser.set(item.user_id, acc);
    }
    acc.periodScore += item.score_delta;
    acc.validPredictions += item.valid_prediction_delta;
    acc.wdlHits += hitDelta(item.new_wdl_hit, item.old_wdl_hit);
    acc.exactHits += hitDelta(item.new_exact_hit, item.old_exact_hit);

    const latest = latestByPrediction.get(item.prediction_id);
    if (
      latest === undefined ||
      item.source_result_version >= latest.source_result_version
    ) {
      latestByPrediction.set(item.prediction_id, {
        user_id: item.user_id,
        source_result_version: item.source_result_version,
        new_score: item.new_score,
      });
    }
  }

  const lastScoringByUser = new Map<string, Date>();
  for (const [predictionId, latest] of latestByPrediction) {
    if (latest.new_score > 0) {
      const anchor = anchorByPrediction.get(predictionId);
      if (anchor !== undefined) {
        const current = lastScoringByUser.get(latest.user_id);
        if (current === undefined || anchor.getTime() > current.getTime()) {
          lastScoringByUser.set(latest.user_id, anchor);
        }
      }
    }
  }

  const periodInfo = period as { period_type: PeriodType; period_key: string };
  const ranked: Array<{
    entry: Omit<RebuiltRankingEntry, "global_rank">;
    comparable: RankingComparable;
  }> = [];

  for (const [userId, acc] of byUser) {
    assertInvariants(userId, acc);
    const candidate = lastScoringByUser.get(userId) ?? null;
    const lastScoring = lastScoringForPeriodScore(acc.periodScore, candidate);
    ranked.push({
      entry: {
        period_type: periodInfo.period_type,
        period_key: periodInfo.period_key,
        user_id: userId,
        period_score: acc.periodScore,
        valid_predictions: acc.validPredictions,
        wdl_hits: acc.wdlHits,
        exact_hits: acc.exactHits,
        last_scoring_match_at: lastScoring,
      },
      comparable: {
        period_score: acc.periodScore,
        valid_predictions: acc.validPredictions,
        wdl_hits: acc.wdlHits,
        exact_hits: acc.exactHits,
        last_scoring_match_at: lastScoring,
        user_id: userId,
      },
    });
  }

  ranked.sort((a, b) => compareRankingEntry(a.comparable, b.comparable));

  return ranked.map(({ entry }, index) => ({
    ...entry,
    global_rank: rankForPosition(entry.valid_predictions, index + 1),
  }));
}
