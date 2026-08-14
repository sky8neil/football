import { describe, expect, it } from "vitest";
import { DomainError } from "../../domain/errors.js";
import {
  CloudBaseRateLimitStore,
  loadCloudBaseRateLimitStoreConfig,
} from "./cloudbase-rate-limit-store.js";
import { RATE_LIMIT_DEFAULTS, type RateLimiter } from "./rate-limit.js";
import {
  InMemoryRateLimitStore,
  SharedRateLimiter,
  type RateLimitStore,
} from "./rate-limit-store.js";
import { mapErrorToHttp } from "./validation.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";
const FIRST_MINUTE = new Date("2026-08-11T00:00:00.000Z");
const NEXT_MINUTE = new Date(FIRST_MINUTE.getTime() + 60_000);
const MID_WINDOW = new Date(FIRST_MINUTE.getTime() + 30_000);

interface IncrementCall {
  key: string;
  windowStart: number;
  serverNow: Date;
  count: number;
}

class RecordingStore implements RateLimitStore {
  readonly calls: IncrementCall[] = [];
  private readonly inner = new InMemoryRateLimitStore();

  async increment(key: string, windowStart: number, serverNow: Date): Promise<number> {
    const count = await this.inner.increment(key, windowStart, serverNow);
    this.calls.push({ key, windowStart, serverNow, count });
    return count;
  }
}

function expectRateLimited(error: unknown): void {
  expect(error).toBeInstanceOf(DomainError);
  expect(error).toMatchObject({
    code: "RATE_LIMITED",
    message: "请求过于频繁",
  });
  expect(mapErrorToHttp(error, "request-rate-limited")).toMatchObject({
    status: 429,
    body: { code: "RATE_LIMITED", message: "请求过于频繁" },
  });
}

