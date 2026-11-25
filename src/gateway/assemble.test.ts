import { describe, expect, it, vi } from "vitest";
import { InMemoryRateLimiter, RATE_LIMIT_DEFAULTS } from "../api/v1/rate-limit.js";
import type { RateLimiter } from "../api/v1/rate-limit.js";
import { SessionService } from "../application/session.js";
import { MatchQueryService } from "../application/match-query.js";
import { MVP_SEASON } from "../domain/config.js";
import { SCHEMA_VERSION, UserStatus } from "../domain/enums.js";
import { DomainError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import { defaultLevelState } from "../domain/types.js";
import type { AuthSessionRecord, AuthSessionStore } from "../infrastructure/postgres-auth-sessions.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { handleGatewayRequest, type GatewayRequestInput } from "./assemble.js";
import { LOCAL_PUBLIC_SOURCE, type GatewayRuntimeConfig } from "./config.js";
import { extractClientIp } from "./http.js";
import { seedGatewayRepository } from "./seed.js";
import type { WechatCode2SessionHttp } from "./wechat-login.js";

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
    postgres_repository: null,
      vps_auth: null,
      deploy_target: "vps",
      ranking_first_period_key: "2026-W31",
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
    ...(input.trusted_openid !== undefined ? { trusted_openid: input.trusted_openid } : {}),
    ...(input.client_ip !== undefined ? { client_ip: input.client_ip } : {}),
    ...(input.authorization !== undefined ? { authorization: input.authorization } : {}),
    ...(input.sessions !== undefined ? { sessions: input.sessions } : {}),
    ...(input.wechat_http !== undefined ? { wechat_http: input.wechat_http } : {}),
  });
}

function memorySessions(seed: AuthSessionRecord[] = []): AuthSessionStore & { records: AuthSessionRecord[] } {
  const records = [...seed];
  return {
    records,
    async create(input) {
      const record = {
        token: `opaque-${records.length + 1}`,
        openid: input.openid,
        expires_at: new Date(input.now.getTime() + input.ttlSeconds * 1000),
      };
      records.push(record);
      return record;
    },
    async findActiveByToken(input) {
      return records.find((item) => item.token === input.token && item.expires_at.getTime() > input.now.getTime()) ??
        null;
    },
    async deleteByOpenid(openid) {
      if (typeof openid !== "string" || openid.trim().length === 0 || openid.trim() !== openid) {
        throw new Error("openid is required");
      }
      let deleted = 0;
      for (let index = records.length - 1; index >= 0; index -= 1) {
        if (records[index]?.openid === openid) {
          records.splice(index, 1);
          deleted += 1;
        }
      }
      return deleted;
    },
  };
}

function wechatHttp(payload: unknown = { openid: MOCK_OPENID }): WechatCode2SessionHttp {
  return { getJson: vi.fn(async () => payload) };
}

