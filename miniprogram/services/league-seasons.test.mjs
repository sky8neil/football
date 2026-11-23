import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const cloudDiagnostics = await import("./cloud-diagnostics.js");

const originals = {
  wx: Object.getOwnPropertyDescriptor(globalThis, "wx"),
};

afterEach(() => {
  if (originals.wx) Object.defineProperty(globalThis, "wx", originals.wx);
  else delete globalThis.wx;
});

function loadService(name, request) {
  const file = new URL(name, import.meta.url);
  const module = { exports: {} };
  runInThisContext(`(function(module, exports, require) {\n${readFileSync(file, "utf8")}\n})`)(module, module.exports, (id) => {
    if (id === "./api.js") return { request };
    throw new Error(`Unexpected require: ${id}`);
  });
  return module.exports;
}

function loadCommonJs(filePath, requireShim) {
  const module = { exports: {} };
  const factory = runInThisContext("(function(module, exports, require) {\n" + readFileSync(filePath, "utf8") + "\n})", {
    filename: filePath,
  });
  factory(module, module.exports, requireShim);
  return module.exports;
}

function loadLeagueSeasonsStack() {
  const store = new Map();
  const wxRequest = vi.fn();
  Object.defineProperty(globalThis, "wx", {
    configurable: true,
    writable: true,
    value: {
      request: wxRequest,
      getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
      getStorageSync: (key) => store.get(key),
      setStorageSync: (key, value) => store.set(key, value),
      removeStorageSync: (key) => store.delete(key),
    },
  });
  const config = { transport: "http", gatewayOrigin: "https://api.example.com", cloudEnvId: "cloud-test", cloudFunctionName: "api" };
  const authStorage = loadCommonJs(join(ROOT, "utils", "auth-storage.js"), () => {
    throw new Error("auth-storage.js 不应 require 其它模块");
  });
  const api = loadCommonJs(join(HERE, "api.js"), (id) => {
    if (id === "../config.js") return config;
    if (id === "./cloud-diagnostics.js") return cloudDiagnostics;
    if (id === "../utils/auth-storage.js") return authStorage;
    if (id === "./auth.js") {
      return {
        clearAuth() {},
        ensureAuth() { return Promise.resolve({ statusCode: 200 }); },
        recoverSession() { return Promise.resolve({ statusCode: 200 }); },
      };
    }
    throw new Error(`Unexpected require: ${id}`);
  });
  const leagueSeasons = loadCommonJs(join(HERE, "league-seasons.js"), (id) => {
    if (id === "./api.js") return api;
    throw new Error(`Unexpected require: ${id}`);
  });
  return { api, leagueSeasons, wxRequest };
}

describe("listLeagueSeasons", () => {
  it("requests /v1/league-seasons without query when called with no args", () => {
    const request = vi.fn();
    loadService("league-seasons.js", request).listLeagueSeasons();
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/league-seasons",
      auth: "optional",
    });
  });

  it("includes league_id when leagueId is set", () => {
    const request = vi.fn();
    loadService("league-seasons.js", request).listLeagueSeasons({ leagueId: "premier_league" });
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/league-seasons",
      query: { league_id: "premier_league" },
      auth: "optional",
    });
  });

  it("returns season catalog data when authPreparer returns 401", async () => {
    const { api, leagueSeasons, wxRequest } = loadLeagueSeasonsStack();
    api.setAuthPreparer(() => Promise.resolve({ statusCode: 401, code: "UNAUTHORIZED", message: "需要重新登录" }));
    wxRequest.mockImplementation((options) => {
      options.success({
        statusCode: 200,
        data: { data: { items: [{ season_id: "2025_2026" }] }, request_id: "seasons-public" },
      });
    });
    await expect(leagueSeasons.listLeagueSeasons()).resolves.toMatchObject({
      statusCode: 200,
      data: { items: [{ season_id: "2025_2026" }] },
    });
    expect(wxRequest).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls[0][0].url).toBe("https://api.example.com/v1/league-seasons");
  });
});
