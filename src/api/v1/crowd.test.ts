import { describe, expect, it, vi } from "vitest";
import { getMatchCrowd } from "./crowd.js";
import { InMemoryRateLimiter } from "./rate-limit.js";
import { readFile } from "node:fs/promises";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const MATCH_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const crowdData = {
  match_id: MATCH_ID,
  status: "available" as const,
  distribution: { home: 45, draw: 25, away: 30 },
  granularity: 5,
  min_predictions: 20,
};

describe("GET /v1/matches/:match_id/crowd", () => {
  it("requires identity before dispatching the query service", async () => {
    const get = vi.fn(async () => crowdData);
    await expect(getMatchCrowd({ get }, {
      match_id: MATCH_ID,
      query: {},
      server_now: NOW,
      request_id: "crowd-auth",
    })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(get).not.toHaveBeenCalled();
  });

  it("validates match id and rejects all query fields", async () => {
    const get = vi.fn(async () => crowdData);
    const base = {
      authenticated_user_id: USER_ID,
      query: {},
      server_now: NOW,
      request_id: "crowd-validation",
    };
    await expect(getMatchCrowd({ get }, { ...base, match_id: "bad" }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(getMatchCrowd({ get }, {
      ...base,
      match_id: MATCH_ID,
      query: { extra: "x" },
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(get).not.toHaveBeenCalled();
  });

  it("returns the documented success envelope", async () => {
    const get = vi.fn(async () => crowdData);
    await expect(getMatchCrowd({ get }, {
      authenticated_user_id: USER_ID,
      match_id: MATCH_ID,
      query: {},
      server_now: NOW,
      request_id: "crowd-success",
    })).resolves.toEqual({
      status: 200,
      body: { data: crowdData, request_id: "crowd-success" },
    });
    expect(get).toHaveBeenCalledWith({
      authenticated_user_id: USER_ID,
      match_id: MATCH_ID,
      server_now: NOW,
    });
  });

  it("limits authenticated reads at the configured 120 requests per minute", async () => {
    const get = vi.fn(async () => crowdData);
    const rateLimiter = new InMemoryRateLimiter();
    const input = {
      authenticated_user_id: USER_ID,
      match_id: MATCH_ID,
      query: {},
      server_now: NOW,
      request_id: "crowd-rate-limit",
      rate_limiter: rateLimiter,
    };

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await getMatchCrowd({ get }, input);
    }
    await expect(getMatchCrowd({ get }, input)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(get).toHaveBeenCalledTimes(120);
  });

  it("documents authentication, error responses, statuses, and response fields", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
    expect(specification).toMatch(/\/matches\/\{match_id\}\/crowd:\s+get:/);
    expect(specification).toMatch(/  \/matches\/\{match_id\}\/crowd:\n    get:[\s\S]*?x-requires-trusted-openid: true/);
    expect(specification).toMatch(/CrowdData:[\s\S]*?enum: \[not_closed, insufficient, available, unavailable\]/);
    expect(specification).toMatch(/CrowdData:[\s\S]*?required: \[match_id, status, distribution, granularity, min_predictions\]/);
    expect(specification).toMatch(/  \/matches\/\{match_id\}\/crowd:[\s\S]*?'401':[\s\S]*?'404':[\s\S]*?'409':[\s\S]*?'422':[\s\S]*?'429':/);
  });
});
