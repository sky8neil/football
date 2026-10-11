import { describe, expect, it } from "vitest";
import { classifyCloudError, missingCloudEnvironmentKeys } from "./cloud-diagnostics.js";

describe("classifyCloudError", () => {
  it.each([
    ["Required environment configuration missing: FOOTBALL_RESOURCE_NAMESPACE", "DIAG_FN_ENV_VAR_MISSING"],
    ["prod environment cannot configure mock identity", "DIAG_PROD_MOCK_IDENTITY"],
    ["Cloud environment mismatch", "DIAG_ENV_MISMATCH"],
    ["Cannot find module 'wx-server-sdk'", "DIAG_FN_DEPENDENCY_MISSING"],
    ["OPENID is missing from runtime context", "DIAG_FN_NO_OPENID"],
    ["collection football_test_users does not exist", "DIAG_DB_COLLECTION_MISSING"],
    ["database permission denied", "DIAG_DB_PERMISSION"],
    ["duplicate key violates unique index", "DIAG_DB_INDEX_MISSING"],
    ["CloudBase transaction failed", "DIAG_DB_TRANSACTION"],
  ])("maps %s to %s", (message, diagCode) => {
    expect(classifyCloudError(Object.assign(new Error(message), { errCode: 503 })).diag_code).toBe(diagCode);
  });

  it("keeps unknown SDK error details, redacts identity and secrets, and truncates the message", () => {
    const openid = "wx1234567890abcdef1234567890abcdef";
    const diagnostic = classifyCloudError(Object.assign(
      new Error(`upstream failed openid=${openid} secret:super-secret ${"x".repeat(400)}`),
      { errCode: "E_UNKNOWN" },
    ));
    expect(diagnostic).toMatchObject({ diag_code: "DIAG_UNKNOWN", sdk_code: "E_UNKNOWN" });
    expect(diagnostic.sdk_message).toHaveLength(300);
    expect(diagnostic.sdk_message).not.toContain(openid);
    expect(diagnostic.sdk_message).not.toContain("super-secret");
  });
});

describe("missingCloudEnvironmentKeys", () => {
  it("returns only missing or blank required keys", () => {
    expect(missingCloudEnvironmentKeys({
      FOOTBALL_ENVIRONMENT: "test",
      FOOTBALL_MATCH_CURSOR_SECRET: " ",
      FOOTBALL_REPOSITORY_BACKEND: "cloudbase",
      FOOTBALL_CLOUD_ENVIRONMENT_ID: "cloud-test",
    })).toEqual(["FOOTBALL_MATCH_CURSOR_SECRET", "FOOTBALL_RESOURCE_NAMESPACE"]);
  });
});
