import { describe, expect, it, vi } from "vitest";
import { SyncJobType } from "../domain/enums.js";
import { COLLECTION_DEFINITIONS } from "../schema/collections.js";
import { cloudBaseCollectionName } from "../infrastructure/cloudbase-db.js";
import type { CloudBaseSdkDatabase } from "../infrastructure/cloudbase-wx-db.js";
import { createCloudFunctionRuntime, isSportApiCloudflareBlocked, runDueProviderJobs } from "./runtime.js";

const ENV = {
  FOOTBALL_ENVIRONMENT: "test",
  FOOTBALL_MATCH_CURSOR_SECRET: "test-cursor-secret",
  FOOTBALL_REPOSITORY_BACKEND: "cloudbase",
  FOOTBALL_CLOUD_ENVIRONMENT_ID: "cloud-test",
  FOOTBALL_RESOURCE_NAMESPACE: "football_test",
};

function fakeDatabase(missing: string[] = []) {
  const documents = new Map<string, Record<string, unknown>>();
  let collectionReads = 0;
  const collection = (name: string) => {
    collectionReads += 1;
    const chain = {
      where() { return chain; },
      orderBy() { return chain; },
      skip() { return chain; },
      limit() { return chain; },
      async get() { return { data: [] as Record<string, unknown>[] }; },
      async count() {
        if (missing.includes(name)) throw Object.assign(new Error(`collection ${name} not found`), { errCode: "COLLECTION_NOT_FOUND" });
        return { total: 0 };
      },
      async add({ data }: { data: Record<string, unknown> }) {
        const id = String(data._id);
        documents.set(`${name}/${id}`, { ...data });
        return { _id: id };
      },
      async update() { return { updated: 0, stats: { updated: 0 } }; },
      doc(id: string) {
        return {
          async get() {
            const data = documents.get(`${name}/${id}`);
            if (!data) throw Object.assign(new Error("document not exist"), { errCode: "DOCUMENT_NOT_FOUND" });
            return { data };
          },
          async update() { return { updated: 0, stats: { updated: 0 } }; },
          async remove() {
            documents.delete(`${name}/${id}`);
            return { removed: 1 };
          },
        };
      },
    };
    return chain;
  };
  const db = {
    collection,
    async startTransaction() {
      return {
        collection,
        async commit() {},
        async rollback() {},
      };
    },
  } as unknown as CloudBaseSdkDatabase;
  return { db, collectionReads: () => collectionReads };
}

describe("Cloud Function runtime startup", () => {
  it("logs missing environment keys with a stable diagnostic code and no values", () => {
    const log = vi.fn();
    expect(() => createCloudFunctionRuntime({ env: {}, db: fakeDatabase().db, sdkVersion: "4.0.2", nodeVersion: "v24", log })).toThrow("Required environment configuration missing");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "startup_error",
      diag_code: "DIAG_FN_ENV_VAR_MISSING",
      missing_environment_keys: expect.arrayContaining(["FOOTBALL_MATCH_CURSOR_SECRET", "FOOTBALL_RESOURCE_NAMESPACE"]),
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("test-cursor-secret");
  });

  it("rejects a production mock identity at startup", () => {
    const log = vi.fn();
    expect(() => createCloudFunctionRuntime({
      env: { ...ENV, FOOTBALL_ENVIRONMENT: "prod", FOOTBALL_RESOURCE_NAMESPACE: "football_prod", FOOTBALL_MOCK_TRUSTED_OPENID: "private-openid" },
      db: fakeDatabase().db,
      sdkVersion: "4.0.2",
      nodeVersion: "v24",
      log,
    })).toThrow("cannot configure mock identity");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "startup_error", diag_code: "DIAG_PROD_MOCK_IDENTITY" }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-openid");
  });
});

describe("Timer summary observation", () => {
  it("emits exactly one timer_summary log after a Timer event", async () => {
    const log = vi.fn();
    const runtime = createCloudFunctionRuntime({
      env: ENV,
      db: fakeDatabase().db,
      sdkVersion: "4.0.2",
      nodeVersion: "v24",
      log,
    });
    await runtime({ Type: "Timer" }, {});
    const summaries = log.mock.calls
      .map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry.event === "timer_summary");
    expect(summaries).toHaveLength(1);
    const dbOps = summaries[0]!.db_ops as { read: number };
    expect(typeof dbOps.read).toBe("number");
    expect(dbOps.read).toBeGreaterThanOrEqual(0);
  });
});

