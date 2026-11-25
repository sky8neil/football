import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createAdminApiClient } from "./api.js";
import {
  createCursorPager,
  formatApiError,
  isValidUuid,
  validateLogoUrl,
  validateReason,
} from "./state.js";

describe("admin/ Web 管理端前端逻辑与 API 客户端", () => {
  it("AdminApiClient 完整覆盖登录、鉴权头、登出及全部管理端写/读接口", async () => {
    let token = null;
    const unauthorizedCalls = [];
    const calls = [];

    const fetchImpl = vi.fn(async (url, init = {}) => {
      const headers = init.headers ?? {};
      calls.push({
        url,
        method: init.method ?? "GET",
        auth: headers.Authorization,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith("/admin/auth/login")) {
        return new Response(
          JSON.stringify({
            data: {
              access_token: "admin-bearer-token",
              token_type: "Bearer",
              expires_at: "2026-08-09T20:00:00.000Z",
              admin: { admin_id: "a1", role: "admin", status: "active" },
            },
            request_id: "r1",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/admin/auth/logout")) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ data: { ok: true }, request_id: "r2" }), { status: 200 });
    });

    const client = createAdminApiClient({
      baseUrl: "/v1",
      fetchImpl,
      getToken: () => token,
      setToken: (next) => {
        token = next;
      },
      onUnauthorized: (err) => unauthorizedCalls.push(err),
    });

    await client.loginWithToken("adm1.abc.def");
    expect(token).toBe("admin-bearer-token");

    await client.getMe();
    await client.listAnomalies({ status: "open", blocking: "true", limit: 20 });
    await client.resolveAnomaly("00000000-0000-4000-8000-000000000010", { reason: "人工解除" });
    await client.getMatch("00000000-0000-4000-8000-000000000011");
    await client.correctResult("00000000-0000-4000-8000-000000000011", {
      expected_result_version: 0,
      regular_home_score: 2,
      regular_away_score: 1,
      reason: "官方补录",
    });
    await client.retrySettlement("00000000-0000-4000-8000-000000000011");
    await client.rebuildUserStats("00000000-0000-4000-8000-000000000012");
    await client.rebuildRankings({ board: "week", period_key: "2026-W32", reason: "重算周榜" });
    await client.rebuildRankings({ board: "career", reason: "重算生涯榜" });
    await client.listTeams({ league_id: "premier_league", missing_only: "true" });
    await client.updateTeam("00000000-0000-4000-8000-000000000013", {
      name_zh: "升班马",
      logo_url: "https://cdn.example.com/a.png",
      reason: "补充资料",
    });
    await client.upsertTeamMapping("00000000-0000-4000-8000-000000000013", {
      provider: "openfoot",
      provider_team_id: "Promoted FC",
      overwrite: true,
      reason: "补齐映射",
    });
    await client.listAuditLogs({ action: "resolve_anomaly", limit: 20 });
    await client.logout();

    expect(token).toBeNull();
    expect(unauthorizedCalls).toEqual([]);
    expect(calls[1]).toMatchObject({
      url: "/v1/admin/auth/me",
      method: "GET",
      auth: "Bearer admin-bearer-token",
    });
    expect(calls[2]?.url).toBe("/v1/admin/anomalies?status=open&blocking=true&limit=20");
    expect(calls[4]?.url).toBe("/v1/admin/matches/00000000-0000-4000-8000-000000000011");
    expect(calls[9]?.body).toEqual({ board: "career", reason: "重算生涯榜" });
    expect(calls.at(-1)).toMatchObject({ url: "/v1/admin/auth/logout", method: "POST" });
  });

  it("401/403 响应时自动清理 token 并触发 onUnauthorized 回调", async () => {
    let token = "stale-token";
    const onUnauthorized = vi.fn();
    const client = createAdminApiClient({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ code: "FORBIDDEN", message: "管理员已禁用", request_id: "r3" }),
          { status: 403 },
        ),
      getToken: () => token,
      setToken: (next) => {
        token = next;
      },
      onUnauthorized,
    });

    await expect(client.getMe()).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(token).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("state.js 分页器、输入校验与错误提示辅助函数正确", () => {
    const pager = createCursorPager();
    expect(pager.canGoBack()).toBe(false);
    pager.applyPage({ next_cursor: "c1", has_more: true });
    // CR-30: planAdvance / planBack 不提前篡改状态，仅在 commit 时提交
    const plannedNext = pager.planAdvance();
    expect(plannedNext).toEqual({ currentCursor: "c1", history: [null] });
    expect(pager.currentCursor).toBeNull();
    pager.commit(plannedNext, { next_cursor: "c2", has_more: true });
    expect(pager.currentCursor).toBe("c1");
    expect(pager.canGoBack()).toBe(true);
    const plannedBack = pager.planBack();
    pager.commit(plannedBack, { next_cursor: "c1", has_more: true });
    expect(pager.currentCursor).toBeNull();

    expect(pager.advance()).toBe(true);
    expect(pager.currentCursor).toBe("c1");
    pager.applyPage({ next_cursor: null, has_more: false });
    expect(pager.advance()).toBe(false);
    expect(pager.back()).toBe(true);
    expect(pager.currentCursor).toBeNull();

    expect(isValidUuid("00000000-0000-4000-8000-000000000001")).toBe(true);
    expect(isValidUuid("bad")).toBe(false);
    expect(validateReason("   ")).not.toBeNull();
    expect(validateReason("合法原因")).toBeNull();
    expect(validateLogoUrl("http://insecure.example/a.png")).not.toBeNull();
    expect(validateLogoUrl("https://cdn.example.com/a.png")).toBeNull();
    expect(validateLogoUrl("/assets/logos/a.png")).toBeNull();
    expect(formatApiError({ code: "TEAM_MAPPING_CONFLICT", message: "conflict" })).toContain(
      "允许覆盖",
    );
    expect(
      formatApiError({
        code: "RESULT_VERSION_CONFLICT",
        message: "conflict",
        details: { actual_result_version: 4 },
      }),
    ).toContain("v4");
  });

  it("admin/app.js 引用的所有 DOM ID 均在 admin/index.html 中定义且无 innerHTML 注入", () => {
    const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
    const ids = [...app.matchAll(/\bel\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(20);
    for (const id of ids) {
      expect(html, `missing id="${id}" in admin/index.html`).toContain(`id="${id}"`);
    }
    expect(app).not.toContain("innerHTML");
  });

  it("ops/vps/Caddyfile 配置了 /admin/ 静态托管、屏蔽测试文件、安全头并保留 /health 屏蔽与 /v1 反代", () => {
    const caddy = readFileSync(new URL("../ops/vps/Caddyfile", import.meta.url), "utf8");
    expect(caddy).toContain("redir /admin /admin/ 308");
    expect(caddy).toContain("@admin path /admin/*");
    expect(caddy).toContain("@admin_tests path *.test.mjs");
    expect(caddy).toContain("respond @admin_tests 404");
    expect(caddy).toContain("try_files {path} {path}/index.html =404");
    expect(caddy).not.toContain("try_files {path} {path}/index.html /admin/index.html");
    expect(caddy).toContain("file_server");
    expect(caddy).toContain("@health path /health");
    expect(caddy).toContain("respond @health 404");
    expect(caddy).toContain("reverse_proxy 127.0.0.1:8787");
    expect(caddy).toContain("X-Frame-Options DENY");
  });
});
