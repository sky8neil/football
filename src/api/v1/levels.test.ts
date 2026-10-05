import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "../../infrastructure/repositories.js";
import { LevelsQueryService } from "../../application/levels.js";
import { getMyLevels } from "./levels.js";
import { InMemoryRateLimiter } from "./rate-limit.js";
import { FIXED_CONFIG_V1 } from "../../domain/config.js";

describe("GET /v1/levels/me", () => {
  it("requires an authenticated user", async () => {
    await expect(
      Promise.resolve().then(() =>
        getMyLevels(new LevelsQueryService(new InMemoryRepository()), {
          authenticated_user_id: null,
          server_now: new Date("2026-08-09T00:00:00.000Z"),
          request_id: "request-levels-1",
        }),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("returns the defined success envelope", async () => {
    const data = {
      season: {
        level_season_id: "2026_2027",
        level: 4,
        best_level: 5,
        is_rated: true,
        valid_predictions: 20,
        remaining_to_rated: 0,
        is_frozen: false,
      },
      career: {
        level: 6,
        best_level: 6,
        is_rated: true,
        valid_predictions: 76,
        remaining_to_rated: 0,
        last_evaluated_at: "2026-08-03T02:00:00.000Z",
        next_evaluation_at: "2026-08-10T02:00:00.000Z",
        is_former_top: false,
      },
      rule_version: FIXED_CONFIG_V1.LEVEL_RULE_VERSION,
    };
    const query = {
      getLevels: async (userId: string) => {
        expect(userId).toBe("00000000-0000-4000-8000-000000000001");
        return data;
      },
    };

    await expect(
      getMyLevels(query, {
        authenticated_user_id: "00000000-0000-4000-8000-000000000001",
        server_now: new Date("2026-08-09T00:00:00.000Z"),
        request_id: "request-levels-2",
      }),
    ).resolves.toEqual({
      status: 200,
      body: { data, request_id: "request-levels-2" },
    });
  });

  it("limits authenticated reads to 120 requests per minute", async () => {
    const getLevels = async () => ({
      season: {
        level_season_id: "2026_2027",
        level: 1,
        best_level: 1,
        is_rated: false,
        valid_predictions: 0,
        remaining_to_rated: 20,
        is_frozen: false,
      },
      career: {
        level: 1,
        best_level: 1,
        is_rated: false,
        valid_predictions: 0,
        remaining_to_rated: 20,
        last_evaluated_at: null,
        next_evaluation_at: "2026-08-10T02:00:00.000Z",
        is_former_top: false,
      },
      rule_version: FIXED_CONFIG_V1.LEVEL_RULE_VERSION,
    });
    const input = {
      authenticated_user_id: "00000000-0000-4000-8000-000000000001",
      request_id: "request-levels-rate-limit",
      server_now: new Date("2026-08-09T00:00:00.000Z"),
      rate_limiter: new InMemoryRateLimiter(),
    };

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await expect(getMyLevels({ getLevels }, input)).resolves.toBeDefined();
    }

    await expect(
      Promise.resolve().then(() => getMyLevels({ getLevels }, input)),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});