describe("SharedRateLimiter", () => {
  it("implements the existing RateLimiter port", () => {
    const limiter: RateLimiter = new SharedRateLimiter(new InMemoryRateLimitStore());
    expect(limiter).toBeInstanceOf(SharedRateLimiter);
  });

  it("increments the same key in the same window and rejects the overflow with RATE_LIMITED/429", async () => {
    const store = new RecordingStore();
    const limiter = new SharedRateLimiter(store);
    const max = RATE_LIMIT_DEFAULTS.predictions.max_requests;

    for (let attempt = 1; attempt <= max; attempt += 1) {
      await expect(limiter.check("predictions", USER_ID, FIRST_MINUTE)).resolves.toBeUndefined();
      expect(store.calls.at(-1)).toMatchObject({
        key: `predictions\u0000${USER_ID}`,
        count: attempt,
      });
    }

    let overflow: unknown;
    try {
      await limiter.check("predictions", USER_ID, FIRST_MINUTE);
    } catch (error) {
      overflow = error;
    }
    expectRateLimited(overflow);
    expect(store.calls).toHaveLength(max + 1);
    expect(store.calls.at(-1)?.count).toBe(max + 1);
  });

  it("lets the max_requests-th call through and rejects max_requests+1", async () => {
    const limiter = new SharedRateLimiter(new InMemoryRateLimitStore());
    const max = RATE_LIMIT_DEFAULTS.predictions.max_requests;

    for (let attempt = 0; attempt < max; attempt += 1) {
      await limiter.check("predictions", USER_ID, FIRST_MINUTE);
    }

    let overflow: unknown;
    try {
      await limiter.check("predictions", USER_ID, FIRST_MINUTE);
    } catch (error) {
      overflow = error;
    }
    expectRateLimited(overflow);
  });

  it("resets the count to 1 after windowStart changes", async () => {
    const store = new RecordingStore();
    const limiter = new SharedRateLimiter(store);
    const max = RATE_LIMIT_DEFAULTS.predictions.max_requests;

    for (let attempt = 0; attempt < max; attempt += 1) {
      await limiter.check("predictions", USER_ID, FIRST_MINUTE);
    }
    await expect(limiter.check("predictions", USER_ID, FIRST_MINUTE)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });

    await expect(limiter.check("predictions", USER_ID, MID_WINDOW)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });

    await expect(limiter.check("predictions", USER_ID, NEXT_MINUTE)).resolves.toBeUndefined();
    expect(store.calls.at(-1)).toEqual({
      key: `predictions\u0000${USER_ID}`,
      windowStart: NEXT_MINUTE.getTime(),
      serverNow: NEXT_MINUTE,
      count: 1,
    });

    for (let attempt = 1; attempt < max; attempt += 1) {
      await limiter.check("predictions", USER_ID, NEXT_MINUTE);
    }
    await expect(limiter.check("predictions", USER_ID, NEXT_MINUTE)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("shares counts across two SharedRateLimiter instances on the same store", async () => {
    const store = new InMemoryRateLimitStore();
    const instanceA = new SharedRateLimiter(store);
    const instanceB = new SharedRateLimiter(store);
    const max = RATE_LIMIT_DEFAULTS.predictions.max_requests;

    for (let attempt = 0; attempt < max; attempt += 1) {
      await instanceA.check("predictions", USER_ID, FIRST_MINUTE);
    }

    let overflow: unknown;
    try {
      await instanceB.check("predictions", USER_ID, FIRST_MINUTE);
    } catch (error) {
      overflow = error;
    }
    expectRateLimited(overflow);
  });

  it("rejects when two instances together exceed the window", async () => {
    const store = new InMemoryRateLimitStore();
    const instanceA = new SharedRateLimiter(store);
    const instanceB = new SharedRateLimiter(store);
    const max = RATE_LIMIT_DEFAULTS.predictions.max_requests;
    const half = Math.floor(max / 2);

    for (let attempt = 0; attempt < half; attempt += 1) {
      await instanceA.check("predictions", USER_ID, FIRST_MINUTE);
    }
    for (let attempt = 0; attempt < max - half; attempt += 1) {
      await instanceB.check("predictions", USER_ID, FIRST_MINUTE);
    }

    let overflow: unknown;
    try {
      await instanceB.check("predictions", USER_ID, FIRST_MINUTE);
    } catch (error) {
      overflow = error;
    }
    expectRateLimited(overflow);
  });

  it("keeps concurrent increments atomic so two instances cannot bypass the cap", async () => {
    const store = new InMemoryRateLimitStore();
    const instanceA = new SharedRateLimiter(store);
    const instanceB = new SharedRateLimiter(store);
    const max = RATE_LIMIT_DEFAULTS.predictions.max_requests;

    const results = await Promise.allSettled([
      ...Array.from({ length: 6 }, () => instanceA.check("predictions", USER_ID, FIRST_MINUTE)),
      ...Array.from({ length: 6 }, () => instanceB.check("predictions", USER_ID, FIRST_MINUTE)),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(max);
    expect(rejected).toHaveLength(12 - max);
    for (const result of rejected) {
      expectRateLimited(result.reason);
    }
  });

  it("isolates different identities", async () => {
    const limiter = new SharedRateLimiter(new InMemoryRateLimitStore());
    const max = RATE_LIMIT_DEFAULTS.predictions.max_requests;

    for (let attempt = 0; attempt < max; attempt += 1) {
      await limiter.check("predictions", USER_ID, FIRST_MINUTE);
    }

    await expect(
      limiter.check("predictions", OTHER_USER_ID, FIRST_MINUTE),
    ).resolves.toBeUndefined();
    await expect(limiter.check("predictions", USER_ID, FIRST_MINUTE)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("isolates different scopes in the key", async () => {
    const store = new RecordingStore();
    const limiter = new SharedRateLimiter(store);
    const predictionMax = RATE_LIMIT_DEFAULTS.predictions.max_requests;

    for (let attempt = 0; attempt < predictionMax; attempt += 1) {
      await limiter.check("predictions", USER_ID, FIRST_MINUTE);
    }

    await expect(
      limiter.check("authenticated_reads", USER_ID, FIRST_MINUTE),
    ).resolves.toBeUndefined();
    await expect(limiter.check("predictions", USER_ID, FIRST_MINUTE)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });

    expect(store.calls.some((call) => call.key === `predictions\u0000${USER_ID}`)).toBe(true);
    expect(store.calls.some((call) => call.key === `authenticated_reads\u0000${USER_ID}`)).toBe(
      true,
    );
  });

  it("uses RATE_LIMIT_DEFAULTS for a non-prediction scope", async () => {
    const limiter = new SharedRateLimiter(new InMemoryRateLimitStore());
    const max = RATE_LIMIT_DEFAULTS.profile_patch.max_requests;

    for (let attempt = 0; attempt < max; attempt += 1) {
      await limiter.check("profile_patch", USER_ID, FIRST_MINUTE);
    }

    let overflow: unknown;
    try {
      await limiter.check("profile_patch", USER_ID, FIRST_MINUTE);
    } catch (error) {
      overflow = error;
    }
    expectRateLimited(overflow);
  });

  it("rejects an empty identity with the same validationError as InMemoryRateLimiter", async () => {
    const store = new RecordingStore();
    const limiter = new SharedRateLimiter(store);

    await expect(limiter.check("predictions", "", FIRST_MINUTE)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "限流身份标识不能为空",
      details: { field: "identity" },
    });
    await expect(
      limiter.check("predictions", null as unknown as string, FIRST_MINUTE),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "identity" },
    });
    expect(store.calls).toEqual([]);
  });

  it("rejects an invalid serverNow with the same validationError as InMemoryRateLimiter", async () => {
    const store = new RecordingStore();
    const limiter = new SharedRateLimiter(store);

    await expect(
      limiter.check("predictions", USER_ID, new Date("invalid")),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "server_now 必须是有效时间",
      details: { field: "server_now" },
    });
    expect(store.calls).toEqual([]);

    for (let attempt = 0; attempt < RATE_LIMIT_DEFAULTS.predictions.max_requests; attempt += 1) {
      await limiter.check("predictions", USER_ID, FIRST_MINUTE);
    }
    await expect(limiter.check("predictions", USER_ID, FIRST_MINUTE)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("forwards the same serverNow instance to store.increment", async () => {
    const store = new RecordingStore();
    const limiter = new SharedRateLimiter(store);

    await limiter.check("predictions", USER_ID, FIRST_MINUTE);
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]?.serverNow).toBe(FIRST_MINUTE);
    expect(store.calls[0]?.windowStart).toBe(
      Math.floor(FIRST_MINUTE.getTime() / RATE_LIMIT_DEFAULTS.predictions.window_ms) *
        RATE_LIMIT_DEFAULTS.predictions.window_ms,
    );
  });
});

describe("CloudBaseRateLimitStore skeleton", () => {
  it("reads only the named CloudBase config keys from the injected env map", () => {
    const config = loadCloudBaseRateLimitStoreConfig({
      FOOTBALL_CLOUD_ENVIRONMENT_ID: " cloud-test ",
      FOOTBALL_RESOURCE_NAMESPACE: " football-test ",
      FOOTBALL_SOME_SECRET: "must-not-be-read",
    });
    expect(config).toEqual({
      cloud_environment_id: "cloud-test",
      resource_namespace: "football-test",
    });
  });

  it("fails closed on missing CloudBase keys without echoing secrets", () => {
    const distinctive = "must-not-appear-in-error";
    expect(() =>
      loadCloudBaseRateLimitStoreConfig({
        FOOTBALL_RESOURCE_NAMESPACE: "football-test",
      }),
    ).toThrow("FOOTBALL_CLOUD_ENVIRONMENT_ID is required");
    expect(() =>
      loadCloudBaseRateLimitStoreConfig({
        FOOTBALL_CLOUD_ENVIRONMENT_ID: "cloud-test",
      }),
    ).toThrow("FOOTBALL_RESOURCE_NAMESPACE is required");

    try {
      loadCloudBaseRateLimitStoreConfig({
        FOOTBALL_CLOUD_ENVIRONMENT_ID: "   ",
        FOOTBALL_RESOURCE_NAMESPACE: distinctive,
      });
      throw new Error("expected Fail Closed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe("FOOTBALL_CLOUD_ENVIRONMENT_ID is required");
      expect(message).not.toContain(distinctive);
    }
  });

  it("increments through an injected fake database and stays unwired without one", async () => {
    const config = loadCloudBaseRateLimitStoreConfig({
      FOOTBALL_CLOUD_ENVIRONMENT_ID: "cloud-test",
      FOOTBALL_RESOURCE_NAMESPACE: "football-test",
    });
    const unwired = new CloudBaseRateLimitStore(config);
    expect(unwired.collectionName).toBe("football-test_rate_limits");
    await expect(unwired.increment("predictions\u0000user", 1, FIRST_MINUTE)).rejects.toThrow(
      /待真环境集成验证/,
    );

    const fake = new InMemoryRateLimitStore();
    const wired = new CloudBaseRateLimitStore(config, {
      incrementInWindow: (key, windowStart, serverNow) =>
        fake.increment(key, windowStart, serverNow),
    });
    const limiter = new SharedRateLimiter(wired);
    await limiter.check("predictions", USER_ID, FIRST_MINUTE);
    await expect(limiter.check("predictions", USER_ID, FIRST_MINUTE)).resolves.toBeUndefined();
  });
});
