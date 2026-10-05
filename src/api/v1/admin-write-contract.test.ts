import { describe, expect, it } from "vitest";
import { conflictError } from "../../domain/errors.js";
import {
  postAdminRebuildRankings,
  postAdminRebuildUserStats,
  postAdminResultCorrection,
  postAdminRetrySettlement,
} from "./admin.js";
import { mapErrorToHttp } from "./validation.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const MATCH_ID = "00000000-0000-4000-8000-000000000010";
const USER_ID = "00000000-0000-4000-8000-000000000011";

type AdminErrorCode = "AUTH_REQUIRED" | "FORBIDDEN";
type AdminWrite = "result-correction" | "retry-settlement" | "rebuild-user" | "rebuild-rankings";

function rejectWith(code: AdminErrorCode): never {
  throw conflictError(code, "admin authorization result");
}

async function invokeAdminWrite(kind: AdminWrite, code: AdminErrorCode): Promise<unknown> {
  const authorizeAdmin = async (_openid: string): Promise<void> => rejectWith(code);
  switch (kind) {
    case "result-correction":
      return postAdminResultCorrection(
        { authorizeAdmin, correct: async () => rejectWith(code) },
        {
          trusted_openid: "trusted-admin",
          match_id: MATCH_ID,
          body: {
            expected_result_version: 1,
            regular_home_score: 1,
            regular_away_score: 0,
            reason: "管理员合同复核",
          },
          server_now: NOW,
          request_id: "admin-contract-result-correction",
        },
      );
    case "retry-settlement":
      return postAdminRetrySettlement(
        { authorizeAdmin, retry: async () => rejectWith(code) },
        {
          trusted_openid: "trusted-admin",
          match_id: MATCH_ID,
          server_now: NOW,
          request_id: "admin-contract-retry-settlement",
        },
      );
    case "rebuild-user":
      return postAdminRebuildUserStats(
        { authorizeAdmin, rebuild: async () => rejectWith(code) },
        {
          trusted_openid: "trusted-admin",
          user_id: USER_ID,
          server_now: NOW,
          request_id: "admin-contract-rebuild-user",
        },
      );
    case "rebuild-rankings":
      return postAdminRebuildRankings(
        { authorizeAdmin, rebuild: async () => rejectWith(code) },
        {
          trusted_openid: "trusted-admin",
          body: {
            board: "week",
            period_key: "2026-W32",
            reason: "管理员合同复核",
          },
          server_now: NOW,
          request_id: "admin-contract-rebuild-rankings",
        },
      );
  }
}

describe("admin write error contract", () => {
  const adminWrites = [
    "result-correction",
    "retry-settlement",
    "rebuild-user",
    "rebuild-rankings",
  ] as const;

  it("maps AUTH_REQUIRED consistently for all four admin writes", async () => {
    for (const kind of adminWrites) {
      const error = await invokeAdminWrite(kind, "AUTH_REQUIRED").catch((caught: unknown) => caught);
      const response = mapErrorToHttp(error, `request-${kind}`);
      expect(response.status).toBe(401);
      expect(response.body.code).toBe("UNAUTHORIZED");
    }
  });

  it("M121 maps non-admin FORBIDDEN to 403 for all four admin writes", async () => {
    for (const kind of adminWrites) {
      const error = await invokeAdminWrite(kind, "FORBIDDEN").catch((caught: unknown) => caught);
      const response = mapErrorToHttp(error, `request-${kind}`);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("FORBIDDEN");
    }
  });
});
