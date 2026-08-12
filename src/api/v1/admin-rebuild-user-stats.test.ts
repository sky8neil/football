import { describe, expect, it, vi } from "vitest";
import { newUuid } from "../../domain/ids.js";
import type { AdminRebuildUserStatsOutcome } from "../../application/admin-rebuild-user-stats.js";
import { postAdminRebuildUserStats } from "./admin.js";
import { InMemoryRateLimiter } from "./rate-limit.js";

const USER_ID = "00000000-0000-4000-8000-000000000010";
const NOW = new Date("2026-08-09T00:00:00.000Z");
const REQUEST_ID = "request-rebuild-user-1";
const AUDIT_ID = newUuid();

describe("POST /v1/admin/rebuild/users/:user_id", () => {
  it("返回第 48.2 定义的成功 envelope 和有限 data", async () => {
    const rebuild = vi.fn(async (): Promise<AdminRebuildUserStatsOutcome> => ({
      user: { user_id: USER_ID },
      season_stats: [{ season_id: "2026_2027" }, { season_id: "2025_2026" }],
      created_level_history: [],
      created_unlocks: [],
      admin_id: newUuid(),
      audit_log: { audit_id: AUDIT_ID },
    } as unknown as AdminRebuildUserStatsOutcome));

    const result = await postAdminRebuildUserStats({ rebuild }, {
      trusted_openid: "trusted-admin-openid",
      user_id: USER_ID,
      server_now: NOW,
      request_id: REQUEST_ID,
    });

    expect(result).toEqual({
      status: 200,
      body: {
        data: {
          user_id: USER_ID,
          rebuilt_season_count: 2,
          audit_id: AUDIT_ID,
        },
        request_id: REQUEST_ID,
      },
    });
    expect(rebuild).toHaveBeenCalledWith("trusted-admin-openid", USER_ID, NOW);
  });

  it("拒绝非 UUID user_id，不调用 application command", async () => {
    const rebuild = vi.fn();

    await expect(
      Promise.resolve().then(() =>
        postAdminRebuildUserStats({ rebuild }, {
          trusted_openid: "trusted-admin-openid",
          user_id: "not-a-uuid",
          server_now: NOW,
          request_id: REQUEST_ID,
        }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("application 返回非法 audit_id 时拒绝生成成功响应", async () => {
    const rebuild = vi.fn(async (): Promise<AdminRebuildUserStatsOutcome> => ({
      user: { user_id: USER_ID },
      season_stats: [],
      created_level_history: [],
      created_unlocks: [],
      admin_id: newUuid(),
      audit_log: { audit_id: "not-a-uuid" },
    } as unknown as AdminRebuildUserStatsOutcome));

    await expect(
      postAdminRebuildUserStats({ rebuild }, {
        trusted_openid: "trusted-admin-openid",
        user_id: USER_ID,
        server_now: NOW,
        request_id: "request-rebuild-user-invalid-audit",
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("application 返回非请求目标用户时拒绝生成成功响应", async () => {
    const rebuild = vi.fn(async (): Promise<AdminRebuildUserStatsOutcome> => ({
      user: { user_id: "00000000-0000-4000-8000-000000000011" },
      season_stats: [],
      created_level_history: [],
      created_unlocks: [],
      admin_id: newUuid(),
      audit_log: { audit_id: AUDIT_ID },
    } as unknown as AdminRebuildUserStatsOutcome));

    await expect(
      postAdminRebuildUserStats({ rebuild }, {
        trusted_openid: "trusted-admin-openid",
        user_id: USER_ID,
        server_now: NOW,
        request_id: "request-rebuild-user-mismatched-target",
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("application 返回非数组 season_stats 时拒绝生成成功响应", async () => {
    const rebuild = vi.fn(async (): Promise<AdminRebuildUserStatsOutcome> => ({
      user: { user_id: USER_ID },
      season_stats: { length: 7 },
      created_level_history: [],
      created_unlocks: [],
      admin_id: newUuid(),
      audit_log: { audit_id: AUDIT_ID },
    } as unknown as AdminRebuildUserStatsOutcome));

    await expect(
      postAdminRebuildUserStats({ rebuild }, {
        trusted_openid: "trusted-admin-openid",
        user_id: USER_ID,
        server_now: NOW,
        request_id: "request-rebuild-user-invalid-season-stats",
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("按管理员身份限制为每分钟 60 次", async () => {
    const rebuild = vi.fn(async (): Promise<AdminRebuildUserStatsOutcome> => ({
      user: { user_id: USER_ID },
      season_stats: [],
      created_level_history: [],
      created_unlocks: [],
      admin_id: newUuid(),
      audit_log: { audit_id: AUDIT_ID },
    } as unknown as AdminRebuildUserStatsOutcome));
    const rateLimiter = new InMemoryRateLimiter();
    const input = {
      trusted_openid: "trusted-admin-openid",
      user_id: USER_ID,
      server_now: NOW,
      request_id: "request-rebuild-user-rate-limit",
      rate_limiter: rateLimiter,
    };

    for (let attempt = 0; attempt < 60; attempt += 1) {
      await expect(postAdminRebuildUserStats({ rebuild }, input)).resolves.toBeDefined();
    }

    await expect(postAdminRebuildUserStats({ rebuild }, input)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(rebuild).toHaveBeenCalledTimes(60);
  });
});
