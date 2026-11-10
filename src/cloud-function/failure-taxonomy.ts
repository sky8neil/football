/**
 * 调度/云函数失败分类纯函数。
 *
 * 判定顺序（必须按此执行，禁止颠倒）：
 * 1. 带 `code` / `errCode` / `providerCode` 的错误码（DomainError、ProviderError、Node errno）
 * 2. `instanceof` 仓库内真实错误类
 * 3. 消息正则兜底（含 CloudBase SDK 的 duplicate / missing 文案）
 *
 * 输入可以是任意 throw 出来的值；本模块不得再抛异常。
 *
 * retryable：
 * - transient → true
 * - quota_auth → true（额度恢复或 key 轮换后可重试，必须带退避，禁止立即打满上游）
 * - lock_contention → true（下次调度再抢锁 / 去重）
 * - data_format / not_due / no_match_window / unknown → false
 *
 * not_due / no_match_window 是正常跳过，不是失败；禁止靠吞错降低失败率。
 */
import { DomainError } from "../domain/errors.js";
import {
  ProviderDataError,
  ProviderError,
  ProviderHttpError,
  ProviderQuotaExceededError,
} from "../provider/http.js";
import {
  CloudBaseDocumentNotFoundError,
  CloudBaseDuplicateKeyError,
} from "../infrastructure/cloudbase-db.js";

export type FailureCategory =
  | "transient"
  | "data_format"
  | "quota_auth"
  | "lock_contention"
  | "not_due"
  | "no_match_window"
  | "unknown";

export interface FailureClassification {
  category: FailureCategory;
  retryable: boolean;
  code: string;
}

export const BENIGN_SKIP_CATEGORIES: ReadonlySet<FailureCategory> = new Set([
  "not_due",
  "no_match_window",
]);

const RETRYABLE_CATEGORIES: ReadonlySet<FailureCategory> = new Set([
  "transient",
  "quota_auth",
  "lock_contention",
]);

const TRANSIENT_ERRNO = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "ABORT_ERR",
]);

export function isBenignSkip(classification: FailureClassification): boolean {
  return BENIGN_SKIP_CATEGORIES.has(classification.category);
}

export function classifyFailure(error: unknown): FailureClassification {
  try {
    return classifyUnsafe(error);
  } catch {
    return result("unknown", "UNKNOWN");
  }
}

function result(category: FailureCategory, code: string): FailureClassification {
  return {
    category,
    retryable: RETRYABLE_CATEGORIES.has(category),
    code,
  };
}

function classifyUnsafe(error: unknown): FailureClassification {
  if (error === null || error === undefined) {
    return result("unknown", "UNKNOWN");
  }

  if (typeof error === "string") {
    return classifyByMessage(error) ?? result("unknown", "UNKNOWN");
  }

  const code = extractCode(error);
  const providerCode = extractProviderCode(error);

  if (providerCode === "1010") {
    return result("quota_auth", "1010");
  }

  if (code !== null) {
    const byCode = classifyByCode(code);
    if (byCode !== null) {
      return byCode;
    }
  }

  if (error instanceof ProviderQuotaExceededError) {
    return result("quota_auth", error.code);
  }
  if (error instanceof ProviderDataError) {
    return result("data_format", error.code);
  }
  if (error instanceof ProviderHttpError) {
    return classifyHttpStatus(error.status, error.code);
  }
  if (error instanceof CloudBaseDuplicateKeyError) {
    return result("lock_contention", "DUPLICATE_KEY");
  }
  if (error instanceof CloudBaseDocumentNotFoundError) {
    return result("unknown", "DOCUMENT_NOT_FOUND");
  }
  if (error instanceof ProviderError) {
    return classifyByCode(error.code) ?? result("unknown", error.code);
  }
  if (error instanceof DomainError) {
    return classifyByCode(error.code) ?? result("unknown", error.code);
  }

  if (isRecord(error) && error.outcome === "skipped") {
    return result("lock_contention", "LOCK_CONTENTION");
  }

  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return result("transient", "TIMEOUT");
    }
    const byMessage = classifyByMessage(error.message);
    if (byMessage !== null) {
      return byMessage;
    }
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause !== undefined && cause !== error) {
      const nested = classifyUnsafe(cause);
      if (nested.category !== "unknown") {
        return nested;
      }
    }
  } else if (isRecord(error)) {
    const byMessage = classifyByMessage(errorMessage(error));
    if (byMessage !== null) {
      return byMessage;
    }
  }

  return result("unknown", code ?? "UNKNOWN");
}

