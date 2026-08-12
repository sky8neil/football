import { describe, expect, it, vi } from "vitest";
import { DomainError } from "../../domain/errors.js";
import type { AdminResultCorrectionOutcome } from "../../application/admin-result-correction.js";
import {
  postAdminResultCorrection,
  validateAdminMatchId,
  validateAdminResultCorrectionPayload,
} from "./admin.js";
import { InMemoryRateLimiter } from "./rate-limit.js";

const VALID_REQUEST = {
  expected_result_version: 1,
  regular_home_score: 1,
  regular_away_score: 0,
  reason: "Provider 正式比分更正",
};

describe("validateAdminResultCorrectionPayload", () => {
  it("接受规范定义的管理员赛果修正请求", () => {
    expect(validateAdminResultCorrectionPayload(VALID_REQUEST)).toEqual(VALID_REQUEST);
  });

  it("拒绝客户端传入 admin_id", () => {
    expect(() =>
      validateAdminResultCorrectionPayload({ ...VALID_REQUEST, admin_id: "client-admin" }),
    ).toThrowError(DomainError);
    expect(() =>
      validateAdminResultCorrectionPayload({ ...VALID_REQUEST, admin_id: "client-admin" }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });

  it("拒绝错误版本、非整数或越界比分", () => {
    expect(() =>
      validateAdminResultCorrectionPayload({
        ...VALID_REQUEST,
        expected_result_version: -1,
      }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(() =>
      validateAdminResultCorrectionPayload({ ...VALID_REQUEST, regular_home_score: 1.5 }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(() =>
      validateAdminResultCorrectionPayload({ ...VALID_REQUEST, regular_away_score: 100 }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });

  it("拒绝空 reason、超长 reason 和错误字段类型", () => {
    expect(() =>
      validateAdminResultCorrectionPayload({ ...VALID_REQUEST, reason: "" }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(() =>
      validateAdminResultCorrectionPayload({
        ...VALID_REQUEST,
        reason: "x".repeat(501),
      }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(() =>
      validateAdminResultCorrectionPayload({
        ...VALID_REQUEST,
        regular_home_score: "1",
      }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });

  it("严格校验 match_id 路径参数为 UUID v4", () => {
    const matchId = "00000000-0000-4000-8000-000000000010";
    expect(validateAdminMatchId(matchId)).toBe(matchId);
    expect(() => validateAdminMatchId("m1")).toThrowError(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
  });
});

describe("POST /v1/admin/matches/:match_id/result-corrections", () => {
  it("返回第 48.2 节定义的 201 成功 envelope 和有限 data", async () => {
    const matchId = "00000000-0000-4000-8000-000000000010";
    const auditId = "00000000-0000-4000-8000-000000000011";
    const serverNow = new Date("2026-08-09T00:00:00.000Z");
    const correct = vi.fn(async (): Promise<AdminResultCorrectionOutcome> => ({
      admin_id: "internal-admin-id",
      match: {
        match_id: matchId,
        result_version: 2,
        regular_home_score: 1,
        regular_away_score: 1,
        result_source: "admin",
        settlement_status: "correcting",
      } as AdminResultCorrectionOutcome["match"],
      result: {
        match_id: matchId,
        result_version: 2,
        regular_home_score: 1,
        regular_away_score: 1,
        source: "admin",
      } as AdminResultCorrectionOutcome["result"],
      audit_log: {
        audit_id: auditId,
      } as AdminResultCorrectionOutcome["audit_log"],
    }));

    const response = await postAdminResultCorrection({ correct }, {
      trusted_openid: "trusted-admin-openid",
      match_id: matchId,
      body: VALID_REQUEST,
      server_now: serverNow,
      request_id: "request-correction-1",
    });

    expect(response).toEqual({
      status: 201,
      body: {
        data: {
          match_id: matchId,
          result_version: 2,
          regular_home_score: 1,
          regular_away_score: 1,
          result_source: "admin",
          settlement_status: "correcting",
          audit_id: auditId,
        },
        request_id: "request-correction-1",
      },
    });
    expect(correct).toHaveBeenCalledWith(
      "trusted-admin-openid",
      matchId,
      VALID_REQUEST,
      serverNow,
    );
  });

  it("application 返回非请求目标 match_id 时拒绝生成成功响应", async () => {
    const matchId = "00000000-0000-4000-8000-000000000010";
    const otherMatchId = "00000000-0000-4000-8000-000000000012";
    const correct = vi.fn(async (): Promise<AdminResultCorrectionOutcome> => ({
      admin_id: "internal-admin-id",
      match: {
        match_id: otherMatchId,
        settlement_status: "correcting",
      } as AdminResultCorrectionOutcome["match"],
      result: {
        match_id: otherMatchId,
        result_version: 2,
        regular_home_score: 1,
        regular_away_score: 1,
        source: "admin",
      } as AdminResultCorrectionOutcome["result"],
      audit_log: {
        audit_id: "00000000-0000-4000-8000-000000000011",
      } as AdminResultCorrectionOutcome["audit_log"],
    }));

    await expect(
      postAdminResultCorrection({ correct }, {
        trusted_openid: "trusted-admin-openid",
        match_id: matchId,
        body: VALID_REQUEST,
        server_now: new Date("2026-08-09T00:00:00.000Z"),
        request_id: "request-correction-mismatched-match",
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("application 返回 match 与 result 的版本不一致时拒绝生成成功响应", async () => {
    const matchId = "00000000-0000-4000-8000-000000000010";
    const correct = vi.fn(async (): Promise<AdminResultCorrectionOutcome> => ({
      admin_id: "internal-admin-id",
      match: {
        match_id: matchId,
        result_version: 1,
        regular_home_score: 1,
        regular_away_score: 0,
        result_source: "admin",
        settlement_status: "correcting",
      } as AdminResultCorrectionOutcome["match"],
      result: {
        match_id: matchId,
        result_version: 2,
        regular_home_score: 1,
        regular_away_score: 0,
        source: "admin",
      } as AdminResultCorrectionOutcome["result"],
      audit_log: {
        audit_id: "00000000-0000-4000-8000-000000000011",
      } as AdminResultCorrectionOutcome["audit_log"],
    }));

    await expect(
      postAdminResultCorrection({ correct }, {
        trusted_openid: "trusted-admin-openid",
        match_id: matchId,
        body: VALID_REQUEST,
        server_now: new Date("2026-08-09T00:00:00.000Z"),
        request_id: "request-correction-mismatched-version",
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("application 返回非法 audit_id 时拒绝生成成功响应", async () => {
    const matchId = "00000000-0000-4000-8000-000000000010";
    const correct = vi.fn(async (): Promise<AdminResultCorrectionOutcome> => ({
      admin_id: "internal-admin-id",
      match: {
        match_id: matchId,
        result_version: 2,
        regular_home_score: 1,
        regular_away_score: 1,
        result_source: "admin",
        settlement_status: "correcting",
      } as AdminResultCorrectionOutcome["match"],
      result: {
        match_id: matchId,
        result_version: 2,
        regular_home_score: 1,
        regular_away_score: 1,
        source: "admin",
      } as AdminResultCorrectionOutcome["result"],
      audit_log: {
        audit_id: "not-a-uuid",
      } as AdminResultCorrectionOutcome["audit_log"],
    }));

    await expect(
      postAdminResultCorrection({ correct }, {
        trusted_openid: "trusted-admin-openid",
        match_id: matchId,
        body: VALID_REQUEST,
        server_now: new Date("2026-08-09T00:00:00.000Z"),
        request_id: "request-correction-invalid-audit",
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("application 返回非法 result_version 时拒绝生成成功响应", async () => {
    const matchId = "00000000-0000-4000-8000-000000000010";
    const correct = vi.fn(async (): Promise<AdminResultCorrectionOutcome> => ({
      admin_id: "internal-admin-id",
      match: {
        match_id: matchId,
        result_version: 2,
        regular_home_score: 1,
        regular_away_score: 1,
        result_source: "admin",
        settlement_status: "correcting",
      } as AdminResultCorrectionOutcome["match"],
      result: {
        match_id: matchId,
        result_version: 0,
        regular_home_score: 1,
        regular_away_score: 1,
        source: "admin",
      } as AdminResultCorrectionOutcome["result"],
      audit_log: {
        audit_id: "00000000-0000-4000-8000-000000000011",
      } as AdminResultCorrectionOutcome["audit_log"],
    }));

    await expect(
      postAdminResultCorrection({ correct }, {
        trusted_openid: "trusted-admin-openid",
        match_id: matchId,
        body: VALID_REQUEST,
        server_now: new Date("2026-08-09T00:00:00.000Z"),
        request_id: "request-correction-invalid-result",
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("按管理员身份限制为每分钟 60 次", async () => {
    const matchId = "00000000-0000-4000-8000-000000000010";
    const correct = vi.fn(async (): Promise<AdminResultCorrectionOutcome> => ({
      admin_id: "internal-admin-id",
      match: {
        match_id: matchId,
        result_version: 2,
        regular_home_score: 1,
        regular_away_score: 1,
        result_source: "admin",
        settlement_status: "correcting",
      } as AdminResultCorrectionOutcome["match"],
      result: {
        match_id: matchId,
        result_version: 2,
        regular_home_score: 1,
        regular_away_score: 1,
        source: "admin",
      } as AdminResultCorrectionOutcome["result"],
      audit_log: {
        audit_id: "00000000-0000-4000-8000-000000000011",
      } as AdminResultCorrectionOutcome["audit_log"],
    }));
    const rateLimiter = new InMemoryRateLimiter();
    const input = {
      trusted_openid: "trusted-admin-openid",
      match_id: matchId,
      body: VALID_REQUEST,
      server_now: new Date("2026-08-09T00:00:00.000Z"),
      request_id: "request-correction-rate-limit",
      rate_limiter: rateLimiter,
    };

    for (let attempt = 0; attempt < 60; attempt += 1) {
      await expect(postAdminResultCorrection({ correct }, input)).resolves.toBeDefined();
    }

    await expect(postAdminResultCorrection({ correct }, input)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(correct).toHaveBeenCalledTimes(60);
  });
});
