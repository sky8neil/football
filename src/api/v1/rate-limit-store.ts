/**
 * 共享限流存储 port 与 SharedRateLimiter。
 *
 * 生产多实例必须走同一 RateLimitStore，避免进程内 InMemoryRateLimiter
 * 按实例分片后合计超过 RATE_LIMIT_DEFAULTS。本文件只提供 port 与适配器，
 * 不改 RateLimiter 签名、额度、429/code 或 identity key 语义，也不接入 gateway。
 */
import { conflictError, validationError } from "../../domain/errors.js";
import {
  RATE_LIMIT_DEFAULTS,
  type RateLimiter,
  type RateLimitScope,
} from "./rate-limit.js";

/**
 * 共享限流计数存储。
 *
 * increment 必须在同一 key 上原子执行：
 *   若存储中该 key 的窗口 != windowStart 则重置计数为 1，否则 +1；
 *   返回当前窗口计数。
 *
 * 读-改-写必须原子。若两个实例同时观察到旧窗口并各自写成 1，
 * 窗口重置竞态会让实际请求数超过 max_requests（内存分片绕过）。
 *
 * key 语义沿用 InMemoryRateLimiter：`${scope}\u0000${identity}`（NUL 分隔）。
 */
export interface RateLimitStore {
  increment(key: string, windowStart: number, serverNow: Date): Promise<number>;
}

interface WindowState {
  window_start: number;
  count: number;
}

/**
 * 进程内 RateLimitStore，供本地测试与单实例使用。
 * 计数规则与 InMemoryRateLimiter 等价；无 await 间隙，单线程下读-改-写原子。
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, WindowState>();

  increment(key: string, windowStart: number, _serverNow: Date): Promise<number> {
    const previous = this.windows.get(key);
    const count = previous?.window_start === windowStart ? previous.count + 1 : 1;
    this.windows.set(key, {
      window_start: windowStart,
      count,
    });
    return Promise.resolve(count);
  }
}

export interface SharedRateLimiterOptions {
  /**
   * 可选：缓存每个 key 最近一次成功 increment 的 window_start。
   * 不替代 store.increment（计数仍以存储返回值为准），仅减少调用方对窗口状态的本地猜测。
   */
  cacheWindowStart?: boolean;
}

/**
 * 同一 RateLimiter port 的共享存储实现。
 *
 * check 校验、key、固定窗口计算、超限抛 conflictError("RATE_LIMITED", "请求过于频繁")
 * 均与 InMemoryRateLimiter 一致；每次 check 调用 store.increment，
 * 返回值 > max_requests 判定超限。
 *
 * increment 为异步，调用方必须 await check。生产 gateway 组装切换留给 B3 环境就绪后。
 */
export class SharedRateLimiter implements RateLimiter {
  private readonly store: RateLimitStore;
  private readonly windowStartCache: Map<string, number> | undefined;

  constructor(store: RateLimitStore, options?: SharedRateLimiterOptions) {
    this.store = store;
    this.windowStartCache = options?.cacheWindowStart === true ? new Map() : undefined;
  }

  async check(
    scope: RateLimitScope,
    identity: string,
    serverNow: Date,
  ): Promise<void> {
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
    const requestCount = await this.store.increment(key, windowStart, serverNow);
    if (this.windowStartCache !== undefined) {
      this.windowStartCache.set(key, windowStart);
    }

    if (requestCount > config.max_requests) {
      throw conflictError("RATE_LIMITED", "请求过于频繁");
    }
  }
}
