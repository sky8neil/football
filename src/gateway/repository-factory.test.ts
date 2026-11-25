import { EventEmitter } from "node:events";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudBaseAppRepository } from "../infrastructure/cloudbase-app-repository.js";
import type { CloudBaseDb } from "../infrastructure/cloudbase-db.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import {
  createGatewayRepository,
  createGatewayRepositoryHandle,
  createPostgresDocumentDbFromPool,
} from "./repository-factory.js";
import { LOCAL_PUBLIC_SOURCE, type GatewayRuntimeConfig } from "./config.js";

const TEST_DATABASE_URL = process.env.FOOTBALL_TEST_DATABASE_URL ?? "";

const base: GatewayRuntimeConfig = {
  environment: "test",
  mock_trusted_openid: null,
  match_cursor_secret: "gateway-test-secret",
  public_source: LOCAL_PUBLIC_SOURCE,
  repository_backend: "memory",
  cloudbase_repository: null,
  postgres_repository: null,
  vps_auth: null,
  deploy_target: "vps",
  ranking_first_period_key: "2026-W31",
};

const OriginalPool = pg.Pool;

const POSTGRES_REPOSITORY = {
  database_url: "postgres://football:secret@127.0.0.1:1/football",
  database_schema: "football_test",
  resource_namespace: "ft",
};

