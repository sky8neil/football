/**
 * API-Football 真实 HTTP 传输层（阶段 B2）。
 *
 * 实现 ProviderHttpClient：拼 URL、认证头、传输超时、按 HTTP 状态分类错误。
 * 不重复 ApiFootballClient 的只读白名单、envelope 解码或 payload 校验。
 *
 * 真实凭证只经调用方注入，本文件不读取环境、不打印 key；key 绝不进入日志/错误 message。
 *
 * 错误分类严格按 MVP §49.13：
 * - 429 → ProviderQuotaExceededError（不 retry）
 * - 408 / 5xx → ProviderHttpError（loader retry）
 * - 其他非 2xx → ProviderHttpError（不 retry）
 * - 网络/超时 → 普通 Error（可 retry）；不得包装成 ProviderError/DomainError
 */
import {
  API_FOOTBALL_BASE_URL,
  ProviderDataError,
  ProviderHttpError,
  ProviderQuotaExceededError,
  type ProviderHttpClient,
} from "./http.js";

/** 仅传输层超时，不进入业务判断（loader/sync 的 retry 与窗口仍由调用方决定）。 */
const DEFAULT_TIMEOUT_MS = 10_000;

const QUOTA_RESET_HEADERS = [
  "x-ratelimit-requests-reset",
  "x-ratelimit-reset",
  "x-requestcounter-reset",
  "retry-after",
] as const;

export interface FetchProviderHttpClientOptions {
  apiKey: string;
  baseUrl?: string;
  authHeaderName?: string;
  authScheme?: "raw" | "token" | "bearer";
  /** 仅传输层超时，不进入业务判断。默认 10_000ms。 */
  timeoutMs?: number;
  /** 可注入，测试用 fake。默认 Node 内置全局 fetch。 */
  fetchImpl?: typeof fetch;
  onResponse?: (metadata: ProviderResponseMetadata) => void;
  defaultHeaders?: Record<string, string>;
}

export interface ProviderResponseMetadata {
  status: number;
  rate_limit: string | null;
  rate_limit_policy: string | null;
  retry_after: string | null;
  requests_available_minute: string | null;
  request_counter_reset: string | null;
  rate_limit_limit: string | null;
  rate_limit_remaining: string | null;
  rate_limit_reset: string | null;
  etag: string | null;
}

export class FetchProviderHttpClient implements ProviderHttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly authHeaderName: string;
  private readonly authScheme: "raw" | "token" | "bearer";
  private readonly onResponse: ((metadata: ProviderResponseMetadata) => void) | undefined;
  private readonly defaultHeaders: Record<string, string>;

  constructor(options: FetchProviderHttpClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? API_FOOTBALL_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.authHeaderName = options.authHeaderName ?? "x-apisports-key";
    this.authScheme = options.authScheme ?? "raw";
    this.onResponse = options.onResponse;
    this.defaultHeaders = options.defaultHeaders ?? {};
  }

  async getJson(path: string, query: Record<string, string>): Promise<unknown> {
    return (await this.getJsonResponse(path, query)).data;
  }

  async getJsonResponse(
    path: string,
    query: Record<string, string>,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ data: unknown; status: number; headers: Headers }> {
    const url = buildRequestUrl(this.baseUrl, path, query);
    const response = await this.fetchResponse(url, extraHeaders);
    const status = response.status;
    const metadata = responseMetadata(response);
    this.onResponse?.(metadata);

    if (status === 304) return { data: null, status, headers: response.headers };

    if (status === 429) {
      const details = await readQuotaDetails(response);
      throw new ProviderQuotaExceededError(details.reset_at ?? readQuotaResetAt(response), details.code);
    }
    if (status < 200 || status >= 300) {
      throw new ProviderHttpError(status, httpErrorMessage(status, response.statusText), await readProviderErrorCode(response));
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new ProviderDataError("provider response is not valid JSON");
    }
    if (!isJsonObject(parsed)) {
      throw new ProviderDataError("provider response is not a JSON object");
    }
    return { data: parsed, status, headers: response.headers };
  }

  private async fetchResponse(url: string, extraHeaders: Record<string, string>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }

    try {
      return await this.fetchImpl(url, {
        method: "GET",
        headers: {
          ...this.defaultHeaders,
          ...extraHeaders,
          [this.authHeaderName]: this.authScheme === "token"
            ? `Token ${this.apiKey}`
            : this.authScheme === "bearer" ? `Bearer ${this.apiKey}` : this.apiKey,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch (err) {
      throw wrapTransportFailure(err);
    } finally {
      clearTimeout(timer);
    }
  }
}

function responseMetadata(response: Response): ProviderResponseMetadata {
  return {
    status: response.status,
    rate_limit: response.headers.get("ratelimit"),
    rate_limit_policy: response.headers.get("ratelimit-policy"),
    retry_after: response.headers.get("retry-after"),
    requests_available_minute: response.headers.get("x-requests-available-minute"),
    request_counter_reset: response.headers.get("x-requestcounter-reset"),
    rate_limit_limit: response.headers.get("x-ratelimit-limit"),
    rate_limit_remaining: response.headers.get("x-ratelimit-remaining"),
    rate_limit_reset: response.headers.get("x-ratelimit-reset"),
    etag: response.headers.get("etag"),
  };
}

async function readQuotaDetails(response: Response): Promise<{ code: string | null; reset_at: Date | null }> {
  try {
    const body: unknown = await response.clone().json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) return { code: null, reset_at: null };
    const record = body as Record<string, unknown>;
    const rawCode = record.code ?? record.errorCode;
    const code = typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode) : null;
    const message = typeof record.message === "string" ? record.message : "";
    const wait = /wait\s+(\d+)\s+seconds?/i.exec(message);
    return {
      code,
      reset_at: wait ? new Date(Date.now() + Number(wait[1]) * 1000) : null,
    };
  } catch {
    return { code: null, reset_at: null };
  }
}

