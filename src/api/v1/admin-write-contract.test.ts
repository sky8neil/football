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
  switch (kind) {
    case "result-correction":
      return postAdminResultCorrection(
        { correct: async () => rejectWith(code) },
        {
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
        { retry: async () => rejectWith(code) },
        {
          match_id: MATCH_ID,
          server_now: NOW,
          request_id: "admin-contract-retry-settlement",
        },
      );
    case "rebuild-user":
      return postAdminRebuildUserStats(
        { rebuild: async () => rejectWith(code) },
        {
          user_id: USER_ID,
          server_now: NOW,
          request_id: "admin-contract-rebuild-user",
        },
      );
    case "rebuild-rankings":
      return postAdminRebuildRankings(
        { rebuild: async () => rejectWith(code) },
        {
          body: {
            period_type: "week",
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
  it.each([
    ["AUTH_REQUIRED", 401, "UNAUTHORIZED"],
    ["FORBIDDEN", 403, "FORBIDDEN"],
  ] as const)("maps %s consistently for all four admin writes", async (code, status, externalCode) => {
    for (const kind of [
      "result-correction",
      "retry-settlement",
      "rebuild-user",
      "rebuild-rankings",
    ] as const) {
      const error = await invokeAdminWrite(kind, code).catch((caught: unknown) => caught);
      const response = mapErrorToHttp(error, `request-${kind}`);

      expect(response.status).toBe(status);
      expect(response.body.code).toBe(externalCode);
    }
  });
});
