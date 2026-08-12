/**
 * 预测应用服务（阶段 2）。
 *
 * 提交预测（submit）唯一入口：以服务端 server_now 为唯一时间源，强制
 * user active、match scheduled + kickoff_confirmed + 未关闭 + deadline > server_now、
 * 整数比分 0..20、拒绝客户端派生字段；两层幂等：
 * - 同 user+idempotency_key：同 payload → 幂等重放；不同 payload → IDEMPOTENCY_KEY_REUSED
 * - 同 user+match 已有预测（不同 key）→ PREDICTION_ALREADY_SUBMITTED
 */
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { SCHEMA_VERSION, UserStatus } from "../domain/enums.js";
import { conflictError, notFoundError, validationError } from "../domain/errors.js";
import { isValidIdempotencyKey, isValidUuid, newUuid } from "../domain/ids.js";
import {
  assertPredictionPayload,
  predictRejectCode,
  predictRejectReason,
  type PredictRejectReason,
  validatePredictionScores,
  type PredictionScores,
} from "../domain/prediction-policy.js";
import { deriveResult } from "../domain/scoring.js";
import type { Prediction } from "../domain/types.js";
import {
  UniqueConstraintError,
  type AppRepository,
} from "../infrastructure/repositories.js";

export interface SubmitPredictionResult {
  prediction: Prediction;
  created: boolean;
}

const REJECT_MESSAGE: Readonly<Record<PredictRejectReason, string>> = {
  AUTH_REQUIRED: "需要登录后提交预测",
  USER_DELETED: "用户已注销，不可提交预测",
  ALREADY_SUBMITTED: "本场比赛已提交过预测，不可重复提交",
  NOT_SCHEDULED: "比赛当前不可预测",
  KICKOFF_UNCONFIRMED: "比赛 kickoff 未确认或缺少截止时间",
  CLOSED: "预测已关闭",
};

function assertJsonObject(payload: unknown): asserts payload is Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw validationError("请求体必须为 JSON 对象");
  }
}

function assertValidServerNow(serverNow: Date): void {
  if (!(serverNow instanceof Date) || Number.isNaN(serverNow.getTime())) {
    throw validationError("server_now 必须是有效时间", { field: "server_now" });
  }
}

function predictionPayloadEqual(
  prediction: Prediction,
  matchId: string,
  scores: PredictionScores,
): boolean {
  return (
    prediction.match_id === matchId &&
    prediction.pred_home_score === scores.home_score &&
    prediction.pred_away_score === scores.away_score
  );
}

function buildPrediction(
  userId: string,
  matchId: string,
  idempotencyKey: string,
  scores: PredictionScores,
  serverNow: Date,
): Prediction {
  return {
    schema_version: SCHEMA_VERSION,
    prediction_id: newUuid(),
    user_id: userId,
    match_id: matchId,
    idempotency_key: idempotencyKey,
    pred_home_score: scores.home_score,
    pred_away_score: scores.away_score,
    derived_result: deriveResult(scores.home_score, scores.away_score),
    submitted_at: serverNow,
    scoring_rule_version: FIXED_CONFIG_V1.SCORING_RULE_VERSION,
    match_score: null,
    wdl_hit: null,
    exact_hit: null,
    applied_result_version: 0,
    created_at: serverNow,
    updated_at: serverNow,
  };
}

export class PredictionService {
  constructor(private readonly repo: AppRepository) {}

  async submit(
    userId: string,
    payload: Record<string, unknown>,
    serverNow: Date,
  ): Promise<SubmitPredictionResult> {
    assertValidServerNow(serverNow);
    assertJsonObject(payload);
    assertPredictionPayload(payload);

    if (!isValidUuid(userId)) {
      throw validationError("user_id 必须为 UUID v4", { field: "user_id" });
    }

    const idempotencyKey = payload.idempotency_key;
    if (typeof idempotencyKey !== "string" || !isValidIdempotencyKey(idempotencyKey)) {
      throw validationError("idempotency_key 必须为 UUID v4", {
        field: "idempotency_key",
      });
    }

    const matchId = payload.match_id;
    if (typeof matchId !== "string" || !isValidUuid(matchId)) {
      throw validationError("match_id 必须为 UUID v4", { field: "match_id" });
    }

    const scores = validatePredictionScores(payload.home_score, payload.away_score);

    try {
      return await this.repo.withTransaction(async (tx) => {
        const user = await tx.users.findById(userId);
        if (user === null) {
          throw notFoundError("USER");
        }

        const match = await tx.matches.findById(matchId);
        if (match === null) {
          throw notFoundError("MATCH");
        }

        // 49.2 优先级 2（在幂等重放之前，已注销用户不重放历史预测）。
        if (user.status !== UserStatus.Active) {
          throw conflictError("USER_DELETED", REJECT_MESSAGE.USER_DELETED);
        }

        const byKey = await tx.predictions.findByUserAndIdempotencyKey(
          userId,
          idempotencyKey,
        );
        if (byKey !== null) {
          if (predictionPayloadEqual(byKey, matchId, scores)) {
            return { prediction: byKey, created: false };
          }
          throw conflictError("IDEMPOTENCY_KEY_REUSED", "幂等键已被不同的预测请求使用", {
            idempotency_key: idempotencyKey,
          });
        }

        const byMatch = await tx.predictions.findByUserAndMatch(userId, matchId);
        // 49.2 唯一判定：reason 与 list/detail 的 can_predict_reason 同源同序。
        const reason = predictRejectReason({
          user,
          match,
          existingPrediction: byMatch === null ? null : { prediction_id: byMatch.prediction_id },
          serverNow,
        });
        if (reason !== null) {
          throw conflictError(predictRejectCode(reason), REJECT_MESSAGE[reason]);
        }

        const prediction = buildPrediction(
          userId,
          matchId,
          idempotencyKey,
          scores,
          serverNow,
        );
        await tx.predictions.insert(prediction);
        return { prediction, created: true };
      });
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        const winner = await this.repo.predictions.findByUserAndIdempotencyKey(
          userId,
          idempotencyKey,
        );
        if (winner !== null) {
          if (predictionPayloadEqual(winner, matchId, scores)) {
            return { prediction: winner, created: false };
          }
          throw conflictError(
            "IDEMPOTENCY_KEY_REUSED",
            "幂等键已被不同的预测请求使用",
            { idempotency_key: idempotencyKey },
          );
        }
        throw conflictError(
          "PREDICTION_ALREADY_SUBMITTED",
          "本场比赛已提交过预测，不可重复提交",
          { match_id: matchId },
        );
      }
      throw err;
    }
  }
}
