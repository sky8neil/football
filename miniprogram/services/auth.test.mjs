import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const cloudDiagnostics = await import("./cloud-diagnostics.js");

// 相对当前时间生成，避免写死日期到期后整批用例失败
const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const PAST = "2020-01-01T00:00:00.000Z";
const AUTH_SESSION_STORAGE_KEY = "auth_session";

const originals = {
  wx: Object.getOwnPropertyDescriptor(globalThis, "wx"),
};

afterEach(() => {
  if (originals.wx) Object.defineProperty(globalThis, "wx", originals.wx);
  else delete globalThis.wx;
});

function loadCommonJs(filePath, requireShim) {
  const module = { exports: {} };
  const factory = runInThisContext("(function(module, exports, require) {\n" + readFileSync(filePath, "utf8") + "\n})", {
    filename: filePath,
  });
  factory(module, module.exports, requireShim);
  return module.exports;
}

function loadStack({
  transport = "http",
  envVersion = "develop",
  gatewayOrigin = "https://api.example.com",
  stored = {},
  loginCode = "wx-code",
} = {}) {
  const store = new Map(Object.entries(stored));
  const wxRequest = vi.fn();
  const callFunction = vi.fn();
  const wxLogin = vi.fn((options) => {
    if (loginCode) options.success({ code: loginCode });
    else options.fail({ errMsg: "login:fail" });
  });
  Object.defineProperty(globalThis, "wx", {
    configurable: true,
    writable: true,
    value: {
      request: wxRequest,
      login: wxLogin,
      cloud: { callFunction },
      getAccountInfoSync: () => ({ miniProgram: { envVersion } }),
      getStorageSync: (key) => store.get(key),
      setStorageSync: (key, value) => store.set(key, value),
      removeStorageSync: (key) => store.delete(key),
    },
  });
  const config = { transport, gatewayOrigin, cloudEnvId: "cloud-test", cloudFunctionName: "api" };
  const authStorage = loadCommonJs(join(ROOT, "utils", "auth-storage.js"), () => {
    throw new Error("auth-storage.js 不应 require 其它模块");
  });
  const authRef = { current: null };
  const api = loadCommonJs(join(HERE, "api.js"), (id) => {
    if (id === "../config.js") return config;
    if (id === "./cloud-diagnostics.js") return cloudDiagnostics;
    if (id === "../utils/auth-storage.js") return authStorage;
    if (id === "./auth.js") {
      if (!authRef.current) throw new Error("auth.js not loaded");
      return authRef.current;
    }
    throw new Error(`Unexpected require: ${id}`);
  });
  const auth = loadCommonJs(join(HERE, "auth.js"), (id) => {
    if (id === "../config.js") return config;
    if (id === "./api.js") return api;
    if (id === "../utils/auth-storage.js") return authStorage;
    throw new Error(`Unexpected require: ${id}`);
  });
  authRef.current = auth;
  const session = loadCommonJs(join(HERE, "session.js"), (id) => {
    if (id === "./api.js") return api;
    if (id === "./auth.js") return auth;
    throw new Error(`Unexpected require: ${id}`);
  });
  const matches = loadCommonJs(join(HERE, "matches.js"), (id) => {
    if (id === "./api.js") return api;
    throw new Error(`Unexpected require: ${id}`);
  });
  const predictions = loadCommonJs(join(HERE, "predictions.js"), (id) => {
    if (id === "./api.js") return api;
    throw new Error(`Unexpected require: ${id}`);
  });
  return { api, auth, session, matches, predictions, wxRequest, callFunction, wxLogin, store };
}

function succeedHttp(wxRequest, handler) {
  wxRequest.mockImplementation((options) => {
    const url = String(options.url || "");
    const response = handler(url, options);
    options.success(response);
  });
}

function succeedCloud(callFunction, handler) {
  callFunction.mockImplementation((options) => {
    options.success({ result: handler(options.data) });
  });
}

