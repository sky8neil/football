import { describe, expect, it } from "vitest";
import {
  InMemoryRateLimiter,
  RATE_LIMIT_DEFAULTS,
} from "../api/v1/rate-limit.js";
import { MatchQueryService } from "../application/match-query.js";
import { SessionService } from "../application/session.js";
import { SCHEMA_VERSION, UserStatus } from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { handleGatewayRequest, type GatewayRequestInput } from "./assemble.js";
import { LOCAL_PUBLIC_SOURCE, type GatewayRuntimeConfig } from "./config.js";
import { seedGatewayRepository } from "./seed.js";
import { MVP_SEASON } from "../domain/config.js";

const TEST_CURSOR_SECRET = "test-match-cursor-secret-v6";
const MOCK_OPENID = "mock-openid-v6";
const DELETED_OPENID = "mock-openid-v6-deleted";
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

/**
 * D-P1 方案 B 夹具：注销用户按新模型建模——users 主记录墓碑 openid，
 * 原 openid 只存在于 deleted_openid_mappings（不可登录、只供可信 openid 解析）。
 * 废除「deleted 仍持原 openid」的旧夹具。
 */
async function seedDeletedUserWithMapping(
  repo: InMemoryRepository,
  originalOpenid: string,
): Promise<{ user_id: string; originalOpenid: string }> {
  const user_id = newUuid();
  await repo.users.insert({
    schema_version: SCHEMA_VERSION,
    user_id,
    openid: `deleted:${user_id}`,
    unionid: null,
    nickname: null,
    favorite_team_id: null,
    status: UserStatus.Deleted,
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_level: 1,
    career_best_level: 1,
    deleted_at: NOW,
    created_at: NOW,
    updated_at: NOW,
  });
  await repo.deletedOpenidMappings.upsert({
    schema_version: SCHEMA_VERSION,
    original_openid: originalOpenid,
    deleted_user_id: user_id,
    deleted_at: NOW,
    created_at: NOW,
    updated_at: NOW,
  });
  return { user_id, originalOpenid };
}

/** 按方案 B 把 active 用户改写为「墓碑 users + mapping」的注销态（供重放测试）。 */
async function tombstoneWithMapping(
  repo: InMemoryRepository,
  userId: string,
  originalOpenid: string,
): Promise<void> {
  const current = await repo.users.findById(userId);
  if (current === null) {
    throw new Error("expected seeded user");
  }
  await repo.users.update({
    ...current,
    openid: `deleted:${userId}`,
    unionid: null,
    nickname: null,
    favorite_team_id: null,
    status: UserStatus.Deleted,
    deleted_at: NOW,
    updated_at: NOW,
  });
  await repo.deletedOpenidMappings.upsert({
    schema_version: SCHEMA_VERSION,
    original_openid: originalOpenid,
    deleted_user_id: userId,
    deleted_at: NOW,
    created_at: NOW,
    updated_at: NOW,
  });
}

function fillRateLimitWindow(
  limiter: InMemoryRateLimiter,
  scope: "authenticated_reads" | "public_reads",
  identity: string,
  serverNow: Date,
): void {
  const max = RATE_LIMIT_DEFAULTS[scope].max_requests;
  for (let attempt = 0; attempt < max; attempt += 1) {
    limiter.check(scope, identity, serverNow);
  }
}

