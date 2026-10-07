import { conflictError, internalError, validationError } from "../../domain/errors.js";
import { FIXED_CONFIG_V1 } from "../../domain/config.js";
import { PeriodType, RankingBoard, SettlementStatus } from "../../domain/enums.js";
import { isValidUuid } from "../../domain/ids.js";
import { isValidPeriodKey } from "../../domain/time.js";
import type {
  AdminResultCorrectionInput,
  AdminResultCorrectionOutcome,
  AdminResultCorrectionService,
} from "../../application/admin-result-correction.js";
import type { AdminWriteAuthorizer } from "../../application/admin.js";
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
  "board",
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
  payload: unknown,
): AdminResultCorrectionInput {
  const body = payload as Record<string, unknown>;
  assertUnknownFields(body, ADMIN_RESULT_CORRECTION_FIELDS);
  assertIntegerInRange(body.expected_result_version, "expected_result_version", 0, Number.MAX_SAFE_INTEGER);
  assertIntegerInRange(body.regular_home_score, "regular_home_score", 0, 99);
  assertIntegerInRange(body.regular_away_score, "regular_away_score", 0, 99);
  if (
    typeof body.reason !== "string" ||
    body.reason.length < 1 ||
    body.reason.length > 500
  ) {
    throw validationError("reason 长度必须为 1..500", { field: "reason" });
  }
  return {
    expected_result_version: body.expected_result_version,
    regular_home_score: body.regular_home_score,
    regular_away_score: body.regular_away_score,
    reason: body.reason,
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
  payload: unknown,
): AdminRebuildRankingsInput {
  const body = payload as Record<string, unknown>;
  assertUnknownFields(body, ADMIN_REBUILD_RANKINGS_FIELDS);
  if (!Object.values(RankingBoard).includes(body.board as RankingBoard)) {
    throw validationError("board 必须是 week、career、strength 或 season", { field: "board" });
  }
  const board = body.board as RankingBoard;
  let periodKey: string | null = null;
  if (board === RankingBoard.Week) {
    if (
      typeof body.period_key !== "string" ||
      !isValidPeriodKey(PeriodType.Week, body.period_key)
    ) {
      throw validationError("week board 必须携带有效 period_key", { field: "period_key" });
    }
    periodKey = body.period_key;
  } else if (Object.prototype.hasOwnProperty.call(body, "period_key")) {
    throw validationError("career/strength/season board 禁止携带 period_key", {
      field: "period_key",
    });
  }
  if (
    typeof body.reason !== "string" ||
    body.reason.length < 1 ||
    body.reason.length > 500
  ) {
    throw validationError("reason 长度必须为 1..500", { field: "reason" });
  }
  return {
    board,
    period_key: periodKey,
    reason: body.reason,
  };
}

async function checkAdminRateLimit(
  trustedOpenid: string | null | undefined,
  serverNow: Date,
  rateLimiter: RateLimiter | undefined,
): Promise<void> {
  if (typeof trustedOpenid === "string" && trustedOpenid.length > 0) {
    await (rateLimiter ?? defaultApiRateLimiter).check(
      "admin_apis",
      trustedOpenid,
      serverNow,
    );
  }
}

async function preflightAdmin(
  service: AdminWriteAuthorizer,
  value: string | null | undefined,
): Promise<string> {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw conflictError("UNAUTHORIZED", "需要可信管理员身份");
  }
  await service.authorizeAdmin(value);
  return value;
}

function validateEmptyAdminBody(body: unknown): void {
  if (body === undefined || body === null) {
    return;
  }
  assertUnknownFields(body as Record<string, unknown>, new Set());
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
  body: unknown;
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
  service: Pick<AdminResultCorrectionService, "correct" | "authorizeAdmin">,
  input: PostAdminResultCorrectionInput,
): Promise<PostAdminResultCorrectionSuccessResponse> {
  const trustedOpenid = await preflightAdmin(service, input.trusted_openid);
  const matchId = validateAdminMatchId(input.match_id);
  const correction = validateAdminResultCorrectionPayload(input.body);
  await checkAdminRateLimit(trustedOpenid, input.server_now, input.rate_limiter);
  const outcome = await service.correct(
    trustedOpenid,
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
  body?: unknown;
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
  const trustedOpenid = await preflightAdmin(service, input.trusted_openid);
  const matchId = validateAdminMatchId(input.match_id);
  validateEmptyAdminBody(input.body);
  await checkAdminRateLimit(trustedOpenid, input.server_now, input.rate_limiter);
  const outcome: AdminRetrySettlementOutcome = await service.retry(
    trustedOpenid,
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
  if (outcome.kind !== "settled" && outcome.kind !== "failed") {
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
        outcome: outcome.kind,
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
  body?: unknown;
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
      level_state_changed: boolean;
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
  const trustedOpenid = await preflightAdmin(service, input.trusted_openid);
  const userId = validateAdminUserId(input.user_id);
  validateEmptyAdminBody(input.body);
  await checkAdminRateLimit(trustedOpenid, input.server_now, input.rate_limiter);
  const outcome: AdminRebuildUserStatsOutcome = await service.rebuild(
    trustedOpenid,
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
        level_state_changed: outcome.level_state_changed,
        audit_id: outcome.audit_log.audit_id,
      },
      request_id: input.request_id,
    },
  };
}

export interface PostAdminRebuildRankingsInput {
  trusted_openid?: string | null;
  body: unknown;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface PostAdminRebuildRankingsSuccessResponse {
  status: 200;
  body: {
    data: {
      board: AdminRebuildRankingsInput["board"];
      period_key: string | null;
      rebuilt_entry_count: number;
      audit_id: string;
    };
    request_id: string;
  };
}

/** 第 30.6 节成功 envelope；内部排行榜和审计文档不直接暴露给 API。 */
export async function postAdminRebuildRankings(
  service: AdminRebuildRankingsCommand,
  input: PostAdminRebuildRankingsInput,
): Promise<PostAdminRebuildRankingsSuccessResponse> {
  const trustedOpenid = await preflightAdmin(service, input.trusted_openid);
  const rebuild = validateAdminRebuildRankingsPayload(input.body);
  await checkAdminRateLimit(trustedOpenid, input.server_now, input.rate_limiter);
  const outcome: AdminRebuildRankingsOutcome = await service.rebuild(
    trustedOpenid,
    rebuild.board,
    rebuild.period_key,
    rebuild.reason,
    input.server_now,
  );
  if (outcome.board !== rebuild.board || outcome.period_key !== rebuild.period_key) {
    throw internalError("管理员 rankings rebuild 返回的目标榜单不一致");
  }
  assertNonNegativeSafeInteger(outcome.rebuilt_entry_count, "rebuilt_entry_count");
  if (!isValidUuid(outcome.audit_log.audit_id)) {
    throw internalError("管理员 rankings rebuild 缺少审计记录");
  }
  return {
    status: 200,
    body: {
      data: {
        board: rebuild.board,
        period_key: rebuild.period_key,
        rebuilt_entry_count: outcome.rebuilt_entry_count,
        audit_id: outcome.audit_log.audit_id,
      },
      request_id: input.request_id,
    },
  };
}