function classifyByCode(code: string): FailureClassification | null {
  const upper = code.toUpperCase();

  if (TRANSIENT_ERRNO.has(upper)) {
    return result("transient", upper);
  }
  if (upper === "PROVIDER_QUOTA_EXCEEDED") {
    return result("quota_auth", "PROVIDER_QUOTA_EXCEEDED");
  }
  if (upper === "1010") {
    return result("quota_auth", "1010");
  }
  if (upper === "PROVIDER_DATA_ERROR" || upper === "VALIDATION_ERROR") {
    return result("data_format", upper);
  }
  if (upper === "E11000" || upper === "11000") {
    return result("lock_contention", "E11000");
  }

  const http = /^PROVIDER_HTTP_(\d+)$/.exec(upper);
  if (http) {
    return classifyHttpStatus(Number(http[1]), upper);
  }

  if (/^(408|5\d\d)$/.test(upper)) {
    return result("transient", `PROVIDER_HTTP_${upper}`);
  }
  if (upper === "401" || upper === "403" || upper === "429") {
    return result("quota_auth", `PROVIDER_HTTP_${upper}`);
  }

  return null;
}

function classifyHttpStatus(status: number, code: string): FailureClassification {
  if (status === 408 || status >= 500) {
    return result("transient", code);
  }
  if (status === 401 || status === 403 || status === 429) {
    return result("quota_auth", code);
  }
  if (status >= 400 && status < 500) {
    return result("data_format", code);
  }
  return result("unknown", code);
}

function classifyByMessage(text: string): FailureClassification | null {
  if (text.length === 0) {
    return null;
  }
  const lower = text.toLowerCase();

  if (/未到(重试|执行)/.test(text) || /not[_ ]due|before (the )?(retry|execution) window/.test(lower)) {
    return result("not_due", "NOT_DUE");
  }
  if (/无比赛窗口|无候选/.test(text) || /no match window|no candidate/.test(lower)) {
    return result("no_match_window", "NO_MATCH_WINDOW");
  }
  if (/duplicate|already exists|e11000|\b11000\b/.test(lower)) {
    return result("lock_contention", "DUPLICATE_KEY");
  }
  if (/quota|rate.?limit|too many requests/.test(lower)) {
    return result("quota_auth", "PROVIDER_QUOTA_EXCEEDED");
  }
  if (/unauthorized|forbidden|invalid (api )?key|鉴权|key (invalid|expired)/.test(lower)) {
    return result("quota_auth", "AUTH_FAILED");
  }
  if (/invalid provider|not valid json|not a json object|envelope missing|forbidden or unknown provider/.test(lower)) {
    return result("data_format", "PROVIDER_DATA_ERROR");
  }
  if (/validation|校验失败/.test(lower)) {
    return result("data_format", "VALIDATION_ERROR");
  }
  if (/econnreset/.test(lower)) {
    return result("transient", "ECONNRESET");
  }
  if (/etimedout|timeout|aborted/.test(lower)) {
    return result("transient", "TIMEOUT");
  }
  if (/econnrefused/.test(lower)) {
    return result("transient", "ECONNREFUSED");
  }
  if (/socket hang up|network error|enotfound|eai_again|epipe/.test(lower)) {
    return result("transient", "NETWORK");
  }
  if (/provider http 408|provider http 5\d\d/.test(lower)) {
    return result("transient", "PROVIDER_HTTP_5XX");
  }

  return null;
}

function extractCode(error: unknown): string | null {
  if (!isRecord(error)) {
    return null;
  }
  const value = error.code ?? error.errCode;
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function extractProviderCode(error: unknown): string | null {
  if (!isRecord(error)) {
    return null;
  }
  const value = error.providerCode;
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  return String(error ?? "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
