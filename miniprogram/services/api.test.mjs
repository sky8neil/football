import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const cloudDiagnostics = await import("./cloud-diagnostics.js");

function loadApi({ gatewayOrigin = "http://127.0.0.1:8787", URL, transport = "http", envVersion = "develop", cloudEnvId = "cloud-test", cloudFunctionName = "api" } = {}) {
  const wxRequest = vi.fn();
  const callFunction = vi.fn();
  const warn = vi.fn();
  const context = {
    module: { exports: {} },
    require(id) {
      if (id === "../config.js") return { gatewayOrigin, transport, cloudEnvId, cloudFunctionName };
      if (id === "./cloud-diagnostics.js") return cloudDiagnostics;
      throw new Error(`Unexpected require: ${id}`);
    },
    wx: { request: wxRequest, cloud: { callFunction }, getAccountInfoSync: () => ({ miniProgram: { envVersion } }) },
    console: { warn },
    URL,
    URLSearchParams: undefined,
  };
  runInNewContext(readFileSync(join(HERE, "api.js"), "utf8"), context, { filename: "api.js" });
  return { api: context.module.exports, wxRequest, callFunction, warn };
}

describe("mini program request URL compatibility", () => {
  it.each([undefined, {}])("initializes a session when URL is unavailable or not a constructor (%s)", async (URL) => {
    const { api, wxRequest } = loadApi({ URL });
    const context = {
      module: { exports: {} },
      require(id) {
        if (id === "./api.js") return api;
        throw new Error(`Unexpected require: ${id}`);
      },
    };
    runInNewContext(readFileSync(join(HERE, "session.js"), "utf8"), context, { filename: "session.js" });
    const pending = context.module.exports.initSession("球友");
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
    await expect(pending).resolves.toEqual({ statusCode: 0, data: undefined, code: undefined, message: undefined, details: undefined, request_id: undefined });
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
    await expect(pending).resolves.toMatchObject({ statusCode: 0 });
    expect(warn).toHaveBeenCalledWith("[diag]", expect.objectContaining({ diag_code: "DIAG_CLIENT_FUNCTION_NOT_FOUND" }));
  });

  it("does not print technical diagnostics in release", async () => {
    const { api, callFunction, warn } = loadApi({ transport: "cloud", envVersion: "release" });
    const pending = api.request({ method: "GET", path: "/v1/matches" });
    callFunction.mock.calls[0][0].fail({ errCode: -1, errMsg: "cloud function not found" });
    await expect(pending).resolves.toMatchObject({ statusCode: 0 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects HTTP in trial and release and blocks client supplied identity keys", () => {
    const releaseHttp = loadApi({ envVersion: "release" });
    expect(() => releaseHttp.api.request({ method: "GET", path: "/v1/matches" })).toThrow("must use cloud transport");
    const { api, callFunction } = loadApi({ transport: "cloud" });
    expect(() => api.request({ method: "POST", path: "/v1/session/init", data: { nickname: "Sky", nested: { openid: "fake" } } })).toThrow("identity field is forbidden");
    expect(callFunction).not.toHaveBeenCalled();
  });

  it("requires cloud environment and function configuration", () => {
    expect(() => loadApi({ transport: "cloud", cloudEnvId: "" }).api.request({ method: "GET", path: "/v1/matches" })).toThrow("cloudEnvId is required");
    expect(() => loadApi({ transport: "cloud", cloudFunctionName: "" }).api.request({ method: "GET", path: "/v1/matches" })).toThrow("cloudFunctionName is required");
  });
});