async function waitFor(predicate, ticks = 20) {
  for (let i = 0; i < ticks; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
}

describe("HTTP self-hosted login and session cache", () => {
  it("logs in with wx.login, caches token and expiry, then inits session with Bearer", async () => {
    const { session, wxRequest, wxLogin, callFunction, store } = loadStack();
    succeedHttp(wxRequest, (url) => {
      if (url.endsWith("/v1/auth/wechat")) {
        return { statusCode: 200, data: { data: { access_token: "opaque-token", token_type: "Bearer", expires_at: FUTURE }, request_id: "auth-1" } };
      }
      if (url.endsWith("/v1/session/init")) {
        return { statusCode: 201, data: { data: { nickname: "球友" }, request_id: "session-1" } };
      }
      throw new Error(url);
    });
    await expect(session.initSession("球友")).resolves.toMatchObject({ statusCode: 201, data: { nickname: "球友" } });
    expect(wxLogin).toHaveBeenCalledTimes(1);
    expect(callFunction).not.toHaveBeenCalled();
    expect(wxRequest.mock.calls[0][0]).toMatchObject({
      url: "https://api.example.com/v1/auth/wechat",
      method: "POST",
      data: { code: "wx-code" },
      header: { "content-type": "application/json" },
    });
    expect(wxRequest.mock.calls[0][0].header.Authorization).toBeUndefined();
    expect(wxRequest.mock.calls[1][0]).toMatchObject({
      url: "https://api.example.com/v1/session/init",
      method: "POST",
      data: { nickname: "球友" },
      header: { "content-type": "application/json", Authorization: "Bearer opaque-token" },
    });
    expect(store.get(AUTH_SESSION_STORAGE_KEY)).toEqual({ access_token: "opaque-token", expires_at: FUTURE });
  });

  it("does not init a session when login fails", async () => {
    const { session, wxRequest, wxLogin } = loadStack({ loginCode: "" });
    await expect(session.initSession("球友")).resolves.toMatchObject({ statusCode: 401, code: "UNAUTHORIZED" });
    expect(wxLogin).toHaveBeenCalledTimes(1);
    expect(wxRequest).not.toHaveBeenCalled();
  });

  it("does not wx.login on launch when no cached session exists", async () => {
    const { auth, wxRequest, wxLogin, store } = loadStack();
    await expect(auth.restoreAuth()).resolves.toMatchObject({ statusCode: 200 });
    expect(wxLogin).not.toHaveBeenCalled();
    expect(wxRequest).not.toHaveBeenCalled();
    expect(store.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);
  });

  it("restores a valid cached session without wx.login", async () => {
    const { auth, matches, wxRequest, wxLogin } = loadStack({
      stored: { [AUTH_SESSION_STORAGE_KEY]: { access_token: "cached-token", expires_at: FUTURE } },
    });
    succeedHttp(wxRequest, (url) => {
      if (url.endsWith("/v1/matches")) {
        return { statusCode: 200, data: { data: { items: [{ match_id: "m1" }] }, request_id: "matches-1" } };
      }
      throw new Error(url);
    });
    await expect(auth.restoreAuth()).resolves.toMatchObject({ statusCode: 200, data: { access_token: "cached-token", expires_at: FUTURE } });
    await expect(matches.listMatches()).resolves.toMatchObject({ statusCode: 200, data: { items: [{ match_id: "m1" }] } });
    expect(wxLogin).not.toHaveBeenCalled();
    expect(wxRequest).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls[0][0].header).toEqual({ Authorization: "Bearer cached-token" });
  });

  it("re-runs wx.login when the cached session is expired", async () => {
    const { auth, wxRequest, wxLogin, store } = loadStack({
      stored: { [AUTH_SESSION_STORAGE_KEY]: { access_token: "expired-token", expires_at: PAST } },
    });
    succeedHttp(wxRequest, (url) => {
      if (url.endsWith("/v1/auth/wechat")) {
        return { statusCode: 200, data: { data: { access_token: "fresh-token", token_type: "Bearer", expires_at: FUTURE }, request_id: "auth-2" } };
      }
      throw new Error(url);
    });
    await expect(auth.restoreAuth()).resolves.toMatchObject({ statusCode: 200, data: { access_token: "fresh-token" } });
    expect(wxLogin).toHaveBeenCalledTimes(1);
    expect(store.get(AUTH_SESSION_STORAGE_KEY)).toEqual({ access_token: "fresh-token", expires_at: FUTURE });
  });

  it("clears the cache on logout and requires a new login", async () => {
    const { auth, predictions, wxRequest, wxLogin, store } = loadStack({
      stored: { [AUTH_SESSION_STORAGE_KEY]: { access_token: "cached-token", expires_at: FUTURE } },
    });
    succeedHttp(wxRequest, (url) => {
      if (url.endsWith("/v1/auth/wechat")) {
        return { statusCode: 200, data: { data: { access_token: "next-token", token_type: "Bearer", expires_at: FUTURE }, request_id: "auth-3" } };
      }
      if (url.endsWith("/v1/predictions")) {
        return { statusCode: 201, data: { data: { prediction_id: "p1" }, request_id: "pred-1" } };
      }
      throw new Error(url);
    });
    await auth.restoreAuth();
    auth.clearAuth();
    expect(store.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);
    await expect(auth.ensureAuth()).resolves.toMatchObject({ statusCode: 200, data: { access_token: "next-token" } });
    await expect(predictions.submitPrediction({
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      matchId: "m1",
      homeScore: 1,
      awayScore: 0,
    })).resolves.toMatchObject({ statusCode: 201, data: { prediction_id: "p1" } });
    expect(wxLogin).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls[0][0].header.Authorization).toBeUndefined();
    expect(wxRequest.mock.calls[1][0]).toMatchObject({
      method: "POST",
      data: {
        idempotency_key: "11111111-1111-4111-8111-111111111111",
        match_id: "m1",
        home_score: 1,
        away_score: 0,
      },
      header: { "content-type": "application/json", Authorization: "Bearer next-token" },
    });
  });

  it("re-logs in when a restored session expires before a later business request", async () => {
    const { auth, matches, wxRequest, wxLogin, store } = loadStack({
      stored: { [AUTH_SESSION_STORAGE_KEY]: { access_token: "cached-token", expires_at: FUTURE } },
    });
    succeedHttp(wxRequest, (url) => {
      if (url.endsWith("/v1/auth/wechat")) {
        return { statusCode: 200, data: { data: { access_token: "fresh-token", token_type: "Bearer", expires_at: FUTURE }, request_id: "auth-exp" } };
      }
      if (url.endsWith("/v1/matches")) {
        return { statusCode: 200, data: { data: { items: [{ match_id: "m1" }] }, request_id: "matches-exp" } };
      }
      throw new Error(url);
    });
    await auth.restoreAuth();
    expect(wxLogin).not.toHaveBeenCalled();
    store.set(AUTH_SESSION_STORAGE_KEY, { access_token: "cached-token", expires_at: PAST });
    await expect(matches.listMatches()).resolves.toMatchObject({ statusCode: 200, data: { items: [{ match_id: "m1" }] } });
    expect(wxLogin).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls.map((call) => call[0].url)).toEqual([
      "https://api.example.com/v1/auth/wechat",
      "https://api.example.com/v1/matches",
    ]);
    expect(wxRequest.mock.calls[0][0].header.Authorization).toBeUndefined();
    expect(wxRequest.mock.calls[1][0].header).toEqual({ Authorization: "Bearer fresh-token" });
    expect(store.get(AUTH_SESSION_STORAGE_KEY)).toEqual({ access_token: "fresh-token", expires_at: FUTURE });
  });

  it("waits for in-flight launch restore before sending a business request", async () => {
    let finishLogin;
    const { auth, matches, wxRequest, wxLogin } = loadStack({
      stored: { [AUTH_SESSION_STORAGE_KEY]: { access_token: "expired-token", expires_at: PAST } },
    });
    wxRequest.mockImplementation((options) => {
      const url = String(options.url || "");
      if (url.endsWith("/v1/auth/wechat")) {
        finishLogin = () => options.success({
          statusCode: 200,
          data: { data: { access_token: "fresh-token", token_type: "Bearer", expires_at: FUTURE }, request_id: "auth-wait" },
        });
        return;
      }
      if (url.endsWith("/v1/matches")) {
        options.success({ statusCode: 200, data: { data: { items: [{ match_id: "m1" }] }, request_id: "matches-wait" } });
        return;
      }
      throw new Error(url);
    });
    const restore = auth.restoreAuth();
    const pendingMatches = matches.listMatches();
    await Promise.resolve();
    expect(wxLogin).toHaveBeenCalledTimes(1);
    expect(wxRequest).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls[0][0].url).toBe("https://api.example.com/v1/auth/wechat");
    expect(wxRequest.mock.calls[0][0].header.Authorization).toBeUndefined();
    finishLogin();
    await expect(restore).resolves.toMatchObject({ statusCode: 200, data: { access_token: "fresh-token" } });
    await expect(pendingMatches).resolves.toMatchObject({ statusCode: 200, data: { items: [{ match_id: "m1" }] } });
    expect(wxRequest.mock.calls.map((call) => call[0].url)).toEqual([
      "https://api.example.com/v1/auth/wechat",
      "https://api.example.com/v1/matches",
    ]);
    expect(wxRequest.mock.calls[1][0].header).toEqual({ Authorization: "Bearer fresh-token" });
  });

  it("returns auth failure without sending the business request when expired session re-login fails", async () => {
    const { matches, wxRequest, wxLogin } = loadStack({
      stored: { [AUTH_SESSION_STORAGE_KEY]: { access_token: "expired-token", expires_at: PAST } },
    });
    succeedHttp(wxRequest, (url) => {
      if (url.endsWith("/v1/auth/wechat")) {
        return { statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录" } };
      }
      throw new Error(url);
    });
    await expect(matches.listMatches()).resolves.toMatchObject({ statusCode: 401, code: "UNAUTHORIZED" });
    expect(wxLogin).toHaveBeenCalledTimes(1);
    expect(wxRequest).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls[0][0].url).toBe("https://api.example.com/v1/auth/wechat");
  });

  it("does not auto-login a business request after logout", async () => {
    const { auth, matches, wxRequest, wxLogin, store } = loadStack({
      stored: { [AUTH_SESSION_STORAGE_KEY]: { access_token: "cached-token", expires_at: FUTURE } },
    });
    succeedHttp(wxRequest, (url) => {
      if (url.endsWith("/v1/matches")) {
        return { statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录" } };
      }
      throw new Error(url);
    });
    await auth.restoreAuth();
    auth.clearAuth();
    expect(store.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);
    await expect(matches.listMatches()).resolves.toMatchObject({ statusCode: 401, code: "UNAUTHORIZED" });
    expect(wxLogin).not.toHaveBeenCalled();
    expect(wxRequest).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls[0][0].header.Authorization).toBeUndefined();
  });

  it("does not wx.login, retry, or restore session when an in-flight request gets 401 after logout", async () => {
    const { auth, matches, wxRequest, wxLogin, store } = loadStack({
      stored: { [AUTH_SESSION_STORAGE_KEY]: { access_token: "cached-token", expires_at: FUTURE } },
    });
    let pendingOptions;
    wxRequest.mockImplementation((options) => {
      const url = String(options.url || "");
      if (url.endsWith("/v1/matches")) {
        pendingOptions = options;
        return;
      }
      throw new Error(url);
    });
    await auth.restoreAuth();
    const pending = matches.listMatches();
    await Promise.resolve();
    expect(pendingOptions).toMatchObject({
      url: "https://api.example.com/v1/matches",
      header: { Authorization: "Bearer cached-token" },
    });
    auth.clearAuth();
    expect(store.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);
    pendingOptions.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录" } });
    await expect(pending).resolves.toMatchObject({ statusCode: 401, code: "UNAUTHORIZED" });
    expect(wxLogin).not.toHaveBeenCalled();
    expect(wxRequest).toHaveBeenCalledTimes(1);
    expect(store.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);
  });

  it("does not persist, succeed, or replay when logout happens during 401 recovery login", async () => {
    const { auth, matches, wxRequest, wxLogin, store } = loadStack({
      stored: { [AUTH_SESSION_STORAGE_KEY]: { access_token: "stale-token", expires_at: FUTURE } },
    });
    const loginQueue = [];
    let matchCalls = 0;
    wxRequest.mockImplementation((options) => {
      const url = String(options.url || "");
      if (url.endsWith("/v1/auth/wechat")) {
        loginQueue.push(options);
        return;
      }
      if (url.endsWith("/v1/matches")) {
        matchCalls += 1;
        options.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录" } });
        return;
      }
      throw new Error(url);
    });
    const pending = matches.listMatches();
    await waitFor(() => loginQueue.length === 1);
    expect(wxLogin).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls.map((call) => call[0].url)).toEqual([
      "https://api.example.com/v1/matches",
      "https://api.example.com/v1/auth/wechat",
    ]);
    auth.clearAuth();
    expect(store.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);
    loginQueue[0].success({
      statusCode: 200,
      data: { data: { access_token: "fresh-token", token_type: "Bearer", expires_at: FUTURE }, request_id: "auth-logout-race" },
    });
    await expect(pending).resolves.toMatchObject({ statusCode: 401, code: "UNAUTHORIZED" });
    expect(store.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);
    expect(matchCalls).toBe(1);
    expect(wxRequest.mock.calls.map((call) => call[0].url)).toEqual([
      "https://api.example.com/v1/matches",
      "https://api.example.com/v1/auth/wechat",
    ]);
    const ensured = auth.ensureAuth();
    await waitFor(() => loginQueue.length === 2);
    expect(wxLogin).toHaveBeenCalledTimes(2);
    loginQueue[1].success({
      statusCode: 200,
      data: { data: { access_token: "fresh-token", token_type: "Bearer", expires_at: FUTURE }, request_id: "auth-logout-next" },
    });
    await expect(ensured).resolves.toMatchObject({ statusCode: 200, data: { access_token: "fresh-token" } });
    expect(store.get(AUTH_SESSION_STORAGE_KEY)).toEqual({ access_token: "fresh-token", expires_at: FUTURE });
  });

  it("does not send login or persist when logout happens while silent wx.login is pending", async () => {
    const { auth, matches, wxRequest, wxLogin, store } = loadStack({
      stored: { [AUTH_SESSION_STORAGE_KEY]: { access_token: "stale-token", expires_at: FUTURE } },
    });
    let finishWxLogin;
    wxLogin.mockImplementation((options) => {
      finishWxLogin = () => options.success({ code: "wx-code" });
    });
    wxRequest.mockImplementation((options) => {
      const url = String(options.url || "");
      if (url.endsWith("/v1/auth/wechat")) {
        options.success({
          statusCode: 200,
          data: { data: { access_token: "fresh-token", token_type: "Bearer", expires_at: FUTURE }, request_id: "auth-wx-logout" },
        });
        return;
      }
      if (url.endsWith("/v1/matches")) {
        options.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录" } });
        return;
      }
      throw new Error(url);
    });
    const pending = matches.listMatches();
    await waitFor(() => typeof finishWxLogin === "function");
    expect(wxLogin).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls.map((call) => call[0].url)).toEqual([
      "https://api.example.com/v1/matches",
    ]);
    auth.clearAuth();
    expect(store.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);
    finishWxLogin();
    await expect(pending).resolves.toMatchObject({ statusCode: 401, code: "UNAUTHORIZED" });
    expect(store.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);
    expect(wxRequest.mock.calls.map((call) => call[0].url)).toEqual([
      "https://api.example.com/v1/matches",
    ]);
  });

  it("does not share a still-pending session-A recovery with a later session-B 401", async () => {
    const { auth, matches, predictions, wxRequest, wxLogin, store } = loadStack({
      stored: { [AUTH_SESSION_STORAGE_KEY]: { access_token: "session-a-token", expires_at: FUTURE } },
    });
    const wxLogins = [];
    wxLogin.mockImplementation((options) => {
      wxLogins.push(options);
    });
    let authLogins = 0;
    wxRequest.mockImplementation((options) => {
      const url = String(options.url || "");
      const token = options.header && options.header.Authorization;
      if (url.endsWith("/v1/auth/wechat")) {
        authLogins += 1;
        if (authLogins === 1) {
          options.success({
            statusCode: 200,
            data: { data: { access_token: "session-b-token", token_type: "Bearer", expires_at: FUTURE }, request_id: "auth-b" },
          });
          return;
        }
        if (authLogins === 2) {
          options.success({
            statusCode: 200,
            data: { data: { access_token: "session-b-fresh", token_type: "Bearer", expires_at: FUTURE }, request_id: "auth-b-fresh" },
          });
          return;
        }
        throw new Error("session A late login must not call /v1/auth/wechat");
      }
      if (url.endsWith("/v1/matches")) {
        if (token === "Bearer session-a-token") {
          options.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录", request_id: "a-401" } });
          return;
        }
        throw new Error("session A must not be retried: " + token);
      }
      if (url.endsWith("/v1/predictions/me")) {
        if (token === "Bearer session-b-token") {
          options.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录", request_id: "b-401" } });
          return;
        }
        if (token === "Bearer session-b-fresh") {
          options.success({ statusCode: 200, data: { data: { items: [{ prediction_id: "p1" }] }, request_id: "b-ok" } });
          return;
        }
        throw new Error("unexpected predictions token: " + token);
      }
      throw new Error(url);
    });
    const pendingA = matches.listMatches();
    await waitFor(() => wxLogins.length === 1);
    expect(wxRequest.mock.calls.map((call) => call[0].url)).toEqual(["https://api.example.com/v1/matches"]);
    auth.clearAuth();
    const pendingEnsure = auth.ensureAuth();
    await waitFor(() => wxLogins.length === 2);
    wxLogins[1].success({ code: "wx-code" });
    await expect(pendingEnsure).resolves.toMatchObject({ statusCode: 200, data: { access_token: "session-b-token" } });
    expect(store.get(AUTH_SESSION_STORAGE_KEY)).toEqual({ access_token: "session-b-token", expires_at: FUTURE });
    const pendingB = predictions.listMyPredictions();
    await waitFor(() => wxLogins.length === 3);
    expect(wxLogin).toHaveBeenCalledTimes(3);
    wxLogins[2].success({ code: "wx-code" });
    await expect(pendingB).resolves.toMatchObject({ statusCode: 200, data: { items: [{ prediction_id: "p1" }] } });
    expect(store.get(AUTH_SESSION_STORAGE_KEY)).toEqual({ access_token: "session-b-fresh", expires_at: FUTURE });
    wxLogins[0].success({ code: "wx-code" });
    await expect(pendingA).resolves.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
      request_id: "a-401",
    });
    expect(authLogins).toBe(2);
    expect(store.get(AUTH_SESSION_STORAGE_KEY)).toEqual({ access_token: "session-b-fresh", expires_at: FUTURE });
    expect(wxRequest.mock.calls.map((call) => [call[0].url, call[0].header && call[0].header.Authorization])).toEqual([
      ["https://api.example.com/v1/matches", "Bearer session-a-token"],
      ["https://api.example.com/v1/auth/wechat", undefined],
      ["https://api.example.com/v1/predictions/me", "Bearer session-b-token"],
      ["https://api.example.com/v1/auth/wechat", undefined],
      ["https://api.example.com/v1/predictions/me", "Bearer session-b-fresh"],
    ]);
  });

  it("returns the original 401 without replay when logout happens after recovery login succeeds", async () => {
    const { auth, matches, wxRequest, wxLogin, store } = loadStack({
      stored: { [AUTH_SESSION_STORAGE_KEY]: { access_token: "stale-token", expires_at: FUTURE } },
    });
    const loginQueue = [];
    const originalSetStorage = globalThis.wx.setStorageSync;
    globalThis.wx.setStorageSync = (key, value) => {
      originalSetStorage(key, value);
      if (key === AUTH_SESSION_STORAGE_KEY && value && value.access_token === "fresh-token") {
        auth.clearAuth();
      }
    };
    wxRequest.mockImplementation((options) => {
      const url = String(options.url || "");
      if (url.endsWith("/v1/auth/wechat")) {
        loginQueue.push(options);
        return;
      }
      if (url.endsWith("/v1/matches")) {
        options.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录", request_id: "orig-401" } });
        return;
      }
      throw new Error(url);
    });
    const pending = matches.listMatches();
    await waitFor(() => loginQueue.length === 1);
    expect(wxLogin).toHaveBeenCalledTimes(1);
    loginQueue[0].success({
      statusCode: 200,
      data: { data: { access_token: "fresh-token", token_type: "Bearer", expires_at: FUTURE }, request_id: "auth-ok" },
    });
    await expect(pending).resolves.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
      request_id: "orig-401",
    });
    expect(store.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);
    expect(wxRequest.mock.calls.map((call) => call[0].url)).toEqual([
      "https://api.example.com/v1/matches",
      "https://api.example.com/v1/auth/wechat",
    ]);
  });

  it("does not let a late recovery login clear or overwrite a new ensureAuth session after logout", async () => {
    const { auth, matches, wxRequest, wxLogin, store } = loadStack({
      stored: { [AUTH_SESSION_STORAGE_KEY]: { access_token: "stale-token", expires_at: FUTURE } },
    });
    const loginQueue = [];
    wxRequest.mockImplementation((options) => {
      const url = String(options.url || "");
      if (url.endsWith("/v1/auth/wechat")) {
        loginQueue.push(options);
        return;
      }
      if (url.endsWith("/v1/matches")) {
        options.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录" } });
        return;
      }
      throw new Error(url);
    });
    const pendingMatches = matches.listMatches();
    await waitFor(() => loginQueue.length === 1);
    expect(loginQueue).toHaveLength(1);
    auth.clearAuth();
    const pendingEnsure = auth.ensureAuth();
    await waitFor(() => loginQueue.length === 2);
    expect(wxLogin).toHaveBeenCalledTimes(2);
    expect(loginQueue).toHaveLength(2);
    loginQueue[1].success({
      statusCode: 200,
      data: { data: { access_token: "new-token", token_type: "Bearer", expires_at: FUTURE }, request_id: "auth-new" },
    });
    await expect(pendingEnsure).resolves.toMatchObject({ statusCode: 200, data: { access_token: "new-token" } });
    expect(store.get(AUTH_SESSION_STORAGE_KEY)).toEqual({ access_token: "new-token", expires_at: FUTURE });
    loginQueue[0].success({
      statusCode: 200,
      data: { data: { access_token: "late-token", token_type: "Bearer", expires_at: FUTURE }, request_id: "auth-late-old" },
    });
    await expect(pendingMatches).resolves.toMatchObject({ statusCode: 401, code: "UNAUTHORIZED" });
    expect(store.get(AUTH_SESSION_STORAGE_KEY)).toEqual({ access_token: "new-token", expires_at: FUTURE });
  });

  it("reads my predictions with the restored Bearer token", async () => {
    const { auth, predictions, wxRequest, wxLogin } = loadStack({
      stored: { [AUTH_SESSION_STORAGE_KEY]: { access_token: "cached-token", expires_at: FUTURE } },
    });
    succeedHttp(wxRequest, (url) => {
      if (url.endsWith("/v1/predictions/me")) {
        return { statusCode: 200, data: { data: { items: [{ prediction_id: "p1" }] }, request_id: "mine-1" } };
      }
      throw new Error(url);
    });
    await auth.restoreAuth();
    await expect(predictions.listMyPredictions()).resolves.toMatchObject({
      statusCode: 200,
      data: { items: [{ prediction_id: "p1" }] },
    });
    expect(wxLogin).not.toHaveBeenCalled();
    expect(wxRequest.mock.calls[0][0].header).toEqual({ Authorization: "Bearer cached-token" });
  });

  it("recovers a still-cached but server-rejected token and replays the original request once", async () => {
    const { matches, wxRequest, wxLogin, store } = loadStack({
      stored: { [AUTH_SESSION_STORAGE_KEY]: { access_token: "stale-token", expires_at: FUTURE } },
    });
    let matchCalls = 0;
    succeedHttp(wxRequest, (url, options) => {
      if (url.endsWith("/v1/auth/wechat")) {
        return { statusCode: 200, data: { data: { access_token: "fresh-token", token_type: "Bearer", expires_at: FUTURE }, request_id: "auth-401" } };
      }
      if (url.includes("/v1/matches")) {
        matchCalls += 1;
        if (matchCalls === 1) {
          expect(options.header).toEqual({ Authorization: "Bearer stale-token" });
          return { statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录" } };
        }
        expect(options.header).toEqual({ Authorization: "Bearer fresh-token" });
        return { statusCode: 200, data: { data: { items: [{ match_id: "m1" }] }, request_id: "matches-ok" } };
      }
      throw new Error(url);
    });
    await expect(matches.listMatches({ limit: 20, league_id: "premier_league" })).resolves.toMatchObject({
      statusCode: 200,
      data: { items: [{ match_id: "m1" }] },
    });
    expect(wxLogin).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls.map((call) => call[0].url)).toEqual([
      "https://api.example.com/v1/matches?league_id=premier_league&limit=20",
      "https://api.example.com/v1/auth/wechat",
      "https://api.example.com/v1/matches?league_id=premier_league&limit=20",
    ]);
    expect(wxRequest.mock.calls[0][0].data).toBeUndefined();
    expect(wxRequest.mock.calls[2][0].data).toBeUndefined();
    expect(wxRequest.mock.calls[2][0].header).toEqual({ Authorization: "Bearer fresh-token" });
    expect(store.get(AUTH_SESSION_STORAGE_KEY)).toEqual({ access_token: "fresh-token", expires_at: FUTURE });
  });

  it("replays the original prediction POST after 401 recovery", async () => {
    const { predictions, wxRequest, wxLogin } = loadStack({
      stored: { [AUTH_SESSION_STORAGE_KEY]: { access_token: "stale-token", expires_at: FUTURE } },
    });
    const payload = {
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      matchId: "m1",
      homeScore: 1,
      awayScore: 0,
    };
    let predCalls = 0;
    succeedHttp(wxRequest, (url, options) => {
      if (url.endsWith("/v1/auth/wechat")) {
        return { statusCode: 200, data: { data: { access_token: "fresh-token", token_type: "Bearer", expires_at: FUTURE }, request_id: "auth-post" } };
      }
      if (url.endsWith("/v1/predictions")) {
        predCalls += 1;
        expect(options.data).toEqual({
          idempotency_key: payload.idempotencyKey,
          match_id: payload.matchId,
          home_score: payload.homeScore,
          away_score: payload.awayScore,
        });
        if (predCalls === 1) {
          expect(options.header.Authorization).toBe("Bearer stale-token");
          return { statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录" } };
        }
        expect(options.header.Authorization).toBe("Bearer fresh-token");
        return { statusCode: 201, data: { data: { prediction_id: "p1" }, request_id: "pred-ok" } };
      }
      throw new Error(url);
    });
    await expect(predictions.submitPrediction(payload)).resolves.toMatchObject({
      statusCode: 201,
      data: { prediction_id: "p1" },
    });
    expect(wxLogin).toHaveBeenCalledTimes(1);
    expect(predCalls).toBe(2);
  });

  it("does not loop when recovery login succeeds but the business request is still 401", async () => {
    const { matches, wxRequest, wxLogin } = loadStack({
      stored: { [AUTH_SESSION_STORAGE_KEY]: { access_token: "stale-token", expires_at: FUTURE } },
    });
    succeedHttp(wxRequest, (url) => {
      if (url.endsWith("/v1/auth/wechat")) {
        return { statusCode: 200, data: { data: { access_token: "fresh-token", token_type: "Bearer", expires_at: FUTURE }, request_id: "auth-loop" } };
      }
      if (url.endsWith("/v1/matches")) {
        return { statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录" } };
      }
      throw new Error(url);
    });
    await expect(matches.listMatches()).resolves.toMatchObject({ statusCode: 401, code: "UNAUTHORIZED" });
    expect(wxLogin).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls.map((call) => call[0].url)).toEqual([
      "https://api.example.com/v1/matches",
      "https://api.example.com/v1/auth/wechat",
      "https://api.example.com/v1/matches",
    ]);
  });

  it("returns the real login error and does not replay when 401 recovery fails", async () => {
    const { matches, wxRequest, wxLogin } = loadStack({
      stored: { [AUTH_SESSION_STORAGE_KEY]: { access_token: "stale-token", expires_at: FUTURE } },
    });
    succeedHttp(wxRequest, (url) => {
      if (url.endsWith("/v1/auth/wechat")) {
        return { statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录" } };
      }
      if (url.endsWith("/v1/matches")) {
        return { statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录", request_id: "biz-401" } };
      }
      throw new Error(url);
    });
    await expect(matches.listMatches()).resolves.toMatchObject({ statusCode: 401, code: "UNAUTHORIZED" });
    expect(wxLogin).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls.map((call) => call[0].url)).toEqual([
      "https://api.example.com/v1/matches",
      "https://api.example.com/v1/auth/wechat",
    ]);
  });

  it("shares one wx.login when two stale-token 401s arrive together and replays both originals", async () => {
    const { matches, predictions, wxRequest, wxLogin, store } = loadStack({
      stored: { [AUTH_SESSION_STORAGE_KEY]: { access_token: "stale-token", expires_at: FUTURE } },
    });
    const held = [];
    wxRequest.mockImplementation((options) => {
      const url = String(options.url || "");
      if (url.endsWith("/v1/auth/wechat")) {
        options.success({
          statusCode: 200,
          data: { data: { access_token: "fresh-token", token_type: "Bearer", expires_at: FUTURE }, request_id: "auth-concurrent" },
        });
        return;
      }
      if (options.header && options.header.Authorization === "Bearer stale-token") {
        held.push(options);
        return;
      }
      if (url.includes("/v1/matches")) {
        expect(options.header).toEqual({ Authorization: "Bearer fresh-token" });
        options.success({ statusCode: 200, data: { data: { items: [{ match_id: "m1" }] }, request_id: "matches-ok" } });
        return;
      }
      if (url.endsWith("/v1/predictions/me")) {
        expect(options.header).toEqual({ Authorization: "Bearer fresh-token" });
        options.success({ statusCode: 200, data: { data: { items: [{ prediction_id: "p1" }] }, request_id: "mine-ok" } });
        return;
      }
      throw new Error(url);
    });
    const pendingMatches = matches.listMatches({ limit: 20, league_id: "premier_league" });
    const pendingMine = predictions.listMyPredictions();
    await Promise.resolve();
    await Promise.resolve();
    expect(held).toHaveLength(2);
    expect(held[0]).toMatchObject({
      url: "https://api.example.com/v1/matches?league_id=premier_league&limit=20",
      method: "GET",
      header: { Authorization: "Bearer stale-token" },
    });
    expect(held[0].data).toBeUndefined();
    expect(held[1]).toMatchObject({
      url: "https://api.example.com/v1/predictions/me",
      method: "GET",
      header: { Authorization: "Bearer stale-token" },
    });
    held.forEach((options) => {
      options.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录" } });
    });
    await expect(pendingMatches).resolves.toMatchObject({ statusCode: 200, data: { items: [{ match_id: "m1" }] } });
    await expect(pendingMine).resolves.toMatchObject({ statusCode: 200, data: { items: [{ prediction_id: "p1" }] } });
    expect(wxLogin).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls.map((call) => call[0].url)).toEqual([
      "https://api.example.com/v1/matches?league_id=premier_league&limit=20",
      "https://api.example.com/v1/predictions/me",
      "https://api.example.com/v1/auth/wechat",
      "https://api.example.com/v1/matches?league_id=premier_league&limit=20",
      "https://api.example.com/v1/predictions/me",
    ]);
    expect(wxRequest.mock.calls[2][0].header.Authorization).toBeUndefined();
    expect(wxRequest.mock.calls[3][0].header).toEqual({ Authorization: "Bearer fresh-token" });
    expect(wxRequest.mock.calls[4][0].header).toEqual({ Authorization: "Bearer fresh-token" });
    expect(store.get(AUTH_SESSION_STORAGE_KEY)).toEqual({ access_token: "fresh-token", expires_at: FUTURE });
  });

  it("does not clear a fresh session or wx.login again when a stale 401 arrives late", async () => {
    const { matches, api, wxRequest, wxLogin, store } = loadStack({
      stored: { [AUTH_SESSION_STORAGE_KEY]: { access_token: "stale-token", expires_at: FUTURE } },
    });
    let late401;
    wxRequest.mockImplementation((options) => {
      const url = String(options.url || "");
      if (url.endsWith("/v1/auth/wechat")) {
        options.success({
          statusCode: 200,
          data: { data: { access_token: "fresh-token", token_type: "Bearer", expires_at: FUTURE }, request_id: "auth-late" },
        });
        return;
      }
      if (url.endsWith("/v1/profile/me") && options.header && options.header.Authorization === "Bearer stale-token") {
        late401 = options;
        return;
      }
      if (url.includes("/v1/matches") && options.header && options.header.Authorization === "Bearer stale-token") {
        options.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录" } });
        return;
      }
      if (url.includes("/v1/matches")) {
        expect(options.header).toEqual({ Authorization: "Bearer fresh-token" });
        options.success({ statusCode: 200, data: { data: { items: [{ match_id: "m1" }] }, request_id: "matches-late" } });
        return;
      }
      if (url.endsWith("/v1/profile/me")) {
        expect(options.header).toEqual({ Authorization: "Bearer fresh-token" });
        options.success({ statusCode: 200, data: { data: { nickname: "球友" }, request_id: "profile-late" } });
        return;
      }
      throw new Error(url);
    });
    const late = api.request({ method: "GET", path: "/v1/profile/me" });
    await Promise.resolve();
    await expect(matches.listMatches({ limit: 20, league_id: "premier_league" })).resolves.toMatchObject({
      statusCode: 200,
      data: { items: [{ match_id: "m1" }] },
    });
    expect(wxLogin).toHaveBeenCalledTimes(1);
    expect(store.get(AUTH_SESSION_STORAGE_KEY)).toEqual({ access_token: "fresh-token", expires_at: FUTURE });
    late401.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录" } });
    await expect(late).resolves.toMatchObject({ statusCode: 200, data: { nickname: "球友" } });
    expect(wxLogin).toHaveBeenCalledTimes(1);
    expect(store.get(AUTH_SESSION_STORAGE_KEY)).toEqual({ access_token: "fresh-token", expires_at: FUTURE });
    expect(wxRequest.mock.calls.map((call) => call[0].url)).toEqual([
      "https://api.example.com/v1/profile/me",
      "https://api.example.com/v1/matches?league_id=premier_league&limit=20",
      "https://api.example.com/v1/auth/wechat",
      "https://api.example.com/v1/matches?league_id=premier_league&limit=20",
      "https://api.example.com/v1/profile/me",
    ]);
    expect(wxRequest.mock.calls[4][0].header).toEqual({ Authorization: "Bearer fresh-token" });
  });

  it("does not replay a previous session POST when its 401 arrives after logout and a new login", async () => {
    const { auth, predictions, wxRequest, wxLogin, store } = loadStack({
      stored: { [AUTH_SESSION_STORAGE_KEY]: { access_token: "session-a-token", expires_at: FUTURE } },
    });
    const payload = {
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      matchId: "m1",
      homeScore: 1,
      awayScore: 0,
    };
    let late401;
    wxRequest.mockImplementation((options) => {
      const url = String(options.url || "");
      if (url.endsWith("/v1/auth/wechat")) {
        options.success({
          statusCode: 200,
          data: { data: { access_token: "session-b-token", token_type: "Bearer", expires_at: FUTURE }, request_id: "auth-b" },
        });
        return;
      }
      if (url.endsWith("/v1/predictions") && options.header && options.header.Authorization === "Bearer session-a-token") {
        late401 = options;
        return;
      }
      if (url.endsWith("/v1/predictions")) {
        options.success({ statusCode: 201, data: { data: { prediction_id: "p-leaked" }, request_id: "pred-leaked" } });
        return;
      }
      throw new Error(url);
    });
    await auth.restoreAuth();
    const pending = predictions.submitPrediction(payload);
    await Promise.resolve();
    expect(late401).toMatchObject({
      url: "https://api.example.com/v1/predictions",
      method: "POST",
      data: {
        idempotency_key: payload.idempotencyKey,
        match_id: payload.matchId,
        home_score: payload.homeScore,
        away_score: payload.awayScore,
      },
      header: {
        "content-type": "application/json",
        Authorization: "Bearer session-a-token",
      },
    });
    auth.clearAuth();
    await expect(auth.ensureAuth()).resolves.toMatchObject({ statusCode: 200, data: { access_token: "session-b-token" } });
    expect(store.get(AUTH_SESSION_STORAGE_KEY)).toEqual({ access_token: "session-b-token", expires_at: FUTURE });
    late401.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录", request_id: "late-a" } });
    await expect(pending).resolves.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
      request_id: "late-a",
    });
    expect(wxLogin).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls.map((call) => [call[0].url, call[0].header && call[0].header.Authorization])).toEqual([
      ["https://api.example.com/v1/predictions", "Bearer session-a-token"],
      ["https://api.example.com/v1/auth/wechat", undefined],
    ]);
    expect(store.get(AUTH_SESSION_STORAGE_KEY)).toEqual({ access_token: "session-b-token", expires_at: FUTURE });
  });

  it("refreshes optional-auth 401 when a bearer was sent and retries with the new session", async () => {
    const { api, wxRequest, wxLogin, store } = loadStack({
      stored: { [AUTH_SESSION_STORAGE_KEY]: { access_token: "stale-token", expires_at: FUTURE } },
    });
    wxRequest.mockImplementation((options) => {
      const url = String(options.url || "");
      if (url.endsWith("/v1/auth/wechat")) {
        options.success({
          statusCode: 200,
          data: { data: { access_token: "fresh-token", token_type: "Bearer", expires_at: FUTURE }, request_id: "auth-optional" },
        });
        return;
      }
      if (url.endsWith("/v1/league-seasons") && options.header && options.header.Authorization === "Bearer stale-token") {
        options.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录" } });
        return;
      }
      if (url.endsWith("/v1/league-seasons")) {
        expect(options.header).toEqual({ Authorization: "Bearer fresh-token" });
        options.success({ statusCode: 200, data: { data: { items: [] }, request_id: "seasons-ok" } });
        return;
      }
      throw new Error(url);
    });
    await expect(api.request({ method: "GET", path: "/v1/league-seasons", auth: "optional" })).resolves.toMatchObject({
      statusCode: 200,
      data: { items: [] },
    });
    expect(wxLogin).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls.map((call) => call[0].url)).toEqual([
      "https://api.example.com/v1/league-seasons",
      "https://api.example.com/v1/auth/wechat",
      "https://api.example.com/v1/league-seasons",
    ]);
    expect(wxRequest.mock.calls[0][0].header).toEqual({ Authorization: "Bearer stale-token" });
    expect(wxRequest.mock.calls[1][0].header.Authorization).toBeUndefined();
    expect(wxRequest.mock.calls[2][0].header).toEqual({ Authorization: "Bearer fresh-token" });
    expect(store.get(AUTH_SESSION_STORAGE_KEY)).toEqual({ access_token: "fresh-token", expires_at: FUTURE });
  });

  it("does not wx.login on optional-auth 401 when no token was sent", async () => {
    const { api, wxRequest, wxLogin } = loadStack();
    succeedHttp(wxRequest, (url) => {
      if (url.endsWith("/v1/share-card/u1")) {
        return { statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录" } };
      }
      throw new Error(url);
    });
    await expect(api.request({ method: "GET", path: "/v1/share-card/u1", auth: "optional" })).resolves.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
    });
    expect(wxLogin).not.toHaveBeenCalled();
    expect(wxRequest).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls[0][0].header.Authorization).toBeUndefined();
  });

  it("does not recover optional-auth 401 after logout", async () => {
    const { auth, api, wxRequest, wxLogin, store } = loadStack({
      stored: { [AUTH_SESSION_STORAGE_KEY]: { access_token: "cached-token", expires_at: FUTURE } },
    });
    succeedHttp(wxRequest, (url) => {
      if (url.endsWith("/v1/league-seasons")) {
        return { statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录" } };
      }
      throw new Error(url);
    });
    await auth.restoreAuth();
    auth.clearAuth();
    expect(store.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);
    await expect(api.request({ method: "GET", path: "/v1/league-seasons", auth: "optional" })).resolves.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
    });
    expect(wxLogin).not.toHaveBeenCalled();
    expect(wxRequest).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls[0][0].header.Authorization).toBeUndefined();
  });
});

