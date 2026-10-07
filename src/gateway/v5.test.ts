import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter } from "../api/v1/rate-limit.js";
import { MatchQueryService } from "../application/match-query.js";
import { SessionService } from "../application/session.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { handleGatewayRequest, type GatewayRequestInput } from "./assemble.js";
import { LOCAL_PUBLIC_SOURCE, type GatewayRuntimeConfig } from "./config.js";
import { seedGatewayRepository, seedRankingLeaderboard } from "./seed.js";

const TEST_CURSOR_SECRET = "test-match-cursor-secret-v5";
const MOCK_OPENID = "mock-openid-v5";
const NOW = new Date("2026-08-09T12:00:00.000Z");

const FROZEN_RANKING_ITEM_KEYS = [
  "rank",
  "user_id",
  "display_name",
  "favorite_team_id",
  "career_level",
  "period_score",
  "valid_predictions",
  "exact_hits",
  "last_scoring_match_at",
] as const;

type RankingItem = Record<string, unknown> & {
  rank: number;
  user_id: string;
  display_name: string;
  period_score: number;
  valid_predictions: number;
};

type RankingPage = {
  data: {
    board: string;
    scope: string;
    period_key: string | null;
    updated_at: string | null;
    server_now: string;
    current_period_key: string;
    available_boards: string[];
    seasons_participated: number;
    entry_count: number;
    items: RankingItem[];
    page: { next_cursor: string | null; has_more: boolean };
  };
};

function makeConfig(overrides: Partial<GatewayRuntimeConfig> = {}): GatewayRuntimeConfig {
  return {
    environment: "test",
    mock_trusted_openid: null,
    match_cursor_secret: TEST_CURSOR_SECRET,
    public_source: LOCAL_PUBLIC_SOURCE,
    repository_backend: "memory",
    cloudbase_repository: null,
    ...overrides,
  };
}

function makeHarness(config: GatewayRuntimeConfig = makeConfig()) {
  const repo = new InMemoryRepository();
  const rateLimiter = new InMemoryRateLimiter();
  return {
    repo,
    rateLimiter,
    config,
    session: new SessionService(repo),
    matches: new MatchQueryService(repo, config.match_cursor_secret),
  };
}

function request(
  harness: ReturnType<typeof makeHarness>,
  input: Partial<GatewayRequestInput> & Pick<GatewayRequestInput, "method" | "path">,
) {
  return handleGatewayRequest({
    method: input.method,
    path: input.path,
    query: input.query ?? {},
    body: input.body,
    server_now: input.server_now ?? NOW,
    config: harness.config,
    ...(input.trusted_openid !== undefined ? { trusted_openid: input.trusted_openid } : {}),
    services: { session: harness.session, matches: harness.matches },
    repo: harness.repo,
    rate_limiter: harness.rateLimiter,
  });
}

async function seedRankings(
  harness: ReturnType<typeof makeHarness>,
): Promise<void> {
  await seedGatewayRepository(harness.repo, NOW);
  await seedRankingLeaderboard(harness.repo, NOW);
}

