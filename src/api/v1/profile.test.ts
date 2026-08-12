import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { newUuid } from "../../domain/ids.js";
import { DomainError } from "../../domain/errors.js";
import { InMemoryRepository } from "../../infrastructure/repositories.js";
import { ProfileQueryService } from "../../application/profile.js";
import {
  deleteMyProfile,
  getMyProfile,
  getPublicProfile,
  patchMyProfile,
  validateProfilePatch,
  validatePublicProfileUserId,
} from "./profile.js";
import { InMemoryRateLimiter } from "./rate-limit.js";

describe("PATCH /v1/profile/me", () => {
  it("严格校验允许字段并返回更新后的 profile data", async () => {
    expect(validateProfilePatch({ nickname: "  Alice  " })).toEqual({
      nickname: "  Alice  ",
    });
    expect(validateProfilePatch({ favorite_team_id: null })).toEqual({
      favorite_team_id: null,
    });
    expect(() => validateProfilePatch({})).toThrowError(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
    expect(() => validateProfilePatch({ career_points: 999 })).toThrowError(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
  });

  it("认证用户调用 application command 并返回 200 envelope", async () => {
    const updateProfile = vi.fn(async () => ({
      user_id: "00000000-0000-4000-8000-000000000010",
      nickname: "Alice",
      favorite_team_id: null,
      career_points: 12,
      career_valid_predictions: 1,
      career_wdl_hits: 1,
      career_exact_hits: 1,
      career_wdl_accuracy_percent: "100.0",
      career_level: 1,
      career_best_level: 1,
    }));
    const serverNow = new Date("2026-08-09T00:00:00.000Z");

    await expect(
      patchMyProfile({ updateMyProfile: updateProfile }, {
        authenticated_user_id: "00000000-0000-4000-8000-000000000010",
        body: { nickname: "Alice" },
        server_now: serverNow,
        request_id: "request-profile-patch-1",
      }),
    ).resolves.toEqual({
      status: 200,
      body: {
        data: {
          user_id: "00000000-0000-4000-8000-000000000010",
          nickname: "Alice",
          favorite_team_id: null,
          career_points: 12,
          career_valid_predictions: 1,
          career_wdl_hits: 1,
          career_exact_hits: 1,
          career_wdl_accuracy_percent: "100.0",
          career_level: 1,
          career_best_level: 1,
        },
        request_id: "request-profile-patch-1",
      },
    });
    expect(updateProfile).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000010",
      { nickname: "Alice" },
      serverNow,
    );
  });

  it("没有认证用户时拒绝且不调用 application command", async () => {
    const updateProfile = vi.fn();

    await expect(
      patchMyProfile({ updateMyProfile: updateProfile }, {
        authenticated_user_id: null,
        body: { nickname: "Alice" },
        server_now: new Date("2026-08-09T00:00:00.000Z"),
        request_id: "request-profile-patch-2",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("按用户限制资料写入为每分钟 20 次", async () => {
    const updateProfile = vi.fn(async () => ({
      user_id: "00000000-0000-4000-8000-000000000010",
      nickname: "Alice",
      favorite_team_id: null,
      career_points: 0,
      career_valid_predictions: 0,
      career_wdl_hits: 0,
      career_exact_hits: 0,
      career_wdl_accuracy_percent: "0.0",
      career_level: 1,
      career_best_level: 1,
    }));
    const rateLimiter = new InMemoryRateLimiter();
    const input = {
      authenticated_user_id: "00000000-0000-4000-8000-000000000010",
      body: { nickname: "Alice" },
      server_now: new Date("2026-08-09T00:00:00.000Z"),
      request_id: "request-profile-rate-limit",
      rate_limiter: rateLimiter,
    } as never;

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await expect(patchMyProfile({ updateMyProfile: updateProfile }, input)).resolves.toBeDefined();
    }

    await expect(
      patchMyProfile({ updateMyProfile: updateProfile }, input),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("GET /v1/profiles/:user_id", () => {
  it("返回规范成功 envelope", async () => {
    const repo = new InMemoryRepository();
    const userId = newUuid();
    await repo.users.insert({
      schema_version: 1,
      user_id: userId,
      openid: "openid-public-profile",
      unionid: null,
      nickname: "Sky",
      favorite_team_id: null,
      status: "active",
      career_points: 3,
      career_valid_predictions: 1,
      career_wdl_hits: 1,
      career_exact_hits: 0,
      career_level: 1,
      career_best_level: 1,
      deleted_at: null,
      created_at: new Date("2026-08-01T00:00:00Z"),
      updated_at: new Date("2026-08-01T00:00:00Z"),
    });

    const response = await getPublicProfile(new ProfileQueryService(repo), {
      user_id: userId,
      request_id: "request-profile-1",
      public_source: "gateway-source-profile-success",
      server_now: new Date("2026-08-09T00:00:00.000Z"),
    });

    expect(response).toEqual({
      status: 200,
      body: {
        data: {
          user_id: userId,
          display_name: "Sky",
          favorite_team_id: null,
          career_points: 3,
          career_valid_predictions: 1,
          career_wdl_accuracy_percent: "100.0",
          career_level: 1,
          career_best_level: 1,
        },
        request_id: "request-profile-1",
      },
    });
  });

  it("拒绝非 UUID user_id", () => {
    expect(() => validatePublicProfileUserId("not-a-uuid")).toThrowError(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
    expect(() => validatePublicProfileUserId("not-a-uuid")).toThrow(DomainError);
  });

  it("缺少可信公开来源时 Fail Closed 且不调用查询服务", async () => {
    const getPublicProfileData = vi.fn();

    await expect(
      getPublicProfile({ getPublicProfile: getPublicProfileData }, {
        user_id: newUuid(),
        request_id: "request-profile-public-source-required",
        server_now: new Date("2026-08-09T00:00:00.000Z"),
      } as never),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(getPublicProfileData).not.toHaveBeenCalled();
  });

  it("按可信来源限制公开资料每分钟 120 次", async () => {
    const getPublicProfileData = vi.fn(async () => ({
      user_id: "00000000-0000-4000-8000-000000000010",
      display_name: "Sky",
      favorite_team_id: null,
      career_points: 0,
      career_valid_predictions: 0,
      career_wdl_accuracy_percent: null,
      career_level: 1,
      career_best_level: 1,
    }));
    const rateLimiter = new InMemoryRateLimiter();
    const input = {
      user_id: "00000000-0000-4000-8000-000000000010",
      public_source: "gateway-source-profile-1",
      server_now: new Date("2026-08-09T00:00:00.000Z"),
      request_id: "request-profile-public-rate-limit",
      rate_limiter: rateLimiter,
    };

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await expect(getPublicProfile({ getPublicProfile: getPublicProfileData }, input as never))
        .resolves.toBeDefined();
    }

    await expect(
      getPublicProfile({ getPublicProfile: getPublicProfileData }, input as never),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(getPublicProfileData).toHaveBeenCalledTimes(120);
  });
});

describe("GET /v1/profile/me", () => {
  it("返回当前用户完整资料的成功 envelope", async () => {
    const repo = new InMemoryRepository();
    const userId = newUuid();
    await repo.users.insert({
      schema_version: 1,
      user_id: userId,
      openid: "openid-private-profile",
      unionid: null,
      nickname: "Sky",
      favorite_team_id: null,
      status: "active",
      career_points: 428,
      career_valid_predictions: 76,
      career_wdl_hits: 46,
      career_exact_hits: 8,
      career_level: 6,
      career_best_level: 6,
      deleted_at: null,
      created_at: new Date("2026-08-01T00:00:00Z"),
      updated_at: new Date("2026-08-01T00:00:00Z"),
    });

    const response = await getMyProfile(new ProfileQueryService(repo), {
      authenticated_user_id: userId,
      server_now: new Date("2026-08-09T00:00:00.000Z"),
      request_id: "request-profile-me-1",
    });

    expect(response).toEqual({
      status: 200,
      body: {
        data: {
          user_id: userId,
          nickname: "Sky",
          favorite_team_id: null,
          career_points: 428,
          career_valid_predictions: 76,
          career_wdl_hits: 46,
          career_exact_hits: 8,
          career_wdl_accuracy_percent: "60.5",
          career_level: 6,
          career_best_level: 6,
        },
        request_id: "request-profile-me-1",
      },
    });
  });

  it("没有认证用户时拒绝访问", async () => {
    await expect(
      getMyProfile(new ProfileQueryService(new InMemoryRepository()), {
        authenticated_user_id: null,
        server_now: new Date("2026-08-09T00:00:00.000Z"),
        request_id: "request-profile-me-2",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("按用户限制私有资料读取为每分钟 120 次", async () => {
    const getProfile = vi.fn(async () => ({
      user_id: "00000000-0000-0000-0000-000000000001",
      nickname: "Sky",
      favorite_team_id: null,
      career_points: 0,
      career_valid_predictions: 0,
      career_wdl_hits: 0,
      career_exact_hits: 0,
      career_wdl_accuracy_percent: "0.0",
      career_level: 1,
      career_best_level: 1,
    }));
    const input = {
      authenticated_user_id: "00000000-0000-0000-0000-000000000001",
      request_id: "request-profile-me-rate-limit",
      server_now: new Date("2026-08-09T00:00:00.000Z"),
      rate_limiter: new InMemoryRateLimiter(),
    };

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await expect(getMyProfile({ getMyProfile: getProfile }, input as never))
        .resolves.toBeDefined();
    }

    await expect(
      getMyProfile({ getMyProfile: getProfile }, input as never),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(getProfile).toHaveBeenCalledTimes(120);
  });
});

describe("DELETE /v1/profile/me", () => {
  it("返回 204 且不产生 response body", async () => {
    const deleteProfile = vi.fn(async () => ({
      user_id: "00000000-0000-4000-8000-000000000010",
      deleted: true as const,
    }));

    await expect(
      deleteMyProfile({ deleteMyProfile: deleteProfile }, {
        authenticated_user_id: "00000000-0000-4000-8000-000000000010",
        server_now: new Date("2026-08-09T00:00:00.000Z"),
        request_id: "request-profile-delete-1",
      }),
    ).resolves.toEqual({ status: 204 });
    expect(deleteProfile).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000010",
      new Date("2026-08-09T00:00:00.000Z"),
    );
  });

  it("没有认证用户时返回 UNAUTHORIZED 且不调用 application command", async () => {
    const deleteProfile = vi.fn();

    await expect(
      deleteMyProfile({ deleteMyProfile: deleteProfile }, {
        authenticated_user_id: null,
        server_now: new Date("2026-08-09T00:00:00.000Z"),
        request_id: "request-profile-delete-2",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(deleteProfile).not.toHaveBeenCalled();
  });

  it("按用户限制资料注销写作为每分钟 20 次", async () => {
    const deleteProfile = vi.fn(async () => ({
      user_id: "00000000-0000-4000-8000-000000000010",
      deleted: true as const,
    }));
    const rateLimiter = new InMemoryRateLimiter();
    const input = {
      authenticated_user_id: "00000000-0000-4000-8000-000000000010",
      server_now: new Date("2026-08-09T00:00:00.000Z"),
      request_id: "request-profile-delete-rate-limit",
      rate_limiter: rateLimiter,
    };

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await expect(
        deleteMyProfile({ deleteMyProfile: deleteProfile }, input as never),
      ).resolves.toEqual({ status: 204 });
    }

    await expect(
      deleteMyProfile({ deleteMyProfile: deleteProfile }, input as never),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(deleteProfile).toHaveBeenCalledTimes(20);
  });

  it("OpenAPI contract 声明 DELETE /profile/me 的 429 RateLimited", () => {
    const openapi = readFileSync(new URL("./openapi.yaml", import.meta.url), "utf8");
    expect(openapi).toMatch(
      /  \/profile\/me:\n(?:.*\n)*?    delete:[\s\S]*?'429':[\s\S]*?RateLimited/,
    );
  });
});
