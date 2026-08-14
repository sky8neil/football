import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter } from "../api/v1/rate-limit.js";
import { SessionService } from "../application/session.js";
import { MatchQueryService } from "../application/match-query.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { handleGatewayRequest, resolveIdentity } from "./assemble.js";
import {
  LOCAL_PUBLIC_SOURCE,
  loadGatewayRuntimeConfig,
  type GatewayRuntimeConfig,
} from "./config.js";
import { resolveTrustedOpenid } from "./identity.js";

const TEST_CURSOR_SECRET = "test-match-cursor-secret";
const MOCK_OPENID = "mock-openid-identity";
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

describe("resolveTrustedOpenid", () => {
  it("injects a non-empty mock openid in dev and test", () => {
    expect(
      resolveTrustedOpenid(makeConfig({
        environment: "dev",
        mock_trusted_openid: MOCK_OPENID,
      })),
    ).toBe(MOCK_OPENID);
    expect(
      resolveTrustedOpenid(makeConfig({
        environment: "test",
        mock_trusted_openid: MOCK_OPENID,
      })),
    ).toBe(MOCK_OPENID);
  });

  it("treats a missing or empty mock openid as null in dev and test", () => {
    expect(resolveTrustedOpenid(makeConfig({ environment: "dev" }))).toBeNull();
    expect(
      resolveTrustedOpenid(makeConfig({
        environment: "test",
        mock_trusted_openid: "",
      })),
    ).toBeNull();
    expect(
      resolveTrustedOpenid(makeConfig({
        environment: "dev",
        mock_trusted_openid: "   ",
      })),
    ).toBeNull();
  });

  it("discards the mock key in prod even when it is set", () => {
    expect(
      resolveTrustedOpenid(makeConfig({
        environment: "prod",
        mock_trusted_openid: MOCK_OPENID,
      })),
    ).toBeNull();
  });

  it("loads mock openid from env only in dev/test and never in prod", () => {
    expect(
      loadGatewayRuntimeConfig({
        FOOTBALL_ENVIRONMENT: "dev",
        FOOTBALL_MATCH_CURSOR_SECRET: TEST_CURSOR_SECRET,
        FOOTBALL_MOCK_TRUSTED_OPENID: MOCK_OPENID,
      }).mock_trusted_openid,
    ).toBe(MOCK_OPENID);
    expect(
      loadGatewayRuntimeConfig({
        FOOTBALL_ENVIRONMENT: "test",
        FOOTBALL_MATCH_CURSOR_SECRET: TEST_CURSOR_SECRET,
        FOOTBALL_MOCK_TRUSTED_OPENID: "",
      }).mock_trusted_openid,
    ).toBeNull();
    expect(
      loadGatewayRuntimeConfig({
        FOOTBALL_ENVIRONMENT: "prod",
        FOOTBALL_MATCH_CURSOR_SECRET: TEST_CURSOR_SECRET,
        FOOTBALL_MOCK_TRUSTED_OPENID: MOCK_OPENID,
      }).mock_trusted_openid,
    ).toBeNull();
  });
});

describe("prod identity isolation", () => {
  it("returns 401 UNAUTHORIZED for session init when prod is given the same mock key", async () => {
    const config = makeConfig({
      environment: "prod",
      mock_trusted_openid: MOCK_OPENID,
    });
    const repo = new InMemoryRepository();
    const response = await handleGatewayRequest({
      method: "POST",
      path: "/v1/session/init",
      query: {},
      body: { nickname: "Sky" },
      server_now: NOW,
      config,
      services: {
        session: new SessionService(repo),
        matches: new MatchQueryService(repo, config.match_cursor_secret),
      },
      repo,
      rate_limiter: new InMemoryRateLimiter(),
    });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      code: "UNAUTHORIZED",
      request_id: expect.any(String),
    });
    expect(await repo.users.findAll()).toEqual([]);
  });
});

