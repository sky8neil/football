import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter } from "../api/v1/rate-limit.js";
import { MatchQueryService } from "../application/match-query.js";
import { SessionService } from "../application/session.js";
import { newUuid } from "../domain/ids.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { handleGatewayRequest, type GatewayRequestInput } from "./assemble.js";
import { LOCAL_PUBLIC_SOURCE, type GatewayRuntimeConfig } from "./config.js";
import { seedGatewayRepository } from "./seed.js";

const TEST_CURSOR_SECRET = "test-match-cursor-secret-v3";
const MOCK_OPENID = "mock-openid-v3";
const NOW = new Date("2026-08-09T12:00:00.000Z");

const FROZEN_HISTORY_ITEM_KEYS = [
  "prediction_id",
  "match_id",
  "league_id",
  "season_id",
  "round_id",
  "home_team_id",
  "away_team_id",
  "kickoff_at",
  "pred_home_score",
  "pred_away_score",
  "derived_result",
  "submitted_at",
  "scoring_rule_version",
  "match_status",
  "regular_home_score",
  "regular_away_score",
  "match_score",
  "wdl_hit",
  "exact_hit",
] as const;

type HistoryItem = Record<string, unknown> & {
  prediction_id: string;
  match_id: string;
  home_team_id: string;
  away_team_id: string;
};

type HistoryPage = {
  data: {
    items: HistoryItem[];
    page: { next_cursor: string | null; has_more: boolean };
  };
};

function makeConfig(overrides: Partial<GatewayRuntimeConfig> = {}): GatewayRuntimeConfig {
  return {
    environment: "test",
    mock_trusted_openid: null,
    match_cursor_secret: TEST_CURSOR_SECRET,
    public_source: LOCAL_PUBLIC_SOURCE,
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
    services: { session: harness.session, matches: harness.matches },
    repo: harness.repo,
    rate_limiter: harness.rateLimiter,
  });
}

async function initAuthedHarness() {
  const harness = makeHarness(makeConfig({ mock_trusted_openid: MOCK_OPENID }));
  await seedGatewayRepository(harness.repo, NOW);
  const init = await request(harness, {
    method: "POST",
    path: "/v1/session/init",
    body: { nickname: "Sky" },
  });
  expect(init.status).toBe(201);
  return harness;
}

async function predictableMatchIds(
  harness: ReturnType<typeof makeHarness>,
): Promise<string[]> {
  const listed = await request(harness, { method: "GET", path: "/v1/matches" });
  expect(listed.status).toBe(200);
  const body = listed.body as {
    data: { items: Array<{ match_id: string; can_predict: boolean }> };
  };
  return body.data.items
    .filter((item) => item.can_predict)
    .map((item) => item.match_id);
}

async function submitPrediction(
  harness: ReturnType<typeof makeHarness>,
  matchId: string,
  homeScore: number,
  awayScore: number,
) {
  const created = await request(harness, {
    method: "POST",
    path: "/v1/predictions",
    body: {
      idempotency_key: newUuid(),
      match_id: matchId,
      home_score: homeScore,
      away_score: awayScore,
    },
  });
  expect(created.status).toBe(201);
  return created;
}

describe("GET /v1/predictions/me", () => {
  it("returns 401 UNAUTHORIZED without identity", async () => {
    const harness = makeHarness();
    const response = await request(harness, {
      method: "GET",
      path: "/v1/predictions/me",
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual(expect.objectContaining({
      code: "UNAUTHORIZED",
      request_id: expect.any(String),
    }));
  });

  it("returns an empty page after init when the user has no predictions", async () => {
    const harness = await initAuthedHarness();
    const response = await request(harness, {
      method: "GET",
      path: "/v1/predictions/me",
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        items: [],
        page: { next_cursor: null, has_more: false },
      },
      request_id: expect.any(String),
    });
  });

  it("freezes history item fields and omits nested team objects", async () => {
    const harness = await initAuthedHarness();
    const matchIds = await predictableMatchIds(harness);
    expect(matchIds.length).toBeGreaterThan(0);
    await submitPrediction(harness, matchIds[0]!, 2, 1);

    const response = await request(harness, {
      method: "GET",
      path: "/v1/predictions/me",
    });
    expect(response.status).toBe(200);
    const body = response.body as HistoryPage;
    expect(body.data.items).toHaveLength(1);
    expect(body.data.page).toEqual({ next_cursor: null, has_more: false });

    const item = body.data.items[0]!;
    expect(item).toEqual(expect.objectContaining({
      prediction_id: expect.any(String),
      match_id: matchIds[0],
      home_team_id: expect.any(String),
      away_team_id: expect.any(String),
      league_id: expect.any(String),
      season_id: expect.any(String),
      round_id: expect.any(String),
      kickoff_at: expect.any(String),
      pred_home_score: 2,
      pred_away_score: 1,
      derived_result: "HOME",
      submitted_at: expect.any(String),
      scoring_rule_version: expect.any(String),
      match_status: expect.any(String),
    }));
    expect(Object.keys(item).sort()).toEqual([...FROZEN_HISTORY_ITEM_KEYS].sort());
    expect(item).not.toHaveProperty("home_team");
    expect(item).not.toHaveProperty("away_team");
  });

  it("pages two match predictions with limit=1 and the server next_cursor", async () => {
    const harness = await initAuthedHarness();
    const matchIds = await predictableMatchIds(harness);
    expect(matchIds.length).toBeGreaterThanOrEqual(2);
    await submitPrediction(harness, matchIds[0]!, 1, 0);
    await submitPrediction(harness, matchIds[1]!, 2, 2);

    const first = await request(harness, {
      method: "GET",
      path: "/v1/predictions/me",
      query: { limit: "1" },
    });
    expect(first.status).toBe(200);
    const firstBody = first.body as HistoryPage;
    expect(firstBody.data.items).toHaveLength(1);
    expect(firstBody.data.page.has_more).toBe(true);
    expect(firstBody.data.page.next_cursor).not.toBeNull();
    expect(typeof firstBody.data.page.next_cursor).toBe("string");

    const second = await request(harness, {
      method: "GET",
      path: "/v1/predictions/me",
      query: {
        limit: "1",
        cursor: firstBody.data.page.next_cursor ?? "",
      },
    });
    expect(second.status).toBe(200);
    const secondBody = second.body as HistoryPage;
    expect(secondBody.data.items).toHaveLength(1);
    expect(secondBody.data.items[0]?.prediction_id).not.toBe(
      firstBody.data.items[0]?.prediction_id,
    );
    expect(secondBody.data.items[0]?.match_id).not.toBe(firstBody.data.items[0]?.match_id);
  });

  it("returns 422 VALIDATION_ERROR for an illegal cursor", async () => {
    const harness = await initAuthedHarness();
    const response = await request(harness, {
      method: "GET",
      path: "/v1/predictions/me",
      query: { cursor: "not-a-cursor" },
    });

    expect(response.status).toBe(422);
    expect(response.body).toEqual(expect.objectContaining({
      code: "VALIDATION_ERROR",
      request_id: expect.any(String),
    }));
  });
});