function fakePoolClient(methods: {
  query: (sql: string) => Promise<{ rows: unknown[]; command?: string }>;
  release: (err?: Error) => void;
}): EventEmitter & {
  query: (sql: string) => Promise<{ rows: unknown[]; command?: string }>;
  release: (err?: Error) => void;
} {
  return Object.assign(new EventEmitter(), methods);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createGatewayRepository", () => {
  it("uses the configured in-memory backend", () => {
    expect(createGatewayRepository(base)).toBeInstanceOf(InMemoryRepository);
  });

  it("uses CloudBase only when the adapter is explicitly supplied", () => {
    const config: GatewayRuntimeConfig = {
      ...base,
      repository_backend: "cloudbase",
      cloudbase_repository: {
        cloud_environment_id: "cloud-test",
        resource_namespace: "football-test",
      },
    };
    expect(() => createGatewayRepository(config)).toThrow("CloudBaseDb adapter is not configured");
    expect(createGatewayRepository(config, {} as CloudBaseDb)).toBeInstanceOf(CloudBaseAppRepository);
  });

  it("requires the handle API for postgres so the pool can be closed", () => {
    const config: GatewayRuntimeConfig = {
      ...base,
      repository_backend: "postgres",
      postgres_repository: {
        database_url: "postgres://football:secret@127.0.0.1:1/football",
        database_schema: "football_test",
        resource_namespace: "ft",
      },
    };
    expect(() => createGatewayRepository(config)).toThrow(
      "PostgreSQL backend requires createGatewayRepositoryHandle to close the pool",
    );
    expect(() => createGatewayRepositoryHandle({ ...base, repository_backend: "postgres" })).toThrow(
      "PostgreSQL repository configuration is required",
    );
  });

  it("builds a postgres AppRepository without a CloudBase environment id and closes the pool", async () => {
    const handle = createGatewayRepositoryHandle({
      ...base,
      repository_backend: "postgres",
      postgres_repository: {
        database_url: "postgres://football:secret@127.0.0.1:1/football",
        database_schema: "football_test",
        resource_namespace: "ft",
      },
    });
    expect(handle.repo).toBeInstanceOf(CloudBaseAppRepository);
    await handle.close();
    await handle.close();
  });

  it("configures the postgres handle pool with the same default timeouts as VPS runtime", async () => {
    const options: unknown[] = [];
    vi.spyOn(pg, "Pool").mockImplementation(function mockPool(this: pg.Pool, config?: pg.PoolConfig) {
      options.push(config);
      return new OriginalPool(config);
    });
    const handle = createGatewayRepositoryHandle({
      ...base,
      repository_backend: "postgres",
      postgres_repository: {
        database_url: "postgres://football:secret@127.0.0.1:1/football",
        database_schema: "football_test",
        resource_namespace: "ft",
      },
    }, undefined, {});
    expect(options).toEqual([{
      connectionString: "postgres://football:secret@127.0.0.1:1/football",
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
    }]);
    await handle.close();
  });

  it("passes ROLLBACK errors to pool client.release so the client is discarded", async () => {
    const released: Array<Error | undefined> = [];
    const rollbackError = new Error("rollback failed");
    const fakeClient = fakePoolClient({
      query: async (sql: string) => {
        if (sql === "ROLLBACK") throw rollbackError;
        return { rows: [] };
      },
      release: (err?: Error) => {
        released.push(err);
      },
    });
    const fakePool = { connect: async () => fakeClient } as unknown as pg.Pool;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = createPostgresDocumentDbFromPool(fakePool, {
      database_url: "postgres://football:secret@127.0.0.1:1/football",
      database_schema: "football_test",
      resource_namespace: "ft",
    });
    await expect(db.transaction(async () => {
      throw new Error("abort");
    })).rejects.toThrow("abort");
    expect(released).toEqual([rollbackError]);
    expect(JSON.parse(String(spy.mock.calls[0]?.[0]))).toEqual({
      event: "pg_rollback_failed",
      message: "rollback failed",
    });
  });

  it("passes BEGIN errors to pool client.release and preserves the original exception", async () => {
    const released: Array<Error | undefined> = [];
    const beginError = new Error("begin failed");
    const fakeClient = fakePoolClient({
      query: async (sql: string) => {
        if (sql === "BEGIN") throw beginError;
        return { rows: [] };
      },
      release: (err?: Error) => {
        released.push(err);
      },
    });
    const fakePool = { connect: async () => fakeClient } as unknown as pg.Pool;
    const db = createPostgresDocumentDbFromPool(fakePool, {
      database_url: "postgres://football:secret@127.0.0.1:1/football",
      database_schema: "football_test",
      resource_namespace: "ft",
    });
    await expect(db.transaction(async () => "ok")).rejects.toBe(beginError);
    expect(released).toEqual([beginError]);
  });

  it("factory path rejects COMMIT command ROLLBACK after a swallowed SQL error", async () => {
    const released: Array<Error | undefined> = [];
    const statements: string[] = [];
    const fakeClient = fakePoolClient({
      query: async (sql: string) => {
        statements.push(sql);
        if (sql === "BEGIN") return { rows: [], command: "BEGIN" };
        if (sql === "COMMIT") return { rows: [], command: "ROLLBACK" };
        if (sql === "ROLLBACK") return { rows: [], command: "ROLLBACK" };
        throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
      },
      release: (err?: Error) => {
        released.push(err);
      },
    });
    const fakePool = { connect: async () => fakeClient } as unknown as pg.Pool;
    const db = createPostgresDocumentDbFromPool(fakePool, {
      database_url: "postgres://football:secret@127.0.0.1:1/football",
      database_schema: "football_test",
      resource_namespace: "ft",
    });
    await expect(db.transaction(async (tx) => {
      try {
        await tx.add("ft_users", "a", { _id: "a" });
      } catch {
        return "swallowed";
      }
      return "ok";
    })).rejects.toThrow(/COMMIT.*ROLLBACK/);
    expect(statements).toContain("COMMIT");
    expect(statements).toContain("ROLLBACK");
    expect(released).toHaveLength(1);
  });

  it("returns a healthy checked-out client to the pool and detaches the error listener", async () => {
    const released: Array<Error | undefined> = [];
    const fakeClient = fakePoolClient({
      query: async () => ({ rows: [] }),
      release: (err?: Error) => {
        released.push(err);
      },
    });
    const fakePool = { connect: async () => fakeClient } as unknown as pg.Pool;
    const db = createPostgresDocumentDbFromPool(fakePool, POSTGRES_REPOSITORY);
    await expect(db.transaction(async () => "ok")).resolves.toBe("ok");
    expect(released).toEqual([undefined]);
    expect(fakeClient.listenerCount("error")).toBe(0);
  });

  it("logs a checked-out client error, survives the follow-up error, and discards the connection", async () => {
    const released: Array<Error | undefined> = [];
    const fakeClient = fakePoolClient({
      query: async () => ({ rows: [] }),
      release: (err?: Error) => {
        released.push(err);
      },
    });
    const fakePool = { connect: async () => fakeClient } as unknown as pg.Pool;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = createPostgresDocumentDbFromPool(fakePool, POSTGRES_REPOSITORY);
    const disconnect = new Error("Connection terminated unexpectedly");
    const followUp = new Error("additional client error");
    await expect(db.transaction(async () => {
      expect(fakeClient.emit("error", disconnect)).toBe(true);
      expect(fakeClient.emit("error", followUp)).toBe(true);
      return "ok";
    })).resolves.toBe("ok");
    expect(released).toEqual([disconnect]);
    expect(fakeClient.listenerCount("error")).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = String(spy.mock.calls[0]?.[0]);
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain(POSTGRES_REPOSITORY.database_url);
    expect(JSON.parse(logged)).toEqual({
      event: "pg_client_error",
      message: "Connection terminated unexpectedly",
    });
  });

  it("prefers an explicit release error over a checked-out client error", async () => {
    const released: Array<Error | undefined> = [];
    const rollbackError = new Error("rollback failed");
    const fakeClient = fakePoolClient({
      query: async (sql: string) => {
        if (sql === "ROLLBACK") throw rollbackError;
        return { rows: [] };
      },
      release: (err?: Error) => {
        released.push(err);
      },
    });
    const fakePool = { connect: async () => fakeClient } as unknown as pg.Pool;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = createPostgresDocumentDbFromPool(fakePool, POSTGRES_REPOSITORY);
    await expect(db.transaction(async () => {
      fakeClient.emit("error", new Error("connection terminated"));
      throw new Error("abort");
    })).rejects.toThrow("abort");
    expect(released).toEqual([rollbackError]);
    expect(fakeClient.listenerCount("error")).toBe(0);
    expect(spy.mock.calls.map((call) => JSON.parse(String(call[0])))).toEqual([
      { event: "pg_client_error", message: "connection terminated" },
      { event: "pg_rollback_failed", message: "rollback failed" },
    ]);
  });

  it.skipIf(TEST_DATABASE_URL.length === 0)(
    "uses an exclusive pool client for postgres transactions and releases the pool on close",
    async () => {
      const handle = createGatewayRepositoryHandle({
        ...base,
        repository_backend: "postgres",
        postgres_repository: {
          database_url: TEST_DATABASE_URL,
          database_schema: "football_vps03_factory",
          resource_namespace: "ft",
        },
      });
      try {
        await expect(handle.repo.withTransaction(async () => "ok")).resolves.toBe("ok");
        await expect(handle.repo.withTransaction(async () => {
          throw new Error("factory tx abort");
        })).rejects.toThrow("factory tx abort");
      } finally {
        await handle.close();
      }
      await expect(handle.repo.withTransaction(async () => "closed")).rejects.toThrow();
    },
  );
});
