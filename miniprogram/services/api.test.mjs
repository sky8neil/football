import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const cloudDiagnostics = await import("./cloud-diagnostics.js");

function loadApi({ gatewayOrigin = "http://127.0.0.1:8787", URL, transport = "http", envVersion = "develop", cloudEnvId = "cloud-test", cloudFunctionName = "api", stored = {}, auth } = {}) {
  const wxRequest = vi.fn();
  const callFunction = vi.fn();
  const warn = vi.fn();
  const store = new Map(Object.entries(stored));
  const authModule = typeof auth === "function"
    ? auth({ store })
    : (auth || {
      clearAuth: vi.fn(),
      ensureAuth: vi.fn(() => Promise.resolve({ statusCode: 200 })),
    });
  if (typeof authModule.recoverSession !== "function") {
    authModule.recoverSession = vi.fn((staleToken) => {
      if (typeof authModule.clearAuth === "function") authModule.clearAuth(staleToken);
      if (typeof authModule.ensureAuth !== "function") {
        return Promise.resolve({ statusCode: 401, code: "UNAUTHORIZED" });
      }
      return Promise.resolve(authModule.ensureAuth());
    });
  }
  const wx = {
    request: wxRequest,
    cloud: { callFunction },
    getAccountInfoSync: () => ({ miniProgram: { envVersion } }),
    getStorageSync: (key) => store.get(key),
    setStorageSync: (key, value) => store.set(key, value),
    removeStorageSync: (key) => store.delete(key),
  };
  const authStorageContext = {
    module: { exports: {} },
    require() { throw new Error("auth-storage.js 不应 require 其它模块"); },
    wx,
  };
  runInNewContext(readFileSync(join(HERE, "..", "utils", "auth-storage.js"), "utf8"), authStorageContext, { filename: "auth-storage.js" });
  const context = {
    module: { exports: {} },
    require(id) {
      if (id === "../config.js") return { gatewayOrigin, transport, cloudEnvId, cloudFunctionName };
      if (id === "./cloud-diagnostics.js") return cloudDiagnostics;
      if (id === "../utils/auth-storage.js") return authStorageContext.module.exports;
      if (id === "./auth.js") return authModule;
      throw new Error(`Unexpected require: ${id}`);
    },
    wx,
    console: { warn },
    URL,
    URLSearchParams: undefined,
  };
  runInNewContext(readFileSync(join(HERE, "api.js"), "utf8"), context, { filename: "api.js" });
  return { api: context.module.exports, wxRequest, callFunction, warn, store, auth: authModule };
}

