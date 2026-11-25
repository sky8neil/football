import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryRateLimiter, RATE_LIMIT_DEFAULTS } from "../api/v1/rate-limit.js";
import { MatchQueryService } from "../application/match-query.js";
import { SessionService } from "../application/session.js";
import { AdminRole, AdminStatus, AnomalyStatus, AnomalyType, LeagueId, TeamStatus } from "../domain/enums.js";
import type { Admin, Anomaly, Team } from "../domain/types.js";
import {
  createInMemoryAdminConsumedJtiStore,
  createInMemoryAuthSessionStore,
} from "../infrastructure/postgres-auth-sessions.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { issueAdminLoginToken } from "./admin-auth.js";
import { handleGatewayRequest } from "./assemble.js";
import { LOCAL_PUBLIC_SOURCE, type GatewayRuntimeConfig } from "./config.js";
import { startGatewayServer } from "./http.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const SECRET = "gateway-admin-auth-secret";
const ADMIN_OPENID = "wx-admin-web-openid";
const ADMIN_ID = "00000000-0000-4000-8000-000000000001";

function makeConfig(overrides: Partial<GatewayRuntimeConfig> = {}): GatewayRuntimeConfig {
  return {
    environment: "prod",
    mock_trusted_openid: null,
    match_cursor_secret: SECRET,
    public_source: LOCAL_PUBLIC_SOURCE,
    repository_backend: "memory",
    cloudbase_repository: null,
    postgres_repository: null,
    vps_auth: {
      wechat_app_id: "wx-app",
      wechat_app_secret: "wx-secret",
      session_ttl_seconds: 604800,
    },
    deploy_target: "vps",
    ranking_first_period_key: "2026-W31",
    ...overrides,
  };
}

