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

export interface GatewayRepositoryHandle {
  repo: AppRepository;
  close(): Promise<void>;
}

async function noopClose(): Promise<void> {}

function createPostgresConnect(pool: pg.Pool): PostgresConnectFn {
  return async () => {
    const client = await pool.connect();
    return {
      query: createPostgresQueryFn(client),
      release: () => client.release(),
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
): GatewayRepositoryHandle {
  const pool = new pg.Pool({ connectionString: postgres.database_url });
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
): GatewayRepositoryHandle {
  if (config.repository_backend === "memory") {
    return { repo: new InMemoryRepository(), close: noopClose };
  }
  if (config.repository_backend === "postgres") {
    if (config.postgres_repository === null) {
      throw new Error("PostgreSQL repository configuration is required");
    }
    return createPostgresRepositoryHandle(config.postgres_repository);
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
