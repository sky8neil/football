import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "../../infrastructure/repositories.js";
import { LevelsQueryService } from "../../application/levels.js";
import { getMyLevels } from "./levels.js";
import { InMemoryRateLimiter } from "./rate-limit.js";

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
        season_id: "2026_2027",
        valid_predictions: 20,
        wdl_hits: 12,
        wdl_accuracy_percent: "60.0",
        level: 4,
        best_level: 5,
      },
      career: {
        valid_predictions: 76,
        wdl_hits: 46,
        wdl_accuracy_percent: "60.5",
        level: 6,
        best_level: 7,
      },
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
        season_id: "2026_2027",
        valid_predictions: 0,
        wdl_hits: 0,
        wdl_accuracy_percent: "0.0",
        level: 1,
        best_level: 1,
      },
      career: {
        valid_predictions: 0,
        wdl_hits: 0,
        wdl_accuracy_percent: "0.0",
        level: 1,
        best_level: 1,
      },
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