describe("Provider Timer scheduling", () => {
  it("dispatches only the oldest due league for each schedule job in one Timer tick", async () => {
    const now = new Date("2026-10-13T12:00:00.000Z");
    const dueLeagues = vi.fn()
      .mockResolvedValueOnce(["la_liga", "serie_a"])
      .mockResolvedValueOnce(["bundesliga", "ligue_1"]);
    const providerRegistry = { dueLeagues } as unknown as Parameters<typeof runDueProviderJobs>[0]["providerRegistry"];
    const dispatchRun = vi.fn(async (..._args: unknown[]) => ({ kind: "completed" }));
    const dispatcher = { run: dispatchRun } as unknown as Parameters<typeof runDueProviderJobs>[0]["dispatcher"];
    const querySpy = vi.fn(async () => []);
    const cloudDb = { query: querySpy } as unknown as Parameters<typeof runDueProviderJobs>[0]["cloudDb"];
    const reconcile = { run: vi.fn(async () => ({ kind: "completed" })) } as unknown as Parameters<typeof runDueProviderJobs>[0]["reconcile"];

    const result = await runDueProviderJobs({
      cloudDb,
      namespace: "football_test",
      dispatcher,
      providerRegistry,
      syncLeagueIds: ["la_liga", "serie_a", "bundesliga", "ligue_1"],
      sourceIds: ["fd"],
      profile: "test",
      reconcile,
      serverNow: now,
      log: vi.fn(),
    });

    // 底层适配器收物理集合名：查 sync_logs 必须带命名空间前缀，否则云端报「表不存在」。
    expect(querySpy).toHaveBeenCalledWith("football_test_sync_logs", expect.anything(), expect.anything());

    expect(dispatchRun).toHaveBeenCalledWith(SyncJobType.FutureSchedule, now, "la_liga");
    expect(dispatchRun).toHaveBeenCalledWith(SyncJobType.FullScheduleVerify, now, "bundesliga");
    expect(dispatchRun.mock.calls.filter(([job]) => job === SyncJobType.FutureSchedule)).toHaveLength(1);
    expect(dispatchRun.mock.calls.filter(([job]) => job === SyncJobType.FullScheduleVerify)).toHaveLength(1);
    expect(result.jobs_run).toEqual(expect.arrayContaining([
      `${SyncJobType.FutureSchedule}:la_liga`, `${SyncJobType.FullScheduleVerify}:bundesliga`,
    ]));
  });
});

describe("Cloud Function diagnostic action", () => {
  it("marks only sportapi 403 or provider code 1010 requests as Cloudflare blocked", () => {
    expect(isSportApiCloudflareBlocked("sp", { status: 403 })).toBe(true);
    expect(isSportApiCloudflareBlocked("sp", { status: 200, provider_code: "1010" })).toBe(true);
    expect(isSportApiCloudflareBlocked("sp", { status: 429, provider_code: "429" })).toBe(false);
    expect(isSportApiCloudflareBlocked("fd", { status: 403 })).toBe(false);
    expect(isSportApiCloudflareBlocked("sp", null)).toBe(false);
  });

  it("reports collection, environment, namespace, identity and transaction checks without exposing OPENID", async () => {
    const fake = fakeDatabase();
    const runtime = createCloudFunctionRuntime({ env: ENV, db: fake.db, sdkVersion: "4.0.2", nodeVersion: "v24.21.0", buildTime: "2026-10-11T01:02:03.000Z", log: vi.fn() });
    const result = await runtime({ action: "diag" }, { ENV: "cloud-test", OPENID: "wx-private-openid" });
    const body = result.result.body as { data: Record<string, any>; request_id: string };
    expect(result.result.status).toBe(200);
    expect(body.request_id).toEqual(expect.any(String));
    expect(body.data).toMatchObject({
      environment: { ok: true, missing_keys: [] },
      environment_match: { ok: true, configured_id: "cloud-test", runtime_id: "cloud-test" },
      namespace_match: { ok: true, resource_namespace: "football_test", environment: "test" },
      read_write_probe: { ok: true },
      transaction_probe: { ok: true },
      identity_available: true,
      versions: { wx_server_sdk: "4.0.2", node: "v24.21.0", build: "2026-10-11T01:02:03.000Z" },
    });
    expect(Object.keys(body.data.collections)).toEqual(expect.arrayContaining([
      ...COLLECTION_DEFINITIONS.map((definition) => cloudBaseCollectionName("football_test", definition.collection)),
      "football_test_diag",
      "football_test_rate_limits",
    ]));
    expect(body.data.indexes).toContain("人工核对");
    expect(JSON.stringify(body)).not.toContain("wx-private-openid");
    expect(fake.collectionReads()).toBeGreaterThan(COLLECTION_DEFINITIONS.length);
  });

  it("attaches diagnostic code and hint to missing collections and environment mismatches", async () => {
    const missingCollection = `football_test_${COLLECTION_DEFINITIONS[0]!.collection}`;
    const runtime = createCloudFunctionRuntime({
      env: ENV,
      db: fakeDatabase([missingCollection]).db,
      sdkVersion: "4.0.2",
      nodeVersion: "v24.21.0",
      log: vi.fn(),
    });
    const result = await runtime({ action: "diag" }, { ENV: "wrong-env" });
    const data = (result.result.body as { data: Record<string, any> }).data;
    expect(result.result.status).toBe(503);
    expect(data.environment_match).toMatchObject({ ok: false, diag_code: "DIAG_ENV_MISMATCH", hint: expect.any(String) });
    expect(data.collections[missingCollection]).toMatchObject({ exists: false, diag_code: "DIAG_DB_COLLECTION_MISSING", hint: expect.any(String) });
  });

  it("returns a non-informative 404 for the diagnostic action in prod", async () => {
    const fake = fakeDatabase();
    const runtime = createCloudFunctionRuntime({
      env: { ...ENV, FOOTBALL_ENVIRONMENT: "prod", FOOTBALL_RESOURCE_NAMESPACE: "football_prod" },
      db: fake.db,
      sdkVersion: "4.0.2",
      nodeVersion: "v24.21.0",
      log: vi.fn(),
    });
    const result = await runtime({ action: "diag" }, { ENV: "cloud-test", OPENID: "wx-private-openid" });
    expect(result.result).toMatchObject({ status: 404, body: { code: "NOT_FOUND", request_id: expect.any(String) } });
    expect(fake.collectionReads()).toBe(0);
    expect(JSON.stringify(result)).not.toContain("wx-private-openid");
  });
});
