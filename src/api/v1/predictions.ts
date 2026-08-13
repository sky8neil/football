import { conflictError, validationError } from "../../domain/errors.js";
import { isValidUuid } from "../../domain/ids.js";
import type {
  PredictionDetailData,
  PredictionHistoryItem,
  PredictionQueryService,
  PredictionHistoryQuery,
  PredictionHistoryQueryService,
  PredictionHistoryResult,
} from "../../application/prediction-query.js";
import { FIXED_CONFIG_V1, MVP_SEASON } from "../../domain/config.js";
import type { PredictionService, SubmitPredictionResult } from "../../application/predictions.js";
import { assertUnknownFields, submitPredictionStatus } from "./validation.js";
import {
  defaultApiRateLimiter,
  type RateLimiter,
} from "./rate-limit.js";

const PREDICTION_BODY_FIELDS = new Set([
  "idempotency_key",
  "match_id",
  "home_score",
  "away_score",
]);

const PREDICTION_HISTORY_QUERY_FIELDS = new Set(["season_id", "limit", "cursor"]);

export interface PostPredictionInput {
  authenticated_user_id?: string | null;
  body: unknown;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface PostPredictionSuccessResponse {
  status: 200 | 201;
  body: {
    data: {
      prediction_id: string;
      match_id: string;
      pred_home_score: number;
      pred_away_score: number;
      derived_result: SubmitPredictionResult["prediction"]["derived_result"];
      submitted_at: string;
      scoring_rule_version: SubmitPredictionResult["prediction"]["scoring_rule_version"];
    };
    request_id: string;
  };
}

export function validatePredictionBody(payload: unknown): Record<string, unknown> {
  assertUnknownFields(payload as Record<string, unknown>, PREDICTION_BODY_FIELDS);
  return payload as Record<string, unknown>;
}

function requireAuthenticatedUserId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw conflictError("UNAUTHORIZED", "需要登录后提交预测");
  }
  return value;
}

function mapPredictionResult(
  result: SubmitPredictionResult,
  requestId: string,
): PostPredictionSuccessResponse {
  const { prediction } = result;
  return {
    status: submitPredictionStatus(result),
    body: {
      data: {
        prediction_id: prediction.prediction_id,
        match_id: prediction.match_id,
        pred_home_score: prediction.pred_home_score,
        pred_away_score: prediction.pred_away_score,
        derived_result: prediction.derived_result,
        submitted_at: prediction.submitted_at.toISOString(),
        scoring_rule_version: prediction.scoring_rule_version,
      },
      request_id: requestId,
    },
  };
}

export async function postPrediction(
  service: Pick<PredictionService, "submit">,
  input: PostPredictionInput,
): Promise<PostPredictionSuccessResponse> {
  const userId = requireAuthenticatedUserId(input.authenticated_user_id);
  (input.rate_limiter ?? defaultApiRateLimiter).check(
    "predictions",
    userId,
    input.server_now,
  );
  const body = validatePredictionBody(input.body);
  const result = await service.submit(userId, body, input.server_now);
  return mapPredictionResult(result, input.request_id);
}

export interface GetMyPredictionInput {
  authenticated_user_id?: string | null;
  prediction_id: unknown;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface GetMyPredictionSuccessResponse {
  status: 200;
  body: {
    data: PredictionDetailData;
    request_id: string;
  };
}

function requirePredictionId(value: unknown): string {
  if (typeof value !== "string" || !isValidUuid(value)) {
    throw validationError("prediction_id 必须为 UUID v4", { field: "prediction_id" });
  }
  return value;
}

function requireAuthenticatedUserIdForRead(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw conflictError("UNAUTHORIZED", "需要登录后访问预测");
  }
  return value;
}

export async function getMyPrediction(
  service: Pick<PredictionQueryService, "getMyPrediction">,
  input: GetMyPredictionInput,
): Promise<GetMyPredictionSuccessResponse> {
  const userId = requireAuthenticatedUserIdForRead(input.authenticated_user_id);
  (input.rate_limiter ?? defaultApiRateLimiter).check(
    "authenticated_reads",
    userId,
    input.server_now,
  );
  const predictionId = requirePredictionId(input.prediction_id);
  const data = await service.getMyPrediction(userId, predictionId);
  return {
    status: 200,
    body: {
      data,
      request_id: input.request_id,
    },
  };
}

export interface GetMyPredictionsInput {
  authenticated_user_id?: string | null;
  query: Record<string, unknown>;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface GetMyPredictionsSuccessResponse {
  status: 200;
  body: {
    data: {
      items: PredictionHistoryResult["items"];
      page: {
        next_cursor: string | null;
        has_more: boolean;
      };
    };
    request_id: string;
  };
}

function parseHistoryLimit(value: unknown): number {
  if (value === undefined) {
    return FIXED_CONFIG_V1.API_DEFAULT_LIMIT;
  }
  const parsed =
    typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > FIXED_CONFIG_V1.API_MAX_LIMIT
  ) {
    throw validationError("limit 必须是 1..100 的整数", { field: "limit" });
  }
  return parsed;
}

export function validateMyPredictionsQuery(
  query: Record<string, unknown>,
): PredictionHistoryQuery {
  assertUnknownFields(query, PREDICTION_HISTORY_QUERY_FIELDS);
  const seasonId = query.season_id;
  if (seasonId !== undefined && seasonId !== MVP_SEASON.season_id) {
    throw validationError("season_id 必须是已知赛季", { field: "season_id" });
  }
  const cursor = query.cursor;
  if (cursor !== undefined && typeof cursor !== "string") {
    throw validationError("cursor 格式无效", { field: "cursor" });
  }
  return {
    season_id: MVP_SEASON.season_id,
    limit: parseHistoryLimit(query.limit),
    cursor: cursor === undefined ? null : cursor,
  };
}

function toPublicPredictionHistoryItem(item: PredictionHistoryItem): PredictionHistoryItem {
  return {
    prediction_id: item.prediction_id,
    match_id: item.match_id,
    league_id: item.league_id,
    season_id: item.season_id,
    round_id: item.round_id,
    home_team_id: item.home_team_id,
    away_team_id: item.away_team_id,
    kickoff_at: item.kickoff_at,
    pred_home_score: item.pred_home_score,
    pred_away_score: item.pred_away_score,
    derived_result: item.derived_result,
    submitted_at: item.submitted_at,
    scoring_rule_version: item.scoring_rule_version,
    match_status: item.match_status,
    regular_home_score: item.regular_home_score,
    regular_away_score: item.regular_away_score,
    match_score: item.match_score,
    wdl_hit: item.wdl_hit,
    exact_hit: item.exact_hit,
  };
}

export async function getMyPredictions(
  service: Pick<PredictionHistoryQueryService, "listMyPredictions">,
  input: GetMyPredictionsInput,
): Promise<GetMyPredictionsSuccessResponse> {
  const userId = requireAuthenticatedUserIdForRead(input.authenticated_user_id);
  (input.rate_limiter ?? defaultApiRateLimiter).check(
    "authenticated_reads",
    userId,
    input.server_now,
  );
  const query = validateMyPredictionsQuery(input.query);
  const result = await service.listMyPredictions(userId, query);
  return {
    status: 200,
    body: {
      data: {
        items: result.items.map(toPublicPredictionHistoryItem),
        page: {
          next_cursor: result.next_cursor,
          has_more: result.has_more,
        },
      },
      request_id: input.request_id,
    },
  };
}
