import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { MatchScoreValue, SettlementItemStatus } from "../domain/enums.js";
import { DomainError } from "../domain/errors.js";
import { calculateMatchScore } from "../domain/scoring.js";
import type {
  Match,
  MatchResult,
  Prediction,
  SettlementDoc,
  SettlementItem,
} from "../domain/types.js";
import type { UnitOfWork } from "../infrastructure/repositories.js";

export interface AppliedSettlementFact {
  item: SettlementItem;
  prediction: Prediction;
  settlement: SettlementDoc;
  match: Match;
  result: MatchResult;
}

export function invalidLedger(message: string): DomainError {
  return new DomainError("INVALID_LEDGER", message);
}

export function activeSettlement(match: Match): boolean {
  return match.settlement_status === "settling" || match.settlement_status === "correcting";
}

function sameItemValue(item: SettlementItem, fact: ReturnType<typeof calculateMatchScore>): boolean {
  return (
    item.new_score === fact.match_score &&
    item.new_wdl_hit === fact.wdl_hit &&
    item.new_exact_hit === fact.exact_hit
  );
}

function validIntegerRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/**
 * 读取并校验目标范围内的 applied ledger。预测上的当前结算字段只用于身份/原始比分，
 * 不参与聚合；每个 item 的新值由 immutable match_results 重新校验。
 */
