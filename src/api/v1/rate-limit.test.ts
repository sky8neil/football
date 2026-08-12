import { describe, expect, it } from "vitest";
import {
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
});
