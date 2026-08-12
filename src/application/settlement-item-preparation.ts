import {
  SCHEMA_VERSION,
  SettlementItemStatus,
} from "../domain/enums.js";
import { DomainError } from "../domain/errors.js";
import type {
  MatchResult,
  SettlementDoc,
  SettlementItem,
} from "../domain/types.js";
import type { UnitOfWork } from "../infrastructure/repositories.js";
import { computeSettlementItemDelta } from "./settlement.js";

function invalidLedger(message: string): never {
  throw new DomainError("INVALID_LEDGER", message);
}

/**
 * 结算启动时把当前比赛 predictions 物化为 settlement_items。
 * 唯一索引负责幂等，已存在 item 由后续状态机继续处理。
 */
export async function prepareSettlementItems(
  tx: UnitOfWork,
  settlement: SettlementDoc,
  result: MatchResult,
  serverNow: Date,
): Promise<SettlementItem[]> {
  if (
    result.match_id !== settlement.match_id ||
    result.result_version !== settlement.result_version
  ) {
    invalidLedger("settlement 与 match_result 版本或比赛不一致");
  }

  const predictions = await tx.predictions.findByMatch(settlement.match_id);
  for (const prediction of predictions) {
    const existing = await tx.settlementItems.findBySettlementAndPrediction(
      settlement.settlement_id,
      prediction.prediction_id,
    );
    if (existing !== null) {
      continue;
    }

    if (prediction.scoring_rule_version !== settlement.rule_version) {
      invalidLedger(
        `settlement rule_version 与 prediction 不一致（prediction_id=${prediction.prediction_id}）`,
      );
    }

    if (settlement.is_correction) {
      if (
        prediction.applied_result_version < 1 ||
        prediction.applied_result_version + 1 !== result.result_version
      ) {
        invalidLedger(
          `修正 settlement 不能跳过 prediction 版本（prediction_id=${prediction.prediction_id}）`,
        );
      }
    } else if (prediction.applied_result_version !== 0) {
      invalidLedger(
        `首次 settlement 包含已结算 prediction（prediction_id=${prediction.prediction_id}）`,
      );
    }

    const delta = computeSettlementItemDelta(
      prediction,
      result,
      prediction.scoring_rule_version,
    );
    if (
      settlement.is_correction && delta.valid_prediction_delta !== 0 ||
      !settlement.is_correction && delta.valid_prediction_delta !== 1
    ) {
      invalidLedger(
        `settlement item valid_prediction_delta 不符合 settlement 类型（prediction_id=${prediction.prediction_id}）`,
      );
    }

    await tx.settlementItems.insert({
      schema_version: SCHEMA_VERSION,
      settlement_id: settlement.settlement_id,
      prediction_id: prediction.prediction_id,
      user_id: prediction.user_id,
      ...delta,
      source_result_version: result.result_version,
      status: SettlementItemStatus.Pending,
      applied_at: null,
      attempt_count: 0,
      last_error_code: null,
      last_error_message: null,
      created_at: serverNow,
      updated_at: serverNow,
    });
  }

  return tx.settlementItems.findBySettlement(settlement.settlement_id);
}