describe("handleGatewayRequest wechat login", () => {
  const auth = {
    wechat_app_id: "wx-test-appid",
    wechat_app_secret: "wx-test-secret-must-not-leak",
    session_ttl_seconds: 120,
  };
  const loginCode = "wx-one-time-code-must-not-leak";

  it("issues an opaque bearer without requiring trusted openid", async () => {
    const sessions = memorySessions();
    const http = wechatHttp();
    const harness = makeHarness(makeConfig({ vps_auth: auth }));
    const response = await request(harness, {
      method: "POST",
      path: "/v1/auth/wechat",
      body: { code: loginCode },
      sessions,
      wechat_http: http,
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        access_token: "opaque-1",
        token_type: "Bearer",
        expires_at: "2026-08-09T12:02:00.000Z",
      },
      request_id: expect.any(String),
    });
    expect(JSON.stringify(response.body)).not.toContain(auth.wechat_app_secret);
    expect(JSON.stringify(response.body)).not.toContain(loginCode);
    expect(sessions.records).toEqual([
      { token: "opaque-1", openid: MOCK_OPENID, expires_at: new Date("2026-08-09T12:02:00.000Z") },
    ]);
  });

  it("maps wechat failure to 401 and does not create a session", async () => {
    const sessions = memorySessions();
    const harness = makeHarness(makeConfig({ vps_auth: auth }));
    const response = await request(harness, {
      method: "POST",
      path: "/v1/auth/wechat",
      body: { code: loginCode },
      sessions,
      wechat_http: wechatHttp({ errcode: 40029, errmsg: "invalid code" }),
    });
    expect(response.status).toBe(401);
    expect(response.body).toEqual(expect.objectContaining({ code: "UNAUTHORIZED" }));
    expect(sessions.records).toEqual([]);
  });

  it("injects bearer openid into session init", async () => {
    const sessions = memorySessions([{
      token: "opaque-live",
      openid: MOCK_OPENID,
      expires_at: new Date(NOW.getTime() + 1000),
    }]);
    const harness = makeHarness(makeConfig({ environment: "prod", mock_trusted_openid: "must-not-use-mock" }));
    const created = await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: { nickname: "Sky" },
      authorization: "Bearer opaque-live",
      sessions,
    });
    expect(created.status).toBe(201);
    expect(await harness.repo.users.findByOpenid(MOCK_OPENID)).not.toBeNull();
    expect(await harness.repo.users.findByOpenid("must-not-use-mock")).toBeNull();
  });

  it("returns 401 after the bearer expires", async () => {
    const sessions = memorySessions([{
      token: "opaque-live",
      openid: MOCK_OPENID,
      expires_at: NOW,
    }]);
    const harness = makeHarness(makeConfig({ environment: "prod" }));
    const response = await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: { nickname: "Sky" },
      authorization: "Bearer opaque-live",
      sessions,
    });
    expect(response.status).toBe(401);
    expect(response.body).toEqual(expect.objectContaining({ code: "UNAUTHORIZED" }));
    expect(await harness.repo.users.findAll()).toEqual([]);
  });

  it("keeps an explicit CloudBase trusted_openid over bearer", async () => {
    const sessions = memorySessions([{
      token: "opaque-live",
      openid: MOCK_OPENID,
      expires_at: new Date(NOW.getTime() + 1000),
    }]);
    const harness = makeHarness(makeConfig({ environment: "prod" }));
    const created = await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: { nickname: "Cloud" },
      trusted_openid: "cloud-context-openid",
      authorization: "Bearer opaque-live",
      sessions,
    });
    expect(created.status).toBe(201);
    expect(await harness.repo.users.findByOpenid("cloud-context-openid")).not.toBeNull();
    expect(await harness.repo.users.findByOpenid(MOCK_OPENID)).toBeNull();
  });

  it("rejects a malformed code before calling jscode2session", async () => {
    const http = wechatHttp();
    const harness = makeHarness(makeConfig({ vps_auth: auth }));
    for (const code of [123, "", " ", "bad code", "a".repeat(129)]) {
      const response = await request(harness, {
        method: "POST",
        path: "/v1/auth/wechat",
        body: { code },
        sessions: memorySessions(),
        wechat_http: http,
        client_ip: "203.0.113.8",
      });
      expect(response.status).toBe(422);
      expect(response.body).toEqual(expect.objectContaining({
        code: "VALIDATION_ERROR",
        details: { field: "code" },
      }));
    }
    expect(http.getJson).not.toHaveBeenCalled();
  });

  it("rate limits POST /v1/auth/wechat per client ip before the outbound call", async () => {
    const http = wechatHttp();
    const harness = makeHarness(makeConfig({ vps_auth: auth }));
    const sessions = memorySessions();
    const max = RATE_LIMIT_DEFAULTS.wechat_login.max_requests;
    for (let attempt = 0; attempt < max; attempt += 1) {
      const response = await request(harness, {
        method: "POST",
        path: "/v1/auth/wechat",
        body: { code: loginCode },
        sessions,
        wechat_http: http,
        client_ip: "203.0.113.20",
      });
      expect(response.status).toBe(200);
    }

    const blocked = await request(harness, {
      method: "POST",
      path: "/v1/auth/wechat",
      body: { code: loginCode },
      sessions,
      wechat_http: http,
      client_ip: "203.0.113.20",
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual(expect.objectContaining({ code: "RATE_LIMITED" }));
    expect(http.getJson).toHaveBeenCalledTimes(max);

    const otherIp = await request(harness, {
      method: "POST",
      path: "/v1/auth/wechat",
      body: { code: loginCode },
      sessions,
      wechat_http: http,
      client_ip: "203.0.113.21",
    });
    expect(otherIp.status).toBe(200);
    expect(http.getJson).toHaveBeenCalledTimes(max + 1);
  });
});

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

