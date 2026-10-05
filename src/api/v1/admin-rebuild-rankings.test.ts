import { describe, expect, it, vi } from "vitest";
import { newUuid } from "../../domain/ids.js";
import type { AdminRebuildRankingsOutcome } from "../../application/admin-rebuild-rankings.js";
import {
  postAdminRebuildRankings,
  validateAdminRebuildRankingsPayload,
} from "./admin.js";
import { InMemoryRateLimiter } from "./rate-limit.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const REQUEST_ID = "request-rebuild-rankings-1";
const AUDIT_ID = newUuid();
const authorizeAdmin = async (_openid: string): Promise<void> => undefined;

function outcome(): AdminRebuildRankingsOutcome {
  return {
    board: "week",
    period_key: "2026-W32",
    rebuilt_entry_count: 0,
    admin_id: newUuid(),
    audit_log: { audit_id: AUDIT_ID } as AdminRebuildRankingsOutcome["audit_log"],
  };
}

describe("validateAdminRebuildRankingsPayload", () => {
  it("接受 week period 与无 period_key 的快照 board 请求", () => {
    expect(
      validateAdminRebuildRankingsPayload({
        board: "week",
        period_key: "2026-W32",
        reason: "一致性修复",
      }),
    ).toEqual({
      board: "week",
      period_key: "2026-W32",
      reason: "一致性修复",
    });
    expect(
      validateAdminRebuildRankingsPayload({
        board: "career",
        reason: "一致性修复",
      }),
    ).toEqual({
      board: "career",
      period_key: null,
      reason: "一致性修复",
    });
    expect(
      validateAdminRebuildRankingsPayload({
        board: "strength",
        reason: "一致性修复",
      }),
    ).toEqual({ board: "strength", period_key: null, reason: "一致性修复" });
  });

  it("严格拒绝未知字段、周期类型和不匹配的 period_key", () => {
    expect(() =>
      validateAdminRebuildRankingsPayload({
        board: "week",
        period_key: "2026-W32",
        reason: "一致性修复",
        admin_id: "client-admin",
      }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(() =>
      validateAdminRebuildRankingsPayload({
        board: "quarter",
        reason: "一致性修复",
      }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(() =>
      validateAdminRebuildRankingsPayload({
        board: "week",
        period_key: "2026-08",
        reason: "一致性修复",
      }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(() =>
      validateAdminRebuildRankingsPayload({
        board: "career",
        period_key: "2026-W32",
        reason: "一致性修复",
      }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(() =>
      validateAdminRebuildRankingsPayload({
        board: "strength",
        period_key: null,
        reason: "一致性修复",
      }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(() =>
      validateAdminRebuildRankingsPayload({
        board: "week",
        period_key: "2026-W00",
        reason: "一致性修复",
      }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });

  it("严格校验 reason", () => {
    expect(() =>
      validateAdminRebuildRankingsPayload({
        board: "week",
        period_key: "2026-W32",
        reason: "",
      }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(() =>
      validateAdminRebuildRankingsPayload({
        board: "week",
        period_key: "2026-W32",
        reason: "x".repeat(501),
      }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(() =>
      validateAdminRebuildRankingsPayload({
        board: "week",
        period_key: "2026-W32",
        reason: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });
});

describe("POST /v1/admin/rebuild/rankings", () => {
  it("返回 §30.6 定义的成功 envelope", async () => {
    const rebuild = vi.fn(async (): Promise<AdminRebuildRankingsOutcome> => outcome());

    const result = await postAdminRebuildRankings({ authorizeAdmin, rebuild }, {
      trusted_openid: "trusted-admin-openid",
      body: {
        board: "week",
        period_key: "2026-W32",
        reason: "一致性修复",
      },
      server_now: NOW,
      request_id: REQUEST_ID,
    });

    expect(result).toEqual({
      status: 200,
      body: {
        data: {
          board: "week",
          period_key: "2026-W32",
          rebuilt_entry_count: 0,
          audit_id: AUDIT_ID,
        },
        request_id: REQUEST_ID,
      },
    });
    expect(rebuild).toHaveBeenCalledWith(
      "trusted-admin-openid",
      "week",
      "2026-W32",
      "一致性修复",
      NOW,
    );
  });

  it("career snapshot rebuild 返回 period_key=null", async () => {
    const careerOutcome: AdminRebuildRankingsOutcome = {
      ...outcome(),
      board: "career",
      period_key: null,
      rebuilt_entry_count: 7,
    };
    const rebuild = vi.fn(async () => careerOutcome);
    const result = await postAdminRebuildRankings({ authorizeAdmin, rebuild }, {
      trusted_openid: "trusted-admin-openid",
      body: { board: "career", reason: "快照校正" },
      server_now: NOW,
      request_id: "request-career-snapshot-rebuild",
    });

    expect(result.body.data).toEqual({
      board: "career",
      period_key: null,
      rebuilt_entry_count: 7,
      audit_id: AUDIT_ID,
    });
    expect(rebuild).toHaveBeenCalledWith(
      "trusted-admin-openid",
      "career",
      null,
      "快照校正",
      NOW,
    );
  });

  it("body 校验失败时不调用 application command", async () => {
    const rebuild = vi.fn();

    await expect(
      Promise.resolve().then(() =>
        postAdminRebuildRankings({ authorizeAdmin, rebuild }, {
          trusted_openid: "trusted-admin-openid",
      body: {
        board: "week",
        period_key: "2026-W32",
        reason: "一致性修复",
        extra: true,
      },
      server_now: NOW,
      request_id: REQUEST_ID,
      }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("application 返回非法 audit_id 时拒绝生成成功响应", async () => {
    const rebuild = vi.fn(async (): Promise<AdminRebuildRankingsOutcome> => ({
      ...outcome(),
      audit_log: { audit_id: "not-a-uuid" } as AdminRebuildRankingsOutcome["audit_log"],
    }));

    await expect(
      postAdminRebuildRankings({ authorizeAdmin, rebuild }, {
        trusted_openid: "trusted-admin-openid",
        body: {
          board: "week",
          period_key: "2026-W32",
          reason: "一致性修复",
        },
        server_now: NOW,
        request_id: "request-rebuild-rankings-invalid-audit",
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("application 返回非法 rebuilt_entry_count 时拒绝生成成功响应", async () => {
    const rebuild = vi.fn(async (): Promise<AdminRebuildRankingsOutcome> => ({
      ...outcome(),
      rebuilt_entry_count: -1,
    }));

    await expect(
      postAdminRebuildRankings({ authorizeAdmin, rebuild }, {
        trusted_openid: "trusted-admin-openid",
        body: {
          board: "week",
          period_key: "2026-W32",
          reason: "一致性修复",
        },
        server_now: NOW,
        request_id: "request-rebuild-rankings-invalid-summary",
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("按管理员身份限制为每分钟 60 次", async () => {
    const rebuild = vi.fn(async (): Promise<AdminRebuildRankingsOutcome> => outcome());
    const rateLimiter = new InMemoryRateLimiter();
    const input = {
      trusted_openid: "trusted-admin-openid",
      body: {
        board: "week",
        period_key: "2026-W32",
        reason: "一致性修复",
      },
      server_now: NOW,
      request_id: "request-rebuild-rankings-rate-limit",
      rate_limiter: rateLimiter,
    };

    for (let attempt = 0; attempt < 60; attempt += 1) {
      await expect(postAdminRebuildRankings({ authorizeAdmin, rebuild }, input)).resolves.toBeDefined();
    }

    await expect(postAdminRebuildRankings({ authorizeAdmin, rebuild }, input)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(rebuild).toHaveBeenCalledTimes(60);
  });
});
