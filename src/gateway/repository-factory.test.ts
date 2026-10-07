import { describe, expect, it } from "vitest";
import { CloudBaseAppRepository } from "../infrastructure/cloudbase-app-repository.js";
import type { CloudBaseDb } from "../infrastructure/cloudbase-db.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { createGatewayRepository } from "./repository-factory.js";
import { LOCAL_PUBLIC_SOURCE, type GatewayRuntimeConfig } from "./config.js";

const base: GatewayRuntimeConfig = {
  environment: "test",
  mock_trusted_openid: null,
  match_cursor_secret: "gateway-test-secret",
  public_source: LOCAL_PUBLIC_SOURCE,
  repository_backend: "memory",
  cloudbase_repository: null,
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
});
