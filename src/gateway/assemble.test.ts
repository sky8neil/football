import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter } from "../api/v1/rate-limit.js";
import { SessionService } from "../application/session.js";
import { MatchQueryService } from "../application/match-query.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { handleGatewayRequest, type GatewayRequestInput } from "./assemble.js";
import { LOCAL_PUBLIC_SOURCE, type GatewayRuntimeConfig } from "./config.js";
import { seedGatewayRepository } from "./seed.js";

const TEST_CURSOR_SECRET = "test-match-cursor-secret";
const MOCK_OPENID = "mock-openid-assemble";
const NOW = new Date("2026-08-09T12:00:00.000Z");

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

describe("handleGatewayRequest session init", () => {
  it("returns 401 UNAUTHORIZED without a mock openid and does not write a user", async () => {
    const harness = makeHarness(makeConfig({ mock_trusted_openid: null }));
    const response = await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: { nickname: "Sky" },
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual(expect.objectContaining({
      code: "UNAUTHORIZED",
      request_id: expect.any(String),
    }));
    expect(await harness.repo.users.findAll()).toEqual([]);
  });

  it("returns 401 UNAUTHORIZED when the mock openid is an empty string", async () => {
    const harness = makeHarness(makeConfig({ mock_trusted_openid: "" }));
    const response = await request(harness, {
      method: "post",
      path: "/v1/session/init/",
      body: { nickname: "Sky" },
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual(expect.objectContaining({
      code: "UNAUTHORIZED",
      request_id: expect.any(String),
    }));
    expect(await harness.repo.users.findAll()).toEqual([]);
  });

  it("creates on first init and is idempotent on the same repo, ignoring a new nickname", async () => {
    const harness = makeHarness(makeConfig({
      environment: "dev",
      mock_trusted_openid: MOCK_OPENID,
    }));

    const first = await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: { nickname: "Sky" },
    });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      data: expect.objectContaining({
        nickname: "Sky",
        status: "active",
      }),
      request_id: expect.any(String),
    });
    expect(first.body).not.toEqual(expect.objectContaining({
      data: expect.objectContaining({ openid: expect.anything() }),
    }));
    const firstBody = first.body as { data: { nickname: string; user_id: string } };
    expect(firstBody.data).not.toHaveProperty("openid");

    const second = await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: { nickname: "Other" },
    });
    expect(second.status).toBe(200);
    const secondBody = second.body as { data: { nickname: string; user_id: string } };
    expect(secondBody.data.nickname).toBe("Sky");
    expect(secondBody.data.user_id).toBe(firstBody.data.user_id);
    expect(secondBody.data).not.toHaveProperty("openid");
  });

  it("rejects a client-supplied openid with 422", async () => {
    const harness = makeHarness(makeConfig({ mock_trusted_openid: MOCK_OPENID }));
    const response = await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: { nickname: "Sky", openid: "attacker" },
    });

    expect(response.status).toBe(422);
    expect(response.body).toEqual(expect.objectContaining({
      code: "VALIDATION_ERROR",
      request_id: expect.any(String),
    }));
  });

  it("treats an empty POST body as {} and still reaches the handler", async () => {
    const harness = makeHarness(makeConfig({ mock_trusted_openid: null }));
    const response = await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: undefined,
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual(expect.objectContaining({
      code: "UNAUTHORIZED",
      request_id: expect.any(String),
    }));
  });

  it("rejects a non-object POST body at the gateway with 422", async () => {
    const harness = makeHarness(makeConfig({ mock_trusted_openid: MOCK_OPENID }));
    const response = await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: ["not-an-object"],
    });

    expect(response.status).toBe(422);
    expect(response.body).toEqual(expect.objectContaining({
      code: "VALIDATION_ERROR",
      request_id: expect.any(String),
    }));
  });
});

