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
    });
    expect(config).toEqual({
      environment: "test",
      mock_trusted_openid: null,
      match_cursor_secret: "test-match-cursor-secret",
      public_source: LOCAL_PUBLIC_SOURCE,
    });
    expect(config.public_source).toBe("local_v0");
  });
});
