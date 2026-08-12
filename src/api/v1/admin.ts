import { conflictError, internalError, validationError } from "../../domain/errors.js";
import { FIXED_CONFIG_V1 } from "../../domain/config.js";
import { PeriodType, SettlementStatus } from "../../domain/enums.js";
import { isValidUuid } from "../../domain/ids.js";
import { isValidPeriodKey } from "../../domain/time.js";
import type {
  AdminResultCorrectionInput,
  AdminResultCorrectionOutcome,
  AdminResultCorrectionService,
} from "../../application/admin-result-correction.js";
import type {
  AdminRetrySettlementOutcome,
  RetrySettlementCommand,
} from "../../application/admin-retry-settlement.js";
import type {
  AdminRebuildUserStatsCommand,
  AdminRebuildUserStatsOutcome,
} from "../../application/admin-rebuild-user-stats.js";
import type {
  AdminRebuildRankingsCommand,
  AdminRebuildRankingsInput,
  AdminRebuildRankingsOutcome,
} from "../../application/admin-rebuild-rankings.js";
import { assertUnknownFields } from "./validation.js";
import {
  defaultApiRateLimiter,
  type RateLimiter,
} from "./rate-limit.js";

export {
  getAdminAnomalies,
  validateAdminAnomaliesQuery,
} from "./admin-anomalies.js";
export type {
  AdminAnomalyResponse,
  GetAdminAnomaliesInput,
  GetAdminAnomaliesSuccessResponse,
} from "./admin-anomalies.js";

const ADMIN_RESULT_CORRECTION_FIELDS = new Set([
  "expected_result_version",
  "regular_home_score",
  "regular_away_score",
  "reason",
]);

const ADMIN_REBUILD_RANKINGS_FIELDS = new Set([
  "period_type",
  "period_key",
  "reason",
]);

function assertIntegerInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw validationError(`${field} 必须是 ${min}..${max} 的整数`, { field });
  }
}

export function validateAdminResultCorrectionPayload(
  payload: Record<string, unknown>,
): AdminResultCorrectionInput {
  assertUnknownFields(payload, ADMIN_RESULT_CORRECTION_FIELDS);
  assertIntegerInRange(payload.expected_result_version, "expected_result_version", 0, Number.MAX_SAFE_INTEGER);
  assertIntegerInRange(payload.regular_home_score, "regular_home_score", 0, 99);
  assertIntegerInRange(payload.regular_away_score, "regular_away_score", 0, 99);
  if (
    typeof payload.reason !== "string" ||
    payload.reason.length < 1 ||
    payload.reason.length > 500
  ) {
    throw validationError("reason 长度必须为 1..500", { field: "reason" });
  }
  return {
    expected_result_version: payload.expected_result_version,
    regular_home_score: payload.regular_home_score,
    regular_away_score: payload.regular_away_score,
    reason: payload.reason,
  };
}

export function validateAdminMatchId(value: unknown): string {
  if (typeof value !== "string" || !isValidUuid(value)) {
    throw validationError("match_id 必须为 UUID v4", { field: "match_id" });
  }
  return value;
}

export function validateAdminUserId(value: unknown): string {
  if (typeof value !== "string" || !isValidUuid(value)) {
    throw validationError("user_id 必须为 UUID v4", { field: "user_id" });
  }
  return value;
}

export function validateAdminRebuildRankingsPayload(
  payload: Record<string, unknown>,
): AdminRebuildRankingsInput {
  assertUnknownFields(payload, ADMIN_REBUILD_RANKINGS_FIELDS);
  if (payload.period_type !== PeriodType.Week && payload.period_type !== PeriodType.Month) {
    throw validationError("period_type 必须是 week 或 month", { field: "period_type" });
  }
  if (
    typeof payload.period_key !== "string" ||
    !isValidPeriodKey(payload.period_type, payload.period_key)
  ) {
    throw validationError("period_key 格式与 period_type 不匹配", { field: "period_key" });
  }
  if (
    typeof payload.reason !== "string" ||
    payload.reason.length < 1 ||
    payload.reason.length > 500
  ) {
    throw validationError("reason 长度必须为 1..500", { field: "reason" });
  }
  return {
    period_type: payload.period_type,
    period_key: payload.period_key,
    reason: payload.reason,
  };
}

function checkAdminRateLimit(
  trustedOpenid: string | null | undefined,
  serverNow: Date,
  rateLimiter: RateLimiter | undefined,
): void {
  if (typeof trustedOpenid === "string" && trustedOpenid.length > 0) {
    (rateLimiter ?? defaultApiRateLimiter).check("admin_apis", trustedOpenid, serverNow);
  }
}