describe("handleGatewayRequest matches", () => {
  it("returns 200 with an empty page when the repo has no matches", async () => {
    const harness = makeHarness();
    const response = await request(harness, {
      method: "GET",
      path: "/v1/matches",
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

  it("forwards limit as the string 2 and pages with the server next_cursor", async () => {
    const harness = makeHarness();
    await seedGatewayRepository(harness.repo, NOW);

    const first = await request(harness, {
      method: "GET",
      path: "/v1/matches",
      query: { limit: "2" },
    });
    expect(first.status).toBe(200);
    const firstBody = first.body as {
      data: {
        items: Array<{ match_id: string }>;
        page: { next_cursor: string | null; has_more: boolean };
      };
    };
    expect(firstBody.data.items).toHaveLength(2);
    expect(firstBody.data.page.has_more).toBe(true);
    expect(typeof firstBody.data.page.next_cursor).toBe("string");

    const second = await request(harness, {
      method: "GET",
      path: "/v1/matches",
      query: { limit: "2", cursor: firstBody.data.page.next_cursor ?? "" },
    });
    expect(second.status).toBe(200);
    const secondBody = second.body as {
      data: {
        items: Array<{ match_id: string }>;
        page: { next_cursor: string | null; has_more: boolean };
      };
    };
    expect(secondBody.data.items.length).toBeGreaterThan(0);
    expect(secondBody.data.items[0]?.match_id).not.toBe(firstBody.data.items[0]?.match_id);
  });

  it("returns 422 VALIDATION_ERROR for an illegal cursor and includes code and request_id", async () => {
    const harness = makeHarness();
    const response = await request(harness, {
      method: "GET",
      path: "/v1/matches",
      query: { cursor: "not-a-cursor" },
    });

    expect(response.status).toBe(422);
    expect(response.body).toEqual(expect.objectContaining({
      code: "VALIDATION_ERROR",
      request_id: expect.any(String),
    }));
  });
});

describe("handleGatewayRequest routing", () => {
  it("returns 422 for an unknown path with code and request_id", async () => {
    const harness = makeHarness();
    const response = await request(harness, {
      method: "GET",
      path: "/v1/unknown",
    });

    expect(response.status).toBe(422);
    expect(response.body).toEqual(expect.objectContaining({
      code: "VALIDATION_ERROR",
      request_id: expect.any(String),
    }));
  });

  it("uses the same local_v0 public_source constant as the HTTP entry", () => {
    expect(LOCAL_PUBLIC_SOURCE).toBe("local_v0");
    expect(makeConfig().public_source).toBe(LOCAL_PUBLIC_SOURCE);
  });
});

describe("handleGatewayRequest GET /v1/predictions/me", () => {
  it("routes to the existing handler instead of unknown-path 422", async () => {
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
});

describe("handleGatewayRequest GET /v1/profile/me", () => {
  it("routes to the existing handler instead of unknown-path 422", async () => {
    const harness = makeHarness();
    const response = await request(harness, {
      method: "GET",
      path: "/v1/profile/me",
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual(expect.objectContaining({
      code: "UNAUTHORIZED",
      request_id: expect.any(String),
    }));
  });
});

describe("handleGatewayRequest GET /v1/levels/me", () => {
  it("routes to the existing handler instead of unknown-path 422", async () => {
    const harness = makeHarness();
    const response = await request(harness, {
      method: "GET",
      path: "/v1/levels/me",
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual(expect.objectContaining({
      code: "UNAUTHORIZED",
      request_id: expect.any(String),
    }));
  });
});

describe("handleGatewayRequest GET /v1/unlocks/me", () => {
  it("routes to the existing handler instead of unknown-path 422", async () => {
    const harness = makeHarness();
    const response = await request(harness, {
      method: "GET",
      path: "/v1/unlocks/me",
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual(expect.objectContaining({
      code: "UNAUTHORIZED",
      request_id: expect.any(String),
    }));
  });
});

describe("handleGatewayRequest GET /v1/rankings", () => {
  it("routes to the existing handler instead of unknown-path 422", async () => {
    const harness = makeHarness();
    const response = await request(harness, {
      method: "GET",
      path: "/v1/rankings",
      query: { period_type: "week" },
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
});