describe("resolveIdentity（D-P1 方案 B，§4.5.1）", () => {
  const NOW = new Date("2026-08-09T12:00:00.000Z");

  function makeUser(overrides: Partial<Parameters<InMemoryRepository["users"]["insert"]>[0]> = {}) {
    return {
      schema_version: 1,
      user_id: "00000000-0000-4000-8000-000000000001",
      openid: "openid-resolve-active",
      unionid: null,
      nickname: "Sky",
      favorite_team_id: null,
      status: "active" as const,
      career_points: 0,
      career_valid_predictions: 0,
      career_wdl_hits: 0,
      career_exact_hits: 0,
      career_level: 1,
      career_best_level: 1,
      deleted_at: null,
      created_at: NOW,
      updated_at: NOW,
      ...overrides,
    };
  }

  it("无可信 openid → anonymous", async () => {
    const repo = new InMemoryRepository();
    await expect(resolveIdentity(null, repo)).resolves.toEqual({ kind: "anonymous" });
  });

  it("D7：active 用户优先于任何旧 deleted mapping", async () => {
    const repo = new InMemoryRepository();
    const openid = "openid-resolve-active";
    const active = makeUser({ openid });
    await repo.users.insert(active);
    await repo.deletedOpenidMappings.upsert({
      schema_version: 1,
      original_openid: openid,
      deleted_user_id: "00000000-0000-4000-8000-000000000099",
      deleted_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    });
    await expect(resolveIdentity(openid, repo)).resolves.toEqual({
      kind: "active",
      openid,
      user_id: active.user_id,
    });
  });

  it("无 active 但 mapping 命中 → deleted（携带旧 user_id）", async () => {
    const repo = new InMemoryRepository();
    const openid = "openid-resolve-deleted";
    const oldUserId = "00000000-0000-4000-8000-000000000042";
    await repo.users.insert({
      ...makeUser({ openid: `deleted:${oldUserId}` }),
      user_id: oldUserId,
      status: "deleted",
      nickname: null,
      deleted_at: NOW,
    });
    await repo.deletedOpenidMappings.upsert({
      schema_version: 1,
      original_openid: openid,
      deleted_user_id: oldUserId,
      deleted_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    });
    await expect(resolveIdentity(openid, repo)).resolves.toEqual({
      kind: "deleted",
      openid,
      user_id: oldUserId,
    });
  });

  it("均无 → unregistered（mapping 不影响未注册判定）", async () => {
    const repo = new InMemoryRepository();
    await expect(resolveIdentity("openid-resolve-unregistered", repo)).resolves.toEqual({
      kind: "unregistered",
      openid: "openid-resolve-unregistered",
    });
  });

  it("D11：无 mapping 的历史墓碑用户 → unregistered（原 openid 不被误判 deleted）", async () => {
    const repo = new InMemoryRepository();
    const oldUserId = "00000000-0000-4000-8000-000000000043";
    await repo.users.insert({
      ...makeUser({ openid: `deleted:${oldUserId}` }),
      user_id: oldUserId,
      status: "deleted",
      nickname: null,
      deleted_at: NOW,
    });
    await expect(resolveIdentity("openid-legacy-no-mapping", repo)).resolves.toEqual({
      kind: "unregistered",
      openid: "openid-legacy-no-mapping",
    });
  });

  it("D10：迁移前脏数据（users 仍挂原 openid 且 deleted）→ 仍解析为 deleted", async () => {
    const repo = new InMemoryRepository();
    const openid = "openid-resolve-dirty";
    const dirtyUserId = "00000000-0000-4000-8000-000000000044";
    await repo.users.insert({
      ...makeUser({ openid }),
      user_id: dirtyUserId,
      status: "deleted",
      nickname: null,
      deleted_at: NOW,
    });
    await expect(resolveIdentity(openid, repo)).resolves.toEqual({
      kind: "deleted",
      openid,
      user_id: dirtyUserId,
    });
  });
});