describe("S4 deleted user（D-P1 方案 B）", () => {
  it("D7：session init 使用已注销 openid → 创建全新 active 用户 201（不再 409）", async () => {
    const harness = makeHarness(makeConfig({ mock_trusted_openid: DELETED_OPENID }));
    const old = await seedDeletedUserWithMapping(harness.repo, DELETED_OPENID);

    const response = await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: { nickname: "Sky" },
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual(expect.objectContaining({
      data: expect.objectContaining({
        user_id: expect.not.stringMatching(old.user_id),
        status: "active",
      }),
      request_id: expect.any(String),
    }));
    const users = await harness.repo.users.findAll();
    expect(users).toHaveLength(2);
    const oldUser = users.find((u) => u.user_id === old.user_id);
    expect(oldUser?.status).toBe(UserStatus.Deleted);
    expect(oldUser?.openid).toBe(`deleted:${old.user_id}`);
    // mapping 保持指向旧 deleted_user_id；active 优先保证隔离。
    const mapping = await harness.repo.deletedOpenidMappings.findByOriginalOpenid(DELETED_OPENID);
    expect(mapping?.deleted_user_id).toBe(old.user_id);
  });

  it("D2：GET /v1/profile/me → 409 USER_DELETED", async () => {
    const harness = makeHarness(makeConfig({ mock_trusted_openid: DELETED_OPENID }));
    await seedDeletedUserWithMapping(harness.repo, DELETED_OPENID);

    const response = await request(harness, { method: "GET", path: "/v1/profile/me" });
    expect(response.status).toBe(409);
    expect(response.body).toEqual(expect.objectContaining({
      code: "USER_DELETED",
      request_id: expect.any(String),
    }));
  });

  it("D2：GET /v1/predictions/me → 409 USER_DELETED", async () => {
    const harness = makeHarness(makeConfig({ mock_trusted_openid: DELETED_OPENID }));
    await seedDeletedUserWithMapping(harness.repo, DELETED_OPENID);

    const response = await request(harness, { method: "GET", path: "/v1/predictions/me" });
    expect(response.status).toBe(409);
    expect(response.body).toEqual(expect.objectContaining({
      code: "USER_DELETED",
      request_id: expect.any(String),
    }));
  });

  it("D2：GET /v1/unlocks/me → 409 USER_DELETED", async () => {
    const harness = makeHarness(makeConfig({ mock_trusted_openid: DELETED_OPENID }));
    await seedDeletedUserWithMapping(harness.repo, DELETED_OPENID);

    const response = await request(harness, { method: "GET", path: "/v1/unlocks/me" });
    expect(response.status).toBe(409);
    expect(response.body).toEqual(expect.objectContaining({
      code: "USER_DELETED",
      request_id: expect.any(String),
    }));
  });

  it("D2：GET /v1/levels/me → 409 USER_DELETED", async () => {
    const harness = makeHarness(makeConfig({ mock_trusted_openid: DELETED_OPENID }));
    await seedDeletedUserWithMapping(harness.repo, DELETED_OPENID);

    const response = await request(harness, { method: "GET", path: "/v1/levels/me" });
    expect(response.status).toBe(409);
    expect(response.body).toEqual(expect.objectContaining({
      code: "USER_DELETED",
      request_id: expect.any(String),
    }));
  });

  it("D5：POST /v1/predictions 新 key → 409 USER_DELETED", async () => {
    const harness = makeHarness(makeConfig({ mock_trusted_openid: DELETED_OPENID }));
    await seedDeletedUserWithMapping(harness.repo, DELETED_OPENID);
    await seedGatewayRepository(harness.repo, NOW);
    const matches = await harness.repo.matches.findBySeason(MVP_SEASON.season_id);
    const match = matches[0];
    if (match === undefined) {
      throw new Error("expected seeded match");
    }

    const response = await request(harness, {
      method: "POST",
      path: "/v1/predictions",
      body: {
        idempotency_key: newUuid(),
        match_id: match.match_id,
        home_score: 2,
        away_score: 1,
      },
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual(expect.objectContaining({
      code: "USER_DELETED",
      request_id: expect.any(String),
    }));
  });

  it("D6：GET /v1/matches → 200 + can_predict_reason=USER_DELETED", async () => {
    const harness = makeHarness(makeConfig({ mock_trusted_openid: DELETED_OPENID }));
    await seedDeletedUserWithMapping(harness.repo, DELETED_OPENID);
    await seedGatewayRepository(harness.repo, NOW);

    const response = await request(harness, { method: "GET", path: "/v1/matches" });
    expect(response.status).toBe(200);
    const body = response.body as {
      data: { items: Array<{ can_predict: boolean; can_predict_reason: string | null }> };
    };
    expect(body.data.items.length).toBeGreaterThan(0);
    for (const item of body.data.items) {
      expect(item.can_predict).toBe(false);
      expect(item.can_predict_reason).toBe("USER_DELETED");
    }
  });

  it("D6：GET /v1/matches/:id → 200 + reason=USER_DELETED + my_prediction=null", async () => {
    const harness = makeHarness(makeConfig({ mock_trusted_openid: DELETED_OPENID }));
    await seedDeletedUserWithMapping(harness.repo, DELETED_OPENID);
    await seedGatewayRepository(harness.repo, NOW);
    const matches = await harness.repo.matches.findBySeason(MVP_SEASON.season_id);
    const match = matches[0];
    if (match === undefined) {
      throw new Error("expected seeded match");
    }

    const response = await request(harness, {
      method: "GET",
      path: `/v1/matches/${match.match_id}`,
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      data: expect.objectContaining({
        can_predict: false,
        can_predict_reason: "USER_DELETED",
        my_prediction: null,
      }),
    }));
  });

  it("returns 200 public matches for an unregistered openid", async () => {
    const harness = makeHarness(makeConfig({ mock_trusted_openid: "mock-openid-v6-unregistered" }));
    await seedGatewayRepository(harness.repo, NOW);

    const response = await request(harness, { method: "GET", path: "/v1/matches" });
    expect(response.status).toBe(200);
  });

  it("D14：无 trusted openid → 公开 matches 200 且 reason=AUTH_REQUIRED；私有 401", async () => {
    const harness = makeHarness(makeConfig({ mock_trusted_openid: null }));
    await seedGatewayRepository(harness.repo, NOW);

    const matches = await request(harness, { method: "GET", path: "/v1/matches" });
    expect(matches.status).toBe(200);
    const body = matches.body as {
      data: { items: Array<{ can_predict: boolean; can_predict_reason: string | null }> };
    };
    for (const item of body.data.items) {
      expect(item.can_predict).toBe(false);
      expect(item.can_predict_reason).toBe("AUTH_REQUIRED");
    }

    const profile = await request(harness, { method: "GET", path: "/v1/profile/me" });
    expect(profile.status).toBe(401);
    expect(profile.body).toEqual(expect.objectContaining({ code: "UNAUTHORIZED" }));
  });

  it("D3：注销后同 key+同 payload 重放返回 200 首次结果", async () => {
    const openid = "mock-openid-v6-replay";
    const harness = makeHarness(makeConfig({ mock_trusted_openid: openid }));
    const session = await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: { nickname: "Replayer" },
    });
    expect(session.status).toBe(201);
    const userId = (session.body as { data: { user_id: string } }).data.user_id;

    await seedGatewayRepository(harness.repo, NOW);
    const matches = await harness.repo.matches.findBySeason(MVP_SEASON.season_id);
    const match = matches[0];
    if (match === undefined) {
      throw new Error("expected seeded match");
    }
    const key = newUuid();
    const body = {
      idempotency_key: key,
      match_id: match.match_id,
      home_score: 2,
      away_score: 1,
    };

    const first = await request(harness, {
      method: "POST",
      path: "/v1/predictions",
      body,
    });
    expect(first.status).toBe(201);

    await tombstoneWithMapping(harness.repo, userId, openid);

    const replay = await request(harness, {
      method: "POST",
      path: "/v1/predictions",
      body,
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(expect.objectContaining({
      data: expect.objectContaining({
        prediction_id: (first.body as { data: { prediction_id: string } }).data.prediction_id,
      }),
      request_id: expect.any(String),
    }));
  });

  it("D4：注销后同 key 异 payload → 409 IDEMPOTENCY_KEY_REUSED", async () => {
    const openid = "mock-openid-v6-replay-conflict";
    const harness = makeHarness(makeConfig({ mock_trusted_openid: openid }));
    const session = await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: { nickname: "Replayer" },
    });
    expect(session.status).toBe(201);
    const userId = (session.body as { data: { user_id: string } }).data.user_id;

    await seedGatewayRepository(harness.repo, NOW);
    const matches = await harness.repo.matches.findBySeason(MVP_SEASON.season_id);
    const match = matches[0];
    if (match === undefined) {
      throw new Error("expected seeded match");
    }
    const key = newUuid();
    const body = {
      idempotency_key: key,
      match_id: match.match_id,
      home_score: 2,
      away_score: 1,
    };

    const first = await request(harness, {
      method: "POST",
      path: "/v1/predictions",
      body,
    });
    expect(first.status).toBe(201);

    await tombstoneWithMapping(harness.repo, userId, openid);

    const conflict = await request(harness, {
      method: "POST",
      path: "/v1/predictions",
      body: { ...body, away_score: 0 },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual(expect.objectContaining({
      code: "IDEMPOTENCY_KEY_REUSED",
      request_id: expect.any(String),
    }));
  });

  it("D8：重注册新用户后 GET /v1/predictions/me 看不到旧预测", async () => {
    const openid = "mock-openid-v6-rereg";
    const harness = makeHarness(makeConfig({ mock_trusted_openid: openid }));
    const session = await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: { nickname: "Old" },
    });
    expect(session.status).toBe(201);
    const oldUserId = (session.body as { data: { user_id: string } }).data.user_id;

    await seedGatewayRepository(harness.repo, NOW);
    const matches = await harness.repo.matches.findBySeason(MVP_SEASON.season_id);
    const match = matches[0];
    if (match === undefined) {
      throw new Error("expected seeded match");
    }
    const submitted = await request(harness, {
      method: "POST",
      path: "/v1/predictions",
      body: {
        idempotency_key: newUuid(),
        match_id: match.match_id,
        home_score: 2,
        away_score: 1,
      },
    });
    expect(submitted.status).toBe(201);

    await tombstoneWithMapping(harness.repo, oldUserId, openid);

    const rereg = await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: { nickname: "New" },
    });
    expect(rereg.status).toBe(201);
    const newUserId = (rereg.body as { data: { user_id: string } }).data.user_id;
    expect(newUserId).not.toBe(oldUserId);

    const mine = await request(harness, {
      method: "GET",
      path: "/v1/predictions/me",
    });
    expect(mine.status).toBe(200);
    const mineBody = mine.body as { data: { items: unknown[] } };
    expect(mineBody.data.items).toEqual([]);
  });
});

