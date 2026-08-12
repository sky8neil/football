import { describe, expect, it, vi } from "vitest";
import { MatchQueryService } from "../../application/match-query.js";
import { InMemoryRepository } from "../../infrastructure/repositories.js";
import { getMatch, getMatches, validateMatchesQuery } from "./matches.js";
import { InMemoryRateLimiter } from "./rate-limit.js";
import { readFile } from "node:fs/promises";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const FROM = "2026-08-09T00:00:00.000Z";
const TO = "2026-08-10T00:00:00.000Z";

describe("GET /v1/matches", () => {
  it("parses UTC date filters, status, limit, and cursor", () => {
    expect(validateMatchesQuery({
      from: FROM,
      to: TO,
      status: "scheduled",
      limit: "2",
      cursor: "opaque",
    })).toEqual({
      from: new Date(FROM),
      to: new Date(TO),
      status: "scheduled",
      limit: 2,
      cursor: "opaque",
    });
    expect(validateMatchesQuery({})).toEqual({
      from: null,
      to: null,
      status: null,
      limit: 20,
      cursor: null,
    });
  });

  it("rejects non-UTC dates, invalid status/range values, and unknown parameters", () => {
    for (const query of [
      { from: "2026-08-09" },
      { from: "2026-08-09T00:00:00+08:00" },
      { to: "not-a-date" },
      { status: "pending" },
      { limit: "0" },
      { limit: "101" },
      { extra: "x" },
    ]) {
      expect(() => validateMatchesQuery(query)).toThrowError(
        expect.objectContaining({ code: "VALIDATION_ERROR" }),
      );
    }
  });

  it("returns a paginated success envelope", async () => {
    const response = await getMatches(new MatchQueryService(new InMemoryRepository(), "secret"), {
      public_source: "gateway-source-1",
      query: { from: FROM, to: TO, limit: "2" },
      server_now: NOW,
      authenticated_user_id: null,
      request_id: "request-matches-1",
    });

    expect(response).toEqual({
      status: 200,
      body: {
        data: { items: [], page: { next_cursor: null, has_more: false } },
        request_id: "request-matches-1",
      },
    });
  });

  it("按网关来源限制公开比赛列表每分钟 120 次", async () => {
    const list = vi.fn(async () => ({
      items: [],
      next_cursor: null,
      has_more: false,
    }));
    const rateLimiter = new InMemoryRateLimiter();
    const input = {
      public_source: "gateway-source-1",
      rate_limiter: rateLimiter,
      query: {},
      server_now: NOW,
      request_id: "request-matches-rate-limit",
    };

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await expect(getMatches({ list }, input)).resolves.toBeDefined();
    }

    await expect(getMatches({ list }, input)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(list).toHaveBeenCalledTimes(120);
  });

  it("缺少可信公开来源标识时 Fail Closed 且不查询比赛", async () => {
    const list = vi.fn(async () => ({
      items: [],
      next_cursor: null,
      has_more: false,
    }));

    await expect(getMatches({
      list,
    }, {
      query: {},
      server_now: NOW,
      request_id: "request-matches-missing-source",
    } as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(list).not.toHaveBeenCalled();
  });

  it("documents the list endpoint and item contract", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
    expect(specification).toMatch(/\/matches:\s*\n\s+get:/);
    expect(specification).toMatch(/MatchListItem:/);
    expect(specification).toMatch(/can_predict_reason/);
    expect(specification).toMatch(
      /  \/matches:\n    get:[\s\S]*?'429':[\s\S]*?RateLimited/,
    );
  });

  it("returns the match detail success envelope and documents the detail endpoint", async () => {
    const detail = {
      match_id: "00000000-0000-4000-8000-000000000010",
      my_prediction: null,
    };
    const get = vi.fn(async () => detail);

    const response = await getMatch({ get } as never, {
      match_id: detail.match_id,
      authenticated_user_id: null,
      public_source: "gateway-source-detail-1",
      server_now: NOW,
      request_id: "request-match-detail-1",
    } as never);

    expect(response).toEqual({
      status: 200,
      body: {
        data: detail,
        request_id: "request-match-detail-1",
      },
    });
    expect(get).toHaveBeenCalledWith(detail.match_id, null, NOW);

    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
    expect(specification).toMatch(/\/matches\/\{match_id\}:\s*\n\s+get:/);
    expect(specification).toMatch(/MatchDetailData:/);
    expect(specification).toMatch(
      /  \/matches\/\{match_id\}:\n    get:[\s\S]*?'429':[\s\S]*?RateLimited/,
    );
  });

  it("按网关来源限制公开比赛详情每分钟 120 次", async () => {
    const detail = {
      match_id: "00000000-0000-4000-8000-000000000010",
      my_prediction: null,
    };
    const get = vi.fn(async () => detail);
    const rateLimiter = new InMemoryRateLimiter();
    const input = {
      match_id: detail.match_id,
      authenticated_user_id: null,
      public_source: "gateway-source-detail-1",
      rate_limiter: rateLimiter,
      server_now: NOW,
      request_id: "request-match-detail-rate-limit",
    };

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await expect(getMatch({ get } as never, input as never)).resolves.toBeDefined();
    }

    await expect(getMatch({ get } as never, input as never)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(get).toHaveBeenCalledTimes(120);
  });
});
