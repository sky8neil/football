import { describe, expect, it } from "vitest";
import {
  conflictError,
  DomainError,
  notFoundError,
  validationError,
} from "../../domain/errors.js";
import { isValidUuid } from "../../domain/ids.js";
import {
  assertUnknownFields,
  makeRequestId,
  mapErrorToHttp,
  submitPredictionStatus,
} from "./validation.js";

describe("assertUnknownFields", () => {
  const ALLOWED = new Set(["openid", "nickname"]);

  it("允许字段全部通过", () => {
    expect(() =>
      assertUnknownFields({ openid: "o", nickname: "n" }, ALLOWED),
    ).not.toThrow();
  });

  it("未定义字段拒绝（VALIDATION_ERROR，details.field 标识字段）", () => {
    let caught: DomainError | null = null;
    try {
      assertUnknownFields({ openid: "o", token: "t" }, ALLOWED);
    } catch (err) {
      caught = err as DomainError;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect(caught?.code).toBe("VALIDATION_ERROR");
    expect(caught?.details).toEqual({ field: "token" });
  });

  it("非对象请求体拒绝", () => {
    expect(() => assertUnknownFields(null as never, ALLOWED)).toThrow(DomainError);
    expect(() => assertUnknownFields("x" as never, ALLOWED)).toThrow(DomainError);
    expect(() => assertUnknownFields([1] as never, ALLOWED)).toThrow(DomainError);
  });
});

describe("mapErrorToHttp", () => {
  it("VALIDATION_ERROR → 422", () => {
    const mapped = mapErrorToHttp(validationError("参数错误"), "req-1");
    expect(mapped.status).toBe(422);
    expect(mapped.body.code).toBe("VALIDATION_ERROR");
  });

  it("*_NOT_FOUND → 404", () => {
    expect(mapErrorToHttp(notFoundError("USER"), "req-1").status).toBe(404);
    expect(mapErrorToHttp(notFoundError("MATCH"), "req-1").status).toBe(404);
    expect(mapErrorToHttp(notFoundError("USER"), "req-1").body.code).toBe("USER_NOT_FOUND");
  });

  it("409 冲突码映射", () => {
    expect(mapErrorToHttp(conflictError("IDEMPOTENCY_KEY_REUSED", "m"), "r").status).toBe(409);
    expect(
      mapErrorToHttp(conflictError("PREDICTION_ALREADY_SUBMITTED", "m"), "r").status,
    ).toBe(409);
    expect(mapErrorToHttp(conflictError("USER_DELETED", "m"), "r").status).toBe(409);
    expect(mapErrorToHttp(conflictError("MATCH_NOT_PREDICTABLE", "m"), "r").status).toBe(409);
  });

  it("规范定义的结算/版本冲突码映射 409", () => {
    for (const code of [
      "MATCH_NOT_PREDICTABLE",
      "MATCH_STATE_CONFLICT",
      "PREDICTION_LOCKED",
      "SETTLEMENT_NOT_READY",
      "SETTLEMENT_ALREADY_RUNNING",
      "SETTLEMENT_FAILED",
      "RESULT_UNCHANGED",
      "RESULT_VERSION_CONFLICT",
      "PROVIDER_DATA_INVALID",
      "PROVIDER_STATE_CONFLICT",
    ]) {
      expect(mapErrorToHttp(conflictError(code, "m"), "r").status).toBe(409);
    }
  });

  it("修正与版本顺序冲突码映射 409", () => {
    for (const code of [
      "MATCH_NOT_FINISHED",
      "INVALID_RESULT_VERSION",
      "MATCH_NOT_SETTLED",
      "SETTLEMENT_NOTHING_TO_CORRECT",
      "RESULT_VERSION_SKIPPED",
      "RESULT_VERSION_STALE",
    ]) {
      expect(mapErrorToHttp(conflictError(code, "m"), "r").status).toBe(409);
    }
  });

  it("403 / 401 / 429 映射", () => {
    expect(mapErrorToHttp(conflictError("FORBIDDEN", "m"), "r").status).toBe(403);
    expect(mapErrorToHttp(conflictError("USER_NOT_ACTIVE", "m"), "r").status).toBe(403);
    expect(mapErrorToHttp(conflictError("AUTH_REQUIRED", "m"), "r").status).toBe(401);
    expect(mapErrorToHttp(conflictError("RATE_LIMITED", "m"), "r").status).toBe(429);
  });

  it("49.2 UNAUTHORIZED 映射为 401", () => {
    expect(mapErrorToHttp(conflictError("UNAUTHORIZED", "m"), "r").status).toBe(401);
  });

  it("PROVIDER_UNAVAILABLE 映射为 503", () => {
    expect(mapErrorToHttp(conflictError("PROVIDER_UNAVAILABLE", "m"), "r").status).toBe(503);
  });

  it("未知 code 与 INTERNAL_ERROR → 500", () => {
    expect(mapErrorToHttp(conflictError("SOMETHING_WEIRD", "m"), "r").status).toBe(500);
    expect(mapErrorToHttp(conflictError("INTERNAL_ERROR", "m"), "r").status).toBe(500);
  });

  it("事实账本数据不一致对外统一为 500 INTERNAL_ERROR", () => {
    const mapped = mapErrorToHttp(conflictError("INVALID_LEDGER", "m"), "r");

    expect(mapped.status).toBe(500);
    expect(mapped.body.code).toBe("INTERNAL_ERROR");
  });

  it("非 DomainError → 500 INTERNAL_ERROR", () => {
    const mapped = mapErrorToHttp(new Error("boom"), "req-2");
    expect(mapped.status).toBe(500);
    expect(mapped.body.code).toBe("INTERNAL_ERROR");
    expect(mapped.body.message).toBe("服务器内部错误");
  });

  it("envelope 携带 request_id 与 details", () => {
    const mapped = mapErrorToHttp(validationError("x", { field: "a" }), "req-42");
    expect(mapped.body.request_id).toBe("req-42");
    expect(mapped.body.details).toEqual({ field: "a" });
    expect(mapped.body.message).toBe("x");
  });
});

describe("submitPredictionStatus", () => {
  it("created → 201，幂等重放 → 200", () => {
    expect(submitPredictionStatus({ created: true })).toBe(201);
    expect(submitPredictionStatus({ created: false })).toBe(200);
  });
});

describe("makeRequestId", () => {
  it("返回 UUID v4 字符串", () => {
    const id = makeRequestId();
    expect(typeof id).toBe("string");
    expect(isValidUuid(id)).toBe(true);
  });
});
