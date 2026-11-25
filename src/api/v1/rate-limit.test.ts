import { describe, expect, it, vi } from "vitest";
import {
  IN_MEMORY_RATE_LIMIT_MAX_BUCKETS,
  InMemoryRateLimiter,
  RATE_LIMIT_DEFAULTS,
} from "./rate-limit.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";
const FIRST_MINUTE = new Date("2026-08-11T00:00:00.000Z");

describe("API rate limit middleware", () => {
  it("exposes the frozen defaults and rejects the 11th prediction request", () => {
    expect(RATE_LIMIT_DEFAULTS.predictions).toEqual({
      max_requests: 10,
      window_ms: 60_000,
    });

    const limiter = new InMemoryRateLimiter();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(() => limiter.check("predictions", USER_ID, FIRST_MINUTE)).not.toThrow();
    }

    expect(() => limiter.check("predictions", USER_ID, FIRST_MINUTE)).toThrowError(
      expect.objectContaining({ code: "RATE_LIMITED" }),
    );
  });

  it("isolates users and resets at the next minute", () => {
    const limiter = new InMemoryRateLimiter();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      limiter.check("predictions", USER_ID, FIRST_MINUTE);
    }

    expect(() => limiter.check("predictions", OTHER_USER_ID, FIRST_MINUTE)).not.toThrow();
    expect(() => limiter.check(
      "predictions",
      USER_ID,
      new Date(FIRST_MINUTE.getTime() + 60_000),
    )).not.toThrow();
  });

  it("rejects an invalid server time before changing the bucket", () => {
    const limiter = new InMemoryRateLimiter();
    expect(() => limiter.check("predictions", USER_ID, new Date("invalid"))).toThrowError(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
    for (let attempt = 0; attempt < 10; attempt += 1) {
      limiter.check("predictions", USER_ID, FIRST_MINUTE);
    }
    expect(() => limiter.check("predictions", USER_ID, FIRST_MINUTE)).toThrowError(
      expect.objectContaining({ code: "RATE_LIMITED" }),
    );
  });

  it("prunes expired buckets over time so long-running memory usage stays bounded", () => {
    const limiter = new InMemoryRateLimiter();
    for (let i = 0; i < 1200; i += 1) {
      limiter.check("public_reads", `ip:10.0.${Math.floor(i / 256)}.${i % 256}`, FIRST_MINUTE);
    }
    expect(limiter.bucketCount).toBe(1200);

    const nextMinute = new Date(FIRST_MINUTE.getTime() + 60_000);
    limiter.check("public_reads", "ip:10.1.0.1", nextMinute);
    expect(limiter.bucketCount).toBe(1);
  });

  it("[Slice 3.4] 同一分钟 2,000 个活跃 key 后连续 200 次请求不会每次全表 prune", () => {
    const limiter = new InMemoryRateLimiter();
    const prune = vi.spyOn(
      limiter as unknown as { pruneExpired(nowMs: number): void },
      "pruneExpired",
    );
    for (let i = 0; i < 2000; i += 1) {
      limiter.check("public_reads", `ip:10.2.${Math.floor(i / 256)}.${i % 256}`, FIRST_MINUTE);
    }
    prune.mockClear();

    for (let i = 0; i < 200; i += 1) {
      limiter.check("public_reads", `ip:10.3.0.${i}`, FIRST_MINUTE);
    }
    expect(prune.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("rejects a new identity once the in-memory map reaches its capacity", () => {
    const limiter = new InMemoryRateLimiter();
    for (let i = 0; i < IN_MEMORY_RATE_LIMIT_MAX_BUCKETS; i += 1) {
      limiter.check("public_reads", `ip:cap-${i}`, FIRST_MINUTE);
    }
    expect(limiter.bucketCount).toBe(IN_MEMORY_RATE_LIMIT_MAX_BUCKETS);

    expect(() => limiter.check("public_reads", "ip:overflow", FIRST_MINUTE)).toThrowError(
      expect.objectContaining({ code: "RATE_LIMITED" }),
    );
    expect(limiter.bucketCount).toBe(IN_MEMORY_RATE_LIMIT_MAX_BUCKETS);
    expect(() => limiter.check("public_reads", "ip:cap-0", FIRST_MINUTE)).not.toThrow();

    const nextMinute = new Date(FIRST_MINUTE.getTime() + 60_000);
    expect(() => limiter.check("public_reads", "ip:after-prune", nextMinute)).not.toThrow();
    expect(limiter.bucketCount).toBe(1);
  });

  it("[CR-03] prunes expired buckets before throwing 429 even within prune cooldown", () => {
    const limiter = new InMemoryRateLimiter();
    // Populate 4096 keys at t=0, trigger a prune at t=59_000 so lastPruneAt is recent
    // and nextPruneSize is clamped to IN_MEMORY_RATE_LIMIT_MAX_BUCKETS (8192).
    for (let i = 0; i < 4096; i += 1) {
      limiter.check("public_reads", `ip:pre-${i}`, FIRST_MINUTE);
    }
    const nearEnd = new Date(FIRST_MINUTE.getTime() + 59_000);
    for (let i = 0; i < 4096; i += 1) {
      limiter.check("public_reads", `ip:late-${i}`, nearEnd);
    }
    expect(limiter.bucketCount).toBe(IN_MEMORY_RATE_LIMIT_MAX_BUCKETS);

    // At t=60_000 (1s after t=59_000, < PRUNE_COOLDOWN_MS), all 8192 buckets are expired.
    const nextMinute = new Date(FIRST_MINUTE.getTime() + 60_000);
    expect(() => limiter.check("public_reads", "ip:fresh-user", nextMinute)).not.toThrow();
    expect(limiter.bucketCount).toBe(1);
  });

  it("keeps wechat login on its own 10/min bucket", () => {
    expect(RATE_LIMIT_DEFAULTS.wechat_login).toEqual({
      max_requests: 10,
      window_ms: 60_000,
    });
    const limiter = new InMemoryRateLimiter();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(() => limiter.check("wechat_login", "ip:203.0.113.9", FIRST_MINUTE)).not.toThrow();
    }
    expect(() => limiter.check("wechat_login", "ip:203.0.113.9", FIRST_MINUTE)).toThrowError(
      expect.objectContaining({ code: "RATE_LIMITED" }),
    );
    expect(() => limiter.check("public_reads", "ip:203.0.113.9", FIRST_MINUTE)).not.toThrow();
  });
});