function assertResultCorrectionResponse(
  outcome: AdminResultCorrectionOutcome,
  matchId: string,
): void {
  if (outcome.match.match_id !== matchId || outcome.result.match_id !== matchId) {
    throw internalError("管理员赛果修正结果比赛标识不一致");
  }
  if (outcome.result.source !== "admin") {
    throw internalError("管理员赛果修正结果来源不一致");
  }
  if (
    outcome.match.result_version !== outcome.result.result_version ||
    outcome.match.regular_home_score !== outcome.result.regular_home_score ||
    outcome.match.regular_away_score !== outcome.result.regular_away_score ||
    outcome.match.result_source !== outcome.result.source
  ) {
    throw internalError("管理员赛果修正的比赛快照与结果摘要不一致");
  }
  if (
    !Number.isSafeInteger(outcome.result.result_version) ||
    outcome.result.result_version < 1 ||
    !Number.isInteger(outcome.result.regular_home_score) ||
    outcome.result.regular_home_score < FIXED_CONFIG_V1.FINAL_SCORE_MIN ||
    outcome.result.regular_home_score > FIXED_CONFIG_V1.FINAL_SCORE_MAX ||
    !Number.isInteger(outcome.result.regular_away_score) ||
    outcome.result.regular_away_score < FIXED_CONFIG_V1.FINAL_SCORE_MIN ||
    outcome.result.regular_away_score > FIXED_CONFIG_V1.FINAL_SCORE_MAX ||
    !Object.values(SettlementStatus).includes(outcome.match.settlement_status)
  ) {
    throw internalError("管理员赛果修正返回的结果摘要无效");
  }
  if (!isValidUuid(outcome.audit_log.audit_id)) {
    throw internalError("管理员赛果修正缺少有效审计标识");
  }
}

export interface PostAdminResultCorrectionInput {
  trusted_openid?: string | null;
  match_id: unknown;
  body: Record<string, unknown>;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface PostAdminResultCorrectionSuccessResponse {
  status: 201;
  body: {
    data: {
      match_id: string;
      result_version: number;
      regular_home_score: number;
      regular_away_score: number;
      result_source: "admin";
      settlement_status: AdminResultCorrectionOutcome["match"]["settlement_status"];
      audit_id: string;
    };
    request_id: string;
  };
}

export async function postAdminResultCorrection(
  service: Pick<AdminResultCorrectionService, "correct">,
  input: PostAdminResultCorrectionInput,
): Promise<PostAdminResultCorrectionSuccessResponse> {
  const matchId = validateAdminMatchId(input.match_id);
  const correction = validateAdminResultCorrectionPayload(input.body);
  checkAdminRateLimit(input.trusted_openid, input.server_now, input.rate_limiter);
  const outcome = await service.correct(
    input.trusted_openid,
    matchId,
    correction,
    input.server_now,
  );
  assertResultCorrectionResponse(outcome, matchId);
  return {
    status: 201 as const,
    body: {
      data: {
        match_id: outcome.match.match_id,
        result_version: outcome.result.result_version,
        regular_home_score: outcome.result.regular_home_score,
        regular_away_score: outcome.result.regular_away_score,
        result_source: "admin" as const,
        settlement_status: outcome.match.settlement_status,
        audit_id: outcome.audit_log.audit_id,
      },
      request_id: input.request_id,
    },
  };
}

export interface PostAdminRetrySettlementInput {
  trusted_openid?: string | null;
  match_id: unknown;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface PostAdminRetrySettlementSuccessResponse {
  status: 200;
  body: {
    data: {
      match_id: string;
      settlement_id: string;
      result_version: number;
      outcome: "settled" | "failed";
      processed_count: number;
      skipped_applied_count: number;
      audit_id: string;
    };
    request_id: string;
  };
}

function assertPositiveSafeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw internalError(`管理员 retry 返回的 ${field} 无效`);
  }
}

function assertNonNegativeSafeInteger(
  value: unknown,
  field: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw internalError(`管理员 retry 返回的 ${field} 无效`);
  }
}

