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

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flushTasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountAdminApp(fetchHandler) {
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevFetch = globalThis.fetch;

  const elements = new Map();
  const makeElement = (tagName, id = "") => {
    const classes = new Set();
    const listeners = new Map();
    let textValue = "";
    const node = {
      tagName: tagName.toUpperCase(),
      id,
      value: "",
      checked: false,
      disabled: false,
      required: false,
      colSpan: 1,
      style: {},
      dataset: {},
      children: [],
      get className() {
        return [...classes].join(" ");
      },
      set className(val) {
        classes.clear();
        for (const token of String(val ?? "").split(/\s+/).filter(Boolean)) {
          classes.add(token);
        }
      },
      classList: {
        toggle(cls, force) {
          if (force === undefined) {
            if (classes.has(cls)) classes.delete(cls);
            else classes.add(cls);
          } else if (force) {
            classes.add(cls);
          } else {
            classes.delete(cls);
          }
        },
        contains(cls) {
          return classes.has(cls);
        },
      },
      get textContent() {
        if (this.children.length === 0) return textValue;
        return this.children.map((child) => child.textContent).join("");
      },
      set textContent(val) {
        textValue = String(val ?? "");
        this.children = [];
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      append(...nodes) {
        this.children.push(...nodes);
      },
      addEventListener(type, fn) {
        const list = listeners.get(type) ?? [];
        list.push(fn);
        listeners.set(type, list);
      },
      async trigger(type, event = {}) {
        const evt = { preventDefault() {}, ...event };
        for (const fn of listeners.get(type) ?? []) {
          await fn(evt);
        }
      },
    };
    return node;
  };

  const getEl = (id) => {
    if (!elements.has(id)) {
      elements.set(id, makeElement("div", id));
    }
    return elements.get(id);
  };

  // Seed default control states from admin/index.html
  getEl("anomaly-status-filter").value = "open";
  getEl("anomaly-limit-filter").value = "20";
  getEl("anomaly-prev-btn").disabled = true;
  getEl("anomaly-next-btn").disabled = true;
  getEl("rc-expected-version").value = "0";
  getEl("audit-limit-filter").value = "20";
  getEl("audit-prev-btn").disabled = true;
  getEl("audit-next-btn").disabled = true;
  getEl("rebuild-board").value = "week";

  const authModeBtns = ["token", "passcode"].map((mode) => {
    const btn = makeElement("button");
    btn.dataset.authMode = mode;
    return btn;
  });
  const navTabBtns = ["anomalies", "settlement", "teams", "rebuild", "audit"].map((tab) => {
    const btn = makeElement("button");
    btn.dataset.tab = tab;
    return btn;
  });
  const tabPanels = ["anomalies", "settlement", "teams", "rebuild", "audit"].map((tab) =>
    getEl(`tab-${tab}`),
  );

  const storage = new Map();
  globalThis.window = {
    sessionStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
  };
  globalThis.document = {
    getElementById: getEl,
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({ textContent: String(text ?? "") }),
    querySelectorAll: (selector) => {
      if (selector === "[data-auth-mode]") return authModeBtns;
      if (selector === ".nav-tab") return navTabBtns;
      if (selector === ".tab-panel") return tabPanels;
      return [];
    },
  };
  globalThis.fetch = fetchHandler;

  vi.resetModules();
  await import("./app.js");
  await flushTasks();

  return {
    el: getEl,
    cleanup() {
      vi.resetModules();
      globalThis.window = prevWindow;
      globalThis.document = prevDocument;
      globalThis.fetch = prevFetch;
    },
  };
}

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

  it("CR42-01: 先读取有比分比赛 A 再读取无比分比赛 B 时清空比分框，且空比分/非法比分不能提交", async () => {
    const matchAId = "00000000-0000-4000-8000-00000000000a";
    const matchBId = "00000000-0000-4000-8000-00000000000b";
    const postBodies = [];

    const app = await mountAdminApp(async (url, init = {}) => {
      const method = init.method ?? "GET";
      if (method === "GET" && url === `/v1/admin/matches/${matchAId}`) {
        return new Response(
          JSON.stringify({
            data: {
              match_id: matchAId,
              match_status: "finished",
              settlement_status: "settled",
              result_version: 1,
              settled_result_version: 1,
              result_source: "official",
              regular_home_score: 4,
              regular_away_score: 1,
              open_anomalies: [],
              home_team: { name_zh: "主队A" },
              away_team: { name_zh: "客队A" },
            },
          }),
          { status: 200 },
        );
      }
      if (method === "GET" && url === `/v1/admin/matches/${matchBId}`) {
        return new Response(
          JSON.stringify({
            data: {
              match_id: matchBId,
              match_status: "finished",
              settlement_status: "failed",
              result_version: 0,
              settled_result_version: 0,
              result_source: null,
              regular_home_score: null,
              regular_away_score: null,
              open_anomalies: [],
              home_team: { name_zh: "主队B" },
              away_team: { name_zh: "客队B" },
            },
          }),
          { status: 200 },
        );
      }
      if (method === "POST" && url === `/v1/admin/matches/${matchBId}/result-corrections`) {
        const body = JSON.parse(String(init.body));
        postBodies.push(body);
        return new Response(
          JSON.stringify({ data: { result_version: 1, audit_id: "audit-1" } }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    try {
      const { el } = app;
      // 读取比赛 A (4:1)
      el("rc-match-id").value = matchAId;
      await el("rc-load-match-btn").trigger("click");
      expect(el("rc-expected-version").value).toBe("1");
      expect(el("rc-home-score").value).toBe("4");
      expect(el("rc-away-score").value).toBe("1");

      // 切换并读取无比分比赛 B (null:null)
      el("rc-match-id").value = matchBId;
      await el("rc-load-match-btn").trigger("click");
      expect(el("rc-expected-version").value).toBe("0");
      expect(el("rc-home-score").value).toBe("");
      expect(el("rc-away-score").value).toBe("");

      // 不填比分时禁止提交，避免 Number("") 静默成 0
      el("rc-reason").value = "人工补录缺失比分";
      await el("result-correction-form").trigger("submit");
      expect(postBodies).toHaveLength(0);
      expect(el("global-toast").className).toContain("error");

      // 仅填一侧或非法负数/小数时也不得提交
      el("rc-home-score").value = "2";
      el("rc-away-score").value = "";
      await el("result-correction-form").trigger("submit");
      expect(postBodies).toHaveLength(0);

      el("rc-home-score").value = "-1";
      el("rc-away-score").value = "1.5";
      await el("result-correction-form").trigger("submit");
      expect(postBodies).toHaveLength(0);

      // 显式填入 0:0 合法非负整数后允许提交
      el("rc-home-score").value = "0";
      el("rc-away-score").value = "0";
      await el("result-correction-form").trigger("submit");
      expect(postBodies).toEqual([
        {
          expected_result_version: 0,
          regular_home_score: 0,
          regular_away_score: 0,
          reason: "人工补录缺失比分",
        },
      ]);
      expect(el("rc-expected-version").value).toBe("1");
    } finally {
      app.cleanup();
    }
  });

  it("CR42-02: 异常/球队/审计列表筛选请求乱序返回时仅保留最新请求的行与分页状态", async () => {
    const anomalyRequests = [];
    const teamRequests = [];
    const auditRequests = [];

    const app = await mountAdminApp(async (url) => {
      const deferred = createDeferred();
      if (url.startsWith("/v1/admin/anomalies")) {
        anomalyRequests.push({ url, deferred });
      } else if (url.startsWith("/v1/admin/teams")) {
        teamRequests.push({ url, deferred });
      } else if (url.startsWith("/v1/admin/audit-logs")) {
        auditRequests.push({ url, deferred });
      } else {
        throw new Error(`Unexpected request: ${url}`);
      }
      return deferred.promise;
    });

    try {
      const { el } = app;

      // 1) 异常列表两次筛选请求逆序返回
      el("anomaly-status-filter").value = "open";
      await el("anomaly-status-filter").trigger("change");
      el("anomaly-status-filter").value = "resolved";
      await el("anomaly-status-filter").trigger("change");
      expect(anomalyRequests).toHaveLength(2);

      // 新筛选请求先返回
      anomalyRequests[1].deferred.resolve(
        new Response(
          JSON.stringify({
            data: {
              items: [
                {
                  anomaly_id: "anom-new",
                  match_id: "match-new",
                  type: "RESULT_CONFLICT",
                  status: "resolved",
                  blocking: false,
                  occurrence_count: 1,
                  last_seen_at: "2026-08-01T10:00:00.000Z",
                },
              ],
              page: { next_cursor: "cursor-new", has_more: true },
            },
          }),
          { status: 200 },
        ),
      );
      await flushTasks();

      expect(el("anomalies-tbody").children).toHaveLength(1);
      expect(el("anomalies-tbody").textContent).toContain("anom-new");
      expect(el("anomaly-next-btn").disabled).toBe(false);

      // 旧筛选请求后返回：不能覆盖表格，也不能覆盖分页按钮或游标
      anomalyRequests[0].deferred.resolve(
        new Response(
          JSON.stringify({
            data: {
              items: [
                {
                  anomaly_id: "anom-old-1",
                  match_id: "match-old-1",
                  type: "FINISHED_NO_SCORE",
                  status: "open",
                  blocking: true,
                  occurrence_count: 3,
                  last_seen_at: "2026-08-01T08:00:00.000Z",
                },
                {
                  anomaly_id: "anom-old-2",
                  match_id: "match-old-2",
                  type: "FINISHED_NO_SCORE",
                  status: "open",
                  blocking: true,
                  occurrence_count: 2,
                  last_seen_at: "2026-08-01T07:00:00.000Z",
                },
              ],
              page: { next_cursor: "cursor-old", has_more: false },
            },
          }),
          { status: 200 },
        ),
      );
      await flushTasks();

      expect(el("anomalies-tbody").children).toHaveLength(1);
      expect(el("anomalies-tbody").textContent).toContain("anom-new");
      expect(el("anomalies-tbody").textContent).not.toContain("anom-old-1");
      expect(el("anomalies-tbody").textContent).not.toContain("anom-old-2");
      expect(el("anomaly-next-btn").disabled).toBe(false);

      // 点击下一页应沿用新筛选的 cursor-new
      await el("anomaly-next-btn").trigger("click");
      expect(anomalyRequests).toHaveLength(3);
      expect(anomalyRequests[2].url).toContain("cursor=cursor-new");
      anomalyRequests[2].deferred.resolve(
        new Response(
          JSON.stringify({ data: { items: [], page: { next_cursor: null, has_more: false } } }),
          { status: 200 },
        ),
      );
      await flushTasks();

      // 2) 球队列表两次查询逆序返回
      el("teams-search-input").value = "OldTeam";
      await el("teams-refresh-btn").trigger("click");
      el("teams-search-input").value = "NewTeam";
      await el("teams-refresh-btn").trigger("click");
      expect(teamRequests).toHaveLength(2);

      teamRequests[1].deferred.resolve(
        new Response(
          JSON.stringify({
            data: {
              items: [
                {
                  team_id: "team-new",
                  league_id: "premier_league",
                  name: "NewTeam FC",
                  name_zh: "新队",
                  logo_url: null,
                  mappings: [],
                },
              ],
            },
          }),
          { status: 200 },
        ),
      );
      await flushTasks();
      teamRequests[0].deferred.resolve(
        new Response(
          JSON.stringify({
            data: {
              items: [
                {
                  team_id: "team-old",
                  league_id: "premier_league",
                  name: "OldTeam FC",
                  name_zh: "旧队",
                  logo_url: null,
                  mappings: [],
                },
              ],
            },
          }),
          { status: 200 },
        ),
      );
      await flushTasks();
      expect(el("teams-tbody").children).toHaveLength(1);
      expect(el("teams-tbody").textContent).toContain("team-new");
      expect(el("teams-tbody").textContent).not.toContain("team-old");

      // 3) 审计列表两次查询逆序返回
      el("audit-action-filter").value = "resolve_anomaly";
      await el("audit-action-filter").trigger("change");
      el("audit-action-filter").value = "result_correction";
      await el("audit-action-filter").trigger("change");
      expect(auditRequests).toHaveLength(2);

      auditRequests[1].deferred.resolve(
        new Response(
          JSON.stringify({
            data: {
              items: [
                {
                  created_at: "2026-08-01T10:00:00.000Z",
                  action: "result_correction",
                  target_type: "match",
                  target_id: "m-new",
                  admin_id: "a1",
                  reason: "new audit",
                  old_value: null,
                  new_value: { v: 1 },
                },
              ],
              page: { next_cursor: "audit-next", has_more: true },
            },
          }),
          { status: 200 },
        ),
      );
      await flushTasks();
      auditRequests[0].deferred.resolve(
        new Response(
          JSON.stringify({
            data: {
              items: [
                {
                  created_at: "2026-08-01T08:00:00.000Z",
                  action: "resolve_anomaly",
                  target_type: "anomaly",
                  target_id: "anom-old",
                  admin_id: "a1",
                  reason: "old audit",
                  old_value: null,
                  new_value: null,
                },
              ],
              page: { next_cursor: null, has_more: false },
            },
          }),
          { status: 200 },
        ),
      );
      await flushTasks();
      expect(el("audit-tbody").children).toHaveLength(1);
      expect(el("audit-tbody").textContent).toContain("m-new");
      expect(el("audit-tbody").textContent).not.toContain("anom-old");
      expect(el("audit-next-btn").disabled).toBe(false);
    } finally {
      app.cleanup();
    }
  });

  it("CR43-01: 赛果读取响应乱序完成及切换 match_id 未重新读取时禁止串场提交", async () => {
    const matchAId = "00000000-0000-4000-8000-0000000000a1";
    const matchBId = "00000000-0000-4000-8000-0000000000b2";
    const deferredA = createDeferred();
    const deferredB = createDeferred();
    const deferredAFail = createDeferred();
    const postCalls = [];
    let matchACalls = 0;

    const app = await mountAdminApp(async (url, init = {}) => {
      const method = init.method ?? "GET";
      if (method === "GET" && url === `/v1/admin/matches/${matchAId}`) {
        matchACalls += 1;
        return matchACalls === 1 ? deferredA.promise : deferredAFail.promise;
      }
      if (method === "GET" && url === `/v1/admin/matches/${matchBId}`) {
        return deferredB.promise;
      }
      if (method === "POST" && url.endsWith("/result-corrections")) {
        postCalls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(
          JSON.stringify({ data: { result_version: 2, audit_id: "audit-cr43-01" } }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    try {
      const { el } = app;

      // 1. 先点读取 A，再立即把输入框改为 B 并点读取 B
      el("rc-match-id").value = matchAId;
      const loadA = el("rc-load-match-btn").trigger("click");
      el("rc-match-id").value = matchBId;
      const loadB = el("rc-load-match-btn").trigger("click");

      // 读取 B 尚未完成前，禁止直接提交
      el("rc-expected-version").value = "1";
      el("rc-home-score").value = "9";
      el("rc-away-score").value = "9";
      el("rc-reason").value = "测试未完成读取禁止提交";
      await el("result-correction-form").trigger("submit");
      expect(postCalls).toHaveLength(0);
      expect(el("global-toast").textContent).toContain("请先重新读取当前比赛信息后再提交");
      expect(el("global-toast").className).toContain("error");

      // 2. B 的响应先返回 (2:0 / v1)
      deferredB.resolve(
        new Response(
          JSON.stringify({
            data: {
              match_id: matchBId,
              match_status: "finished",
              settlement_status: "settled",
              result_version: 1,
              settled_result_version: 1,
              result_source: "official",
              regular_home_score: 2,
              regular_away_score: 0,
              open_anomalies: [],
              home_team: { name_zh: "主队B" },
              away_team: { name_zh: "客队B" },
            },
          }),
          { status: 200 },
        ),
      );
      await loadB;

      expect(el("rc-expected-version").value).toBe("1");
      expect(el("rc-home-score").value).toBe("2");
      expect(el("rc-away-score").value).toBe("0");
      expect(el("rc-match-preview").textContent).toContain("主队B");

      // 3. A 的旧响应晚到 (4:1 / v1)：必须完全丢弃，不得覆盖 B 的表单与预览
      deferredA.resolve(
        new Response(
          JSON.stringify({
            data: {
              match_id: matchAId,
              match_status: "finished",
              settlement_status: "settled",
              result_version: 1,
              settled_result_version: 1,
              result_source: "official",
              regular_home_score: 4,
              regular_away_score: 1,
              open_anomalies: [],
              home_team: { name_zh: "主队A" },
              away_team: { name_zh: "客队A" },
            },
          }),
          { status: 200 },
        ),
      );
      await loadA;

      expect(el("rc-expected-version").value).toBe("1");
      expect(el("rc-home-score").value).toBe("2");
      expect(el("rc-away-score").value).toBe("0");
      expect(el("rc-match-preview").textContent).toContain("主队B");
      expect(el("rc-match-preview").textContent).not.toContain("主队A");

      // 4. 提交必须发往 B 且携带 B 的 2:0（而非 A 的 4:1）
      el("rc-reason").value = "确认修正 B 比分";
      await el("result-correction-form").trigger("submit");
      expect(postCalls).toEqual([
        {
          url: `/v1/admin/matches/${matchBId}/result-corrections`,
          body: {
            expected_result_version: 1,
            regular_home_score: 2,
            regular_away_score: 0,
            reason: "确认修正 B 比分",
          },
        },
      ]);

      // 5. 已加载 B 后把输入框改成 A（即使触发或不触发 input）未重新读取 A 时禁止提交
      el("rc-match-id").value = matchAId;
      await el("result-correction-form").trigger("submit");
      expect(postCalls).toHaveLength(1);
      expect(el("global-toast").textContent).toContain("请先重新读取当前比赛信息后再提交");
      expect(el("global-toast").className).toContain("error");

      // 6. 读取 A 失败的旧请求在用户又切换回 B 并触发 input 失效后到达，catch 分支也不得弹错
      const loadAFail = el("rc-load-match-btn").trigger("click");
      el("rc-match-id").value = matchBId;
      await el("rc-match-id").trigger("input");
      el("global-toast").textContent = "已清空";
      el("global-toast").className = "toast ok";
      deferredAFail.reject(new Error("stale network error"));
      await loadAFail;
      expect(el("global-toast").textContent).toBe("已清空");
    } finally {
      app.cleanup();
    }
  });
});