describe("mini program request URL compatibility", () => {
  it.each([undefined, {}])("initializes a session when URL is unavailable or not a constructor (%s)", async (URL) => {
    const { api, wxRequest } = loadApi({ URL });
    const context = {
      module: { exports: {} },
      require(id) {
        if (id === "./api.js") return api;
        if (id === "./auth.js") return { ensureAuth: () => Promise.resolve({ statusCode: 200 }), recoverSession: () => Promise.resolve({ statusCode: 200 }) };
        throw new Error(`Unexpected require: ${id}`);
      },
    };
    runInNewContext(readFileSync(join(HERE, "session.js"), "utf8"), context, { filename: "session.js" });
    const pending = context.module.exports.initSession("球友");
    await Promise.resolve();
    const options = wxRequest.mock.calls[0][0];
    expect(options).toMatchObject({
      url: "http://127.0.0.1:8787/v1/session/init",
      method: "POST",
      data: { nickname: "球友" },
      header: { "content-type": "application/json" },
    });
    options.success({ statusCode: 201, data: { data: { nickname: "球友" }, request_id: "session-request" } });
    await expect(pending).resolves.toMatchObject({ statusCode: 201, data: { nickname: "球友" }, request_id: "session-request" });
  });

  it.each(["/v1/matches", "v1/matches"])("joins origin and route without duplicate slashes (%s)", (path) => {
    const { api, wxRequest } = loadApi({ gatewayOrigin: "http://127.0.0.1:8787/" });
    api.request({ method: "GET", path });
    expect(wxRequest.mock.calls[0][0].url).toBe("http://127.0.0.1:8787/v1/matches");
  });

  it("encodes query keys and values with the original URLSearchParams semantics", () => {
    const { api, wxRequest } = loadApi();
    api.request({
      method: "GET", path: "/v1/matches",
      query: {
        "中文 &": "球友 +&=#?/%!~'()*",
        from: "2026-10-10T00:00:00+08:00",
        cursor: "a+b/c==",
        limit: 0, enabled: false, empty: "", absent: undefined, omitted: null,
      },
    });
    expect(wxRequest.mock.calls[0][0].url).toBe(
      "http://127.0.0.1:8787/v1/matches?%E4%B8%AD%E6%96%87+%26=%E7%90%83%E5%8F%8B+%2B%26%3D%23%3F%2F%25%21%7E%27%28%29*&from=2026-10-10T00%3A00%3A00%2B08%3A00&cursor=a%2Bb%2Fc%3D%3D&limit=0&enabled=false&empty=",
    );
  });

  it.each([
    ["/v1/matches?status=live#section", "/v1/matches?status=live&limit=2#section"],
    ["/v1/matches?", "/v1/matches?limit=2"],
    ["/v1/matches?status=live&", "/v1/matches?status=live&limit=2"],
    ["/v1/球友 name/%E7%90%83", "/v1/%E7%90%83%E5%8F%8B%20name/%E7%90%83?limit=2"],
  ])("preserves route encoding, existing query and fragment (%s)", (path, expected) => {
    const { api, wxRequest } = loadApi();
    api.request({ method: "GET", path, query: { limit: 2 } });
    expect(wxRequest.mock.calls[0][0].url).toBe("http://127.0.0.1:8787" + expected);
  });

  it("sends profile PATCH changes as a JSON body", () => {
    const { api, wxRequest } = loadApi();
    const data = { nickname: "新昵称", favorite_team_id: null };
    api.request({ method: "PATCH", path: "/v1/profile/me", data });
    expect(wxRequest.mock.calls[0][0]).toMatchObject({ method: "PATCH", data, header: { "content-type": "application/json" } });
  });

  it.each([401, 409, 422, 429])("keeps HTTP %s as an unchanged error envelope", async (statusCode) => {
    const { api, wxRequest } = loadApi();
    const pending = api.request({ method: "GET", path: "/v1/profile/me" });
    const options = wxRequest.mock.calls[0][0];
    expect(options.header).toEqual({});
    expect(options.data).toBeUndefined();
    options.success({ statusCode, data: { code: "ERROR_CODE", message: "message", details: { field: "nickname" }, request_id: "error-request" } });
    await expect(pending).resolves.toEqual({
      statusCode, data: undefined, code: "ERROR_CODE", message: "message", details: { field: "nickname" }, request_id: "error-request",
    });
  });

  it("preserves the network failure result", async () => {
    const { api, wxRequest } = loadApi();
    const pending = api.request({ method: "GET", path: "/v1/matches" });
    wxRequest.mock.calls[0][0].fail();
    await expect(pending).resolves.toEqual({
      statusCode: 0,
      data: undefined,
      code: "NETWORK_ERROR",
      message: "网络异常",
      details: undefined,
      request_id: undefined,
    });
  });

  it("dispatches cloud requests without changing the service request shape", async () => {
    const { api, callFunction, wxRequest } = loadApi({ transport: "cloud" });
    const pending = api.request({ method: "POST", path: "/v1/session/init", data: { nickname: "Sky" }, query: { from: "a" } });
    expect(callFunction.mock.calls[0][0]).toMatchObject({ name: "api", data: { method: "POST", path: "/v1/session/init", body: { nickname: "Sky" }, query: { from: "a" } } });
    expect(wxRequest).not.toHaveBeenCalled();
    callFunction.mock.calls[0][0].success({ result: { status: 201, body: { data: { nickname: "Sky" }, request_id: "12345678-1234-1234-1234-12345678abcd" } } });
    await expect(pending).resolves.toMatchObject({ statusCode: 201, data: { nickname: "Sky" }, request_id: "12345678-1234-1234-1234-12345678abcd" });
  });

  it("serializes cloud query values like HTTP query parameters", () => {
    const { api, callFunction } = loadApi({ transport: "cloud" });
    api.request({
      method: "GET",
      path: "/v1/matches",
      query: { limit: 100, enabled: false, cursor: "next", absent: undefined, omitted: null },
    });
    expect(callFunction.mock.calls[0][0].data.query).toEqual({
      limit: "100",
      enabled: "false",
      cursor: "next",
    });
  });

  it.each([200, 201, 401, 409, 422, 429])("maps cloud HTTP %s to the shared service result", async (status) => {
    const { api, callFunction } = loadApi({ transport: "cloud" });
    const pending = api.request({ method: "GET", path: "/v1/profile/me" });
    callFunction.mock.calls[0][0].success({ result: { status, body: { data: { ok: true }, code: status >= 400 ? "ERROR" : undefined, message: "Request failed", request_id: "00000000-0000-4000-8000-12345678abcd" } } });
    const result = await pending;
    expect(result.statusCode).toBe(status);
    if (status >= 400) expect(result.message).toContain("编号 abcd");
  });

  it("maps cloud invocation failure and logs a local diagnostic only in develop", async () => {
    const { api, callFunction, warn } = loadApi({ transport: "cloud" });
    const pending = api.request({ method: "GET", path: "/v1/matches" });
    callFunction.mock.calls[0][0].fail({ errCode: -1, errMsg: "cloud function not found" });
    await expect(pending).resolves.toMatchObject({ statusCode: 0, code: "NETWORK_ERROR" });
    expect(warn).toHaveBeenCalledWith("[diag]", expect.objectContaining({ diag_code: "DIAG_CLIENT_FUNCTION_NOT_FOUND" }));
  });

  it("does not print technical diagnostics in release", async () => {
    const { api, callFunction, warn } = loadApi({ transport: "cloud", envVersion: "release" });
    const pending = api.request({ method: "GET", path: "/v1/matches" });
    callFunction.mock.calls[0][0].fail({ errCode: -1, errMsg: "cloud function not found" });
    await expect(pending).resolves.toMatchObject({ statusCode: 0, code: "NETWORK_ERROR" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects HTTP without a valid https domain in trial and release and blocks client supplied identity keys", () => {
    const releaseHttp = loadApi({ envVersion: "release" });
    expect(() => releaseHttp.api.request({ method: "GET", path: "/v1/matches" })).toThrow("HTTP transport requires a valid https:// domain");
    const { api, callFunction } = loadApi({ transport: "cloud" });
    expect(() => api.request({ method: "POST", path: "/v1/session/init", data: { nickname: "Sky", nested: { openid: "fake" } } })).toThrow("identity field is forbidden");
    expect(callFunction).not.toHaveBeenCalled();
  });

  it("requires cloud environment and function configuration", () => {
    expect(() => loadApi({ transport: "cloud", cloudEnvId: "" }).api.request({ method: "GET", path: "/v1/matches" })).toThrow("cloudEnvId is required");
    expect(() => loadApi({ transport: "cloud", cloudFunctionName: "" }).api.request({ method: "GET", path: "/v1/matches" })).toThrow("cloudFunctionName is required");
  });
});

describe("mini program dual transport and HTTP bearer", () => {
  it.each(["trial", "release"])("allows HTTPS HTTP transport in %s", (envVersion) => {
    const { api, wxRequest, callFunction } = loadApi({
      envVersion,
      gatewayOrigin: "https://api.example.com",
    });
    api.request({ method: "GET", path: "/v1/matches" });
    expect(wxRequest.mock.calls[0][0].url).toBe("https://api.example.com/v1/matches");
    expect(callFunction).not.toHaveBeenCalled();
  });

  it.each([
    ["http://api.example.com", "trial"],
    ["https://127.0.0.1", "release"],
    ["https://localhost", "trial"],
    ["https://192.168.0.1", "release"],
    ["https://api.example.com:443", "trial"],
    ["https://api.example.com/v1", "release"],
  ])("rejects %s as a trial/release HTTP origin", (gatewayOrigin, envVersion) => {
    const { api, wxRequest } = loadApi({ envVersion, gatewayOrigin });
    expect(() => api.request({ method: "GET", path: "/v1/matches" })).toThrow("HTTP transport requires a valid https:// domain");
    expect(wxRequest).not.toHaveBeenCalled();
  });

  it("rejects unknown transport in trial and release", () => {
    const { api } = loadApi({ envVersion: "release", transport: "ftp", gatewayOrigin: "https://api.example.com" });
    expect(() => api.request({ method: "GET", path: "/v1/matches" })).toThrow("must use cloud transport");
  });

  it("keeps CloudBase dispatch without Authorization or HTTP origin checks", () => {
    const provider = vi.fn(() => "opaque-token");
    const { api, callFunction, wxRequest } = loadApi({ transport: "cloud", envVersion: "release" });
    api.setAccessTokenProvider(provider);
    api.request({ method: "GET", path: "/v1/matches" });
    expect(callFunction).toHaveBeenCalledTimes(1);
    expect(wxRequest).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(callFunction.mock.calls[0][0].data).not.toHaveProperty("authorization");
    expect(callFunction.mock.calls[0][0].data).not.toHaveProperty("header");
  });

  it("attaches Bearer on HTTP methods and keeps POST JSON content-type", () => {
    const { api, wxRequest } = loadApi({ gatewayOrigin: "https://api.example.com" });
    api.setAccessTokenProvider(() => "opaque-token");
    api.request({ method: "GET", path: "/v1/matches" });
    expect(wxRequest.mock.calls[0][0].header).toEqual({ Authorization: "Bearer opaque-token" });
    api.request({ method: "POST", path: "/v1/session/init", data: { nickname: "球友" } });
    expect(wxRequest.mock.calls[1][0]).toMatchObject({
      method: "POST",
      data: { nickname: "球友" },
      header: {
        "content-type": "application/json",
        Authorization: "Bearer opaque-token",
      },
    });
  });

  it("does not call the token provider for auth login requests", () => {
    const provider = vi.fn(() => "opaque-token");
    const { api, wxRequest } = loadApi();
    api.setAccessTokenProvider(provider);
    api.request({ method: "POST", path: "/v1/auth/wechat", data: { code: "wx-code" } });
    expect(provider).not.toHaveBeenCalled();
    expect(wxRequest.mock.calls[0][0]).toMatchObject({
      url: "http://127.0.0.1:8787/v1/auth/wechat",
      method: "POST",
      data: { code: "wx-code" },
      header: { "content-type": "application/json" },
    });
    expect(wxRequest.mock.calls[0][0].header.Authorization).toBeUndefined();
  });

  it("waits for the HTTP auth preparer before sending a business request", async () => {
    let resolveAuth;
    const ready = new Promise((resolve) => { resolveAuth = resolve; });
    const { api, wxRequest } = loadApi();
    wxRequest.mockImplementation((options) => {
      options.success({ statusCode: 200, data: { data: { items: [] }, request_id: "matches-auth" } });
    });
    api.setAuthPreparer(() => ready);
    const pending = api.request({ method: "GET", path: "/v1/matches" });
    expect(wxRequest).not.toHaveBeenCalled();
    resolveAuth();
    await expect(pending).resolves.toMatchObject({ statusCode: 200, data: { items: [] } });
    expect(wxRequest).toHaveBeenCalledTimes(1);
  });

  it("returns the auth failure and does not dispatch when restore fails", async () => {
    const { api, wxRequest } = loadApi();
    api.setAuthPreparer(() => Promise.resolve({
      statusCode: 401,
      code: "UNAUTHORIZED",
      message: "需要重新登录",
      data: undefined,
      request_id: undefined,
      details: undefined,
    }));
    await expect(api.request({ method: "GET", path: "/v1/matches" })).resolves.toEqual({
      statusCode: 401,
      code: "UNAUTHORIZED",
      message: "需要重新登录",
      data: undefined,
      request_id: undefined,
      details: undefined,
    });
    expect(wxRequest).not.toHaveBeenCalled();
  });

  it("still dispatches public HTTP requests when the auth preparer skips with no session", async () => {
    const { api, wxRequest } = loadApi();
    wxRequest.mockImplementation((options) => {
      options.success({ statusCode: 200, data: { data: { items: [] }, request_id: "public-1" } });
    });
    api.setAuthPreparer(() => Promise.resolve({ statusCode: 200, data: undefined }));
    await expect(api.request({ method: "GET", path: "/v1/matches" })).resolves.toMatchObject({
      statusCode: 200,
      data: { items: [] },
    });
    expect(wxRequest).toHaveBeenCalledTimes(1);
  });

  it("does not invoke the auth preparer for login or CloudBase requests", () => {
    const preparer = vi.fn(() => Promise.resolve());
    const { api, wxRequest } = loadApi();
    api.setAuthPreparer(preparer);
    api.request({ method: "POST", path: "/v1/auth/wechat", data: { code: "wx-code" } });
    expect(preparer).not.toHaveBeenCalled();
    expect(wxRequest).toHaveBeenCalledTimes(1);
    const cloud = loadApi({ transport: "cloud" });
    cloud.api.setAuthPreparer(preparer);
    cloud.api.request({ method: "GET", path: "/v1/matches" });
    expect(preparer).not.toHaveBeenCalled();
    expect(cloud.callFunction).toHaveBeenCalledTimes(1);
  });

  it("dispatches optional-auth requests even when the preparer returns 401", async () => {
    const { api, wxRequest } = loadApi();
    api.setAuthPreparer(() => Promise.resolve({
      statusCode: 401,
      code: "UNAUTHORIZED",
      message: "需要重新登录",
    }));
    wxRequest.mockImplementation((options) => {
      options.success({ statusCode: 200, data: { data: { items: [] }, request_id: "optional-401" } });
    });
    await expect(api.request({ method: "GET", path: "/v1/share-card/u1", auth: "optional" })).resolves.toMatchObject({
      statusCode: 200,
      data: { items: [] },
    });
    expect(wxRequest).toHaveBeenCalledTimes(1);
  });

  it("does not attach an expired cached token on optional-auth requests", async () => {
    const { api, wxRequest } = loadApi({
      stored: { auth_session: { access_token: "expired-token", expires_at: "2020-01-01T00:00:00.000Z" } },
    });
    api.setAccessTokenProvider(() => "expired-token");
    wxRequest.mockImplementation((options) => {
      options.success({ statusCode: 200, data: { data: {}, request_id: "optional-expired" } });
    });
    await api.request({ method: "GET", path: "/v1/league-seasons", auth: "optional" });
    expect(wxRequest.mock.calls[0][0].header.Authorization).toBeUndefined();
  });

  it("attaches a still-valid cached session on optional-auth requests without calling the preparer", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { api, wxRequest } = loadApi({
      stored: { auth_session: { access_token: "live-token", expires_at: future } },
    });
    const preparer = vi.fn(() => Promise.resolve({ statusCode: 401, code: "UNAUTHORIZED" }));
    api.setAuthPreparer(preparer);
    wxRequest.mockImplementation((options) => {
      options.success({ statusCode: 200, data: { data: {}, request_id: "optional-live" } });
    });
    await api.request({ method: "GET", path: "/v1/league-seasons", auth: "optional" });
    expect(preparer).not.toHaveBeenCalled();
    expect(wxRequest.mock.calls[0][0].header).toEqual({ Authorization: "Bearer live-token" });
  });

  it("preserves the HTTP success envelope after attaching Authorization", async () => {
    const { api, wxRequest } = loadApi();
    api.setAccessTokenProvider(() => "opaque-token");
    const pending = api.request({ method: "GET", path: "/v1/matches" });
    wxRequest.mock.calls[0][0].success({
      statusCode: 200,
      data: { data: { items: [] }, request_id: "matches-request" },
    });
    await expect(pending).resolves.toEqual({
      statusCode: 200,
      data: { items: [] },
      code: undefined,
      message: undefined,
      details: undefined,
      request_id: "matches-request",
    });
  });
});

describe("HTTP 401 silent recovery", () => {
  function authThatRefreshes(tokenRef) {
    return {
      clearAuth: vi.fn(() => { tokenRef.value = undefined; }),
      ensureAuth: vi.fn(() => {
        tokenRef.value = "fresh-token";
        return Promise.resolve({ statusCode: 200, data: { access_token: "fresh-token" } });
      }),
    };
  }

  it("clears auth, re-logins once, and replays the original query and headers after 401 UNAUTHORIZED", async () => {
    const tokenRef = { value: "stale-token" };
    const { api, wxRequest, auth } = loadApi({ auth: authThatRefreshes(tokenRef) });
    api.setAccessTokenProvider(() => tokenRef.value);
    wxRequest.mockImplementation((options) => {
      if (options.header && options.header.Authorization === "Bearer stale-token") {
        options.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录", request_id: "stale-1" } });
        return;
      }
      options.success({ statusCode: 200, data: { data: { items: [{ match_id: "m1" }] }, request_id: "matches-ok" } });
    });
    await expect(api.request({ method: "GET", path: "/v1/matches", query: { limit: 20, league_id: "premier_league" } })).resolves.toEqual({
      statusCode: 200,
      data: { items: [{ match_id: "m1" }] },
      code: undefined,
      message: undefined,
      details: undefined,
      request_id: "matches-ok",
    });
    expect(auth.clearAuth).toHaveBeenCalledTimes(1);
    expect(auth.ensureAuth).toHaveBeenCalledTimes(1);
    expect(wxRequest).toHaveBeenCalledTimes(2);
    expect(wxRequest.mock.calls[0][0]).toMatchObject({
      url: "http://127.0.0.1:8787/v1/matches?limit=20&league_id=premier_league",
      method: "GET",
      header: { Authorization: "Bearer stale-token" },
    });
    expect(wxRequest.mock.calls[1][0]).toMatchObject({
      url: "http://127.0.0.1:8787/v1/matches?limit=20&league_id=premier_league",
      method: "GET",
      header: { Authorization: "Bearer fresh-token" },
    });
    expect(wxRequest.mock.calls[1][0].data).toBeUndefined();
  });

  it("replays the original POST JSON body after a successful 401 recovery", async () => {
    const tokenRef = { value: "stale-token" };
    const { api, wxRequest, auth } = loadApi({ auth: authThatRefreshes(tokenRef) });
    api.setAccessTokenProvider(() => tokenRef.value);
    const data = { idempotency_key: "11111111-1111-4111-8111-111111111111", match_id: "m1", home_score: 1, away_score: 0 };
    wxRequest.mockImplementation((options) => {
      if (options.header && options.header.Authorization === "Bearer stale-token") {
        options.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录" } });
        return;
      }
      options.success({ statusCode: 201, data: { data: { prediction_id: "p1" }, request_id: "pred-ok" } });
    });
    await expect(api.request({ method: "POST", path: "/v1/predictions", data })).resolves.toMatchObject({
      statusCode: 201,
      data: { prediction_id: "p1" },
    });
    expect(auth.clearAuth).toHaveBeenCalledTimes(1);
    expect(auth.ensureAuth).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls).toHaveLength(2);
    for (const [options] of wxRequest.mock.calls) {
      expect(options).toMatchObject({
        url: "http://127.0.0.1:8787/v1/predictions",
        method: "POST",
        data,
        header: expect.objectContaining({ "content-type": "application/json" }),
      });
    }
    expect(wxRequest.mock.calls[1][0].header.Authorization).toBe("Bearer fresh-token");
  });

  it("does not loop when the replayed request is also 401 UNAUTHORIZED", async () => {
    const tokenRef = { value: "stale-token" };
    const { api, wxRequest, auth } = loadApi({ auth: authThatRefreshes(tokenRef) });
    api.setAccessTokenProvider(() => tokenRef.value);
    wxRequest.mockImplementation((options) => {
      options.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录", request_id: "still-401" } });
    });
    await expect(api.request({ method: "GET", path: "/v1/profile/me" })).resolves.toEqual({
      statusCode: 401,
      data: undefined,
      code: "UNAUTHORIZED",
      message: "需要重新登录",
      details: undefined,
      request_id: "still-401",
    });
    expect(auth.clearAuth).toHaveBeenCalledTimes(1);
    expect(auth.ensureAuth).toHaveBeenCalledTimes(1);
    expect(wxRequest).toHaveBeenCalledTimes(2);
  });

  it("does not recover /v1/auth/wechat 401 and does not recurse into login", async () => {
    const { api, wxRequest, auth } = loadApi();
    wxRequest.mockImplementation((options) => {
      options.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录" } });
    });
    await expect(api.request({ method: "POST", path: "/v1/auth/wechat", data: { code: "wx-code" } })).resolves.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
    });
    expect(auth.clearAuth).not.toHaveBeenCalled();
    expect(auth.ensureAuth).not.toHaveBeenCalled();
    expect(wxRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    [403, "FORBIDDEN"],
    [409, "USER_DELETED"],
    [422, "VALIDATION_ERROR"],
    [429, "RATE_LIMITED"],
    [500, "INTERNAL_ERROR"],
    [401, "TOKEN_EXPIRED"],
  ])("does not refresh on HTTP %s %s", async (statusCode, code) => {
    const { api, wxRequest, auth } = loadApi();
    api.setAccessTokenProvider(() => "opaque-token");
    wxRequest.mockImplementation((options) => {
      options.success({ statusCode, data: { code, message: "no-refresh", request_id: "err-1" } });
    });
    await expect(api.request({ method: "GET", path: "/v1/profile/me" })).resolves.toMatchObject({
      statusCode,
      code,
      message: "no-refresh",
    });
    expect(auth.clearAuth).not.toHaveBeenCalled();
    expect(auth.ensureAuth).not.toHaveBeenCalled();
    expect(wxRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps optional-auth guest 401 without calling ensureAuth", async () => {
    const { api, wxRequest, auth } = loadApi();
    wxRequest.mockImplementation((options) => {
      options.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录" } });
    });
    await expect(api.request({ method: "GET", path: "/v1/share-card/u1", auth: "optional" })).resolves.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
    });
    expect(auth.clearAuth).not.toHaveBeenCalled();
    expect(auth.ensureAuth).not.toHaveBeenCalled();
    expect(wxRequest).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls[0][0].header.Authorization).toBeUndefined();
  });

  it("recovers optional-auth 401 when the request actually sent a bearer token", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { api, wxRequest, auth, store } = loadApi({
      stored: { auth_session: { access_token: "stale-token", expires_at: future } },
      auth: ({ store: authStore }) => ({
        clearAuth: vi.fn(() => { authStore.delete("auth_session"); }),
        ensureAuth: vi.fn(() => {
          authStore.set("auth_session", { access_token: "fresh-token", expires_at: future });
          return Promise.resolve({ statusCode: 200, data: { access_token: "fresh-token" } });
        }),
      }),
    });
    wxRequest.mockImplementation((options) => {
      if (options.header && options.header.Authorization === "Bearer stale-token") {
        options.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录", request_id: "optional-stale" } });
        return;
      }
      options.success({ statusCode: 200, data: { data: { items: [] }, request_id: "optional-ok" } });
    });
    await expect(api.request({ method: "GET", path: "/v1/league-seasons", auth: "optional" })).resolves.toEqual({
      statusCode: 200,
      data: { items: [] },
      code: undefined,
      message: undefined,
      details: undefined,
      request_id: "optional-ok",
    });
    expect(auth.clearAuth).toHaveBeenCalledTimes(1);
    expect(auth.ensureAuth).toHaveBeenCalledTimes(1);
    expect(auth.recoverSession).toHaveBeenCalledTimes(1);
    expect(wxRequest).toHaveBeenCalledTimes(2);
    expect(wxRequest.mock.calls[0][0]).toMatchObject({
      url: "http://127.0.0.1:8787/v1/league-seasons",
      method: "GET",
      header: { Authorization: "Bearer stale-token" },
    });
    expect(wxRequest.mock.calls[1][0]).toMatchObject({
      url: "http://127.0.0.1:8787/v1/league-seasons",
      method: "GET",
      header: { Authorization: "Bearer fresh-token" },
    });
    expect(store.get("auth_session")).toEqual({ access_token: "fresh-token", expires_at: future });
  });

  it("shares a single recovery when two requests with the same stale token both get 401", async () => {
    const tokenRef = { value: "stale-token" };
    let finishLogin;
    const auth = {
      clearAuth: vi.fn(() => { tokenRef.value = undefined; }),
      ensureAuth: vi.fn(() => new Promise((resolve) => {
        finishLogin = () => {
          tokenRef.value = "fresh-token";
          resolve({ statusCode: 200, data: { access_token: "fresh-token" } });
        };
      })),
    };
    const { api, wxRequest } = loadApi({ auth });
    api.setAccessTokenProvider(() => tokenRef.value);
    const held = [];
    wxRequest.mockImplementation((options) => {
      if (options.header && options.header.Authorization === "Bearer stale-token") {
        held.push(options);
        return;
      }
      options.success({ statusCode: 200, data: { data: { ok: true }, request_id: "ok" } });
    });
    const matches = api.request({ method: "GET", path: "/v1/matches", query: { limit: 20, league_id: "premier_league" } });
    const profile = api.request({ method: "GET", path: "/v1/profile/me" });
    expect(held).toHaveLength(2);
    held.forEach((options) => {
      options.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录" } });
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(auth.clearAuth).toHaveBeenCalledTimes(1);
    expect(auth.ensureAuth).toHaveBeenCalledTimes(1);
    expect(auth.recoverSession).toHaveBeenCalledTimes(1);
    finishLogin();
    await expect(matches).resolves.toMatchObject({ statusCode: 200, data: { ok: true } });
    await expect(profile).resolves.toMatchObject({ statusCode: 200, data: { ok: true } });
    expect(wxRequest).toHaveBeenCalledTimes(4);
    expect(wxRequest.mock.calls[0][0]).toMatchObject({
      url: "http://127.0.0.1:8787/v1/matches?limit=20&league_id=premier_league",
      header: { Authorization: "Bearer stale-token" },
    });
    expect(wxRequest.mock.calls[1][0]).toMatchObject({
      url: "http://127.0.0.1:8787/v1/profile/me",
      header: { Authorization: "Bearer stale-token" },
    });
    expect(wxRequest.mock.calls[2][0]).toMatchObject({
      url: "http://127.0.0.1:8787/v1/matches?limit=20&league_id=premier_league",
      header: { Authorization: "Bearer fresh-token" },
    });
    expect(wxRequest.mock.calls[3][0]).toMatchObject({
      url: "http://127.0.0.1:8787/v1/profile/me",
      header: { Authorization: "Bearer fresh-token" },
    });
  });

  it("does not clear a fresh token when a stale 401 arrives after refresh", async () => {
    const tokenRef = { value: "stale-token" };
    const { api, wxRequest, auth } = loadApi({ auth: authThatRefreshes(tokenRef) });
    api.setAccessTokenProvider(() => tokenRef.value);
    let late401;
    wxRequest.mockImplementation((options) => {
      const url = String(options.url || "");
      if (url.endsWith("/v1/profile/me") && options.header && options.header.Authorization === "Bearer stale-token") {
        late401 = options;
        return;
      }
      if (options.header && options.header.Authorization === "Bearer stale-token") {
        options.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录" } });
        return;
      }
      options.success({ statusCode: 200, data: { data: { ok: true }, request_id: "ok" } });
    });
    const late = api.request({ method: "GET", path: "/v1/profile/me" });
    await Promise.resolve();
    await expect(api.request({ method: "GET", path: "/v1/matches", query: { limit: 20 } })).resolves.toMatchObject({
      statusCode: 200,
      data: { ok: true },
    });
    expect(auth.clearAuth).toHaveBeenCalledTimes(1);
    expect(auth.ensureAuth).toHaveBeenCalledTimes(1);
    expect(tokenRef.value).toBe("fresh-token");
    late401.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录" } });
    await expect(late).resolves.toMatchObject({ statusCode: 200, data: { ok: true } });
    expect(auth.clearAuth).toHaveBeenCalledTimes(1);
    expect(auth.ensureAuth).toHaveBeenCalledTimes(1);
    expect(auth.recoverSession).toHaveBeenCalledTimes(1);
    expect(tokenRef.value).toBe("fresh-token");
    expect(wxRequest.mock.calls.map((call) => [call[0].url, call[0].header && call[0].header.Authorization])).toEqual([
      ["http://127.0.0.1:8787/v1/profile/me", "Bearer stale-token"],
      ["http://127.0.0.1:8787/v1/matches?limit=20", "Bearer stale-token"],
      ["http://127.0.0.1:8787/v1/matches?limit=20", "Bearer fresh-token"],
      ["http://127.0.0.1:8787/v1/profile/me", "Bearer fresh-token"],
    ]);
  });

  it("does not let a later session share a still-pending unauthorized recovery", async () => {
    let generation = 0;
    const tokenRef = { value: "session-a-token" };
    let finishARecovery;
    const auth = {
      getLoginGeneration: () => generation,
      clearAuth: vi.fn(() => {
        tokenRef.value = undefined;
        generation += 1;
      }),
      ensureAuth: vi.fn(() => {
        tokenRef.value = "session-b-token";
        return Promise.resolve({ statusCode: 200, data: { access_token: "session-b-token" } });
      }),
      recoverSession: vi.fn((staleToken) => {
        if (staleToken === "session-a-token") {
          return new Promise((resolve) => {
            finishARecovery = () => resolve({ statusCode: 200, data: { access_token: "late-a-token" } });
          });
        }
        tokenRef.value = "session-b-fresh";
        return Promise.resolve({ statusCode: 200, data: { access_token: "session-b-fresh" } });
      }),
    };
    const { api, wxRequest } = loadApi({ auth });
    api.setAccessTokenProvider(() => tokenRef.value);
    wxRequest.mockImplementation((options) => {
      const token = options.header && options.header.Authorization;
      if (token === "Bearer session-a-token") {
        options.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录", request_id: "a-401" } });
        return;
      }
      if (token === "Bearer session-b-token") {
        options.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录", request_id: "b-401" } });
        return;
      }
      if (token === "Bearer session-b-fresh") {
        options.success({ statusCode: 200, data: { data: { ok: true }, request_id: "b-ok" } });
        return;
      }
      if (token === "Bearer late-a-token") {
        options.success({ statusCode: 200, data: { data: { leaked: true }, request_id: "a-leak" } });
        return;
      }
      throw new Error("unexpected token " + token);
    });
    const pendingA = api.request({ method: "GET", path: "/v1/matches" });
    await Promise.resolve();
    await Promise.resolve();
    expect(auth.recoverSession).toHaveBeenCalledTimes(1);
    expect(auth.recoverSession).toHaveBeenCalledWith("session-a-token");
    expect(typeof finishARecovery).toBe("function");
    auth.clearAuth();
    await auth.ensureAuth();
    const pendingB = api.request({ method: "GET", path: "/v1/profile/me" });
    await Promise.resolve();
    await Promise.resolve();
    expect(auth.recoverSession.mock.calls.map((call) => call[0])).toEqual(["session-a-token", "session-b-token"]);
    await expect(pendingB).resolves.toMatchObject({ statusCode: 200, data: { ok: true } });
    finishARecovery();
    await expect(pendingA).resolves.toEqual({
      statusCode: 401,
      data: undefined,
      code: "UNAUTHORIZED",
      message: "需要重新登录",
      details: undefined,
      request_id: "a-401",
    });
    expect(tokenRef.value).toBe("session-b-fresh");
    expect(wxRequest.mock.calls.map((call) => [call[0].url, call[0].header && call[0].header.Authorization])).toEqual([
      ["http://127.0.0.1:8787/v1/matches", "Bearer session-a-token"],
      ["http://127.0.0.1:8787/v1/profile/me", "Bearer session-b-token"],
      ["http://127.0.0.1:8787/v1/profile/me", "Bearer session-b-fresh"],
    ]);
  });

  it("returns the original 401 without replay when logout happens after recovery succeeds", async () => {
    let generation = 0;
    const tokenRef = { value: "stale-token" };
    let finishRecovery;
    const auth = {
      getLoginGeneration: () => generation,
      clearAuth: vi.fn(() => {
        tokenRef.value = undefined;
        generation += 1;
      }),
      recoverSession: vi.fn(() => new Promise((resolve) => {
        finishRecovery = () => {
          tokenRef.value = "fresh-token";
          resolve({ statusCode: 200, data: { access_token: "fresh-token" } });
        };
      })),
    };
    const { api, wxRequest } = loadApi({ auth });
    api.setAccessTokenProvider(() => tokenRef.value);
    wxRequest.mockImplementation((options) => {
      options.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录", request_id: "orig-401" } });
    });
    const pending = api.request({ method: "GET", path: "/v1/matches" });
    await Promise.resolve();
    await Promise.resolve();
    expect(typeof finishRecovery).toBe("function");
    finishRecovery();
    auth.clearAuth();
    await expect(pending).resolves.toEqual({
      statusCode: 401,
      data: undefined,
      code: "UNAUTHORIZED",
      message: "需要重新登录",
      details: undefined,
      request_id: "orig-401",
    });
    expect(auth.recoverSession).toHaveBeenCalledTimes(1);
    expect(wxRequest).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls[0][0]).toMatchObject({
      url: "http://127.0.0.1:8787/v1/matches",
      header: { Authorization: "Bearer stale-token" },
    });
  });

  it("does not replay a late 401 with a newer login session after logout", async () => {
    let generation = 0;
    const tokenRef = { value: "session-a-token" };
    const auth = {
      getLoginGeneration: () => generation,
      clearAuth: vi.fn(() => {
        tokenRef.value = undefined;
        generation += 1;
      }),
      ensureAuth: vi.fn(() => {
        tokenRef.value = "session-b-token";
        return Promise.resolve({ statusCode: 200, data: { access_token: "session-b-token" } });
      }),
    };
    const { api, wxRequest } = loadApi({ auth });
    api.setAccessTokenProvider(() => tokenRef.value);
    const data = { idempotency_key: "11111111-1111-4111-8111-111111111111", match_id: "m1", home_score: 1, away_score: 0 };
    let late401;
    wxRequest.mockImplementation((options) => {
      if (options.header && options.header.Authorization === "Bearer session-a-token") {
        late401 = options;
        return;
      }
      options.success({ statusCode: 201, data: { data: { prediction_id: "p-leaked" }, request_id: "pred-leaked" } });
    });
    const pending = api.request({ method: "POST", path: "/v1/predictions", data });
    await Promise.resolve();
    expect(late401).toMatchObject({
      url: "http://127.0.0.1:8787/v1/predictions",
      method: "POST",
      data,
      header: {
        "content-type": "application/json",
        Authorization: "Bearer session-a-token",
      },
    });
    auth.clearAuth();
    await auth.ensureAuth();
    expect(tokenRef.value).toBe("session-b-token");
    late401.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录", request_id: "late-a" } });
    await expect(pending).resolves.toEqual({
      statusCode: 401,
      data: undefined,
      code: "UNAUTHORIZED",
      message: "需要重新登录",
      details: undefined,
      request_id: "late-a",
    });
    expect(auth.recoverSession).not.toHaveBeenCalled();
    expect(auth.ensureAuth).toHaveBeenCalledTimes(1);
    expect(wxRequest).toHaveBeenCalledTimes(1);
  });

  it("returns the real auth error and does not replay when ensureAuth fails", async () => {
    const tokenRef = { value: "stale-token" };
    const auth = {
      clearAuth: vi.fn(() => { tokenRef.value = undefined; }),
      ensureAuth: vi.fn(() => Promise.resolve({
        statusCode: 401,
        code: "UNAUTHORIZED",
        message: "需要重新登录",
        data: undefined,
        request_id: undefined,
        details: undefined,
      })),
    };
    const { api, wxRequest } = loadApi({ auth });
    api.setAccessTokenProvider(() => tokenRef.value);
    wxRequest.mockImplementation((options) => {
      options.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录", request_id: "biz-401" } });
    });
    await expect(api.request({ method: "GET", path: "/v1/matches" })).resolves.toEqual({
      statusCode: 401,
      code: "UNAUTHORIZED",
      message: "需要重新登录",
      data: undefined,
      request_id: undefined,
      details: undefined,
    });
    expect(auth.clearAuth).toHaveBeenCalledTimes(1);
    expect(auth.ensureAuth).toHaveBeenCalledTimes(1);
    expect(wxRequest).toHaveBeenCalledTimes(1);
  });

  it("does not recover a 401 without Authorization after logout", async () => {
    const { api, wxRequest, auth } = loadApi();
    wxRequest.mockImplementation((options) => {
      options.success({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "需要重新登录" } });
    });
    await expect(api.request({ method: "GET", path: "/v1/matches" })).resolves.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
    });
    expect(auth.clearAuth).not.toHaveBeenCalled();
    expect(auth.ensureAuth).not.toHaveBeenCalled();
    expect(wxRequest).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls[0][0].header).toEqual({});
  });

  it("does not recover CloudBase 401 UNAUTHORIZED", async () => {
    const { api, callFunction, wxRequest, auth } = loadApi({ transport: "cloud" });
    api.setAccessTokenProvider(() => "opaque-token");
    callFunction.mockImplementation((options) => {
      options.success({ result: { status: 401, body: { code: "UNAUTHORIZED", message: "需要重新登录", request_id: "cloud-401" } } });
    });
    await expect(api.request({ method: "GET", path: "/v1/matches" })).resolves.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
    });
    expect(auth.clearAuth).not.toHaveBeenCalled();
    expect(auth.ensureAuth).not.toHaveBeenCalled();
    expect(wxRequest).not.toHaveBeenCalled();
    expect(callFunction).toHaveBeenCalledTimes(1);
  });
});