describe("S5 session init 429 and 422", () => {
  it("returns 429 RATE_LIMITED after the authenticated_reads window is full", async () => {
    const harness = makeHarness(makeConfig({ mock_trusted_openid: MOCK_OPENID }));
    fillRateLimitWindow(
      harness.rateLimiter,
      "authenticated_reads",
      MOCK_OPENID,
      NOW,
    );

    const response = await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: { nickname: "Sky" },
    });

    expect(response.status).toBe(429);
    expect(response.body).toEqual(expect.objectContaining({
      code: "RATE_LIMITED",
      request_id: expect.any(String),
    }));
  });

  it("returns 422 VALIDATION_ERROR when nickname is not a string or is too long", async () => {
    const harness = makeHarness(makeConfig({ mock_trusted_openid: MOCK_OPENID }));

    const notString = await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: { nickname: 1 },
    });
    expect(notString.status).toBe(422);
    expect(notString.body).toEqual(expect.objectContaining({
      code: "VALIDATION_ERROR",
      request_id: expect.any(String),
    }));

    const tooLong = await request(harness, {
      method: "POST",
      path: "/v1/session/init",
      body: { nickname: "n".repeat(33) },
    });
    expect(tooLong.status).toBe(422);
    expect(tooLong.body).toEqual(expect.objectContaining({
      code: "VALIDATION_ERROR",
      request_id: expect.any(String),
    }));
  });
});

describe("M14 public_reads rate limit", () => {
  // Unknown path 422 + code/request_id is already covered in assemble.test.ts.

  it("returns 429 RATE_LIMITED after the public_reads window is full", async () => {
    const harness = makeHarness();
    fillRateLimitWindow(
      harness.rateLimiter,
      "public_reads",
      LOCAL_PUBLIC_SOURCE,
      NOW,
    );

    const response = await request(harness, {
      method: "GET",
      path: "/v1/matches",
    });

    expect(response.status).toBe(429);
    expect(response.body).toEqual(expect.objectContaining({
      code: "RATE_LIMITED",
      request_id: expect.any(String),
    }));
  });
});
