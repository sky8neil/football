import { describe, expect, it } from "vitest";
import { getMyUnlocks } from "./unlocks.js";
import { InMemoryRateLimiter } from "./rate-limit.js";

describe("GET /v1/unlocks/me", () => {
  it("requires an authenticated user", async () => {
    await expect(
      Promise.resolve().then(() =>
        getMyUnlocks(
          { getUnlocks: async () => { throw new Error("must not call"); } },
          {
            authenticated_user_id: null,
            server_now: new Date("2026-08-11T00:00:00.000Z"),
            request_id: "request-unlocks-1",
          },
        ),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("returns default resources and unlock records in the success envelope", async () => {
    const data = {
      default_resources: ["avatar_frame", "profile_card", "share_card"],
      unlocked: [],
    };
    const query = {
      getUnlocks: async (userId: string) => {
        expect(userId).toBe("00000000-0000-4000-8000-000000000001");
        return data;
      },
    };

    await expect(
      getMyUnlocks(query, {
        authenticated_user_id: "00000000-0000-4000-8000-000000000001",
        server_now: new Date("2026-08-11T00:00:00.000Z"),
        request_id: "request-unlocks-2",
      }),
    ).resolves.toEqual({
      status: 200,
      body: { data, request_id: "request-unlocks-2" },
    });
  });
  it("limits authenticated unlock reads to 120 requests per minute", async () => {
    const getUnlocks = async () => ({
      default_resources: ["avatar_frame", "profile_card", "share_card"],
      unlocked: [],
    });
    const input = {
      authenticated_user_id: "00000000-0000-4000-8000-000000000001",
      request_id: "request-unlocks-rate-limit",
      server_now: new Date("2026-08-11T00:00:00.000Z"),
      rate_limiter: new InMemoryRateLimiter(),
    };

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await expect(getMyUnlocks({ getUnlocks }, input)).resolves.toBeDefined();
    }

    await expect(getMyUnlocks({ getUnlocks }, input)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });
});