function makeAdmin(overrides: Partial<Admin> = {}): Admin {
  return {
    schema_version: 1,
    admin_id: ADMIN_ID,
    openid: ADMIN_OPENID,
    status: AdminStatus.Active,
    role: AdminRole.Admin,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeHarness(config: GatewayRuntimeConfig = makeConfig()) {
  const repo = new InMemoryRepository();
  const rateLimiter = new InMemoryRateLimiter();
  const sessions = createInMemoryAuthSessionStore();
  const consumedJtis = new Map<string, number>();
  const services = {
    session: new SessionService(repo),
    matches: new MatchQueryService(repo, config.match_cursor_secret),
  };
  return {
    repo,
    rateLimiter,
    sessions,
    consumedJtis,
    config,
    request(input: {
      method: string;
      path: string;
      query?: Record<string, string>;
      body?: unknown;
      authorization?: string;
      client_ip?: string;
      now?: Date;
    }) {
      return handleGatewayRequest({
        method: input.method,
        path: input.path,
        query: input.query ?? {},
        body: input.body,
        server_now: input.now ?? NOW,
        config,
        sessions,
        admin_consumed_jtis: consumedJtis,
        services,
        repo,
        rate_limiter: rateLimiter,
        ...(input.authorization !== undefined ? { authorization: input.authorization } : {}),
        ...(input.client_ip !== undefined ? { client_ip: input.client_ip } : {}),
      });
    },
  };
}

describe("Web Admin Auth & Gateway Integration", () => {
  it("通过短期签名登录令牌签发 SHA-256 会话、校验 /me、禁止重放并支持登出吊销", async () => {
    const harness = makeHarness();
    await harness.repo.admins.insert(makeAdmin());

    const issued = issueAdminLoginToken({
      openid: ADMIN_OPENID,
      secret: SECRET,
      now: NOW,
      ttlSeconds: 300,
    });

    const loginRes = await harness.request({
      method: "POST",
      path: "/v1/admin/auth/login",
      body: { login_token: issued.login_token },
      client_ip: "198.51.100.10",
    });
    expect(loginRes.status).toBe(200);
    const loginData = (loginRes.body as { data: { access_token: string; token_type: string; admin: unknown } }).data;
    expect(loginData.token_type).toBe("Bearer");
    expect(loginData.admin).toEqual({
      admin_id: ADMIN_ID,
      role: AdminRole.Admin,
      status: AdminStatus.Active,
    });
    expect(JSON.stringify(loginRes.body)).not.toContain(ADMIN_OPENID);

    // 验证仅存 SHA-256 摘要且可用该 token 访问 /me 与 admin API
    const meRes = await harness.request({
      method: "GET",
      path: "/v1/admin/auth/me",
      authorization: `Bearer ${loginData.access_token}`,
    });
    expect(meRes.status).toBe(200);
    expect((meRes.body as { data: unknown }).data).toEqual({
      admin_id: ADMIN_ID,
      role: AdminRole.Admin,
      status: AdminStatus.Active,
    });

    // 重放同一次 login_token 必须拒绝
    const replayRes = await harness.request({
      method: "POST",
      path: "/v1/admin/auth/login",
      body: { login_token: issued.login_token },
      client_ip: "198.51.100.11",
    });
    expect(replayRes.status).toBe(401);
    expect(replayRes.body).toMatchObject({ code: "UNAUTHORIZED" });

    // 登出仅吊销当前会话 token
    const otherSession = await harness.sessions.create({
      openid: ADMIN_OPENID,
      now: NOW,
      ttlSeconds: 3600,
    });
    const logoutRes = await harness.request({
      method: "POST",
      path: "/v1/admin/auth/logout",
      body: {},
      authorization: `Bearer ${loginData.access_token}`,
    });
    expect(logoutRes.status).toBe(204);

    const afterLogoutMe = await harness.request({
      method: "GET",
      path: "/v1/admin/auth/me",
      authorization: `Bearer ${loginData.access_token}`,
    });
    expect(afterLogoutMe.status).toBe(401);

    // 其他会话（如小程序会话）不受登出影响
    expect(
      await harness.sessions.findActiveByToken({ token: otherSession.token, now: NOW }),
    ).not.toBeNull();
    expect(
      createHash("sha256").update(loginData.access_token).digest("hex"),
    ).not.toBe(loginData.access_token);
  });

  it("禁用管理员后：既拒绝新登录，也实时拦截已签发的未过期会话", async () => {
    const harness = makeHarness();
    const admin = makeAdmin();
    await harness.repo.admins.insert(admin);
    const issued = issueAdminLoginToken({ openid: ADMIN_OPENID, secret: SECRET, now: NOW });

    const loginRes = await harness.request({
      method: "POST",
      path: "/v1/admin/auth/login",
      body: { login_token: issued.login_token },
      client_ip: "198.51.100.20",
    });
    const token = (loginRes.body as { data: { access_token: string } }).data.access_token;

    // 管理员被禁用
    await harness.repo.admins.update({ ...admin, status: AdminStatus.Disabled, updated_at: NOW });

    const blockedMe = await harness.request({
      method: "GET",
      path: "/v1/admin/auth/me",
      authorization: `Bearer ${token}`,
    });
    expect(blockedMe.status).toBe(403);
    expect(blockedMe.body).toMatchObject({ code: "FORBIDDEN" });

    const blockedAnomalies = await harness.request({
      method: "GET",
      path: "/v1/admin/anomalies",
      authorization: `Bearer ${token}`,
    });
    expect(blockedAnomalies.status).toBe(403);

    const newIssued = issueAdminLoginToken({ openid: ADMIN_OPENID, secret: SECRET, now: NOW });
    const blockedLogin = await harness.request({
      method: "POST",
      path: "/v1/admin/auth/login",
      body: { login_token: newIssued.login_token },
      client_ip: "198.51.100.21",
    });
    expect(blockedLogin.status).toBe(403);
    expect(blockedLogin.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("支持受控口令登录并对登录接口执行防暴力破解限流（5/min per IP）", async () => {
    const harness = makeHarness(makeConfig({ admin_web_passcode: "super-secret-admin-pass-123" }));
    await harness.repo.admins.insert(makeAdmin());

    for (let i = 0; i < RATE_LIMIT_DEFAULTS.admin_login.max_requests; i += 1) {
      const bad = await harness.request({
        method: "POST",
        path: "/v1/admin/auth/login",
        body: { openid: ADMIN_OPENID, passcode: "wrong-passcode" },
        client_ip: "203.0.113.50",
      });
      expect(bad.status).toBe(401);
    }

    const rateLimited = await harness.request({
      method: "POST",
      path: "/v1/admin/auth/login",
      body: { openid: ADMIN_OPENID, passcode: "super-secret-admin-pass-123" },
      client_ip: "203.0.113.50",
    });
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.body).toMatchObject({ code: "RATE_LIMITED" });

    // 其他 IP 仍可正常登录
    const ok = await harness.request({
      method: "POST",
      path: "/v1/admin/auth/login",
      body: { openid: ADMIN_OPENID, passcode: "super-secret-admin-pass-123" },
      client_ip: "203.0.113.51",
    });
    expect(ok.status).toBe(200);
  });

  it("端到端打通网关管理路由：解除异常、维护升班马、查询审计日志", async () => {
    const harness = makeHarness();
    await harness.repo.admins.insert(makeAdmin());
    const anomaly: Anomaly = {
      schema_version: 1,
      anomaly_id: "00000000-0000-4000-8000-000000000601",
      anomaly_key: "00000000-0000-4000-8000-000000000602:UNEXPECTED_PROVIDER_STATUS",
      match_id: "00000000-0000-4000-8000-000000000602",
      type: AnomalyType.UnexpectedProviderStatus,
      blocking: true,
      status: AnomalyStatus.Open,
      first_seen_at: NOW,
      last_seen_at: NOW,
      occurrence_count: 1,
      details: {},
      resolved_at: null,
      resolution: null,
    };
    const team: Team = {
      schema_version: 1,
      team_id: "00000000-0000-4000-8000-000000000701",
      league_id: LeagueId.PremierLeague,
      name: "Leicester City",
      name_zh: null,
      logo_url: null,
      short_name: "LEI",
      primary_color: null,
      secondary_color: null,
      status: TeamStatus.Active,
      created_at: NOW,
      updated_at: NOW,
    };
    await harness.repo.anomalies.insert(anomaly);
    await harness.repo.teams.insert(team);

    const issued = issueAdminLoginToken({ openid: ADMIN_OPENID, secret: SECRET, now: NOW });
    const loginRes = await harness.request({
      method: "POST",
      path: "/v1/admin/auth/login",
      body: { login_token: issued.login_token },
      client_ip: "198.51.100.30",
    });
    const auth = `Bearer ${(loginRes.body as { data: { access_token: string } }).data.access_token}`;

    const resolveRes = await harness.request({
      method: "POST",
      path: `/v1/admin/anomalies/${anomaly.anomaly_id}/resolve`,
      body: { reason: "人工确认解除" },
      authorization: auth,
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(resolveRes.status).toBe(200);

    const teamPatchRes = await harness.request({
      method: "PATCH",
      path: `/v1/admin/teams/${team.team_id}`,
      body: { name_zh: "莱斯特城", logo_url: "/assets/logos/leicester.png", reason: "升班马资料" },
      authorization: auth,
      now: new Date(NOW.getTime() + 2_000),
    });
    expect(teamPatchRes.status).toBe(200);

    const teamMapRes = await harness.request({
      method: "POST",
      path: `/v1/admin/teams/${team.team_id}/mappings`,
      body: { provider: "openfoot", provider_team_id: "Leicester City", reason: "补齐映射" },
      authorization: auth,
      now: new Date(NOW.getTime() + 3_000),
    });
    expect(teamMapRes.status).toBe(200);

    const teamsRes = await harness.request({
      method: "GET",
      path: "/v1/admin/teams",
      query: { q: "莱斯特城" },
      authorization: auth,
    });
    expect(teamsRes.status).toBe(200);
    expect((teamsRes.body as { data: { items: unknown[] } }).data.items).toHaveLength(1);

    const auditRes = await harness.request({
      method: "GET",
      path: "/v1/admin/audit-logs",
      query: { limit: "10" },
      authorization: auth,
    });
    expect(auditRes.status).toBe(200);
    expect((auditRes.body as { data: { items: Array<{ action: string }> } }).data.items.map((x) => x.action)).toEqual([
      "upsert_team_mapping",
      "update_team",
      "resolve_anomaly",
    ]);
  });
});

describe("Gateway HTTP static /admin/ serving", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = await startGatewayServer({
      port: 0,
      env: {
        FOOTBALL_ENVIRONMENT: "dev",
        FOOTBALL_MATCH_CURSOR_SECRET: "http-admin-static-secret",
        FOOTBALL_REPOSITORY_BACKEND: "memory",
        FOOTBALL_MOCK_TRUSTED_OPENID: "dev-user",
        FOOTBALL_SEED_SCENARIO: "normal",
      },
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server?.closeAllConnections();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("托管 /admin/ 静态文件、重定向 /admin 并拒绝目录穿越", async () => {
    const redirect = await fetch(`http://127.0.0.1:${port}/admin`, { redirect: "manual" });
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("/admin/");

    const html = await fetch(`http://127.0.0.1:${port}/admin/`);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(html.headers.get("x-frame-options")).toBe("DENY");
    expect(await html.text()).toContain("赛事预言家 · 运维管理台");

    const js = await fetch(`http://127.0.0.1:${port}/admin/api.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("application/javascript");

    const traversal = await fetch(`http://127.0.0.1:${port}/admin/..%2fpackage.json`);
    expect(traversal.status).toBe(404);
  });

  it("[CR-12] 共享 AdminConsumedJtiStore 在跨实例并发重放时只允许一次消费 login_token", async () => {
    const repo = new InMemoryRepository();
    await repo.admins.insert({
      schema_version: 1,
      admin_id: ADMIN_ID,
      openid: ADMIN_OPENID,
      role: AdminRole.Admin,
      status: AdminStatus.Active,
      created_at: NOW,
      updated_at: NOW,
    });
    const sessions = createInMemoryAuthSessionStore();
    const consumedJtis = createInMemoryAdminConsumedJtiStore();
    const config = makeConfig();
    const issued = issueAdminLoginToken({ openid: ADMIN_OPENID, secret: SECRET, now: NOW });

    // 实例 A 先消费
    const first = await handleGatewayRequest({
      method: "POST",
      path: "/v1/admin/auth/login",
      query: {},
      body: { login_token: issued.login_token },
      server_now: NOW,
      config,
      repo,
      sessions,
      admin_consumed_jtis: consumedJtis,
      rate_limiter: new InMemoryRateLimiter(),
      services: {
        session: new SessionService(repo),
        matches: new MatchQueryService(repo, SECRET),
      },
    });
    expect(first.status).toBe(200);

    // 实例 B（全新 rateLimiter，同一持久化 store）重放同一个 login_token 被拒绝
    const replay = await handleGatewayRequest({
      method: "POST",
      path: "/v1/admin/auth/login",
      query: {},
      body: { login_token: issued.login_token },
      server_now: NOW,
      config,
      repo,
      sessions,
      admin_consumed_jtis: consumedJtis,
      rate_limiter: new InMemoryRateLimiter(),
      services: {
        session: new SessionService(repo),
        matches: new MatchQueryService(repo, SECRET),
      },
    });
    expect(replay.status).toBe(401);
  });
});
