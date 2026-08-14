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
  "retry-after",
] as const;

export interface FetchProviderHttpClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** 仅传输层超时，不进入业务判断。默认 10_000ms。 */
  timeoutMs?: number;
  /** 可注入，测试用 fake。默认 Node 内置全局 fetch。 */
  fetchImpl?: typeof fetch;
}

export class FetchProviderHttpClient implements ProviderHttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FetchProviderHttpClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? API_FOOTBALL_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getJson(path: string, query: Record<string, string>): Promise<unknown> {
    const url = buildRequestUrl(this.baseUrl, path, query);
    const response = await this.fetchResponse(url);
    const status = response.status;

    if (status === 429) {
      throw new ProviderQuotaExceededError(readQuotaResetAt(response));
    }
    if (status < 200 || status >= 300) {
      throw new ProviderHttpError(status, httpErrorMessage(status, response.statusText));
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
    return parsed;
  }

  private async fetchResponse(url: string): Promise<Response> {
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
          "x-apisports-key": this.apiKey,
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

/**
 * ApiFootballClient 会把 `${baseUrl}/${endpoint}` 整段作为 path 传入。
 * path 已是绝对 URL 时不再拼接 baseUrl，避免双重前缀。
 */
function buildRequestUrl(
  baseUrl: string,
  path: string,
  query: Record<string, string>,
): string {
  const search = new URLSearchParams(query).toString();
  const suffix = search.length > 0 ? `?${search}` : "";
  if (isAbsoluteHttpUrl(path)) {
    return `${path}${suffix}`;
  }
  const origin = trimTrailingSlash(baseUrl);
  const relative = path.startsWith("/") ? path.slice(1) : path;
  return `${origin}/${relative}${suffix}`;
}

function isAbsoluteHttpUrl(path: string): boolean {
  return path.startsWith("https://") || path.startsWith("http://");
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
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
    if (numeric >= 1e12) {
      return new Date(numeric);
    }
    return new Date(numeric * 1000);
  }
  const millis = Date.parse(trimmed);
  return Number.isFinite(millis) ? new Date(millis) : null;
}
