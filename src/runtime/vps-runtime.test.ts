import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVpsRuntime } from "./vps-runtime.js";
import { createWechatCode2SessionHttp } from "../gateway/wechat-http.js";

const POSTGRES = {
  database_url: "postgres://football:secret@127.0.0.1:1/football",
  database_schema: "football_vps05",
  resource_namespace: "ft",
} as const;

const OriginalPool = pg.Pool;

function capturePools(): { options: unknown[]; instances: pg.Pool[] } {
  const options: unknown[] = [];
  const instances: pg.Pool[] = [];
  vi.spyOn(pg, "Pool").mockImplementation(function mockPool(this: pg.Pool, config?: pg.PoolConfig) {
    options.push(config);
    const instance = new OriginalPool(config);
    instances.push(instance);
    return instance;
  });
  return { options, instances };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createVpsRuntime", () => {
  it("wires postgres sessions, health check, and a real wechat HTTP client", async () => {
    const runtime = createVpsRuntime({
      postgres: {
        database_url: "postgres://football:secret@127.0.0.1:1/football",
        database_schema: "football_vps05",
        resource_namespace: "ft",
      },
    });
    expect(runtime.wechatHttp).toEqual(expect.objectContaining({ getJson: expect.any(Function) }));
    expect(runtime.db).toEqual(expect.objectContaining({ query: expect.any(Function) }));
    expect(runtime.sessions).toEqual(expect.objectContaining({
      create: expect.any(Function),
      findActiveByToken: expect.any(Function),
    }));
    await expect(runtime.healthCheck()).resolves.toBe(false);
    await runtime.close();
    await runtime.close();
    await expect(runtime.healthCheck()).resolves.toBe(false);
  });

  it("accepts an injected wechat HTTP client", async () => {
    const wechatHttp = createWechatCode2SessionHttp({ origin: "http://127.0.0.1:9" });
    const runtime = createVpsRuntime({
      postgres: {
        database_url: "postgres://football:secret@127.0.0.1:1/football",
        database_schema: "football_vps05",
        resource_namespace: "ft",
      },
      wechatHttp,
    });
    expect(runtime.wechatHttp).toBe(wechatHttp);
    await runtime.close();
  });

  it("configures the pg pool with default max, idle, connect, and statement timeouts", async () => {
    const captured = capturePools();
    const runtime = createVpsRuntime({ postgres: POSTGRES, env: {} });
    expect(captured.options).toEqual([{
      connectionString: POSTGRES.database_url,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
    }]);
    await runtime.close();
  });

  it("overrides pool options from env and treats blank values as defaults", async () => {
    const captured = capturePools();
    const runtime = createVpsRuntime({
      postgres: POSTGRES,
      env: {
        FOOTBALL_PG_POOL_MAX: "8",
        FOOTBALL_PG_IDLE_TIMEOUT_MILLIS: "1000",
        FOOTBALL_PG_CONNECTION_TIMEOUT_MILLIS: "250",
        FOOTBALL_PG_STATEMENT_TIMEOUT: "4000",
      },
    });
    expect(captured.options[0]).toEqual({
      connectionString: POSTGRES.database_url,
      max: 8,
      idleTimeoutMillis: 1000,
      connectionTimeoutMillis: 250,
      statement_timeout: 4000,
    });
    await runtime.close();

    captured.options.length = 0;
    const blank = createVpsRuntime({
      postgres: POSTGRES,
      env: {
        FOOTBALL_PG_POOL_MAX: "  ",
        FOOTBALL_PG_IDLE_TIMEOUT_MILLIS: "",
      },
    });
    expect(captured.options[0]).toEqual({
      connectionString: POSTGRES.database_url,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
    });
    await blank.close();
  });

  it("rejects invalid pool env values without echoing the connection string", () => {
    for (const key of [
      "FOOTBALL_PG_POOL_MAX",
      "FOOTBALL_PG_IDLE_TIMEOUT_MILLIS",
      "FOOTBALL_PG_CONNECTION_TIMEOUT_MILLIS",
      "FOOTBALL_PG_STATEMENT_TIMEOUT",
    ] as const) {
      for (const value of ["0", "-1", "1.5", "abc"]) {
        try {
          createVpsRuntime({ postgres: POSTGRES, env: { [key]: value } });
          throw new Error("expected Fail Closed");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          expect(message).toBe(`${key} must be a positive integer`);
          expect(message).not.toContain("secret");
          expect(message).not.toContain(POSTGRES.database_url);
        }
      }
    }
  });

  it("logs idle pool errors as structured JSON without the connection string", async () => {
    const captured = capturePools();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runtime = createVpsRuntime({ postgres: POSTGRES, env: {} });
    const idleError = new Error("idle client connection terminated");
    captured.instances[0]!.emit("error", idleError);
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = spy.mock.calls[0]?.[0];
    expect(typeof logged).toBe("string");
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain(POSTGRES.database_url);
    expect(JSON.parse(String(logged))).toEqual({
      event: "pg_pool_error",
      message: "idle client connection terminated",
    });
    await runtime.close();
  });
});
