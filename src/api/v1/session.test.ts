import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SessionInitResult } from "../../application/session.js";
import type { User } from "../../domain/types.js";
import { postSessionInit, validateSessionInitBody } from "./session.js";
import { InMemoryRateLimiter } from "./rate-limit.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");

function makeUser(overrides: Partial<User> = {}): User {
  return {
    schema_version: 1,
    user_id: "00000000-0000-4000-8000-000000000001",
    openid: "trusted-openid",
    unionid: null,
    nickname: "Sky",
    favorite_team_id: null,
    status: "active",
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_level: 1,
    career_best_level: 1,
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeCommand(result: SessionInitResult) {
  return {
    init: vi.fn(async (payload: Record<string, unknown>, serverNow: Date) => {
      expect(payload).toEqual({ openid: "trusted-openid", nickname: "Sky" });
      expect(serverNow).toBe(NOW);
      return result;
    }),
  };
}

describe("POST /v1/session/init", () => {
  it("只把可信上下文 openid 传给 application，并返回新用户 201 有限 data", async () => {
    const command = makeCommand({ user: makeUser(), created: true });

    const response = await postSessionInit(command, {
      trusted_openid: "trusted-openid",
      body: { nickname: "Sky" },
      server_now: NOW,
      request_id: "request-session-1",
    });

    expect(response).toEqual({
      status: 201,
      body: {
        data: {
          user_id: "00000000-0000-4000-8000-000000000001",
          nickname: "Sky",
          favorite_team_id: null,
          status: "active",
          career_points: 0,
          career_level: 1,
        },
        request_id: "request-session-1",
      },
    });
    expect(response.body.data).not.toHaveProperty("openid");
  });

  it("已有用户幂等返回 200，且不暴露 created 或内部用户对象", async () => {
    const command = makeCommand({
      user: makeUser({ career_points: 12, career_level: 2 }),
      created: false,
    });

    const response = await postSessionInit(command, {
      trusted_openid: "trusted-openid",
      body: { nickname: "Sky" },
      server_now: NOW,
      request_id: "request-session-2",
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      user_id: "00000000-0000-4000-8000-000000000001",
      nickname: "Sky",
      favorite_team_id: null,
      status: "active",
      career_points: 12,
      career_level: 2,
    });
  });

  it("拒绝客户端 openid、未定义字段和缺失可信身份", async () => {
    expect(() => validateSessionInitBody({ nickname: "Sky", openid: "attacker" }))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(() => validateSessionInitBody({ nickname: "Sky", token: "secret" }))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));

    const command = { init: vi.fn() };
    await expect(
      postSessionInit(command, {
        trusted_openid: null,
        body: { nickname: "Sky" },
        server_now: NOW,
        request_id: "request-session-3",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(command.init).not.toHaveBeenCalled();
  });

  it("按可信 openid 限制 session init 为每分钟 120 次", async () => {
    const init = vi.fn(async () => ({ user: makeUser(), created: false }));
    const rateLimiter = new InMemoryRateLimiter();
    const input = {
      trusted_openid: "trusted-openid-rate-limit",
      body: { nickname: "Sky" },
      server_now: NOW,
      request_id: "request-session-rate-limit",
      rate_limiter: rateLimiter,
    };

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await expect(postSessionInit({ init }, input as never)).resolves.toBeDefined();
    }

    await expect(postSessionInit({ init }, input as never)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(init).toHaveBeenCalledTimes(120);
  });

  it("OpenAPI contract 声明 POST /session/init 的 429 RateLimited", () => {
    const openapi = readFileSync(new URL("./openapi.yaml", import.meta.url), "utf8");
    expect(openapi).toMatch(
      /  \/session\/init:\n    post:[\s\S]*?'429':[\s\S]*?RateLimited/,
    );
  });
});
