import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const cloudDiagnostics = await import("./cloud-diagnostics.js");

const FUTURE = "2026-11-19T00:00:00.000Z";
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
  const api = loadCommonJs(join(HERE, "api.js"), (id) => {
    if (id === "../config.js") return config;
    if (id === "./cloud-diagnostics.js") return cloudDiagnostics;
    throw new Error(`Unexpected require: ${id}`);
  });
  const authStorage = loadCommonJs(join(ROOT, "utils", "auth-storage.js"), () => {
    throw new Error("auth-storage.js 不应 require 其它模块");
  });
  const auth = loadCommonJs(join(HERE, "auth.js"), (id) => {
    if (id === "../config.js") return config;
    if (id === "./api.js") return api;
    if (id === "../utils/auth-storage.js") return authStorage;
    throw new Error(`Unexpected require: ${id}`);
  });
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
