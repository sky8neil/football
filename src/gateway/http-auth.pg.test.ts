import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import pg from "pg";
import { ProviderFutureScheduleService } from "../application/provider-sync-service.js";
import { CloudBaseAppRepository } from "../infrastructure/cloudbase-app-repository.js";
import { createCountingDb } from "../infrastructure/db-op-counter.js";
import { Provider, SyncJobType } from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import {
  AUTH_SESSIONS_TABLE,
  applyPostgresSchema,
  buildPostgresSchemaPlan,
  qualifiedTable,
  quoteIdent,
} from "../infrastructure/postgres-schema.js";
import { createPostgresQueryFn } from "../infrastructure/postgres-document-db.js";
import { makeApiFixture } from "../provider/fixture-factory.js";
import { createApplicationRuntime } from "../runtime/application-runtime.js";
import { createVpsRuntime } from "../runtime/vps-runtime.js";
import { runJobsTick, type JobsTickHandle } from "../jobs/tick.js";
import { createWechatCode2SessionHttp } from "./wechat-http.js";
import { startGatewayServer } from "./http.js";
import { createPostgresAppRepository } from "./repository-factory.js";

const DATABASE_URL = process.env.FOOTBALL_TEST_DATABASE_URL ?? "";
const ENABLED = DATABASE_URL.length > 0;
const SCHEMA = "football_vps05_http";
const NAMESPACE = "ft";
const APP_ID = "wx-test-appid";
const APP_SECRET = "wx-test-secret-must-not-leak";
const ALICE_CODE = "wx-alice-code-must-not-leak";
const BOB_CODE = "wx-bob-code-must-not-leak";
const FAIL_CODE = "wx-fail-code-must-not-leak";
const ALICE_OPENID = "wx-openid-alice";
const BOB_OPENID = "wx-openid-bob";
const SESSION_KEY = "wx-session-key-must-not-leave";
const ALICE_HOME = 2;
const ALICE_AWAY = 1;
const BOB_HOME = 0;
const BOB_AWAY = 3;
const JOB_FIXTURE_ID = 9100101;
const JOB_TICK_ENTRY = fileURLToPath(new URL("../jobs/tick.ts", import.meta.url));
const SCHEDULED_JOBS_ENTRY = fileURLToPath(new URL("../runtime/scheduled-jobs.ts", import.meta.url));