describe("CloudBase keeps the original identity flow", () => {
  it("inits a session without wx.login or self-hosted token exchange", async () => {
    const { session, auth, wxRequest, wxLogin, callFunction, store } = loadStack({ transport: "cloud" });
    succeedCloud(callFunction, (data) => {
      if (data.path === "/v1/session/init") {
        return { status: 201, body: { data: { nickname: "Sky" }, request_id: "cloud-session" } };
      }
      throw new Error(data.path);
    });
    await expect(auth.ensureAuth()).resolves.toMatchObject({ statusCode: 200 });
    await expect(session.initSession("Sky")).resolves.toMatchObject({ statusCode: 201, data: { nickname: "Sky" } });
    expect(wxLogin).not.toHaveBeenCalled();
    expect(wxRequest).not.toHaveBeenCalled();
    expect(store.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);
    expect(callFunction.mock.calls[0][0].data).toEqual({
      method: "POST",
      path: "/v1/session/init",
      query: undefined,
      body: { nickname: "Sky" },
    });
  });

  it("reads matches and writes predictions through callFunction without a Bearer token", async () => {
    const { auth, matches, predictions, wxRequest, wxLogin, callFunction } = loadStack({ transport: "cloud" });
    succeedCloud(callFunction, (data) => {
      if (data.path === "/v1/matches") {
        return { status: 200, body: { data: { items: [{ match_id: "m1" }] }, request_id: "cloud-matches" } };
      }
      if (data.path === "/v1/predictions") {
        return { status: 201, body: { data: { prediction_id: "p1" }, request_id: "cloud-pred" } };
      }
      if (data.path === "/v1/predictions/me") {
        return { status: 200, body: { data: { items: [{ prediction_id: "p1" }] }, request_id: "cloud-mine" } };
      }
      throw new Error(data.path);
    });
    await auth.restoreAuth();
    await expect(matches.listMatches()).resolves.toMatchObject({ statusCode: 200, data: { items: [{ match_id: "m1" }] } });
    await expect(predictions.submitPrediction({
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      matchId: "m1",
      homeScore: 2,
      awayScore: 1,
    })).resolves.toMatchObject({ statusCode: 201, data: { prediction_id: "p1" } });
    await expect(predictions.listMyPredictions()).resolves.toMatchObject({
      statusCode: 200,
      data: { items: [{ prediction_id: "p1" }] },
    });
    expect(wxLogin).not.toHaveBeenCalled();
    expect(wxRequest).not.toHaveBeenCalled();
    expect(callFunction.mock.calls.map((call) => call[0].data.path)).toEqual([
      "/v1/matches",
      "/v1/predictions",
      "/v1/predictions/me",
    ]);
    expect(callFunction.mock.calls.every((call) => !("authorization" in call[0].data) && !("header" in call[0].data))).toBe(true);
  });
});
