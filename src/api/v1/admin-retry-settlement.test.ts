import { describe, expect, it, vi } from "vitest";
import { conflictError, DomainError } from "../../domain/errors.js";
import { newUuid } from "../../domain/ids.js";
import {
  postAdminRetrySettlement,
  validateAdminMatchId,
} from "./admin.js";
import { InMemoryRateLimiter } from "./rate-limit.js";
import { mapErrorToHttp } from "./validation.js";

const MATCH_ID = "00000000-0000-4000-8000-000000000010";
const NOW = new Date("2026-08-09T00:00:00.000Z");
const authorizeAdmin = async (_openid: string): Promise<void> => undefined;

describe("POST /v1/admin/matches/:match_id/retry-settlement", () => {
  it("缺少可信管理员身份对外返回 401 UNAUTHORIZED", async () => {
    const retry = vi.fn(async () => {
      throw conflictError("AUTH_REQUIRED", "需要可信管理员身份");
    });

    const error = await postAdminRetrySettlement({ authorizeAdmin, retry }, {
      match_id: "invalid",
      server_now: NOW,
      request_id: "request-retry-unauthorized",
    }).catch((caught: unknown) => caught);
    const response = mapErrorToHttp(error, "request-retry-unauthorized");

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("UNAUTHORIZED");
  });

  it("返回第 48.2 定义的成功 envelope 和有限 data", async () => {
    const settlementId = newUuid();
    const auditId = newUuid();
    const retry = vi.fn(async () => ({
      kind: "settled" as const,
      settlement_id: settlementId,
      result_version: 2,
      processed_count: 10,
      skipped_applied_count: 487,
      audit_log: { audit_id: auditId },
    } as never));

    const result = await postAdminRetrySettlement({ authorizeAdmin, retry }, {
      trusted_openid: "trusted-admin-openid",
      match_id: MATCH_ID,
      server_now: NOW,
      request_id: "request-retry-1",
    } as never);

    expect(result).toEqual({
      status: 200,
      body: {
        data: {
          match_id: MATCH_ID,
          settlement_id: settlementId,
          result_version: 2,
          outcome: "settled",
          processed_count: 10,
          skipped_applied_count: 487,
          audit_id: auditId,
        },
        request_id: "request-retry-1",
      },
    });
  });

  it("校验 match_id 后把 trusted openid 和 server_now 交给 application command", async () => {
    const settlementId = newUuid();
    const auditId = newUuid();
    const retry = vi.fn(async () => ({
      kind: "settled" as const,
      settlement_id: settlementId,
      result_version: 1,
      processed_count: 0,
      skipped_applied_count: 0,
      audit_log: { audit_id: auditId },
    } as never));
    const service = { authorizeAdmin, retry };

    const result = await postAdminRetrySettlement(service, {
      trusted_openid: "trusted-admin-openid",
      match_id: MATCH_ID,
      server_now: NOW,
      request_id: "request-retry-2",
    } as never);

    expect(result.body.data).toMatchObject({
      match_id: MATCH_ID,
      settlement_id: settlementId,
      result_version: 1,
      outcome: "settled",
      audit_id: auditId,
    });
    expect(retry).toHaveBeenCalledWith("trusted-admin-openid", MATCH_ID, NOW);
  });

  it("将失败执行映射为 outcome=failed，且不暴露完整 audit_log", async () => {
    const retry = vi.fn(async () => ({
      kind: "failed" as const,
      settlement_id: newUuid(),
      result_version: 2,
      processed_count: 1,
      skipped_applied_count: 3,
      audit_log: {
        audit_id: newUuid(),
        admin_id: "internal-admin-id",
        old_value: {},
        new_value: {},
      },
    } as never));

    const result = await postAdminRetrySettlement({ authorizeAdmin, retry }, {
      trusted_openid: "trusted-admin-openid",
      match_id: MATCH_ID,
      server_now: NOW,
      request_id: "request-retry-4",
    } as never);

    expect(result.body.data).toMatchObject({ outcome: "failed" });
    expect(result.body.data).not.toHaveProperty("admin_id");
    expect(result.body.data).not.toHaveProperty("old_value");
    expect(result.body.data).not.toHaveProperty("new_value");
  });

  it("拒绝非 UUID match_id，不调用 application command", async () => {
    expect(() => validateAdminMatchId("not-a-uuid")).toThrowError(DomainError);
    const retry = vi.fn();

    await expect(
      Promise.resolve().then(() =>
        postAdminRetrySettlement({ authorizeAdmin, retry }, {
          trusted_openid: "trusted-admin-openid",
          match_id: "not-a-uuid",
          server_now: NOW,
          request_id: "request-retry-3",
        }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(retry).not.toHaveBeenCalled();
  });

  it("管理员身份检查优先于 path 校验，空 body 白名单校验先于限流", async () => {
    const rateLimiter = { check: vi.fn(async () => undefined) };
    const retry = vi.fn();
    const authorize = vi.fn(async (_openid: string) => undefined);

    await expect(postAdminRetrySettlement({ authorizeAdmin: authorize, retry }, {
      trusted_openid: "trusted-admin-openid",
      match_id: "invalid",
      body: { reason: "client reason" },
      server_now: NOW,
      request_id: "request-retry-order",
      rate_limiter: rateLimiter,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(authorize).toHaveBeenCalledOnce();
    expect(rateLimiter.check).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();

    const deniedAuthorize = vi.fn(async (_openid: string) => {
      throw conflictError("FORBIDDEN", "不是管理员");
    });
    await expect(postAdminRetrySettlement({ authorizeAdmin: deniedAuthorize, retry }, {
      trusted_openid: "disabled-admin-openid",
      match_id: "invalid",
      server_now: NOW,
      request_id: "request-retry-forbidden-first",
      rate_limiter: rateLimiter,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(rateLimiter.check).not.toHaveBeenCalled();
  });

  it("rejects unknown fields in an optional empty request body", async () => {
    const retry = vi.fn();
    const rateLimiter = { check: vi.fn(async () => undefined) };
    await expect(postAdminRetrySettlement({ authorizeAdmin, retry }, {
      trusted_openid: "trusted-admin-openid",
      match_id: MATCH_ID,
      body: { reason: "not accepted" },
      server_now: NOW,
      request_id: "request-retry-body",
      rate_limiter: rateLimiter,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(rateLimiter.check).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it("application 返回非法 settlement_id 或 audit_id 时拒绝成功响应", async () => {
    const invalidSettlement = vi.fn(async () => ({
      kind: "settled" as const,
      settlement_id: "not-a-uuid",
      result_version: 2,
      processed_count: 0,
      skipped_applied_count: 0,
      audit_log: { audit_id: newUuid() },
    } as never));

    await expect(
      postAdminRetrySettlement({ authorizeAdmin, retry: invalidSettlement }, {
        trusted_openid: "trusted-admin-openid",
        match_id: MATCH_ID,
        server_now: NOW,
        request_id: "request-retry-invalid-settlement",
      } as never),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

    const invalidAudit = vi.fn(async () => ({
      kind: "settled" as const,
      settlement_id: newUuid(),
      result_version: 2,
      processed_count: 0,
      skipped_applied_count: 0,
      audit_log: { audit_id: "not-a-uuid" },
    } as never));

    await expect(
      postAdminRetrySettlement({ authorizeAdmin, retry: invalidAudit }, {
        trusted_openid: "trusted-admin-openid",
        match_id: MATCH_ID,
        server_now: NOW,
        request_id: "request-retry-invalid-audit",
      } as never),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("application 返回非法执行摘要时拒绝生成成功响应", async () => {
    const retry = vi.fn(async () => ({
      kind: "settled" as const,
      settlement_id: newUuid(),
      result_version: 0,
      processed_count: -1,
      skipped_applied_count: Number.NaN,
      audit_log: { audit_id: newUuid() },
    } as never));

    await expect(
      postAdminRetrySettlement({ authorizeAdmin, retry }, {
        trusted_openid: "trusted-admin-openid",
        match_id: MATCH_ID,
        server_now: NOW,
        request_id: "request-retry-invalid-summary",
      } as never),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("application 返回 already_running 时映射为 SETTLEMENT_ALREADY_RUNNING，不生成 200", async () => {
    const retry = vi.fn(async () => ({
      kind: "already_running" as const,
      settlement_id: newUuid(),
      code: "SETTLEMENT_ALREADY_RUNNING",
    } as never));

    await expect(
      postAdminRetrySettlement({ authorizeAdmin, retry }, {
        trusted_openid: "trusted-admin-openid",
        match_id: MATCH_ID,
        server_now: NOW,
        request_id: "request-retry-already-running",
      }),
    ).rejects.toMatchObject({ code: "SETTLEMENT_ALREADY_RUNNING" });
  });

  it("application 返回 already_settled 或 not_retryable 时映射为 SETTLEMENT_NOT_READY", async () => {
    const alreadySettled = vi.fn(async () => ({
      kind: "already_settled" as const,
      settlement_id: newUuid(),
    } as never));

    await expect(
      postAdminRetrySettlement({ authorizeAdmin, retry: alreadySettled }, {
        trusted_openid: "trusted-admin-openid",
        match_id: MATCH_ID,
        server_now: NOW,
        request_id: "request-retry-already-settled",
      }),
    ).rejects.toMatchObject({ code: "SETTLEMENT_NOT_READY" });

    const notRetryable = vi.fn(async () => ({
      kind: "not_retryable" as const,
      settlement_id: newUuid(),
      status: "running",
    } as never));

    await expect(
      postAdminRetrySettlement({ authorizeAdmin, retry: notRetryable }, {
        trusted_openid: "trusted-admin-openid",
        match_id: MATCH_ID,
        server_now: NOW,
        request_id: "request-retry-not-retryable",
      }),
    ).rejects.toMatchObject({ code: "SETTLEMENT_NOT_READY" });
  });

  it("不把 application 内部 correcting 结果暴露为 200", async () => {
    const retry = vi.fn(async () => ({
      kind: "correcting" as const,
      settlement_id: newUuid(),
      result_version: 2,
      processed_count: 1,
      skipped_applied_count: 0,
      audit_log: { audit_id: newUuid() },
    } as never));

    await expect(
      postAdminRetrySettlement({ authorizeAdmin, retry }, {
        trusted_openid: "trusted-admin-openid",
        match_id: MATCH_ID,
        server_now: NOW,
        request_id: "request-retry-correcting-internal",
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("按管理员身份限制为每分钟 60 次", async () => {
    const settlementId = newUuid();
    const auditId = newUuid();
    const retry = vi.fn(async () => ({
      kind: "settled" as const,
      settlement_id: settlementId,
      result_version: 1,
      processed_count: 0,
      skipped_applied_count: 0,
      audit_log: { audit_id: auditId },
    } as never));
    const rateLimiter = new InMemoryRateLimiter();
    const input = {
      trusted_openid: "trusted-admin-openid",
      match_id: MATCH_ID,
      server_now: NOW,
      request_id: "request-retry-rate-limit",
      rate_limiter: rateLimiter,
    };

    for (let attempt = 0; attempt < 60; attempt += 1) {
      await expect(postAdminRetrySettlement({ authorizeAdmin, retry }, input)).resolves.toBeDefined();
    }

    await expect(postAdminRetrySettlement({ authorizeAdmin, retry }, input)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(retry).toHaveBeenCalledTimes(60);
  });
});