describe.skipIf(!ENABLED)("HTTP wechat login over isolated postgres", () => {
  let pool!: pg.Pool;
  let stub!: Server;
  let stubOrigin = "";
  let gateway!: Server;
  let origin = "";
  let jobMatchId = "";

  function env(): Record<string, string> {
    return {
      FOOTBALL_ENVIRONMENT: "prod",
      FOOTBALL_MATCH_CURSOR_SECRET: "http-auth-pg-secret",
      FOOTBALL_REPOSITORY_BACKEND: "postgres",
      FOOTBALL_DATABASE_URL: DATABASE_URL,
      FOOTBALL_DATABASE_SCHEMA: SCHEMA,
      FOOTBALL_RESOURCE_NAMESPACE: NAMESPACE,
      FOOTBALL_WECHAT_APP_ID: APP_ID,
      FOOTBALL_WECHAT_APP_SECRET: APP_SECRET,
      FOOTBALL_SESSION_TTL_SECONDS: "60",
    };
  }

  async function json(path: string, init: RequestInit = {}) {
    const response = await fetch(`${origin}${path}`, init);
    const body = await response.json() as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain(APP_SECRET);
    expect(JSON.stringify(body)).not.toContain(ALICE_CODE);
    expect(JSON.stringify(body)).not.toContain(BOB_CODE);
    expect(JSON.stringify(body)).not.toContain(FAIL_CODE);
    expect(JSON.stringify(body)).not.toContain(SESSION_KEY);
    return { status: response.status, body };
  }

  function authHeaders(token: string, json = false): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      ...(json ? { "content-type": "application/json" } : {}),
    };
  }

  async function login(code: string): Promise<string> {
    const response = await json("/v1/auth/wechat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(response.status).toBe(200);
    return (response.body.data as { access_token: string }).access_token;
  }

  function miniProgramMatchesService() {
    const apiModule = { exports: {} as { request: (input: unknown) => Promise<{ statusCode: number; data: unknown }> } };
    runInNewContext(readFileSync(new URL("../../miniprogram/services/api.js", import.meta.url), "utf8"), {
      module: apiModule,
      require: () => ({ gatewayOrigin: origin }),
      wx: {
        request(options: {
          url: string;
          method: string;
          header: Record<string, string>;
          data: unknown;
          success: (res: unknown) => void;
          fail: () => void;
        }) {
          void fetch(options.url, {
            method: options.method,
            headers: options.header,
            ...(options.data ? { body: JSON.stringify(options.data) } : {}),
          })
            .then(async (response) => options.success({ statusCode: response.status, data: await response.json() }))
            .catch(() => options.fail());
        },
      },
    });
    const matchesModule = {
      exports: {} as {
        listMatches: (query?: unknown) => Promise<{ statusCode: number; data: { items: Array<{ match_id: string; match_status: string }> } }>;
        getMatchDetail: (matchId: string) => Promise<{ statusCode: number; data: { match_id: string; match_status: string } }>;
      },
    };
    runInNewContext(readFileSync(new URL("../../miniprogram/services/matches.js", import.meta.url), "utf8"), {
      module: matchesModule,
      require: () => apiModule.exports,
    });
    return matchesModule.exports;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
    await applyPostgresSchema(createPostgresQueryFn(pool), buildPostgresSchemaPlan(NAMESPACE, SCHEMA));
    await pool.query(`TRUNCATE ${qualifiedTable(SCHEMA, AUTH_SESSIONS_TABLE)}`);

    stub = http.createServer((req, res) => {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const code = requestUrl.searchParams.get("js_code");
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      if (code === ALICE_CODE) {
        res.end(JSON.stringify({ openid: ALICE_OPENID, session_key: SESSION_KEY }));
        return;
      }
      if (code === BOB_CODE) {
        res.end(JSON.stringify({ openid: BOB_OPENID, session_key: SESSION_KEY }));
        return;
      }
      res.end(JSON.stringify({ errcode: 40029, errmsg: "invalid code" }));
    });
    await new Promise<void>((resolve) => {
      stub.listen(0, "127.0.0.1", () => resolve());
    });
    stubOrigin = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

    gateway = await startGatewayServer({
      port: 0,
      env: env(),
      wechat_http: createWechatCode2SessionHttp({ origin: stubOrigin }),
    });
    origin = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;

    const now = new Date();
    const kickoffAt = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const fixture = makeApiFixture({
      fixtureId: JOB_FIXTURE_ID,
      statusShort: "NS",
      date: kickoffAt.toISOString(),
      timestamp: Math.floor(kickoffAt.getTime() / 1000),
      round: "Regular Season - 1",
      fulltimeHome: null,
      fulltimeAway: null,
    });
    const stubClient = {
      getTeams: async (query: { leagueId: string }) => {
        if (query.leagueId !== "39") return [];
        return [
          { team: { id: 40, name: "Arsenal" } },
          { team: { id: 41, name: "Chelsea" } },
        ];
      },
      getFixtures: async (query: { leagueId: string }) => {
        if (query.leagueId !== "39") return [];
        return [fixture];
      },
      getSeasonFixtures: async () => [],
      getFixturesFromSource: async () => [],
    };
    const tickEnv = {
      ...env(),
      FOOTBALL_ENVIRONMENT: "test",
      FOOTBALL_PROVIDER_SOURCES: "fd",
      FOOTBALL_PROVIDER_KEY_FD_1: "vps05-fixture-key",
      FOOTBALL_SYNC_LEAGUES: "premier_league",
    };
    const tickLog = vi.fn();
    const tick = await runJobsTick({
      env: tickEnv,
      argv: [],
      now: () => now,
      log: tickLog,
      assemble: async (config): Promise<JobsTickHandle> => {
        if (config.postgres_repository === null) throw new Error("missing postgres");
        const vps = createVpsRuntime({ postgres: config.postgres_repository });
        const counted = createCountingDb(vps.db);
        const countedRepo = new CloudBaseAppRepository(
          { resource_namespace: config.postgres_repository.resource_namespace },
          counted.db,
        );
        const application = createApplicationRuntime({
          env: tickEnv,
          db: counted.db,
          namespace: config.postgres_repository.resource_namespace,
          repo: countedRepo,
          matchCursorSecret: config.match_cursor_secret,
          log: vi.fn(),
        });
        application.providerSources.sources = [{ source_id: "fd" }] as typeof application.providerSources.sources;
        application.providerSources.sync_leagues = new Set(["premier_league"]);
        application.providerRegistry.dueLeagues = vi.fn(async (_leagueIds, jobType) => (
          jobType === SyncJobType.FutureSchedule ? ["premier_league"] : []
        )) as typeof application.providerRegistry.dueLeagues;
        application.providerDispatcher.run = vi.fn(async (jobType, serverNow, leagueId) => {
          if (jobType === SyncJobType.FutureSchedule) {
            return new ProviderFutureScheduleService(application.repo, stubClient).run(serverNow, leagueId);
          }
          return {
            kind: "skipped" as const,
            fixtures: { kind: "skipped" as const, job_type: jobType, reason: "lock_held" as const },
          };
        }) as typeof application.providerDispatcher.run;
        application.providerReconcile.run = vi.fn(async () => ({ kind: "skipped" as const, reason: "lock_held" as const }));
        return {
          application,
          counter: counted.counter,
          close: () => vps.close(),
        };
      },
    });
    expect(tick.exitCode).toBe(0);
    const summary = tickLog.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "timer_summary");
    expect(summary?.ran).toEqual(expect.arrayContaining([`${SyncJobType.FutureSchedule}:premier_league`]));

    const repo = createPostgresAppRepository(pool, {
      database_url: DATABASE_URL,
      database_schema: SCHEMA,
      resource_namespace: NAMESPACE,
    });
    const mapping = await repo.matchProviderMappings!.findByProviderAndExternalId(
      Provider.ApiFootball,
      String(JOB_FIXTURE_ID),
    );
    expect(mapping).not.toBeNull();
    jobMatchId = mapping!.match_id;
  });

  afterAll(async () => {
    gateway?.closeAllConnections();
    if (gateway) {
      await new Promise<void>((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
    }
    stub?.closeAllConnections();
    if (stub) {
      await new Promise<void>((resolve, reject) => stub.close((error) => error ? reject(error) : resolve()));
    }
    if (pool !== undefined) {
      await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(SCHEMA)} CASCADE`);
      await pool.end();
    }
  });

  it("logs in, injects identity, expires, and fails without leaking secrets", async () => {
    const health = await json("/health");
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ ok: true });

    const failed = await json("/v1/auth/wechat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: FAIL_CODE }),
    });
    expect(failed.status).toBe(401);
    expect(failed.body).toEqual(expect.objectContaining({ code: "UNAUTHORIZED" }));

    const aliceLogin = await json("/v1/auth/wechat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: ALICE_CODE }),
    });
    expect(aliceLogin.status).toBe(200);
    const aliceData = aliceLogin.body.data as { access_token: string; token_type: string; expires_at: string };
    expect(aliceData.token_type).toBe("Bearer");
    expect(aliceData.access_token.length).toBeGreaterThan(20);
    expect(aliceData.access_token).not.toContain(".");

    const aliceInit = await json("/v1/session/init", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${aliceData.access_token}`,
      },
      body: JSON.stringify({ nickname: "Alice" }),
    });
    expect(aliceInit.status).toBe(201);

    const aliceMe = await json("/v1/profile/me", {
      headers: { authorization: `Bearer ${aliceData.access_token}` },
    });
    expect(aliceMe.status).toBe(200);
    expect((aliceMe.body.data as { nickname: string }).nickname).toBe("Alice");

    const anonymous = await json("/v1/session/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nickname: "Anon" }),
    });
    expect(anonymous.status).toBe(401);

    const bobLogin = await json("/v1/auth/wechat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: BOB_CODE }),
    });
    expect(bobLogin.status).toBe(200);
    const bobToken = (bobLogin.body.data as { access_token: string }).access_token;
    const bobInit = await json("/v1/session/init", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bobToken}`,
      },
      body: JSON.stringify({ nickname: "Bob" }),
    });
    expect(bobInit.status).toBe(201);
    const bobMe = await json("/v1/profile/me", {
      headers: { authorization: `Bearer ${bobToken}` },
    });
    expect((bobMe.body.data as { nickname: string }).nickname).toBe("Bob");
    const aliceAgain = await json("/v1/profile/me", {
      headers: { authorization: `Bearer ${aliceData.access_token}` },
    });
    expect((aliceAgain.body.data as { nickname: string }).nickname).toBe("Alice");

    await pool.query(
      `UPDATE ${qualifiedTable(SCHEMA, AUTH_SESSIONS_TABLE)} SET expires_at = '2020-01-01T00:00:00.000Z' WHERE token = $1`,
      [aliceData.access_token],
    );
    const expired = await json("/v1/profile/me", {
      headers: { authorization: `Bearer ${aliceData.access_token}` },
    });
    expect(expired.status).toBe(401);
    expect(expired.body).toEqual(expect.objectContaining({ code: "UNAUTHORIZED" }));
  });

  it("lets two users init, submit, and read only their own predictions over real HTTP", async () => {
    const aliceToken = await login(ALICE_CODE);
    const bobToken = await login(BOB_CODE);
    const aliceInit = await json("/v1/session/init", {
      method: "POST",
      headers: authHeaders(aliceToken, true),
      body: JSON.stringify({ nickname: "Alice" }),
    });
    expect([200, 201]).toContain(aliceInit.status);
    const bobInit = await json("/v1/session/init", {
      method: "POST",
      headers: authHeaders(bobToken, true),
      body: JSON.stringify({ nickname: "Bob" }),
    });
    expect([200, 201]).toContain(bobInit.status);

    const listed = await json("/v1/matches?limit=100", { headers: authHeaders(aliceToken) });
    expect(listed.status).toBe(200);
    const matchId = (listed.body.data as { items: Array<{ match_id: string; can_predict: boolean }> })
      .items.find((item) => item.can_predict)?.match_id;
    expect(matchId).toBe(jobMatchId);

    const aliceCreated = await json("/v1/predictions", {
      method: "POST",
      headers: authHeaders(aliceToken, true),
      body: JSON.stringify({
        idempotency_key: newUuid(),
        match_id: matchId,
        home_score: ALICE_HOME,
        away_score: ALICE_AWAY,
      }),
    });
    expect(aliceCreated.status).toBe(201);
    const alicePredictionId = (aliceCreated.body.data as { prediction_id: string }).prediction_id;

    const bobCreated = await json("/v1/predictions", {
      method: "POST",
      headers: authHeaders(bobToken, true),
      body: JSON.stringify({
        idempotency_key: newUuid(),
        match_id: matchId,
        home_score: BOB_HOME,
        away_score: BOB_AWAY,
      }),
    });
    expect(bobCreated.status).toBe(201);
    const bobPredictionId = (bobCreated.body.data as { prediction_id: string }).prediction_id;
    expect(bobPredictionId).not.toBe(alicePredictionId);

    const aliceMine = await json("/v1/predictions/me", { headers: authHeaders(aliceToken) });
    expect(aliceMine.status).toBe(200);
    const aliceItems = (aliceMine.body.data as { items: Array<{ prediction_id: string; pred_home_score: number; pred_away_score: number }> }).items;
    expect(aliceItems).toEqual([
      expect.objectContaining({
        prediction_id: alicePredictionId,
        match_id: matchId,
        pred_home_score: ALICE_HOME,
        pred_away_score: ALICE_AWAY,
      }),
    ]);
    expect(aliceItems.map((item) => item.prediction_id)).not.toContain(bobPredictionId);

    const bobMine = await json("/v1/predictions/me", { headers: authHeaders(bobToken) });
    expect(bobMine.status).toBe(200);
    const bobItems = (bobMine.body.data as { items: Array<{ prediction_id: string; pred_home_score: number; pred_away_score: number }> }).items;
    expect(bobItems).toEqual([
      expect.objectContaining({
        prediction_id: bobPredictionId,
        match_id: matchId,
        pred_home_score: BOB_HOME,
        pred_away_score: BOB_AWAY,
      }),
    ]);
    expect(bobItems.map((item) => item.prediction_id)).not.toContain(alicePredictionId);

    const aliceOne = await json(`/v1/predictions/me/${alicePredictionId}`, { headers: authHeaders(aliceToken) });
    expect(aliceOne.status).toBe(200);
    expect((aliceOne.body.data as { pred_home_score: number }).pred_home_score).toBe(ALICE_HOME);
    const aliceReadsBob = await json(`/v1/predictions/me/${bobPredictionId}`, { headers: authHeaders(aliceToken) });
    expect(aliceReadsBob.status).toBe(404);
  });

  it("exposes job-written matches through the miniprogram HTTP matches API", async () => {
    expect(existsSync(JOB_TICK_ENTRY)).toBe(true);
    expect(existsSync(SCHEDULED_JOBS_ENTRY)).toBe(true);
    const service = miniProgramMatchesService();
    const listed = await service.listMatches({ limit: 100 });
    expect(listed.statusCode).toBe(200);
    expect(listed.data.items.map((item) => item.match_id)).toContain(jobMatchId);
    const detail = await service.getMatchDetail(jobMatchId);
    expect(detail.statusCode).toBe(200);
    expect(detail.data).toEqual(expect.objectContaining({
      match_id: jobMatchId,
      match_status: "scheduled",
    }));
  });
});
