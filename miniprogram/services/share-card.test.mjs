import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const cloudDiagnostics = await import("./cloud-diagnostics.js");
const AUTH_SESSION_STORAGE_KEY = "auth_session";
const PAST = "2020-01-01T00:00:00.000Z";

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

function loadShareCardStack({ stored = {} } = {}) {
  const store = new Map(Object.entries(stored));
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
  const shareCard = loadCommonJs(join(HERE, "share-card.js"), (id) => {
    if (id === "./api.js") return api;
    throw new Error(`Unexpected require: ${id}`);
  });
  return { api, shareCard, wxRequest, store };
}

const VALID = {
  leagueId: "premier_league",
  seasonId: "2025_2026",
  roundId: "12",
};
const USER_ID = "11111111-2222-3333-4444-555555555555";

describe("getMyShareCard", () => {
  it("requests /v1/share-card/me with snake_case league_id, season_id, round_id", () => {
    const request = vi.fn();
    loadService("share-card.js", request).getMyShareCard(VALID);
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/share-card/me",
      query: {
        league_id: "premier_league",
        season_id: "2025_2026",
        round_id: "12",
      },
    });
  });

  it("returns 422 and does not call request when leagueId is missing", async () => {
    const request = vi.fn();
    const result = await loadService("share-card.js", request).getMyShareCard({
      seasonId: VALID.seasonId,
      roundId: VALID.roundId,
    });
    expect(result).toMatchObject({ statusCode: 422, code: "VALIDATION_ERROR" });
    expect(result.message).toMatch(/leagueId/);
    expect(request).not.toHaveBeenCalled();
  });

  it("returns 422 and does not call request when seasonId is missing", async () => {
    const request = vi.fn();
    const result = await loadService("share-card.js", request).getMyShareCard({
      leagueId: VALID.leagueId,
      roundId: VALID.roundId,
    });
    expect(result).toMatchObject({ statusCode: 422, code: "VALIDATION_ERROR" });
    expect(result.message).toMatch(/seasonId/);
    expect(request).not.toHaveBeenCalled();
  });

  it("returns 422 and does not call request when roundId is not a two-digit string", async () => {
    const request = vi.fn();
    const service = loadService("share-card.js", request);
    const results = await Promise.all([
      service.getMyShareCard({ ...VALID, roundId: "1" }),
      service.getMyShareCard({ ...VALID, roundId: "123" }),
      service.getMyShareCard({ ...VALID, roundId: "ab" }),
      service.getMyShareCard({ ...VALID, roundId: "" }),
    ]);
    for (const result of results) {
      expect(result).toMatchObject({ statusCode: 422, code: "VALIDATION_ERROR" });
      expect(result.message).toMatch(/roundId/);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("normalizes numeric roundId 12 to \"12\" and still sends the request", () => {
    const request = vi.fn();
    loadService("share-card.js", request).getMyShareCard({ ...VALID, roundId: 12 });
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/share-card/me",
      query: {
        league_id: "premier_league",
        season_id: "2025_2026",
        round_id: "12",
      },
    });
  });
});

