/**
 * API v1 校验与错误映射（阶段 2）。
 *
 * - assertUnknownFields：拒绝请求体中未定义字段（规范 23.4）。
 * - mapErrorToHttp：将 DomainError 映射为 HTTP 状态 + 错误 envelope（规范 23.6/23.7）。
 *   program 判断只使用 code；message 仅供展示。
 * - submitPredictionStatus：预测提交 201 / 幂等重放 200。
 * - makeRequestId：生成 request_id（UUID v4）。
 */
import type { ErrorDetails } from "../../domain/errors.js";
import { DomainError, validationError } from "../../domain/errors.js";
import { newUuid } from "../../domain/ids.js";

export const ISO_UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export interface HttpErrorEnvelope {
  code: string;
  message: string;
  request_id: string;
  details: ErrorDetails;
}

export interface MappedHttpError {
  status: number;
  body: HttpErrorEnvelope;
}

export function makeRequestId(): string {
  return newUuid();
}

/** 规范 23.4：拒绝所有未定义字段。 */
export function assertUnknownFields(
  payload: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
): void {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw validationError("请求体必须为 JSON 对象");
  }
  for (const key of Object.keys(payload)) {
    if (!allowedFields.has(key)) {
      throw validationError("请求包含未定义字段", { field: key });
    }
  }
}

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  VALIDATION_ERROR: 422,
  AUTH_REQUIRED: 401,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  USER_NOT_ACTIVE: 403,
  IDEMPOTENCY_KEY_REUSED: 409,
  PREDICTION_ALREADY_SUBMITTED: 409,
  USER_DELETED: 409,
  MATCH_NOT_PREDICTABLE: 409,
  MATCH_STATE_CONFLICT: 409,
  PREDICTION_LOCKED: 409,
  SETTLEMENT_NOT_READY: 409,
  SETTLEMENT_ALREADY_RUNNING: 409,
  SETTLEMENT_FAILED: 409,
  RESULT_UNCHANGED: 409,
  RESULT_VERSION_CONFLICT: 409,
  MATCH_NOT_FINISHED: 409,
  INVALID_RESULT_VERSION: 409,
  MATCH_NOT_SETTLED: 409,
  SETTLEMENT_NOTHING_TO_CORRECT: 409,
  RESULT_VERSION_SKIPPED: 409,
  RESULT_VERSION_STALE: 409,
  PROVIDER_DATA_INVALID: 409,
  PROVIDER_STATE_CONFLICT: 409,
  PROVIDER_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

/** 将错误映射为 HTTP 响应（status + ErrorEnvelope）。 */
export function mapErrorToHttp(error: unknown, requestId: string): MappedHttpError {
  if (error instanceof DomainError) {
    let status = STATUS_BY_CODE[error.code];
    if (status === undefined && error.code.endsWith("_NOT_FOUND")) {
      status = 404;
    }
    if (status === undefined) {
      status = 500;
    }
    const code = error.code === "AUTH_REQUIRED"
      ? "UNAUTHORIZED"
      : status === 500
        ? "INTERNAL_ERROR"
        : error.code;
    return {
      status,
      body: {
        code,
        message: error.message,
        request_id: requestId,
        details: error.details,
      },
    };
  }
  return {
    status: 500,
    body: {
      code: "INTERNAL_ERROR",
      message: "服务器内部错误",
      request_id: requestId,
      details: null,
    },
  };
}

/** 预测提交成功响应状态：首次创建 201，幂等重放 200。 */
export function submitPredictionStatus(result: { created: boolean }): 200 | 201 {
  return result.created ? 201 : 200;
}
