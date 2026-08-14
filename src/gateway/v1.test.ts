import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter } from "../api/v1/rate-limit.js";
import { SessionService } from "../application/session.js";
import { MatchQueryService } from "../application/match-query.js";
import { newUuid } from "../domain/ids.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { handleGatewayRequest, type GatewayRequestInput } from "./assemble.js";
import { LOCAL_PUBLIC_SOURCE, type GatewayRuntimeConfig } from "./config.js";
import { seedGatewayRepository } from "./seed.js";

const TEST_CURSOR_SECRET = "test-match-cursor-secret-v1";
const MOCK_OPENID = "mock-openid-v1";
const NOW = new Date("2026-08-09T12:00:00.000Z");
const MISSING_MATCH_ID = "00000000-0000-4000-8000-000000000099";

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

async function firstSeededMatchId(harness: ReturnType<typeof makeHarness>): Promise<string> {
  await seedGatewayRepository(harness.repo, NOW);
  const listed = await request(harness, { method: "GET", path: "/v1/matches" });
  const body = listed.body as { data: { items: Array<{ match_id: string }> } };
  const matchId = body.data.items[0]?.match_id;
  if (matchId === undefined) {
    throw new Error("seeded matches missing");
  }
  return matchId;
}

describe("GET /v1/matches/{match_id}", () => {
  it("returns 200 with my_prediction null for a seeded match", async () => {
    const harness = makeHarness();
    const matchId = await firstSeededMatchId(harness);

    const response = await request(harness, {
      method: "GET",
      path: `/v1/matches/${matchId}`,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: expect.objectContaining({
        match_id: matchId,
        my_prediction: null,
      }),
      request_id: expect.any(String),
    });
  });

  it("returns 422 for an illegal match_id", async () => {
    const harness = makeHarness();
    const response = await request(harness, {
      method: "GET",
      path: "/v1/matches/not-a-uuid",
    });

    expect(response.status).toBe(422);
    expect(response.body).toEqual(expect.objectContaining({
      code: "VALIDATION_ERROR",
      request_id: expect.any(String),
    }));
  });

  it("returns 404 for a well-formed match_id that does not exist", async () => {
    const harness = makeHarness();
    const response = await request(harness, {
      method: "GET",
      path: `/v1/matches/${MISSING_MATCH_ID}`,
    });

    expect(response.status).toBe(404);
    expect(response.body).toEqual(expect.objectContaining({
      code: "MATCH_NOT_FOUND",
      request_id: expect.any(String),
    }));
  });
});

describe("POST /v1/predictions", () => {
  it("returns 401 UNAUTHORIZED without identity", async () => {
    const harness = makeHarness();
    const response = await request(harness, {
      method: "POST",
      path: "/v1/predictions",
      body: {
        idempotency_key: newUuid(),
        match_id: MISSING_MATCH_ID,
        home_score: 1,
        away_score: 0,
      },
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual(expect.objectContaining({
      code: "UNAUTHORIZED",
      request_id: expect.any(String),
    }));
  });

  it("returns 401 when mock identity exists but the user was never initialized", async () => {
    const harness = makeHarness(makeConfig({ mock_trusted_openid: MOCK_OPENID }));
    const matchId = await firstSeededMatchId(harness);

    const response = await request(harness, {
      method: "POST",
      path: "/v1/predictions",
      body: {
        idempotency_key: newUuid(),
        match_id: matchId,
        home_score: 1,
        away_score: 0,
      },
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual(expect.objectContaining({
      code: "UNAUTHORIZED",
      request_id: expect.any(String),
    }));
    expect(await harness.repo.users.findAll()).toEqual([]);
  });

  it("creates, replays, and rejects conflicting prediction submits after init", async () => {
    const harness = makeHarness(makeConfig({ mock_trusted_openid: MOCK_OPENID }));
    const matchId = await firstSeededMatchId(harness);

    const init = await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: { nickname: "Sky" },
    });
    expect(init.status).toBe(201);

    const key = newUuid();
    const payload = {
      idempotency_key: key,
      match_id: matchId,
      home_score: 2,
      away_score: 1,
    };

    const created = await request(harness, {
      method: "POST",
      path: "/v1/predictions",
      body: payload,
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      data: expect.objectContaining({
        match_id: matchId,
        pred_home_score: 2,
        pred_away_score: 1,
      }),
      request_id: expect.any(String),
    });

    const replay = await request(harness, {
      method: "POST",
      path: "/v1/predictions",
      body: payload,
    });
    expect(replay.status).toBe(200);
    const createdBody = created.body as { data: { prediction_id: string } };
    const replayBody = replay.body as { data: { prediction_id: string } };
    expect(replayBody.data.prediction_id).toBe(createdBody.data.prediction_id);

    const reused = await request(harness, {
      method: "POST",
      path: "/v1/predictions",
      body: { ...payload, home_score: 3 },
    });
    expect(reused.status).toBe(409);
    expect(reused.body).toEqual(expect.objectContaining({
      code: "IDEMPOTENCY_KEY_REUSED",
      request_id: expect.any(String),
    }));

    const already = await request(harness, {
      method: "POST",
      path: "/v1/predictions",
      body: { ...payload, idempotency_key: newUuid() },
    });
    expect(already.status).toBe(409);
    expect(already.body).toEqual(expect.objectContaining({
      code: "PREDICTION_ALREADY_SUBMITTED",
      request_id: expect.any(String),
    }));
  });

  it("returns 422 when idempotency_key is missing or a score is out of range", async () => {
    const harness = makeHarness(makeConfig({ mock_trusted_openid: MOCK_OPENID }));
    const matchId = await firstSeededMatchId(harness);
    const init = await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: { nickname: "Sky" },
    });
    expect(init.status).toBe(201);

    const missingKey = await request(harness, {
      method: "POST",
      path: "/v1/predictions",
      body: {
        match_id: matchId,
        home_score: 1,
        away_score: 0,
      },
    });
    expect(missingKey.status).toBe(422);
    expect(missingKey.body).toEqual(expect.objectContaining({
      code: "VALIDATION_ERROR",
      request_id: expect.any(String),
    }));

    const outOfRange = await request(harness, {
      method: "POST",
      path: "/v1/predictions",
      body: {
        idempotency_key: newUuid(),
        match_id: matchId,
        home_score: 21,
        away_score: 0,
      },
    });
    expect(outOfRange.status).toBe(422);
    expect(outOfRange.body).toEqual(expect.objectContaining({
      code: "VALIDATION_ERROR",
      request_id: expect.any(String),
    }));
  });

  it("returns 422 for an empty body because required fields are missing", async () => {
    const harness = makeHarness(makeConfig({ mock_trusted_openid: MOCK_OPENID }));
    const init = await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: { nickname: "Sky" },
    });
    expect(init.status).toBe(201);

    const response = await request(harness, {
      method: "POST",
      path: "/v1/predictions",
      body: undefined,
    });

    expect(response.status).toBe(422);
    expect(response.body).toEqual(expect.objectContaining({
      code: "VALIDATION_ERROR",
      request_id: expect.any(String),
    }));
  });
});