async function readProviderErrorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.clone().json();
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      const record = body as Record<string, unknown>;
      const value = record.errorCode ?? record.code ?? record.error;
      if (typeof value === "string" || typeof value === "number") {
        const text = String(value);
        return /1010/.test(text) ? "1010" : text.slice(0, 40);
      }
    }
  } catch {
    // Some edge services return their diagnostic code as plain text.
  }
  try {
    const bodyText = await response.clone().text();
    return /1010/.test(bodyText) ? "1010" : null;
  } catch {
    return null;
  }
}

/**
 * ApiFootballClient 会把 `${baseUrl}/${endpoint}` 整段作为 path 传入。
 * path 已是绝对 URL 时不再拼接 baseUrl，避免双重前缀。
 */
function buildRequestUrl(
  baseUrl: string,
  path: string,
  query: Record<string, string>,
): string {
  const origin = new URL(baseUrl);
  const url = new URL(path, `${origin.toString().replace(/\/$/, "")}/`);
  if (url.protocol !== "https:") throw new ProviderDataError("provider requests must use https");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function httpErrorMessage(status: number, statusText: string): string {
  const text = statusText.trim();
  return text.length > 0 ? `provider HTTP ${status} ${text}` : `provider HTTP ${status}`;
}

function wrapTransportFailure(err: unknown): Error {
  const cause = err instanceof Error ? err : new Error(String(err));
  const kind = isAbortOrTimeout(cause) ? "timeout" : "network";
  return new Error(`provider ${kind} error`, { cause });
}

function isAbortOrTimeout(err: Error): boolean {
  return err.name === "AbortError" || err.name === "TimeoutError";
}

function readQuotaResetAt(response: Response): Date | null {
  for (const name of QUOTA_RESET_HEADERS) {
    const raw = response.headers.get(name);
    if (raw === null) {
      continue;
    }
    const parsed = parseResetHeader(name, raw);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function parseResetHeader(name: string, raw: string): Date | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isSafeInteger(numeric) || numeric < 0) {
      return null;
    }
    if (name === "retry-after") {
      return new Date(Date.now() + numeric * 1000);
    }
    if (name === "x-requestcounter-reset") {
      return new Date(Date.now() + numeric * 1000);
    }
    if (numeric >= 1e12) {
      return new Date(numeric);
    }
    return new Date(numeric * 1000);
  }
  const millis = Date.parse(trimmed);
  return Number.isFinite(millis) ? new Date(millis) : null;
}
