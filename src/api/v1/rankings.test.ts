import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type {
  RankingQuery,
  RankingQueryResult,
} from "../../application/ranking-query.js";
import { getRankings, validateRankingsQuery } from "./rankings.js";
import { InMemoryRateLimiter } from "./rate-limit.js";

const data: RankingQueryResult = {
  items: [],
  has_more: false,
  next_cursor: null,
};

describe("GET /v1/rankings", () => {
  it("校验 required period_type、可选周期和公共分页参数", () => {
    expect(validateRankingsQuery({ period_type: "week" })).toEqual({
      period_type: "week",
      period_key: null,
      limit: 20,
      cursor: null,
    });
    expect(validateRankingsQuery({
      period_type: "month",
      period_key: "2026-08",
      limit: "2",
      cursor: "opaque",
    })).toEqual({
      period_type: "month",
      period_key: "2026-08",
      limit: 2,
      cursor: "opaque",
    });

    for (const query of [
      {},
      { period_type: "year" },
      { period_type: "week", period_key: "2026-08" },
      { period_type: "week", limit: "0" },
      { period_type: "week", limit: "101" },
      { period_type: "week", extra: "x" },
    ]) {
      expect(() => validateRankingsQuery(query)).toThrowError(
        expect.objectContaining({ code: "VALIDATION_ERROR" }),
      );
    }
  });

  it("返回规范分页成功 envelope", async () => {
    const list = async (query: RankingQuery): Promise<RankingQueryResult> => {
      expect(query).toEqual({
        period_type: "week",
        period_key: null,
        limit: 20,
        cursor: null,
        server_now: new Date("2026-08-09T12:00:00.000Z"),
      });
      return data;
    };

    await expect(getRankings({ list }, {
      authenticated_user_id: null,
      public_source: "gateway-source-1",
      query: { period_type: "week" },
      server_now: new Date("2026-08-09T12:00:00.000Z"),
      request_id: "request-rankings-1",
    })).resolves.toEqual({
      status: 200,
      body: {
        data: {
          items: data.items,
          page: {
            next_cursor: data.next_cursor,
            has_more: data.has_more,
          },
        },
        request_id: "request-rankings-1",
      },
    });
  });

  it("按可信公开来源限制排行榜读取为每分钟 120 次", async () => {
    const list = async (): Promise<RankingQueryResult> => data;
    const rateLimiter = new InMemoryRateLimiter();
    const input = {
      public_source: "gateway-source-1",
      rate_limiter: rateLimiter,
      query: { period_type: "week" },
      server_now: new Date("2026-08-09T12:00:00.000Z"),
      request_id: "request-rankings-rate-limit",
    };

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await expect(getRankings({ list }, input)).resolves.toBeDefined();
    }

    await expect(getRankings({ list }, input)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("缺少可信公开来源标识时 Fail Closed 且不查询排行榜", async () => {
    const list = vi.fn(async (): Promise<RankingQueryResult> => data);

    await expect(getRankings({ list }, {
      query: { period_type: "week" },
      server_now: new Date("2026-08-09T12:00:00.000Z"),
      request_id: "request-rankings-missing-source",
    } as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(list).not.toHaveBeenCalled();
  });

  it("声明排行榜路径与响应 contract", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");

    expect(specification).toMatch(
      /  \/rankings:\n    get:[\s\S]*?RankingEnvelope/,
    );
    expect(specification).toMatch(
      /    RankingItem:[\s\S]*?required: \[global_rank, user_id,[\s\S]*?last_scoring_match_at\]/,
    );
    expect(specification).toMatch(
      /  \/rankings:\n    get:[\s\S]*?'429':[\s\S]*?RateLimited/,
    );
  });
});
