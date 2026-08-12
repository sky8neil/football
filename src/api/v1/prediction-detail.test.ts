import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { PredictionDetailData } from "../../application/prediction-query.js";
import { getMyPrediction } from "./predictions.js";
import { InMemoryRateLimiter } from "./rate-limit.js";

const PREDICTION_ID = "00000000-0000-4000-8000-000000000020";

const data: PredictionDetailData = {
  prediction_id: PREDICTION_ID,
  match_id: "00000000-0000-4000-8000-000000000010",
  pred_home_score: 2,
  pred_away_score: 1,
  derived_result: "HOME",
  submitted_at: "2026-08-08T12:00:00.000Z",
  scoring_rule_version: "scoring_v1",
  match_status: "finished",
  regular_home_score: 2,
  regular_away_score: 1,
  match_score: 12,
  wdl_hit: true,
  exact_hit: true,
};

describe("GET /v1/predictions/me/:prediction_id", () => {
  it("returns a success envelope for the authenticated user's prediction", async () => {
    const response = await getMyPrediction(
      { getMyPrediction: async () => data },
      {
        authenticated_user_id: "00000000-0000-4000-8000-000000000001",
        prediction_id: PREDICTION_ID,
        server_now: new Date("2026-08-11T00:00:00.000Z"),
        request_id: "request-prediction-detail-1",
      },
    );

    expect(response).toEqual({
      status: 200,
      body: { data, request_id: "request-prediction-detail-1" },
    });
  });

  it("requires authentication and validates the path id", async () => {
    const service = { getMyPrediction: async () => data };

    await expect(
      getMyPrediction(service, {
        prediction_id: PREDICTION_ID,
        server_now: new Date("2026-08-11T00:00:00.000Z"),
        request_id: "request-prediction-detail-2",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      getMyPrediction(service, {
        authenticated_user_id: "00000000-0000-4000-8000-000000000001",
        prediction_id: "bad-id",
        server_now: new Date("2026-08-11T00:00:00.000Z"),
        request_id: "request-prediction-detail-3",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("limits authenticated detail reads to 120 requests per minute", async () => {
    const rateLimiter = new InMemoryRateLimiter();
    const input = {
      authenticated_user_id: "00000000-0000-4000-8000-000000000001",
      prediction_id: PREDICTION_ID,
      server_now: new Date("2026-08-11T00:00:00.000Z"),
      request_id: "request-prediction-detail-rate-limit",
      rate_limiter: rateLimiter,
    } as never;
    const service = { getMyPrediction: async () => data };

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await expect(getMyPrediction(service, input)).resolves.toBeDefined();
    }

    await expect(getMyPrediction(service, input)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("declares the detail path and response in OpenAPI", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");

    expect(specification).toMatch(
      /  \/predictions\/me\/\{prediction_id\}:\n    get:[\s\S]*?PredictionDetailEnvelope/,
    );
    expect(specification).toMatch(
      /  \/predictions\/me\/\{prediction_id\}:[\s\S]*?'429':[\s\S]*?RateLimited/,
    );
    expect(specification).toMatch(
      /    PredictionDetailData:[\s\S]*?required: \[prediction_id,[\s\S]*?exact_hit\]/,
    );
  });
});
