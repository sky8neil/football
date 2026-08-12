import { describe, expect, it, vi } from "vitest";
import type { SubmitPredictionResult } from "../../application/predictions.js";
import { newUuid } from "../../domain/ids.js";
import {
  postPrediction,
  validatePredictionBody,
} from "./predictions.js";
import { InMemoryRateLimiter } from "./rate-limit.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const MATCH_ID = "00000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-08-08T12:00:00.000Z");

function predictionResult(created: boolean): SubmitPredictionResult {
  return {
    created,
    prediction: {
      schema_version: 1,
      prediction_id: "00000000-0000-4000-8000-000000000003",
      user_id: USER_ID,
      match_id: MATCH_ID,
      idempotency_key: newUuid(),
      pred_home_score: 2,
      pred_away_score: 1,
      derived_result: "HOME",
      submitted_at: NOW,
      scoring_rule_version: "scoring_v1",
      match_score: null,
      wdl_hit: null,
      exact_hit: null,
      applied_result_version: 0,
      created_at: NOW,
      updated_at: NOW,
    },
  };
}

function makeCommand(result: SubmitPredictionResult) {
  return {
    submit: vi.fn(async (
      userId: string,
      body: Record<string, unknown>,
      serverNow: Date,
    ) => {
      expect(userId).toBe(USER_ID);
      expect(body).toEqual({
        idempotency_key: expect.any(String),
        match_id: MATCH_ID,
        home_score: 2,
        away_score: 1,
      });
      expect(serverNow).toBe(NOW);
      return result;
    }),
  };
}

function body() {
  return {
    idempotency_key: newUuid(),
    match_id: MATCH_ID,
    home_score: 2,
    away_score: 1,
  };
}

describe("POST /v1/predictions", () => {
  it("首次提交返回 201 和规范定义的有限 data", async () => {
    const command = makeCommand(predictionResult(true));

    const response = await postPrediction(command, {
      authenticated_user_id: USER_ID,
      body: body(),
      server_now: NOW,
      request_id: "request-prediction-1",
    });

    expect(response).toEqual({
      status: 201,
      body: {
        data: {
          prediction_id: "00000000-0000-4000-8000-000000000003",
          match_id: MATCH_ID,
          pred_home_score: 2,
          pred_away_score: 1,
          derived_result: "HOME",
          submitted_at: "2026-08-08T12:00:00.000Z",
          scoring_rule_version: "scoring_v1",
        },
        request_id: "request-prediction-1",
      },
    });
    expect(response.body.data).not.toHaveProperty("user_id");
    expect(response.body.data).not.toHaveProperty("idempotency_key");
  });

  it("同幂等请求成功重放返回 200", async () => {
    const command = makeCommand(predictionResult(false));

    const response = await postPrediction(command, {
      authenticated_user_id: USER_ID,
      body: body(),
      server_now: NOW,
      request_id: "request-prediction-2",
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      prediction_id: "00000000-0000-4000-8000-000000000003",
      match_id: MATCH_ID,
      submitted_at: "2026-08-08T12:00:00.000Z",
    });
  });

  it("拒绝缺失可信身份（401 UNAUTHORIZED）和未知 body 字段", async () => {
    const command = { submit: vi.fn() };

    await expect(
      postPrediction(command, {
        authenticated_user_id: null,
        body: body(),
        server_now: NOW,
        request_id: "request-prediction-3",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(command.submit).not.toHaveBeenCalled();

    expect(() => validatePredictionBody({ ...body(), derived_result: "HOME" }))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });

  it("在调用 application service 前执行每用户每分钟 10 次限流", async () => {
    const command = makeCommand(predictionResult(true));
    const rateLimiter = new InMemoryRateLimiter();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(postPrediction(command, {
        authenticated_user_id: USER_ID,
        body: body(),
        server_now: NOW,
        request_id: `request-prediction-rate-${attempt}`,
        rate_limiter: rateLimiter,
      })).resolves.toBeDefined();
    }

    await expect(postPrediction(command, {
      authenticated_user_id: USER_ID,
      body: body(),
      server_now: NOW,
      request_id: "request-prediction-rate-10",
      rate_limiter: rateLimiter,
    })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(command.submit).toHaveBeenCalledTimes(10);
  });
});