describe("handleGatewayRequest GET /v1/profiles/:user_id", () => {
  it("[A-S6-09] rejects unknown query parameters with 422 VALIDATION_ERROR", async () => {
    const harness = makeHarness();
    const userId = newUuid();
    await harness.repo.users.insert({
      schema_version: SCHEMA_VERSION,
      user_id: userId,
      openid: `openid_${userId}`,
      unionid: null,
      nickname: "Sky",
      favorite_team_id: null,
      status: UserStatus.Active,
      career_points: 0,
      career_valid_predictions: 0,
      career_wdl_hits: 0,
      career_exact_hits: 0,
      career_level: 1,
      career_best_level: 1,
      career_last_scoring_match_at: null,
      career_level_state: defaultLevelState(),
      deleted_at: null,
      created_at: NOW,
      updated_at: NOW,
    });

    const response = await request(harness, {
      method: "GET",
      path: `/v1/profiles/${userId}`,
      query: { unexpected: "1" },
    });

    expect(response.status).toBe(422);
    expect(response.body).toEqual(expect.objectContaining({
      code: "VALIDATION_ERROR",
      request_id: expect.any(String),
    }));
  });
});

describe("handleGatewayRequest DELETE /v1/profile/me", () => {
  it("revokes every session for the deleted openid so the old bearer cannot bind a new account", async () => {
    const harness = makeHarness();
    const token = "live-session-token";
    const sessions = memorySessions([{
      token,
      openid: MOCK_OPENID,
      expires_at: new Date(NOW.getTime() + 60_000),
    }]);
    await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: { nickname: "Sky" },
      trusted_openid: MOCK_OPENID,
    });

    const deleted = await request(harness, {
      method: "DELETE",
      path: "/v1/profile/me",
      authorization: `Bearer ${token}`,
      sessions,
    });

    expect(deleted.status).toBe(204);
    expect(sessions.records).toEqual([]);
    const reused = await request(harness, {
      method: "GET",
      path: "/v1/profile/me",
      authorization: `Bearer ${token}`,
      sessions,
    });
    expect(reused.status).toBe(401);
    expect(reused.body).toEqual(expect.objectContaining({ code: "UNAUTHORIZED" }));
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

describe("handleGatewayRequest GET /v1/league-seasons", () => {
  it("allows anonymous access and returns 200 with items", async () => {
    const harness = makeHarness();
    const response = await request(harness, {
      method: "GET",
      path: "/v1/league-seasons",
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: { items: [] },
      request_id: expect.any(String),
    });
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)(
    "returns 405 for %s",
    async (method) => {
      const harness = makeHarness();
      const response = await request(harness, {
        method,
        path: "/v1/league-seasons",
      });

      expect(response.status).toBe(405);
      expect(response.body).toEqual(expect.objectContaining({
        code: "METHOD_NOT_ALLOWED",
        request_id: expect.any(String),
      }));
    },
  );

  it("applies public_reads per client ip", async () => {
    const harness = makeHarness();
    const max = RATE_LIMIT_DEFAULTS.public_reads.max_requests;
    for (let attempt = 0; attempt < max; attempt += 1) {
      const response = await request(harness, {
        method: "GET",
        path: "/v1/league-seasons",
        client_ip: "203.0.113.30",
      });
      expect(response.status).toBe(200);
    }

    const blocked = await request(harness, {
      method: "GET",
      path: "/v1/league-seasons",
      client_ip: "203.0.113.30",
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual(expect.objectContaining({ code: "RATE_LIMITED" }));

    const otherIp = await request(harness, {
      method: "GET",
      path: "/v1/league-seasons",
      client_ip: "203.0.113.31",
    });
    expect(otherIp.status).toBe(200);
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
    const harness = makeHarness(makeConfig({ mock_trusted_openid: MOCK_OPENID }));
    await request(harness, { method: "POST", path: "/v1/session/init", body: { nickname: "Sky" } });
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

describe("handleGatewayRequest GET /v1/share-card", () => {
  it("allows anonymous GET /v1/share-card/<uuid> and returns 200", async () => {
    const harness = makeHarness();
    await seedGatewayRepository(harness.repo, NOW);
    const userId = newUuid();
    await harness.repo.users.insert({
      schema_version: SCHEMA_VERSION,
      user_id: userId,
      openid: `openid_${userId}`,
      unionid: null,
      nickname: "Sharer",
      favorite_team_id: null,
      status: UserStatus.Active,
      career_points: 0,
      career_valid_predictions: 0,
      career_wdl_hits: 0,
      career_exact_hits: 0,
      career_level: 1,
      career_best_level: 1,
      career_last_scoring_match_at: null,
      career_level_state: defaultLevelState(),
      deleted_at: null,
      created_at: NOW,
      updated_at: NOW,
    });

    const response = await request(harness, {
      method: "GET",
      path: `/v1/share-card/${userId}`,
      query: {
        league_id: MVP_SEASON.league_id,
        season_id: MVP_SEASON.season_id,
        round_id: "01",
      },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: expect.objectContaining({
        user_id: userId,
        display_name: "Sharer",
        round_id: "01",
      }),
      request_id: expect.any(String),
    });
  });

  it("keeps GET /v1/share-card/me unauthenticated as 401", async () => {
    const harness = makeHarness();
    const response = await request(harness, {
      method: "GET",
      path: "/v1/share-card/me",
      query: {
        league_id: MVP_SEASON.league_id,
        season_id: MVP_SEASON.season_id,
        round_id: "01",
      },
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual(expect.objectContaining({
      code: "UNAUTHORIZED",
      request_id: expect.any(String),
    }));
  });

  it("returns 405 for POST /v1/share-card/<uuid>", async () => {
    const harness = makeHarness();
    const response = await request(harness, {
      method: "POST",
      path: `/v1/share-card/${newUuid()}`,
    });

    expect(response.status).toBe(405);
    expect(response.body).toEqual(expect.objectContaining({
      code: "METHOD_NOT_ALLOWED",
      request_id: expect.any(String),
    }));
  });

  it("applies public_reads and shares the anonymous ip bucket with league-seasons", async () => {
    const harness = makeHarness();
    await seedGatewayRepository(harness.repo, NOW);
    const userId = newUuid();
    await harness.repo.users.insert({
      schema_version: SCHEMA_VERSION,
      user_id: userId,
      openid: `openid_${userId}`,
      unionid: null,
      nickname: "Sharer",
      favorite_team_id: null,
      status: UserStatus.Active,
      career_points: 0,
      career_valid_predictions: 0,
      career_wdl_hits: 0,
      career_exact_hits: 0,
      career_level: 1,
      career_best_level: 1,
      career_last_scoring_match_at: null,
      career_level_state: defaultLevelState(),
      deleted_at: null,
      created_at: NOW,
      updated_at: NOW,
    });
    const query = {
      league_id: MVP_SEASON.league_id,
      season_id: MVP_SEASON.season_id,
      round_id: "01",
    };
    const max = RATE_LIMIT_DEFAULTS.public_reads.max_requests;
    for (let attempt = 0; attempt < max; attempt += 1) {
      const response = await request(harness, {
        method: "GET",
        path: "/v1/league-seasons",
        client_ip: "203.0.113.40",
      });
      expect(response.status).toBe(200);
    }

    const blocked = await request(harness, {
      method: "GET",
      path: `/v1/share-card/${userId}`,
      query,
      client_ip: "203.0.113.40",
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual(expect.objectContaining({ code: "RATE_LIMITED" }));

    const otherIp = await request(harness, {
      method: "GET",
      path: `/v1/share-card/${userId}`,
      query,
      client_ip: "203.0.113.41",
    });
    expect(otherIp.status).toBe(200);
  });

  it("[Q-PLAN-3 / D-S1-03] passes cursor secret to ShareCardQueryService, blocks scraping without share_token, and masks deleted users", async () => {
    const harness = makeHarness();
    await seedGatewayRepository(harness.repo, NOW);

    const sharerOpenid = "openid-share-token-sharer";
    const otherOpenid = "openid-share-token-other";
    const initSharer = await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: { nickname: "Master" },
      trusted_openid: sharerOpenid,
    });
    expect(initSharer.status).toBe(201);
    const sharerId = (initSharer.body as { data: { user_id: string } }).data.user_id;

    await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: { nickname: "Snooper" },
      trusted_openid: otherOpenid,
    });

    const listedMatches = await request(harness, {
      method: "GET",
      path: "/v1/matches",
      trusted_openid: sharerOpenid,
    });
    const matchItems = (listedMatches.body as {
      data: {
        items: Array<{
          match_id: string;
          league_id: string;
          season_id: string;
          round_id: string;
          can_predict: boolean;
        }>;
      };
    }).data.items;
    const openMatch = matchItems.find((m) => m.can_predict);
    expect(openMatch).toBeDefined();

    const submit = await request(harness, {
      method: "POST",
      path: "/v1/predictions",
      trusted_openid: sharerOpenid,
      body: {
        idempotency_key: newUuid(),
        match_id: openMatch!.match_id,
        home_score: 2,
        away_score: 0,
      },
    });
    expect(submit.status).toBe(201);

    const roundQuery = {
      league_id: openMatch!.league_id,
      season_id: openMatch!.season_id,
      round_id: openMatch!.round_id,
    };
    const meRes = await request(harness, {
      method: "GET",
      path: "/v1/share-card/me",
      trusted_openid: sharerOpenid,
      query: roundQuery,
    });
    expect(meRes.status).toBe(200);
    const meData = (meRes.body as { data: { share_token: string | null; matches: Array<{ match_id: string }> } }).data;
    expect(typeof meData.share_token).toBe("string");
    expect(meData.matches.some((m) => m.match_id === openMatch!.match_id)).toBe(true);

    // Other user or anonymous without share_token cannot see unclosed match
    const snooperRes = await request(harness, {
      method: "GET",
      path: `/v1/share-card/${sharerId}`,
      trusted_openid: otherOpenid,
      query: roundQuery,
    });
    expect(snooperRes.status).toBe(200);
    const snooperData = (snooperRes.body as { data: { share_token: string | null; matches: Array<{ match_id: string }> } }).data;
    expect(snooperData.share_token).toBeNull();
    expect(snooperData.matches.some((m) => m.match_id === openMatch!.match_id)).toBe(false);

    // Friend with valid share_token sees full round including openMatch
    const friendRes = await request(harness, {
      method: "GET",
      path: `/v1/share-card/${sharerId}`,
      query: { ...roundQuery, share_token: meData.share_token! },
    });
    expect(friendRes.status).toBe(200);
    const friendData = (friendRes.body as { data: { share_token: string | null; matches: Array<{ match_id: string }> } }).data;
    expect(friendData.share_token).toBe(meData.share_token);
    expect(friendData.matches.some((m) => m.match_id === openMatch!.match_id)).toBe(true);

    // Delete sharer: /me stays 409 USER_DELETED, public /{user_id} returns 200 masked without unclosed predictions
    const deleted = await request(harness, {
      method: "DELETE",
      path: "/v1/profile/me",
      trusted_openid: sharerOpenid,
    });
    expect(deleted.status).toBe(204);

    const meAfterDelete = await request(harness, {
      method: "GET",
      path: "/v1/share-card/me",
      trusted_openid: sharerOpenid,
      query: roundQuery,
    });
    expect(meAfterDelete.status).toBe(409);
    expect(meAfterDelete.body).toEqual(expect.objectContaining({ code: "USER_DELETED" }));

    const publicAfterDelete = await request(harness, {
      method: "GET",
      path: `/v1/share-card/${sharerId}`,
      query: { ...roundQuery, share_token: meData.share_token! },
    });
    expect(publicAfterDelete.status).toBe(200);
    expect((publicAfterDelete.body as { data: { display_name: string; share_token: null; matches: Array<{ match_id: string }> } }).data).toMatchObject({
      display_name: "已注销用户",
      favorite_team_id: null,
      share_token: null,
    });
    expect(
      (publicAfterDelete.body as { data: { matches: Array<{ match_id: string }> } }).data.matches
        .some((m) => m.match_id === openMatch!.match_id),
    ).toBe(false);
  });
});

describe("handleGatewayRequest S7 routes", () => {
  it.each([
    ["PATCH", "/v1/profile/me", { nickname: "Sky" }, 401],
    ["POST", "/v1/profile/me", { nickname: "Sky" }, 401],
    ["DELETE", "/v1/profile/me", undefined, 401],
    ["GET", "/v1/profiles/00000000-0000-4000-8000-000000000001", undefined, 404],
    ["GET", "/v1/predictions/me/00000000-0000-4000-8000-000000000001", undefined, 401],
    ["GET", "/v1/share-card/me", undefined, 401],
    ["GET", "/v1/admin/auth/me", undefined, 401],
    ["POST", "/v1/admin/auth/logout", {}, 401],
    ["POST", "/v1/admin/auth/login", { login_token: "invalid" }, 401],
    ["GET", "/v1/admin/anomalies", undefined, 401],
    ["POST", "/v1/admin/anomalies/00000000-0000-4000-8000-000000000001/resolve", { reason: "test" }, 401],
    ["GET", "/v1/admin/audit-logs", undefined, 401],
    ["GET", "/v1/admin/teams", undefined, 401],
    ["PATCH", "/v1/admin/teams/00000000-0000-4000-8000-000000000001", { name_zh: "阿森纳", reason: "test" }, 401],
    ["POST", "/v1/admin/teams/00000000-0000-4000-8000-000000000001/mappings", {
      provider: "openfoot",
      provider_team_id: "Arsenal",
      reason: "test",
    }, 401],
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
    ["POST", "/v1/auth/wechat", { code: "wx-code" }, 401],
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

describe("handleGatewayRequest internal error logging", () => {
  it("logs the original assertion on 500 without leaking it in the response", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const assertion = "career_level_state.last_eval_n <= 300";
    const harness = makeHarness();
    const response = await handleGatewayRequest({
      method: "GET",
      path: "/v1/matches",
      query: {},
      body: undefined,
      server_now: NOW,
      config: harness.config,
      request_id: "req-internal",
      services: {
        session: harness.session,
        matches: {
          list: async () => {
            throw new DomainError("INTERNAL_ERROR", assertion, { field: "last_eval_n" });
          },
          get: async () => {
            throw new Error("unused");
          },
        },
      },
      repo: harness.repo,
      rate_limiter: harness.rateLimiter,
    });

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain(assertion);
    expect(spy).toHaveBeenCalled();
    expect(JSON.stringify(spy.mock.calls)).toContain(assertion);
    spy.mockRestore();
  });
});

describe("public_reads rate limit isolation by client_ip and user_id", () => {
  it("isolates anonymous callers by client_ip so users do not share one local_v0 bucket", async () => {
    const harness = makeHarness();
    for (let i = 0; i < 120; i += 1) {
      const res = await request(harness, { method: "GET", path: "/v1/matches", client_ip: "203.0.113.10" });
      expect(res.status).toBe(200);
    }
    const blocked = await request(harness, { method: "GET", path: "/v1/matches", client_ip: "203.0.113.10" });
    expect(blocked.status).toBe(429);

    const otherIp = await request(harness, { method: "GET", path: "/v1/matches", client_ip: "203.0.113.11" });
    expect(otherIp.status).toBe(200);
  });

  it("isolates authenticated callers sharing an IP by user_id", async () => {
    const harness = makeHarness();
    const openidA = "openid-user-a";
    const openidB = "openid-user-b";
    await handleGatewayRequest({
      method: "POST",
      path: "/v1/session/init",
      query: {},
      body: { nickname: "UserA" },
      server_now: NOW,
      config: harness.config,
      trusted_openid: openidA,
      services: { session: harness.session, matches: harness.matches },
      repo: harness.repo,
      rate_limiter: harness.rateLimiter,
    });
    await handleGatewayRequest({
      method: "POST",
      path: "/v1/session/init",
      query: {},
      body: { nickname: "UserB" },
      server_now: NOW,
      config: harness.config,
      trusted_openid: openidB,
      services: { session: harness.session, matches: harness.matches },
      repo: harness.repo,
      rate_limiter: harness.rateLimiter,
    });

    for (let i = 0; i < 120; i += 1) {
      const res = await request(harness, {
        method: "GET",
        path: "/v1/matches",
        trusted_openid: openidA,
        client_ip: "198.51.100.1",
      });
      expect(res.status).toBe(200);
    }
    const blockedA = await request(harness, {
      method: "GET",
      path: "/v1/matches",
      trusted_openid: openidA,
      client_ip: "198.51.100.1",
    });
    expect(blockedA.status).toBe(429);

    const allowedB = await request(harness, {
      method: "GET",
      path: "/v1/matches",
      trusted_openid: openidB,
      client_ip: "198.51.100.1",
    });
    expect(allowedB.status).toBe(200);
  });

  it("returns 405 for a known path before an invalid bearer is parsed", async () => {
    const harness = makeHarness(makeConfig({ environment: "prod" }));
    const response = await request(harness, {
      method: "POST",
      path: "/v1/matches",
      authorization: "Bearer missing",
      sessions: memorySessions(),
    });
    expect(response.status).toBe(405);
    expect(response.body).toEqual(expect.objectContaining({ code: "METHOD_NOT_ALLOWED" }));
  });

  it.each([
    ["GET", "/v1/auth/wechat"],
    ["GET", "/v1/session/init"],
    ["POST", "/v1/leagues/status"],
    ["PUT", "/v1/matches/00000000-0000-4000-8000-000000000001"],
    ["POST", "/v1/matches/00000000-0000-4000-8000-000000000001/crowd"],
    ["GET", "/v1/predictions"],
    ["POST", "/v1/predictions/summary"],
    ["POST", "/v1/predictions/me"],
    ["PUT", "/v1/profile/me"],
    ["POST", "/v1/profiles/00000000-0000-4000-8000-000000000001"],
    ["POST", "/v1/levels/me"],
    ["POST", "/v1/unlocks/me"],
    ["POST", "/v1/rankings"],
    ["POST", "/v1/share-card/me"],
    ["POST", "/v1/admin/anomalies"],
    ["GET", "/v1/admin/auth/login"],
    ["POST", "/v1/admin/auth/me"],
    ["GET", "/v1/admin/auth/logout"],
    ["GET", "/v1/admin/anomalies/00000000-0000-4000-8000-000000000001/resolve"],
    ["POST", "/v1/admin/audit-logs"],
    ["POST", "/v1/admin/teams"],
    ["GET", "/v1/admin/teams/00000000-0000-4000-8000-000000000001"],
    ["GET", "/v1/admin/teams/00000000-0000-4000-8000-000000000001/mappings"],
    ["GET", "/v1/admin/matches/00000000-0000-4000-8000-000000000001/result-corrections"],
    ["GET", "/v1/admin/rebuild/users/00000000-0000-4000-8000-000000000001"],
    ["GET", "/v1/admin/rebuild/rankings"],
    ["GET", "/v1/groups"],
    ["GET", "/v1/groups/join"],
    ["GET", "/v1/groups/00000000-0000-4000-8000-000000000001/leave"],
    ["POST", "/v1/groups/me"],
    ["PUT", "/v1/groups/00000000-0000-4000-8000-000000000001"],
  ] as const)("returns 405 for %s %s", async (method, path) => {
    const harness = makeHarness();
    const response = await request(harness, { method, path });
    expect(response.status).toBe(405);
    expect(response.body).toEqual(expect.objectContaining({
      code: "METHOD_NOT_ALLOWED",
      message: "方法不允许",
      request_id: expect.any(String),
    }));
  });

  it("keeps an unknown path at 422", async () => {
    const harness = makeHarness();
    const response = await request(harness, { method: "GET", path: "/v1/unknown" });
    expect(response.status).toBe(422);
    expect(response.body).toEqual(expect.objectContaining({
      code: "VALIDATION_ERROR",
      message: "不支持的请求",
    }));
  });

  it("returns 401 when a public read carries an invalid bearer", async () => {
    const harness = makeHarness(makeConfig({ environment: "prod" }));
    const sessions = memorySessions();
    const userId = "00000000-0000-4000-8000-000000000001";
    for (const path of [
      "/v1/matches",
      "/v1/leagues/status",
      "/v1/league-seasons",
      `/v1/matches/${userId}`,
      `/v1/profiles/${userId}`,
      `/v1/share-card/${userId}`,
    ]) {
      const response = await request(harness, {
        method: "GET",
        path,
        authorization: "Bearer missing",
        sessions,
      });
      expect(response.status).toBe(401);
      expect(response.body).toEqual(expect.objectContaining({ code: "UNAUTHORIZED" }));
    }
  });

  it("does not pre-parse bearer on POST /v1/auth/wechat", async () => {
    const sessions = memorySessions();
    const harness = makeHarness(makeConfig({ vps_auth: {
      wechat_app_id: "wx-test-appid",
      wechat_app_secret: "wx-test-secret-must-not-leak",
      session_ttl_seconds: 120,
    } }));
    const response = await request(harness, {
      method: "POST",
      path: "/v1/auth/wechat",
      body: { code: "wx-one-time-code" },
      authorization: "Bearer missing",
      sessions,
      wechat_http: wechatHttp(),
    });
    expect(response.status).toBe(200);
  });

  it("extractClientIp honors forwarded headers only from loopback proxies", () => {
    expect(extractClientIp({
      socket: { remoteAddress: "127.0.0.1" },
      headers: { "x-forwarded-for": "198.51.100.42, 10.0.0.1" },
    } as never)).toBe("198.51.100.42");
    expect(extractClientIp({
      socket: { remoteAddress: "::ffff:127.0.0.1" },
      headers: { "x-real-ip": "203.0.113.99" },
    } as never)).toBe("203.0.113.99");
    expect(extractClientIp({
      socket: { remoteAddress: "198.51.100.7" },
      headers: { "x-forwarded-for": "1.2.3.4" },
    } as never)).toBe("198.51.100.7");
  });

  it("[CR-15] rejects unknown query parameters on routes that accept no query params", async () => {
    const harness = makeHarness();
    const uuid = "00000000-0000-4000-8000-000000000901";
    const routes = [
      { method: "POST", path: "/v1/auth/wechat" },
      { method: "POST", path: "/v1/session/init" },
      { method: "POST", path: "/v1/predictions" },
      { method: "PATCH", path: "/v1/profile/me" },
      { method: "POST", path: "/v1/profile/me" },
      { method: "DELETE", path: "/v1/profile/me" },
      { method: "POST", path: "/v1/groups" },
      { method: "POST", path: "/v1/groups/join" },
      { method: "POST", path: `/v1/groups/${uuid}/leave` },
      { method: "GET", path: `/v1/groups/${uuid}` },
      { method: "DELETE", path: `/v1/groups/${uuid}` },
    ];
    for (const route of routes) {
      const response = await request(harness, {
        method: route.method,
        path: route.path,
        query: { unexpected_q: "1" },
      });
      expect(response.status, `${route.method} ${route.path}`).toBe(422);
      expect(response.body).toEqual(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    }
  });
});

describe("memorySessions deleteByOpenid", () => {
  it("removes every session for the openid and leaves others", async () => {
    const sessions = memorySessions([
      { token: "a1", openid: MOCK_OPENID, expires_at: new Date(NOW.getTime() - 1000) },
      { token: "a2", openid: MOCK_OPENID, expires_at: new Date(NOW.getTime() + 1000) },
      { token: "b1", openid: "other-openid", expires_at: NOW },
    ]);

    await expect(sessions.deleteByOpenid(MOCK_OPENID)).resolves.toBe(2);
    expect(sessions.records.map((item) => item.token)).toEqual(["b1"]);
    await expect(sessions.deleteByOpenid(` ${MOCK_OPENID}`)).rejects.toThrow(/openid is required/);
    expect(sessions.records).toHaveLength(1);
  });
});
