import { describe, expect, it } from "vitest";
import { DomainError, validationError } from "../domain/errors.js";
import { CloudBaseDuplicateKeyError } from "../infrastructure/cloudbase-db.js";
import {
  ProviderDataError,
  ProviderHttpError,
  ProviderQuotaExceededError,
} from "../provider/http.js";
import {
  classifyFailure,
  isBenignSkip,
  type FailureClassification,
} from "./failure-taxonomy.js";

function expectClass(
  error: unknown,
  expected: FailureClassification,
): void {
  expect(classifyFailure(error)).toEqual(expected);
}

describe("classifyFailure", () => {
  it("classifies ECONNRESET-shaped transport errors as transient and retryable", () => {
    const error = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expectClass(error, { category: "transient", retryable: true, code: "ECONNRESET" });
    expect(isBenignSkip(classifyFailure(error))).toBe(false);
  });

  it("classifies ProviderDataError as data_format and not retryable", () => {
    const error = new ProviderDataError("invalid provider envelope");
    expectClass(error, {
      category: "data_format",
      retryable: false,
      code: "PROVIDER_DATA_ERROR",
    });
    expect(isBenignSkip(classifyFailure(error))).toBe(false);
  });

  it("classifies ProviderQuotaExceededError as quota_auth and retryable with backoff", () => {
    const error = new ProviderQuotaExceededError(null);
    expectClass(error, {
      category: "quota_auth",
      retryable: true,
      code: "PROVIDER_QUOTA_EXCEEDED",
    });
    expect(isBenignSkip(classifyFailure(error))).toBe(false);
  });

  it("classifies CloudBaseDuplicateKeyError as lock_contention and retryable", () => {
    const error = new CloudBaseDuplicateKeyError("job_locks", "pk_document", { _id: "sync" });
    expectClass(error, {
      category: "lock_contention",
      retryable: true,
      code: "DUPLICATE_KEY",
    });
    expect(isBenignSkip(classifyFailure(error))).toBe(false);
  });

  it("classifies not-due skip messages as not_due and not retryable", () => {
    const error = new Error("未到重试时间");
    expectClass(error, { category: "not_due", retryable: false, code: "NOT_DUE" });
    expect(isBenignSkip(classifyFailure(error))).toBe(true);
  });

  it("classifies no-match-window skip messages as no_match_window and not retryable", () => {
    const error = new Error("无比赛窗口");
    expectClass(error, {
      category: "no_match_window",
      retryable: false,
      code: "NO_MATCH_WINDOW",
    });
    expect(isBenignSkip(classifyFailure(error))).toBe(true);
  });

  it("classifies null and plain string input as unknown without throwing", () => {
    expectClass(null, { category: "unknown", retryable: false, code: "UNKNOWN" });
    expectClass("random failure", { category: "unknown", retryable: false, code: "UNKNOWN" });
    expect(isBenignSkip(classifyFailure(null))).toBe(false);
  });

  it("classifies unknown Error as unknown and not retryable", () => {
    const error = new Error("something completely unexpected");
    expectClass(error, { category: "unknown", retryable: false, code: "UNKNOWN" });
    expect(isBenignSkip(classifyFailure(error))).toBe(false);
  });

  it("prefers DomainError.code over message (VALIDATION_ERROR → data_format)", () => {
    const error = validationError("字段非法", { field: "job_type" });
    expectClass(error, {
      category: "data_format",
      retryable: false,
      code: "VALIDATION_ERROR",
    });
  });

  it("classifies ProviderHttpError 5xx as transient and 401 as quota_auth", () => {
    expectClass(new ProviderHttpError(503, "provider HTTP 503"), {
      category: "transient",
      retryable: true,
      code: "PROVIDER_HTTP_503",
    });
    expectClass(new ProviderHttpError(401, "provider HTTP 401", "1010"), {
      category: "quota_auth",
      retryable: true,
      code: "1010",
    });
  });

  it("classifies scheduler acquire-false skip shape as lock_contention", () => {
    expectClass({ outcome: "skipped" }, {
      category: "lock_contention",
      retryable: true,
      code: "LOCK_CONTENTION",
    });
  });

  it("isBenignSkip is true only for not_due and no_match_window", () => {
    const benign = ["not_due", "no_match_window"];
    const samples: Array<[unknown, boolean]> = [
      [new Error("未到执行窗口"), true],
      [new Error("无候选"), true],
      [new ProviderQuotaExceededError(null), false],
      [new ProviderDataError("bad json"), false],
      [new CloudBaseDuplicateKeyError("c", "i", {}), false],
      [Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }), false],
      [new DomainError("INTERNAL_ERROR", "boom"), false],
      [undefined, false],
    ];
    for (const [error, skip] of samples) {
      const classified = classifyFailure(error);
      expect(isBenignSkip(classified)).toBe(skip);
      expect(benign.includes(classified.category)).toBe(skip);
    }
  });
});