export async function loadAppliedSettlementFacts(
  tx: UnitOfWork,
  items: readonly SettlementItem[],
): Promise<AppliedSettlementFact[]> {
  const facts: AppliedSettlementFact[] = [];

  for (const item of items) {
    if (item.status !== SettlementItemStatus.Applied) {
      throw invalidLedger(`rebuild 输入包含非 applied item（prediction_id=${item.prediction_id}）`);
    }
    if (
      item.score_delta !== item.new_score - item.old_score ||
      (item.valid_prediction_delta !== 0 && item.valid_prediction_delta !== 1) ||
      (item.old_exact_hit && !item.old_wdl_hit) ||
      (item.new_exact_hit && !item.new_wdl_hit)
    ) {
      throw invalidLedger(`settlement item invariant 失败（prediction_id=${item.prediction_id}）`);
    }

    const settlement = await tx.settlements.findById(item.settlement_id);
    if (settlement === null) {
      throw invalidLedger(`applied item 缺少 settlement（prediction_id=${item.prediction_id}）`);
    }
    if (settlement.result_version !== item.source_result_version) {
      throw invalidLedger(`item 与 settlement result_version 不一致（prediction_id=${item.prediction_id}）`);
    }

    const match = await tx.matches.findById(settlement.match_id);
    if (match === null || match.match_status !== "finished") {
      throw invalidLedger(`applied item 缺少 finished match（prediction_id=${item.prediction_id}）`);
    }
    if (match.scoring_rule_version !== settlement.rule_version) {
      throw invalidLedger(`match 与 settlement rule_version 不一致（prediction_id=${item.prediction_id}）`);
    }
    if (
      !Number.isInteger(match.result_version) ||
      match.result_version < item.source_result_version
    ) {
      throw invalidLedger(`item 超过 match 当前 result_version（prediction_id=${item.prediction_id}）`);
    }

    const result = await tx.matchResults.findByMatchAndVersion(
      match.match_id,
      item.source_result_version,
    );
    if (result === null) {
      throw invalidLedger(`applied item 缺少 match_results 版本（prediction_id=${item.prediction_id}）`);
    }
    if (result.match_id !== match.match_id || result.result_version !== item.source_result_version) {
      throw invalidLedger(`match_results 与 item 版本不一致（prediction_id=${item.prediction_id}）`);
    }
    if (
      !validIntegerRange(
        result.regular_home_score,
        FIXED_CONFIG_V1.FINAL_SCORE_MIN,
        FIXED_CONFIG_V1.FINAL_SCORE_MAX,
      ) ||
      !validIntegerRange(
        result.regular_away_score,
        FIXED_CONFIG_V1.FINAL_SCORE_MIN,
        FIXED_CONFIG_V1.FINAL_SCORE_MAX,
      )
    ) {
      throw invalidLedger(`match_results 正式比分非法（prediction_id=${item.prediction_id}）`);
    }

    const prediction = await tx.predictions.findById(item.prediction_id);
    if (
      prediction === null ||
      prediction.user_id !== item.user_id ||
      prediction.match_id !== match.match_id ||
      prediction.scoring_rule_version !== settlement.rule_version
    ) {
      throw invalidLedger(`applied item 与 prediction 不一致（prediction_id=${item.prediction_id}）`);
    }
    if (
      !validIntegerRange(
        prediction.pred_home_score,
        FIXED_CONFIG_V1.PREDICTION_SCORE_MIN,
        FIXED_CONFIG_V1.PREDICTION_SCORE_MAX,
      ) ||
      !validIntegerRange(
        prediction.pred_away_score,
        FIXED_CONFIG_V1.PREDICTION_SCORE_MIN,
        FIXED_CONFIG_V1.PREDICTION_SCORE_MAX,
      )
    ) {
      throw invalidLedger(`prediction 原始比分非法（prediction_id=${item.prediction_id}）`);
    }

    let calculated: ReturnType<typeof calculateMatchScore>;
    try {
      calculated = calculateMatchScore(
        prediction,
        result,
        prediction.scoring_rule_version,
      );
    } catch {
      throw invalidLedger(`prediction 或 match_results 比分非法（prediction_id=${item.prediction_id}）`);
    }
    if (!sameItemValue(item, calculated)) {
      throw invalidLedger(`item new 值与正式赛果不一致（prediction_id=${item.prediction_id}）`);
    }

    facts.push({ item, prediction, settlement, match, result });
  }

  const byPrediction = new Map<string, AppliedSettlementFact[]>();
  for (const fact of facts) {
    const list = byPrediction.get(fact.item.prediction_id) ?? [];
    list.push(fact);
    byPrediction.set(fact.item.prediction_id, list);
  }

  for (const [predictionId, list] of byPrediction) {
    list.sort((a, b) => a.item.source_result_version - b.item.source_result_version);
    let previousScore: number = MatchScoreValue.Miss;
    let previousWdl = false;
    let previousExact = false;
    let previousVersion = 0;
    for (const fact of list) {
      const item = fact.item;
      if (
        item.source_result_version !== previousVersion + 1 ||
        item.old_score !== previousScore ||
        item.old_wdl_hit !== previousWdl ||
        item.old_exact_hit !== previousExact ||
        item.valid_prediction_delta !== (previousVersion === 0 ? 1 : 0)
      ) {
        throw invalidLedger(`prediction 的 applied ledger 版本链断裂（prediction_id=${predictionId}）`);
      }
      previousVersion = item.source_result_version;
      previousScore = item.new_score;
      previousWdl = item.new_wdl_hit;
      previousExact = item.new_exact_hit;
    }
  }

  return facts;
}

export function assertStatsAggregationPorts(tx: UnitOfWork): asserts tx is UnitOfWork & {
  userSeasonStats: NonNullable<UnitOfWork["userSeasonStats"]>;
  levelHistory: NonNullable<UnitOfWork["levelHistory"]>;
} {
  if (tx.userSeasonStats === undefined || tx.levelHistory === undefined) {
    throw new DomainError("INTERNAL_ERROR", "stats rebuild 缺少聚合 repository ports");
  }
}

export function assertRankingPort(tx: UnitOfWork): asserts tx is UnitOfWork & {
  rankings: NonNullable<UnitOfWork["rankings"]>;
} {
  if (tx.rankings === undefined) {
    throw new DomainError("INTERNAL_ERROR", "ranking rebuild 缺少 rankings repository port");
  }
}
