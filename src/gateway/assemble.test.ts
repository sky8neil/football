import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter } from "../api/v1/rate-limit.js";
import type { RateLimiter } from "../api/v1/rate-limit.js";
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
    repository_backend: "memory",
    cloudbase_repository: null,
    ...overrides,
  };
}

function makeHarness(
  config: GatewayRuntimeConfig = makeConfig(),
  rateLimiter: RateLimiter = new InMemoryRateLimiter(),
) {
  const repo = new InMemoryRepository();
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

  it("uses the configured public source for match list and detail", async () => {
    const sources: string[] = [];
    const rateLimiter: RateLimiter = {
      check: (_scope, source) => {
        sources.push(source);
      },
    };
    const harness = makeHarness(
      makeConfig({
        public_source: "configured_source" as unknown as typeof LOCAL_PUBLIC_SOURCE,
      }),
      rateLimiter,
    );

    await request(harness, { method: "GET", path: "/v1/matches" });
    await request(harness, {
      method: "GET",
      path: "/v1/matches/00000000-0000-4000-8000-000000000000",
    });

    expect(sources).toEqual(["configured_source", "configured_source"]);
  });

  it("seeds live, finished, and abandoned matches before the injected clock", async () => {
    const harness = makeHarness();
    await seedGatewayRepository(harness.repo, NOW);
    const matches = await harness.repo.matches.findBySeason("2026_2027");

    expect(
      matches
        .filter((match) => ["live", "finished", "abandoned"].includes(match.match_status))
        .every((match) => match.kickoff_at.getTime() < NOW.getTime()),
    ).toBe(true);
    expect(matches.some((match) => match.match_status === "scheduled" && match.kickoff_at > NOW))
      .toBe(true);
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
  it("requires identity at the existing rankings handler", async () => {
    const harness = makeHarness();
    const response = await request(harness, {
      method: "GET",
      path: "/v1/rankings",
      query: { board: "week" },
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual(expect.objectContaining({ code: "UNAUTHORIZED" }));
  });

  it("returns 422 for the removed month board at the gateway", async () => {
    const harness = makeHarness();
    const response = await request(harness, {
      method: "GET",
      path: "/v1/rankings",
      query: { board: "month" },
    });

    expect(response.status).toBe(422);
    expect(response.body).toEqual(expect.objectContaining({
      code: "VALIDATION_ERROR",
      request_id: expect.any(String),
    }));
  });
});

describe("handleGatewayRequest S7 routes", () => {
  it.each([
    ["PATCH", "/v1/profile/me", { nickname: "Sky" }, 401],
    ["DELETE", "/v1/profile/me", undefined, 401],
    ["GET", "/v1/profiles/00000000-0000-4000-8000-000000000001", undefined, 404],
    ["GET", "/v1/predictions/me/00000000-0000-4000-8000-000000000001", undefined, 401],
    ["GET", "/v1/share-card/me", undefined, 401],
    ["GET", "/v1/admin/anomalies", undefined, 401],
    ["POST", "/v1/admin/matches/00000000-0000-4000-8000-000000000001/result-corrections", {
      expected_result_version: 0,
      regular_home_score: 1,
      regular_away_score: 0,
      reason: "test",
    }, 401],
    ["POST", "/v1/admin/matches/00000000-0000-4000-8000-000000000001/retry-settlement", undefined, 401],
    ["POST", "/v1/admin/rebuild/users/00000000-0000-4000-8000-000000000001", undefined, 401],
    ["POST", "/v1/admin/rebuild/rankings", { board: "week", period_key: "2026-W32", reason: "test" }, 401],
    ["POST", "/v1/groups", {}, 401],
    ["POST", "/v1/groups/join", { invite_code: "AB23CD45" }, 401],
    ["POST", "/v1/groups/00000000-0000-4000-8000-000000000001/leave", undefined, 401],
    ["DELETE", "/v1/groups/00000000-0000-4000-8000-000000000001", undefined, 401],
    ["GET", "/v1/groups/me", undefined, 401],
    ["GET", "/v1/groups/00000000-0000-4000-8000-000000000001", undefined, 401],
  ] as const)("routes %s %s", async (method, path, body, status) => {
    const harness = makeHarness();
    const response = await request(harness, { method, path, body });

    expect(response.status).toBe(status);
    expect(response.body).not.toEqual(expect.objectContaining({ message: "不支持的请求" }));
  });

  it("routes authenticated /v1/groups/me before the group ID route", async () => {
    const harness = makeHarness(makeConfig({
      environment: "dev",
      mock_trusted_openid: MOCK_OPENID,
    }));
    const init = await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: { nickname: "Sky" },
    });
    expect(init.status).toBe(201);

    const response = await request(harness, {
      method: "GET",
      path: "/v1/groups/me",
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: { items: [], page: { next_cursor: null, has_more: false } },
      request_id: expect.any(String),
    });
  });
});