describe("getShareCardForUser", () => {
  it("requests /v1/share-card/<uuid> with snake_case query and without user_id", () => {
    const request = vi.fn();
    loadService("share-card.js", request).getShareCardForUser(USER_ID, VALID);
    expect(request).toHaveBeenCalledTimes(1);
    const [call] = request.mock.calls[0];
    expect(call.method).toBe("GET");
    expect(call.path).toBe("/v1/share-card/" + USER_ID);
    expect(call.path).toContain(USER_ID);
    expect(call.query).toEqual({
      league_id: "premier_league",
      season_id: "2025_2026",
      round_id: "12",
    });
    expect(call.query).not.toHaveProperty("user_id");
    expect(call.auth).toBe("optional");
  });

  it("returns 422 and does not call request when userId is missing", async () => {
    const request = vi.fn();
    const service = loadService("share-card.js", request);
    const results = await Promise.all([
      service.getShareCardForUser("", VALID),
      service.getShareCardForUser(undefined, VALID),
      service.getShareCardForUser(null, VALID),
    ]);
    for (const result of results) {
      expect(result).toMatchObject({ statusCode: 422, code: "VALIDATION_ERROR" });
      expect(result.message).toMatch(/userId/);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("returns 422 and does not call request when leagueId, seasonId, or roundId is invalid", async () => {
    const request = vi.fn();
    const service = loadService("share-card.js", request);
    const results = await Promise.all([
      service.getShareCardForUser(USER_ID, { seasonId: VALID.seasonId, roundId: VALID.roundId }),
      service.getShareCardForUser(USER_ID, { leagueId: VALID.leagueId, roundId: VALID.roundId }),
      service.getShareCardForUser(USER_ID, { ...VALID, roundId: "1" }),
    ]);
    expect(results[0]).toMatchObject({ statusCode: 422, code: "VALIDATION_ERROR" });
    expect(results[0].message).toMatch(/leagueId/);
    expect(results[1]).toMatchObject({ statusCode: 422, code: "VALIDATION_ERROR" });
    expect(results[1].message).toMatch(/seasonId/);
    expect(results[2]).toMatchObject({ statusCode: 422, code: "VALIDATION_ERROR" });
    expect(results[2].message).toMatch(/roundId/);
    expect(request).not.toHaveBeenCalled();
  });

  it("normalizes numeric roundId 12 to \"12\" and still sends the request", () => {
    const request = vi.fn();
    loadService("share-card.js", request).getShareCardForUser(USER_ID, { ...VALID, roundId: 12 });
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/share-card/" + USER_ID,
      query: {
        league_id: "premier_league",
        season_id: "2025_2026",
        round_id: "12",
      },
      auth: "optional",
    });
  });
});

describe("public share-card HTTP auth", () => {
  it("sends getShareCardForUser even when authPreparer returns 401", async () => {
    const { api, shareCard, wxRequest } = loadShareCardStack();
    api.setAuthPreparer(() => Promise.resolve({ statusCode: 401, code: "UNAUTHORIZED", message: "需要重新登录" }));
    wxRequest.mockImplementation((options) => {
      options.success({
        statusCode: 200,
        data: { data: { user_id: USER_ID }, request_id: "share-public-401" },
      });
    });
    const result = await shareCard.getShareCardForUser(USER_ID, VALID);
    expect(wxRequest).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls[0][0].url).toContain("/v1/share-card/" + USER_ID);
    expect(result.statusCode).toBe(200);
    expect(result.statusCode).not.toBe(401);
  });

  it("sends getShareCardForUser with no cached session", async () => {
    const { shareCard, wxRequest, store } = loadShareCardStack();
    expect(store.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);
    wxRequest.mockImplementation((options) => {
      options.success({
        statusCode: 200,
        data: { data: { user_id: USER_ID }, request_id: "share-public-anon" },
      });
    });
    await expect(shareCard.getShareCardForUser(USER_ID, VALID)).resolves.toMatchObject({
      statusCode: 200,
      data: { user_id: USER_ID },
    });
    expect(wxRequest).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls[0][0].header.Authorization).toBeUndefined();
  });

  it("keeps getMyShareCard blocked when authPreparer returns 401", async () => {
    const { api, shareCard, wxRequest } = loadShareCardStack();
    api.setAuthPreparer(() => Promise.resolve({ statusCode: 401, code: "UNAUTHORIZED", message: "需要重新登录" }));
    await expect(shareCard.getMyShareCard(VALID)).resolves.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
    });
    expect(wxRequest).not.toHaveBeenCalled();
  });

  it("does not send an expired token on getShareCardForUser", async () => {
    const { api, shareCard, wxRequest } = loadShareCardStack({
      stored: { [AUTH_SESSION_STORAGE_KEY]: { access_token: "expired-token", expires_at: PAST } },
    });
    api.setAccessTokenProvider(() => "expired-token");
    api.setAuthPreparer(() => Promise.resolve({ statusCode: 401, code: "UNAUTHORIZED" }));
    wxRequest.mockImplementation((options) => {
      options.success({ statusCode: 200, data: { data: { user_id: USER_ID }, request_id: "share-expired" } });
    });
    await expect(shareCard.getShareCardForUser(USER_ID, VALID)).resolves.toMatchObject({ statusCode: 200 });
    expect(wxRequest).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls[0][0].header.Authorization).toBeUndefined();
  });
});
