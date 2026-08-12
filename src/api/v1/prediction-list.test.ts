import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type {
  PredictionHistoryItem,
  PredictionHistoryQuery,
  PredictionHistoryResult,
} from "../../application/prediction-query.js";
import { getMyPredictions, validateMyPredictionsQuery } from "./predictions.js";
import { InMemoryRateLimiter } from "./rate-limit.js";

const ITEM: PredictionHistoryItem = {
  prediction_id: "00000000-0000-4000-8000-000000000020",
  match_id: "00000000-0000-4000-8000-000000000010",
  league_id: "premier_league",
  season_id: "2026_2027",
  round_id: "01",
  home_team_id: "00000000-0000-4000-8000-000000000011",
  away_team_id: "00000000-0000-4000-8000-000000000012",
  kickoff_at: "2026-08-08T14:00:00.000Z",
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

const RESULT: PredictionHistoryResult = {
  items: [ITEM],
  has_more: false,
  next_cursor: null,
};

const NOW = new Date("2026-08-11T00:00:00.000Z");

describe("GET /v1/predictions/me", () => {
  it("校验 season_id、limit、cursor，默认绑定 MVP 赛季", () => {
    expect(validateMyPredictionsQuery({})).toEqual({
      season_id: "2026_2027",
      limit: 20,
      cursor: null,
    });
    expect(validateMyPredictionsQuery({
      season_id: "2026_2027",
      limit: "2",
      cursor: "opaque",
    })).toEqual({
      season_id: "2026_2027",
      limit: 2,
      cursor: "opaque",
    });
    for (const query of [
      { season_id: "2025_2026" },
      { limit: "0" },
      { limit: "101" },
      { extra: "x" },
    ]) {
      expect(() => validateMyPredictionsQuery(query)).toThrowError(
        expect.objectContaining({ code: "VALIDATION_ERROR" }),
      );
    }
  });

  it("要求登录并返回分页成功 envelope", async () => {
    const list = async (
      userId: string,
      query: PredictionHistoryQuery,
    ): Promise<PredictionHistoryResult> => {
      expect(userId).toBe("00000000-0000-4000-8000-000000000001");
      expect(query).toEqual({ season_id: "2026_2027", limit: 20, cursor: null });
      return RESULT;
    };

    await expect(getMyPredictions({ listMyPredictions: list }, {
      authenticated_user_id: "00000000-0000-4000-8000-000000000001",
      query: {},
      server_now: NOW,
      request_id: "request-predictions-list-1",
    })).resolves.toEqual({
      status: 200,
      body: {
        data: { items: [ITEM], page: { next_cursor: null, has_more: false } },
        request_id: "request-predictions-list-1",
      },
    });

    await expect(getMyPredictions({ listMyPredictions: list }, {
      query: {},
      server_now: NOW,
      request_id: "request-predictions-list-2",
    })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("limits authenticated history reads to 120 requests per minute", async () => {
    const rateLimiter = new InMemoryRateLimiter();
    const input = {
      authenticated_user_id: "00000000-0000-4000-8000-000000000001",
      query: {},
      server_now: NOW,
      request_id: "request-predictions-list-rate-limit",
      rate_limiter: rateLimiter,
    } as never;

    const list = async (): Promise<PredictionHistoryResult> => RESULT;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await expect(getMyPredictions({ listMyPredictions: list }, input)).resolves.toBeDefined();
    }

    await expect(getMyPredictions({ listMyPredictions: list }, input)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("声明历史预测列表 OpenAPI contract", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
    expect(specification).toMatch(
      /  \/predictions\/me:\n    get:[\s\S]*?PredictionHistoryEnvelope/,
    );
    expect(specification).toMatch(
      /    PredictionHistoryData:[\s\S]*?required: \[items, page\]/,
    );
    expect(specification).toMatch(
      /  \/predictions\/me:\n    get:[\s\S]*?'429':[\s\S]*?RateLimited/,
    );
  });
});
