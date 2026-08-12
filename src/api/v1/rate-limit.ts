import { conflictError, validationError } from "../../domain/errors.js";

const ONE_MINUTE_MS = 60_000;

export const RATE_LIMIT_DEFAULTS = {
  predictions: {
    max_requests: 10,
    window_ms: ONE_MINUTE_MS,
  },
  profile_patch: {
    max_requests: 20,
    window_ms: ONE_MINUTE_MS,
  },
  authenticated_reads: {
    max_requests: 120,
    window_ms: ONE_MINUTE_MS,
  },
  admin_apis: {
    max_requests: 60,
    window_ms: ONE_MINUTE_MS,
  },
  public_reads: {
    max_requests: 120,
    window_ms: ONE_MINUTE_MS,
  },
} as const;

export type RateLimitScope = keyof typeof RATE_LIMIT_DEFAULTS;

export interface RateLimiter {
  check(scope: RateLimitScope, identity: string, serverNow: Date): void;
}

interface WindowState {
  window_start: number;
  request_count: number;
}

/**
 * 进程内固定窗口实现，供 API middleware 和测试适配器使用。
 * 生产环境可替换为同一 RateLimiter port 的网关/共享存储适配器。
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, WindowState>();

  check(scope: RateLimitScope, identity: string, serverNow: Date): void {
    if (typeof identity !== "string" || identity.length === 0) {
      throw validationError("限流身份标识不能为空", { field: "identity" });
    }
    if (!(serverNow instanceof Date) || !Number.isFinite(serverNow.getTime())) {
      throw validationError("server_now 必须是有效时间", { field: "server_now" });
    }

    const config = RATE_LIMIT_DEFAULTS[scope];
    const windowStart =
      Math.floor(serverNow.getTime() / config.window_ms) * config.window_ms;
    const key = `${scope}\u0000${identity}`;
    const previous = this.windows.get(key);
    const requestCount =
      previous?.window_start === windowStart ? previous.request_count + 1 : 1;
    this.windows.set(key, {
      window_start: windowStart,
      request_count: requestCount,
    });

    if (requestCount > config.max_requests) {
      throw conflictError("RATE_LIMITED", "请求过于频繁");
    }
  }
}

export const defaultApiRateLimiter: RateLimiter = new InMemoryRateLimiter();
