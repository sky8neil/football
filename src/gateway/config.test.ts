import { describe, expect, it } from "vitest";
import { LOCAL_PUBLIC_SOURCE, loadGatewayRuntimeConfig } from "./config.js";

describe("loadGatewayRuntimeConfig", () => {
  it("rejects a missing FOOTBALL_ENVIRONMENT and does not return a listen-ready config", () => {
    expect(() =>
      loadGatewayRuntimeConfig({
        FOOTBALL_MATCH_CURSOR_SECRET: "test-match-cursor-secret",
      }),
    ).toThrow("FOOTBALL_ENVIRONMENT must be one of: dev, test, prod");
  });

  it("rejects an illegal FOOTBALL_ENVIRONMENT", () => {
    expect(() =>
      loadGatewayRuntimeConfig({
        FOOTBALL_ENVIRONMENT: "staging",
        FOOTBALL_MATCH_CURSOR_SECRET: "test-match-cursor-secret",
      }),
    ).toThrow("FOOTBALL_ENVIRONMENT must be one of: dev, test, prod");
    expect(() =>
      loadGatewayRuntimeConfig({
        FOOTBALL_ENVIRONMENT: "",
        FOOTBALL_MATCH_CURSOR_SECRET: "test-match-cursor-secret",
      }),
    ).toThrow("FOOTBALL_ENVIRONMENT must be one of: dev, test, prod");
  });

  it("rejects a missing or blank FOOTBALL_MATCH_CURSOR_SECRET without echoing any secret value", () => {
    const distinctive = "must-not-appear-in-error";
    expect(() =>
      loadGatewayRuntimeConfig({
        FOOTBALL_ENVIRONMENT: "dev",
      }),
    ).toThrow("FOOTBALL_MATCH_CURSOR_SECRET is required");

    try {
      loadGatewayRuntimeConfig({
        FOOTBALL_ENVIRONMENT: "dev",
        FOOTBALL_MATCH_CURSOR_SECRET: "   ",
      });
      throw new Error("expected Fail Closed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toBe("FOOTBALL_MATCH_CURSOR_SECRET is required");
      expect(message).not.toContain(distinctive);
    }
  });

  it("returns a config with the local public_source constant when env is valid", () => {
    const config = loadGatewayRuntimeConfig({
      FOOTBALL_ENVIRONMENT: "test",
      FOOTBALL_MATCH_CURSOR_SECRET: "test-match-cursor-secret",
      FOOTBALL_REPOSITORY_BACKEND: "memory",
    });
    expect(config).toEqual({
      environment: "test",
      mock_trusted_openid: null,
      match_cursor_secret: "test-match-cursor-secret",
      public_source: LOCAL_PUBLIC_SOURCE,
      repository_backend: "memory",
      cloudbase_repository: null,
      postgres_repository: null,
      vps_auth: null,
    });
    expect(config.public_source).toBe("local_v0");
  });

  it("requires CloudBase settings when CloudBase is selected and ignores VPS keys", () => {
    expect(() => loadGatewayRuntimeConfig({
      FOOTBALL_ENVIRONMENT: "prod",
      FOOTBALL_MATCH_CURSOR_SECRET: "test-match-cursor-secret",
      FOOTBALL_REPOSITORY_BACKEND: "cloudbase",
    })).toThrow("FOOTBALL_CLOUD_ENVIRONMENT_ID is required");
    const config = loadGatewayRuntimeConfig({
      FOOTBALL_ENVIRONMENT: "prod",
      FOOTBALL_MATCH_CURSOR_SECRET: "test-match-cursor-secret",
      FOOTBALL_REPOSITORY_BACKEND: "cloudbase",
      FOOTBALL_CLOUD_ENVIRONMENT_ID: "env",
      FOOTBALL_RESOURCE_NAMESPACE: "football",
      FOOTBALL_DATABASE_URL: "postgres://ignored",
      FOOTBALL_WECHAT_APP_SECRET: "ignored-secret",
    });
    expect(config.cloudbase_repository).toEqual({
      cloud_environment_id: "env",
      resource_namespace: "football",
    });
    expect(config.postgres_repository).toBeNull();
    expect(config.vps_auth).toBeNull();
  });

  it("loads postgres and VPS auth without CloudBase keys", () => {
    const config = loadGatewayRuntimeConfig({
      FOOTBALL_ENVIRONMENT: "prod",
      FOOTBALL_MATCH_CURSOR_SECRET: "test-match-cursor-secret",
      FOOTBALL_REPOSITORY_BACKEND: "postgres",
      FOOTBALL_DATABASE_URL: "postgres://football:secret@127.0.0.1:5432/football",
      FOOTBALL_DATABASE_SCHEMA: "football_prod",
      FOOTBALL_RESOURCE_NAMESPACE: "football_prod",
      FOOTBALL_WECHAT_APP_ID: "wx-test-appid",
      FOOTBALL_WECHAT_APP_SECRET: "wx-test-secret",
      FOOTBALL_SESSION_TTL_SECONDS: "604800",
      FOOTBALL_CLOUD_ENVIRONMENT_ID: "must-not-be-required",
    });
    expect(config.repository_backend).toBe("postgres");
    expect(config.cloudbase_repository).toBeNull();
    expect(config.postgres_repository).toEqual({
      database_url: "postgres://football:secret@127.0.0.1:5432/football",
      database_schema: "football_prod",
      resource_namespace: "football_prod",
    });
    expect(config.vps_auth).toEqual({
      wechat_app_id: "wx-test-appid",
      wechat_app_secret: "wx-test-secret",
      session_ttl_seconds: 604800,
    });
  });

  it("rejects postgres without its own keys even if CloudBase keys are present", () => {
    expect(() => loadGatewayRuntimeConfig({
      FOOTBALL_ENVIRONMENT: "prod",
      FOOTBALL_MATCH_CURSOR_SECRET: "test-match-cursor-secret",
      FOOTBALL_REPOSITORY_BACKEND: "postgres",
      FOOTBALL_CLOUD_ENVIRONMENT_ID: "env",
      FOOTBALL_RESOURCE_NAMESPACE: "football_prod",
      FOOTBALL_DATABASE_SCHEMA: "football_prod",
      FOOTBALL_WECHAT_APP_ID: "wx-test-appid",
      FOOTBALL_WECHAT_APP_SECRET: "wx-test-secret",
      FOOTBALL_SESSION_TTL_SECONDS: "604800",
    })).toThrow("FOOTBALL_DATABASE_URL is required");
  });

  it("rejects a blank VPS secret without echoing it", () => {
    const distinctive = "must-not-appear-in-error";
    try {
      loadGatewayRuntimeConfig({
        FOOTBALL_ENVIRONMENT: "prod",
        FOOTBALL_MATCH_CURSOR_SECRET: "test-match-cursor-secret",
        FOOTBALL_REPOSITORY_BACKEND: "postgres",
        FOOTBALL_DATABASE_URL: "postgres://football:secret@127.0.0.1:5432/football",
        FOOTBALL_DATABASE_SCHEMA: "football_prod",
        FOOTBALL_RESOURCE_NAMESPACE: "football_prod",
        FOOTBALL_WECHAT_APP_ID: "wx-test-appid",
        FOOTBALL_WECHAT_APP_SECRET: distinctive,
        FOOTBALL_SESSION_TTL_SECONDS: "0",
      });
      throw new Error("expected Fail Closed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toBe("FOOTBALL_SESSION_TTL_SECONDS must be a positive integer");
      expect(message).not.toContain(distinctive);
    }
  });
});
