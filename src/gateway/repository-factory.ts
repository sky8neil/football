import pg from "pg";
import type { CloudBaseDb } from "../infrastructure/cloudbase-db.js";
import { CloudBaseAppRepository } from "../infrastructure/cloudbase-app-repository.js";
import { InMemoryRepository, type AppRepository } from "../infrastructure/repositories.js";
import {
  createPostgresDocumentDb,
  createPostgresQueryFn,
  type PostgresConnectFn,
} from "../infrastructure/postgres-document-db.js";
import type { GatewayRuntimeConfig, PostgresRepositoryConfig } from "./config.js";

export const DEFAULT_PG_POOL_MAX = 20;
export const DEFAULT_PG_IDLE_TIMEOUT_MILLIS = 30_000;
export const DEFAULT_PG_CONNECTION_TIMEOUT_MILLIS = 5_000;
export const DEFAULT_PG_STATEMENT_TIMEOUT = 30_000;

export interface GatewayRepositoryHandle {
  repo: AppRepository;
  close(): Promise<void>;
}

async function noopClose(): Promise<void> {}

function parsePositiveIntegerEnv(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

export function createPostgresPool(
  connectionString: string,
  env: Record<string, string | undefined> = process.env,
): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: parsePositiveIntegerEnv(env, "FOOTBALL_PG_POOL_MAX", DEFAULT_PG_POOL_MAX),
    idleTimeoutMillis: parsePositiveIntegerEnv(
      env,
      "FOOTBALL_PG_IDLE_TIMEOUT_MILLIS",
      DEFAULT_PG_IDLE_TIMEOUT_MILLIS,
    ),
    connectionTimeoutMillis: parsePositiveIntegerEnv(
      env,
      "FOOTBALL_PG_CONNECTION_TIMEOUT_MILLIS",
      DEFAULT_PG_CONNECTION_TIMEOUT_MILLIS,
    ),
    statement_timeout: parsePositiveIntegerEnv(
      env,
      "FOOTBALL_PG_STATEMENT_TIMEOUT",
      DEFAULT_PG_STATEMENT_TIMEOUT,
    ),
  });
  pool.on("error", (err) => {
    console.error(JSON.stringify({ event: "pg_pool_error", message: err.message }));
  });
  return pool;
}

function createPostgresConnect(pool: pg.Pool): PostgresConnectFn {
  return async () => {
    const client = await pool.connect();
    return {
      query: createPostgresQueryFn(client),
      release: (err?: Error) => client.release(err),
    };
  };
}

export function createPostgresDocumentDbFromPool(
  pool: pg.Pool,
  postgres: PostgresRepositoryConfig,
): CloudBaseDb {
  return createPostgresDocumentDb(
    createPostgresQueryFn(pool),
    {
      schema: postgres.database_schema,
      namespace: postgres.resource_namespace,
    },
    { connect: createPostgresConnect(pool) },
  );
}

export function createPostgresAppRepository(
  pool: pg.Pool,
  postgres: PostgresRepositoryConfig,
  db: CloudBaseDb = createPostgresDocumentDbFromPool(pool, postgres),
): AppRepository {
  return new CloudBaseAppRepository(
    { resource_namespace: postgres.resource_namespace },
    db,
  );
}

function createPostgresRepositoryHandle(
  postgres: PostgresRepositoryConfig,
  env: Record<string, string | undefined> = process.env,
): GatewayRepositoryHandle {
  const pool = createPostgresPool(postgres.database_url, env);
  let closed = false;
  return {
    repo: createPostgresAppRepository(pool, postgres),
    close: async () => {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}

export function createGatewayRepositoryHandle(
  config: GatewayRuntimeConfig,
  cloudbaseDb?: CloudBaseDb,
  env: Record<string, string | undefined> = process.env,
): GatewayRepositoryHandle {
  if (config.repository_backend === "memory") {
    return { repo: new InMemoryRepository(), close: noopClose };
  }
  if (config.repository_backend === "postgres") {
    if (config.postgres_repository === null) {
      throw new Error("PostgreSQL repository configuration is required");
    }
    return createPostgresRepositoryHandle(config.postgres_repository, env);
  }
  if (config.cloudbase_repository === null) {
    throw new Error("CloudBase repository configuration is required");
  }
  if (cloudbaseDb === undefined) {
    throw new Error("CloudBaseDb adapter is not configured; the SDK adapter is a B-stage requirement");
  }
  return {
    repo: new CloudBaseAppRepository(config.cloudbase_repository, cloudbaseDb),
    close: noopClose,
  };
}

export function createGatewayRepository(
  config: GatewayRuntimeConfig,
  cloudbaseDb?: CloudBaseDb,
): AppRepository {
  if (config.repository_backend === "postgres") {
    throw new Error("PostgreSQL backend requires createGatewayRepositoryHandle to close the pool");
  }
  return createGatewayRepositoryHandle(config, cloudbaseDb).repo;
}