/** 第 48.2 节成功 envelope；内部 settlement/audit 文档不直接暴露给 API。 */
export async function postAdminRetrySettlement(
  service: RetrySettlementCommand,
  input: PostAdminRetrySettlementInput,
): Promise<PostAdminRetrySettlementSuccessResponse> {
  const matchId = validateAdminMatchId(input.match_id);
  checkAdminRateLimit(input.trusted_openid, input.server_now, input.rate_limiter);
  const outcome: AdminRetrySettlementOutcome = await service.retry(
    input.trusted_openid,
    matchId,
    input.server_now,
  );
  if (outcome.kind === "already_running") {
    throw conflictError("SETTLEMENT_ALREADY_RUNNING", "比赛已有结算任务正在运行", {
      settlement_id: outcome.settlement_id,
    });
  }
  if (outcome.kind === "already_settled" || outcome.kind === "not_retryable") {
    throw conflictError("SETTLEMENT_NOT_READY", "比赛当前没有可重试的 failed settlement", {
      settlement_id: outcome.settlement_id,
      kind: outcome.kind,
    });
  }
  if (
    outcome.kind !== "settled" &&
    outcome.kind !== "failed" &&
    outcome.kind !== "correcting"
  ) {
    throw internalError("管理员 retry 未返回可对外返回的执行结果");
  }
  if (
    !isValidUuid(outcome.settlement_id) ||
    outcome.audit_log === undefined ||
    !isValidUuid(outcome.audit_log.audit_id)
  ) {
    throw internalError("管理员 retry 缺少结果版本或审计记录");
  }
  assertPositiveSafeInteger(outcome.result_version, "result_version");
  assertNonNegativeSafeInteger(outcome.processed_count, "processed_count");
  assertNonNegativeSafeInteger(outcome.skipped_applied_count, "skipped_applied_count");
  return {
    status: 200,
    body: {
      data: {
        match_id: matchId,
        settlement_id: outcome.settlement_id,
        result_version: outcome.result_version,
        outcome: outcome.kind === "failed" ? "failed" : "settled",
        processed_count: outcome.processed_count,
        skipped_applied_count: outcome.skipped_applied_count,
        audit_id: outcome.audit_log.audit_id,
      },
      request_id: input.request_id,
    },
  };
}

export interface PostAdminRebuildUserStatsInput {
  trusted_openid?: string | null;
  user_id: unknown;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface PostAdminRebuildUserStatsSuccessResponse {
  status: 200;
  body: {
    data: {
      user_id: string;
      rebuilt_season_count: number;
      audit_id: string;
    };
    request_id: string;
  };
}

/** 第 48.2 节成功 envelope；内部重建结果和审计文档不直接暴露给 API。 */
export async function postAdminRebuildUserStats(
  service: AdminRebuildUserStatsCommand,
  input: PostAdminRebuildUserStatsInput,
): Promise<PostAdminRebuildUserStatsSuccessResponse> {
  const userId = validateAdminUserId(input.user_id);
  checkAdminRateLimit(input.trusted_openid, input.server_now, input.rate_limiter);
  const outcome: AdminRebuildUserStatsOutcome = await service.rebuild(
    input.trusted_openid,
    userId,
    input.server_now,
  );
  if (outcome.user.user_id !== userId) {
    throw internalError("管理员 user stats rebuild 结果用户标识不一致");
  }
  if (!Array.isArray(outcome.season_stats)) {
    throw internalError("管理员 user stats rebuild 返回的 season_stats 摘要无效");
  }
  const rebuiltSeasonCount = outcome.season_stats.length;
  assertNonNegativeSafeInteger(rebuiltSeasonCount, "rebuilt_season_count");
  if (!isValidUuid(outcome.audit_log.audit_id)) {
    throw internalError("管理员 user stats rebuild 缺少审计记录");
  }
  return {
    status: 200,
    body: {
      data: {
        user_id: userId,
        rebuilt_season_count: rebuiltSeasonCount,
        audit_id: outcome.audit_log.audit_id,
      },
      request_id: input.request_id,
    },
  };
}

export interface PostAdminRebuildRankingsInput {
  trusted_openid?: string | null;
  body: Record<string, unknown>;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface PostAdminRebuildRankingsSuccessResponse {
  status: 200;
  body: {
    data: {
      period_type: AdminRebuildRankingsInput["period_type"];
      period_key: string;
      rebuilt_entry_count: number;
      audit_id: string;
    };
    request_id: string;
  };
}

/** 第 48.2 节成功 envelope；内部排行榜和审计文档不直接暴露给 API。 */
export async function postAdminRebuildRankings(
  service: AdminRebuildRankingsCommand,
  input: PostAdminRebuildRankingsInput,
): Promise<PostAdminRebuildRankingsSuccessResponse> {
  const rebuild = validateAdminRebuildRankingsPayload(input.body);
  checkAdminRateLimit(input.trusted_openid, input.server_now, input.rate_limiter);
  const outcome: AdminRebuildRankingsOutcome = await service.rebuild(
    input.trusted_openid,
    rebuild.period_type,
    rebuild.period_key,
    rebuild.reason,
    input.server_now,
  );
  if (!Array.isArray(outcome.rankings)) {
    throw internalError("管理员 rankings rebuild 返回的 rankings 摘要无效");
  }
  const rebuiltEntryCount = outcome.rankings.length;
  assertNonNegativeSafeInteger(rebuiltEntryCount, "rebuilt_entry_count");
  if (!isValidUuid(outcome.audit_log.audit_id)) {
    throw internalError("管理员 rankings rebuild 缺少审计记录");
  }
  return {
    status: 200,
    body: {
      data: {
        period_type: rebuild.period_type,
        period_key: rebuild.period_key,
        rebuilt_entry_count: rebuiltEntryCount,
        audit_id: outcome.audit_log.audit_id,
      },
      request_id: input.request_id,
    },
  };
}
