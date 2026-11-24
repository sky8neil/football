import { describe, expect, it } from "vitest";
import { DomainError, validationError } from "../../domain/errors.js";
import { mapErrorToHttp } from "./validation.js";

describe("mapErrorToHttp DATA-03 internal error sanitization", () => {
  it("does not leak domain assertion text on 500 INTERNAL_ERROR", () => {
    const mapped = mapErrorToHttp(
      new DomainError("INTERNAL_ERROR", "career_level_state.last_eval_n <= 300"),
      "req-data-03",
    );

    expect(mapped.status).toBe(500);
    expect(mapped.body.code).toBe("INTERNAL_ERROR");
    expect(mapped.body.message).not.toContain("last_eval_n");
    expect(mapped.body).not.toHaveProperty("details");
    expect(mapped.body.request_id).toBe("req-data-03");
  });

  it("still exposes 401 and 422 messages as-is", () => {
    const unauthorized = mapErrorToHttp(
      new DomainError("UNAUTHORIZED", "需要重新登录"),
      "req-401",
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body.message).toBe("需要重新登录");

    const invalid = mapErrorToHttp(
      validationError("参数错误", { field: "nickname" }),
      "req-422",
    );
    expect(invalid.status).toBe(422);
    expect(invalid.body.message).toBe("参数错误");
  });

  it("maps RANKING_REBUILD_ALREADY_RUNNING to 409 instead of 500", () => {
    const mapped = mapErrorToHttp(
      new DomainError("RANKING_REBUILD_ALREADY_RUNNING", "周期排行榜重算锁被占用"),
      "req-rank-lock",
    );

    expect(mapped.status).toBe(409);
    expect(mapped.body.code).toBe("RANKING_REBUILD_ALREADY_RUNNING");
  });
});