describe("GET /v1/rankings", () => {
  it("returns 200 with non-empty week items sorted by rank", async () => {
    const harness = makeHarness(makeConfig({ environment: "dev", mock_trusted_openid: MOCK_OPENID }));
    await seedRankings(harness);
    await request(harness, { method: "POST", path: "/v1/session/init", body: { nickname: "Sky" } });

    const response = await request(harness, {
      method: "GET",
      path: "/v1/rankings",
      query: { board: "week" },
    });

    expect(response.status).toBe(200);
    const body = response.body as RankingPage;
    expect(body.data.items.length).toBeGreaterThan(0);
    expect(body.data.page.has_more).toBe(false);
    expect(body.data.page.next_cursor).toBeNull();
    const ranks = body.data.items.map((item) => item.rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(ranks[0]).toBe(1);
    expect(body).toEqual({
      data: {
        board: "week",
        scope: "global",
        period_key: "2026-W32",
        updated_at: NOW.toISOString(),
        server_now: NOW.toISOString(),
        current_period_key: "2026-W32",
        available_boards: ["week"],
        seasons_participated: 0,
        entry_count: expect.any(Number),
        items: expect.any(Array),
        page: { next_cursor: null, has_more: false },
        me: { status: "not_participated" },
      },
      request_id: expect.any(String),
    });
  });

  it("returns 422 when month board is requested", async () => {
    const harness = makeHarness(makeConfig({ environment: "dev", mock_trusted_openid: MOCK_OPENID }));
    await seedRankings(harness);
    await request(harness, { method: "POST", path: "/v1/session/init", body: { nickname: "Sky" } });

    const response = await request(harness, {
      method: "GET",
      path: "/v1/rankings",
      query: { board: "month" },
    });

    expect(response.status).toBe(422);
    expect(response.body).toEqual(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });

  it("returns 422 VALIDATION_ERROR when board is missing", async () => {
    const harness = makeHarness();
    const response = await request(harness, {
      method: "GET",
      path: "/v1/rankings",
    });

    expect(response.status).toBe(422);
    expect(response.body).toEqual(expect.objectContaining({
      code: "VALIDATION_ERROR",
      request_id: expect.any(String),
    }));
  });

  it("returns 422 VALIDATION_ERROR when board is illegal", async () => {
    const harness = makeHarness();
    const response = await request(harness, {
      method: "GET",
      path: "/v1/rankings",
      query: { board: "year" },
    });

    expect(response.status).toBe(422);
    expect(response.body).toEqual(expect.objectContaining({
      code: "VALIDATION_ERROR",
      request_id: expect.any(String),
    }));
  });

  it("returns 200 with empty items when the period has no ranking data", async () => {
    const harness = makeHarness(makeConfig({ environment: "dev", mock_trusted_openid: MOCK_OPENID }));
    await seedRankings(harness);
    await request(harness, { method: "POST", path: "/v1/session/init", body: { nickname: "Sky" } });

    const response = await request(harness, {
      method: "GET",
      path: "/v1/rankings",
      query: { board: "week", period_key: "2026-W31" },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        board: "week",
        scope: "global",
        period_key: "2026-W31",
        updated_at: null,
        server_now: NOW.toISOString(),
        current_period_key: "2026-W32",
        available_boards: ["week"],
        seasons_participated: 0,
        entry_count: 0,
        items: [],
        page: { next_cursor: null, has_more: false },
        me: { status: "not_participated" },
      },
      request_id: expect.any(String),
    });
  });

  it("returns 200 with empty items on an independent empty fixture", async () => {
    const harness = makeHarness(makeConfig({ environment: "dev", mock_trusted_openid: MOCK_OPENID }));
    await request(harness, { method: "POST", path: "/v1/session/init", body: { nickname: "Sky" } });
    const response = await request(harness, {
      method: "GET",
      path: "/v1/rankings",
      query: { board: "week" },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        board: "week",
        scope: "global",
        period_key: "2026-W32",
        updated_at: null,
        server_now: NOW.toISOString(),
        current_period_key: "2026-W32",
        available_boards: ["week"],
        seasons_participated: 0,
        entry_count: 0,
        items: [],
        page: { next_cursor: null, has_more: false },
        me: { status: "not_participated" },
      },
      request_id: expect.any(String),
    });
  });

  it("returns 409 for a deleted signed-in account", async () => {
    const harness = makeHarness(makeConfig({ environment: "dev", mock_trusted_openid: MOCK_OPENID }));
    await request(harness, { method: "POST", path: "/v1/session/init", body: { nickname: "Sky" } });
    const deleted = await request(harness, { method: "DELETE", path: "/v1/profile/me" });
    expect(deleted.status).toBe(204);

    const response = await request(harness, {
      method: "GET",
      path: "/v1/rankings",
      query: { board: "week" },
    });
    expect(response.status).toBe(409);
    expect(response.body).toEqual(expect.objectContaining({ code: "USER_DELETED" }));
  });

  it("requires identity for rankings", async () => {
    const response = await request(makeHarness(), {
      method: "GET",
      path: "/v1/rankings",
      query: { board: "week" },
    });
    expect(response.status).toBe(401);
    expect(response.body).toEqual(expect.objectContaining({ code: "UNAUTHORIZED" }));
  });

  it("returns 404 when an explicitly requested season has no data", async () => {
    const harness = makeHarness(makeConfig({ environment: "dev", mock_trusted_openid: MOCK_OPENID }));
    await request(harness, { method: "POST", path: "/v1/session/init", body: { nickname: "Sky" } });

    const response = await request(harness, {
      method: "GET",
      path: "/v1/rankings",
      query: { board: "season", level_season_id: "2024_2025" },
    });

    expect(response.status).toBe(404);
    expect(response.body).toEqual(expect.objectContaining({ code: "LEVEL_SEASON_NOT_FOUND" }));
  });

  it("returns an empty non-provisional current season when no season data exists", async () => {
    const harness = makeHarness(makeConfig({ environment: "dev", mock_trusted_openid: MOCK_OPENID }));
    await request(harness, { method: "POST", path: "/v1/session/init", body: { nickname: "Sky" } });

    const response = await request(harness, {
      method: "GET",
      path: "/v1/rankings",
      query: { board: "season" },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      data: expect.objectContaining({
        level_season_id: "2026_2027",
        is_provisional: false,
        entry_count: 0,
        available_boards: ["week"],
        items: [],
      }),
    }));
  });

  it("honors a smaller page limit and carries the query through its cursor", async () => {
    const harness = makeHarness(makeConfig({ environment: "dev", mock_trusted_openid: MOCK_OPENID }));
    await seedRankings(harness);
    await request(harness, { method: "POST", path: "/v1/session/init", body: { nickname: "Sky" } });

    const first = await request(harness, {
      method: "GET",
      path: "/v1/rankings",
      query: { board: "week", limit: "1" },
    });
    expect(first.status).toBe(200);
    const firstBody = first.body as RankingPage;
    expect(firstBody.data.items).toHaveLength(1);
    expect(firstBody.data.page.has_more).toBe(true);
    expect(typeof firstBody.data.page.next_cursor).toBe("string");
    expect(firstBody.data.items[0]?.rank).toBe(1);

    const second = await request(harness, {
      method: "GET",
      path: "/v1/rankings",
      query: {
        board: "week",
        cursor: firstBody.data.page.next_cursor ?? "",
      },
    });
    expect(second.status).toBe(200);
    const secondBody = second.body as RankingPage;
    expect(secondBody.data.items.length).toBeGreaterThan(0);
    expect(secondBody.data.items[0]?.user_id).not.toBe(firstBody.data.items[0]?.user_id);
    expect(secondBody.data.items.every((item) => item.rank > 1)).toBe(true);
    expect(secondBody.data.page.has_more).toBe(false);
    expect(secondBody.data.page.next_cursor).toBeNull();
  });

  it("freezes ranking item contract fields and does not add extras", async () => {
    const harness = makeHarness(makeConfig({ environment: "dev", mock_trusted_openid: MOCK_OPENID }));
    await seedRankings(harness);
    await request(harness, { method: "POST", path: "/v1/session/init", body: { nickname: "Sky" } });

    const response = await request(harness, {
      method: "GET",
      path: "/v1/rankings",
      query: { board: "week" },
    });
    expect(response.status).toBe(200);
    const body = response.body as RankingPage;
    const item = body.data.items[0]!;
    expect(item).toEqual(expect.objectContaining({
      rank: expect.any(Number),
      user_id: expect.any(String),
      display_name: expect.any(String),
      career_level: expect.any(Number),
      period_score: expect.any(Number),
      valid_predictions: expect.any(Number),
      exact_hits: expect.any(Number),
    }));
    expect(item).toHaveProperty("favorite_team_id");
    expect(item).toHaveProperty("last_scoring_match_at");
    expect(Object.keys(item).sort()).toEqual([...FROZEN_RANKING_ITEM_KEYS].sort());
    expect(item).not.toHaveProperty("nickname");
    expect(item).not.toHaveProperty("openid");
    expect(item).not.toHaveProperty("team_name");
    expect(item).not.toHaveProperty("is_final");
    expect(item).not.toHaveProperty("wdl_hits");
    expect(item).not.toHaveProperty("wdl_accuracy_percent");
  });

  it("does not bind ranking seed users to mock openid so init stays 201", async () => {
    const harness = makeHarness(makeConfig({ mock_trusted_openid: MOCK_OPENID }));
    await seedRankings(harness);

    const first = await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: { nickname: "Sky" },
    });
    expect(first.status).toBe(201);

    const second = await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: { nickname: "Other" },
    });
    expect(second.status).toBe(200);
    const secondBody = second.body as { data: { nickname: string } };
    expect(secondBody.data.nickname).toBe("Sky");
  });
});
