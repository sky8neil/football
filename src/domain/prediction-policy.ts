/**
 * 预测领域策略（规范第 8 节）。
 *
 * 唯一实现入口（规范 0.4）：can_submit_prediction(user, match, existing_prediction, server_now)。
 *
 * 输入（8.1）只接受 { idempotency_key, match_id, home_score, away_score }；
 * user_id / derived_result / match_score / wdl_hit / exact_hit / submitted_at /
 * scoring_rule_version 等字段一律拒绝（服务端推导与生成，不得由客户端提交）。
 */
import { FIXED_CONFIG_V1 } from "./config.js";
import { UserStatus, type UserStatus as UserStatusType } from "./enums.js";
import { validationError } from "./errors.js";
import type { Match, Prediction, User } from "./types.js";

export interface PredictionScores {
  home_score: number;
  away_score: number;
}

const ALLOWED_PREDICTION_PAYLOAD_FIELDS: ReadonlySet<string> = new Set([
  "idempotency_key",
  "match_id",
  "home_score",
  "away_score",
]);

/**
 * 8.1 + 23.4：拒绝所有未定义字段（含 derived_result 等必须由服务端生成的字段）。
 */
export function assertPredictionPayload(
  payload: Record<string, unknown>,
): void {
  for (const key of Object.keys(payload)) {
    if (!ALLOWED_PREDICTION_PAYLOAD_FIELDS.has(key)) {
      throw validationError(`请求包含未定义字段`, { field: key });
    }
  }
}

/**
 * 8.2 比分校验：
 * - 必须为 JSON integer（Number.isInteger），范围 0..20。
 * - 字符串 "2"、2.5、负数、null 拒绝；JSON 2.0 解析后为整数 2 时接受。
 */
export function validatePredictionScores(
  homeScore: unknown,
  awayScore: unknown,
): PredictionScores {
  return {
    home_score: validatePredictionScore(homeScore, "home_score"),
    away_score: validatePredictionScore(awayScore, "away_score"),
  };
}

function validatePredictionScore(value: unknown, field: string): number {
  if (typeof value !== "number") {
    throw validationError(`${field} 必须为整数`, { field });
  }
  if (!Number.isInteger(value)) {
    throw validationError(`${field} 必须为整数`, { field });
  }
  if (
    value < FIXED_CONFIG_V1.PREDICTION_SCORE_MIN ||
    value > FIXED_CONFIG_V1.PREDICTION_SCORE_MAX
  ) {
    throw validationError(`${field} 超出允许范围`, {
      field,
      min: FIXED_CONFIG_V1.PREDICTION_SCORE_MIN,
      max: FIXED_CONFIG_V1.PREDICTION_SCORE_MAX,
    });
  }
  return value;
}

/** 预测截止边界（6.3）：server_now < prediction_deadline_at 才允许提交。 */
export function isDeadlineOpen(
  predictionDeadlineAt: Date | null,
  serverNow: Date,
): boolean {
  if (predictionDeadlineAt === null) {
    return false;
  }
  return serverNow.getTime() < predictionDeadlineAt.getTime();
}

export interface UserLike {
  status: UserStatusType;
}

export interface MatchLike {
  match_status: Match["match_status"];
  kickoff_confirmed: boolean;
  prediction_closed_at: Date | null;
  prediction_deadline_at: Date | null;
}

export type ExistingPrediction = Pick<Prediction, "prediction_id"> | null;

/** 49.2 can_predict_reason 枚举（命中即停，优先级 1→6）。 */
export type PredictRejectReason =
  | "AUTH_REQUIRED"
  | "USER_DELETED"
  | "ALREADY_SUBMITTED"
  | "NOT_SCHEDULED"
  | "KICKOFF_UNCONFIRMED"
  | "CLOSED";

export interface PredictRejectInput {
  user: UserLike | null;
  match: MatchLike;
  existingPrediction: ExistingPrediction;
  serverNow: Date;
}

/**
 * 49.2 唯一判定入口：列表/详情 can_predict_reason 与 POST 拒绝码同源、同顺序。
 * user === null 表示无可信登录（优先级 1）；命中即停，全部通过返回 null（可预测）。
 */
export function predictRejectReason(input: PredictRejectInput): PredictRejectReason | null {
  const { user, match, existingPrediction, serverNow } = input;
  if (user === null) {
    return "AUTH_REQUIRED";
  }
  if (user.status !== UserStatus.Active) {
    return "USER_DELETED";
  }
  if (existingPrediction !== null) {
    return "ALREADY_SUBMITTED";
  }
  if (match.match_status !== "scheduled") {
    return "NOT_SCHEDULED";
  }
  if (!match.kickoff_confirmed || match.prediction_deadline_at === null) {
    return "KICKOFF_UNCONFIRMED";
  }
  if (
    match.prediction_closed_at !== null ||
    !isDeadlineOpen(match.prediction_deadline_at, serverNow)
  ) {
    return "CLOSED";
  }
  return null;
}

/** 49.2 POST /v1/predictions 错误码映射（与 reason 同源）。 */
export function predictRejectCode(reason: PredictRejectReason): string {
  switch (reason) {
    case "AUTH_REQUIRED":
      return "UNAUTHORIZED";
    case "USER_DELETED":
      return "USER_DELETED";
    case "ALREADY_SUBMITTED":
      return "PREDICTION_ALREADY_SUBMITTED";
    case "NOT_SCHEDULED":
      return "MATCH_NOT_PREDICTABLE";
    case "KICKOFF_UNCONFIRMED":
      return "MATCH_NOT_PREDICTABLE";
    case "CLOSED":
      return "PREDICTION_LOCKED";
  }
}

/**
 * 唯一实现入口：can_submit_prediction(user, match, existing_prediction, server_now)。
 *
 * 必须同时满足（8.4）：
 *   user.status == active
 *   match.match_status == scheduled
 *   match.kickoff_confirmed == true
 *   match.prediction_closed_at == null
 *   match.prediction_deadline_at != null
 *   server_now < match.prediction_deadline_at
 *   existing_prediction == null
 *
 * 与 49.2 predictRejectReason 同源（reason === null 才可预测）。
 */
export function canSubmitPrediction(
  user: UserLike,
  match: MatchLike,
  existingPrediction: ExistingPrediction,
  serverNow: Date,
): boolean {
  return (
    predictRejectReason({ user, match, existingPrediction, serverNow }) === null
  );
}
