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
  groups: {
    max_requests: 10,
    window_ms: ONE_MINUTE_MS,
  },
} as const;

export type RateLimitScope = keyof typeof RATE_LIMIT_DEFAULTS;

export interface RateLimiter {
  check(
    scope: RateLimitScope,
    identity: string,
    serverNow: Date,
  ): void | Promise<void>;
}

interface WindowState {
  window_start: number;
  request_count: number;
  expires_at: number;
}

const PRUNE_SIZE_THRESHOLD = 1024;
const PRUNE_COOLDOWN_MS = 10_000;

/**
 * 进程内固定窗口实现，供 API middleware 和测试适配器使用。
 * 生产环境可替换为同一 RateLimiter port 的网关/共享存储适配器。
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, WindowState>();
  private lastPruneAt = 0;
  private nextPruneSize = PRUNE_SIZE_THRESHOLD;

  private pruneExpired(nowMs: number): void {
    for (const [key, state] of this.windows.entries()) {
      if (state.expires_at <= nowMs) {
        this.windows.delete(key);
      }
    }
    this.lastPruneAt = nowMs;
    this.nextPruneSize = Math.max(PRUNE_SIZE_THRESHOLD, this.windows.size * 2);
  }

  /** 仅用于诊断与单测观测当前内存桶数量。 */
  get bucketCount(): number {
    return this.windows.size;
  }

  check(scope: RateLimitScope, identity: string, serverNow: Date): void {
    if (typeof identity !== "string" || identity.length === 0) {
      throw validationError("限流身份标识不能为空", { field: "identity" });
    }
    if (!(serverNow instanceof Date) || !Number.isFinite(serverNow.getTime())) {
      throw validationError("server_now 必须是有效时间", { field: "server_now" });
    }

    const nowMs = serverNow.getTime();
    if (
      nowMs - this.lastPruneAt >= ONE_MINUTE_MS
      || (this.windows.size >= this.nextPruneSize && nowMs - this.lastPruneAt >= PRUNE_COOLDOWN_MS)
    ) {
      this.pruneExpired(nowMs);
    }

    const config = RATE_LIMIT_DEFAULTS[scope];
    const windowStart =
      Math.floor(nowMs / config.window_ms) * config.window_ms;
    const key = `${scope}\u0000${identity}`;
    const previous = this.windows.get(key);
    const requestCount =
      previous?.window_start === windowStart ? previous.request_count + 1 : 1;
    this.windows.set(key, {
      window_start: windowStart,
      request_count: requestCount,
      expires_at: windowStart + config.window_ms,
    });

    if (requestCount > config.max_requests) {
      throw conflictError("RATE_LIMITED", "请求过于频繁");
    }
  }
}

export const defaultApiRateLimiter: RateLimiter = new InMemoryRateLimiter();
