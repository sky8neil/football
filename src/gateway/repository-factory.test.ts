import { describe, expect, it } from "vitest";
import { CloudBaseAppRepository } from "../infrastructure/cloudbase-app-repository.js";
import type { CloudBaseDb } from "../infrastructure/cloudbase-db.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { createGatewayRepository, createGatewayRepositoryHandle } from "./repository-factory.js";
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
};

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
