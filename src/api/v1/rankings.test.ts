import { describe, expect, it, vi } from "vitest";
import type { RankingQuery, RankingQueryResult } from "../../application/ranking-query.js";
import { getRankings, validateRankingsQuery } from "./rankings.js";
import { InMemoryRateLimiter } from "./rate-limit.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const PAGE_RESULT: RankingQueryResult = {
  board: "week" as const,
  scope: "global" as const,
  period_key: "2026-W32",
  updated_at: NOW.toISOString(),
  items: [{ rank: 1, user_id: "u1", display_name: "Sky", favorite_team_id: null, career_level: 1, period_score: 20, valid_predictions: 5, exact_hits: 1, last_scoring_match_at: NOW.toISOString() }],
  has_more: false,
  next_cursor: null,
  me: { status: "ranked" as const, rank: 1, top_percent: null },
};

describe("GET /v1/rankings v2", () => {
  it("要求合法 board，校验 period_key、scope 和 group_id 组合", () => {
    expect(validateRankingsQuery({ board: "week" })).toEqual({
      board: "week", period_key: null, scope: "global", group_id: null, limit: 20, cursor: null,
    });
    for (const query of [
      {},
      { board: "month" },
      { board: "other" },
      { board: "career", period_key: "2026-W32" },
      { board: "career", period_key: null },
      { board: "week", period_key: null },
      { board: "week", period_key: "2026-08" },
      { board: "week", scope: "group" },
      { board: "week", group_id: "00000000-0000-4000-8000-000000000001" },
      { board: "week", scope: "group", group_id: "bad" },
      { board: "week", limit: "0" },
      { board: "week", extra: "x" },
    ]) {
      expect(() => validateRankingsQuery(query)).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    }
  });

  it("映射 v2 envelope，并按登录态选择读取限流 scope", async () => {
    const list = vi.fn(async (query: RankingQuery): Promise<RankingQueryResult> => ({ ...PAGE_RESULT, board: query.board, scope: query.scope }));
    const limiter = { check: vi.fn() };
    const response = await getRankings({ list }, {
      authenticated_user_id: "user-id", public_source: "source", query: { board: "week" },
      server_now: NOW, request_id: "request-1", rate_limiter: limiter,
    });
    expect(response).toEqual({ status: 200, body: { data: {
      board: "week", scope: "global", period_key: "2026-W32", updated_at: NOW.toISOString(),
      items: PAGE_RESULT.items, page: { next_cursor: null, has_more: false }, me: PAGE_RESULT.me,
    }, request_id: "request-1" } });
    expect(list).toHaveBeenCalledWith({
      board: "week", period_key: null, scope: "global", group_id: null, limit: 20, cursor: null,
      server_now: NOW, authenticated_user_id: "user-id",
    });
    expect(limiter.check).toHaveBeenCalledWith("authenticated_reads", "user-id", NOW);
  });

  it("未登录走 public_reads，登录请求不要求 public_source", async () => {
    const list = vi.fn(async () => PAGE_RESULT);
    const limiter = { check: vi.fn() };
    await getRankings({ list }, {
      public_source: "source", query: { board: "week" }, server_now: NOW,
      request_id: "request-2", rate_limiter: limiter,
    });
    expect(limiter.check).toHaveBeenCalledWith("public_reads", "source", NOW);
    await expect(getRankings({ list }, {
      authenticated_user_id: "user-id", query: { board: "week" }, server_now: NOW,
      request_id: "request-3", rate_limiter: limiter,
    })).resolves.toBeDefined();
  });

  it("超出公开读取限流后返回 RATE_LIMITED", async () => {
    const list = async () => PAGE_RESULT;
    const rateLimiter = new InMemoryRateLimiter();
    const input = { public_source: "source", query: { board: "week" }, server_now: NOW, request_id: "rate" , rate_limiter: rateLimiter };
    for (let index = 0; index < 120; index += 1) await getRankings({ list }, input);
    await expect(getRankings({ list }, input)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});
