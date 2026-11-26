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

function loadTeamsStack() {
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
  const teams = loadCommonJs(join(HERE, "teams.js"), (id) => {
    if (id === "./api.js") return api;
    throw new Error(`Unexpected require: ${id}`);
  });
  return { api, teams, wxRequest };
}

describe("listTeams", () => {
  it("requests /v1/teams with auth optional and no query when called with no args", () => {
    const request = vi.fn();
    loadService("teams.js", request).listTeams();
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/teams",
      auth: "optional",
    });
  });

  it("includes league_id when leagueId is set", () => {
    const request = vi.fn();
    loadService("teams.js", request).listTeams({ leagueId: "premier_league" });
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/teams",
      query: { league_id: "premier_league" },
      auth: "optional",
    });
  });

  it("does not block on authPreparer 401 when fetching public teams", async () => {
    const { api, teams, wxRequest } = loadTeamsStack();
    api.setAuthPreparer(() => Promise.resolve({ statusCode: 401, code: "UNAUTHORIZED", message: "需要重新登录" }));
    wxRequest.mockImplementation((options) => {
      options.success({
        statusCode: 200,
        data: {
          data: {
            items: [
              { team_id: "t-promoted", league_id: "premier_league", name: "Promoted FC", name_zh: "升班马联", logo_url: null },
            ],
          },
          request_id: "teams-public",
        },
      });
    });
    await expect(teams.listTeams()).resolves.toMatchObject({
      statusCode: 200,
      data: { items: [{ team_id: "t-promoted", name_zh: "升班马联" }] },
    });
    expect(wxRequest).toHaveBeenCalledTimes(1);
    expect(wxRequest.mock.calls[0][0].url).toBe("https://api.example.com/v1/teams");
  });

  it("[CR43-06] caches active teams in memory, deduplicates in-flight requests, and skips caching failures", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ statusCode: 500, code: "INTERNAL" })
      .mockResolvedValueOnce({
        statusCode: 200,
        data: {
          items: [
            {
              team_id: "promoted-1",
              league_id: "premier_league",
              name: "Promoted FC",
              name_zh: "升班马联",
              logo_url: "https://cdn.example.com/promoted-1.png",
              status: "active",
            },
            {
              team_id: "inactive-1",
              league_id: "premier_league",
              name: "Old FC",
              name_zh: "停用队",
              logo_url: null,
              status: "inactive",
            },
          ],
        },
      });
    const service = loadService("teams.js", request);

    await expect(service.resolveTeamById("promoted-1")).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);

    // Concurrently resolving two teams deduplicates into a single /v1/teams call
    const [hit, inactive] = await Promise.all([
      service.resolveTeamById("promoted-1"),
      service.resolveTeamById("inactive-1"),
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(hit).toMatchObject({ team_id: "promoted-1", name_zh: "升班马联" });
    expect(inactive).toBeNull();

    // Subsequent lookup hits memory cache without another request
    await expect(service.resolveTeamById("promoted-1")).resolves.toMatchObject({ team_id: "promoted-1" });
    expect(request).toHaveBeenCalledTimes(2);

    service.clearTeamsCache();
    await service.fetchActiveTeamsCached();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("[CR44-02] uses persistent wx storage for sync first paint while refreshing out-of-bundle team after memory cache clears", async () => {
    const promotedId = "00000000-0000-4000-8000-000000000501";
    const store = new Map();
    Object.defineProperty(globalThis, "wx", {
      configurable: true,
      writable: true,
      value: {
        getStorageSync: (key) => store.get(key),
        setStorageSync: (key, value) => store.set(key, value),
        removeStorageSync: (key) => store.delete(key),
      },
    });
    const presentTeam = (team) => ({
      nameZh: (team && (team.name_zh || team.name)) || "球队资料待补全",
      logo: (team && team.logo_url) || "placeholder.png",
    });
    const request = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 200,
        data: {
          items: [
            {
              team_id: promotedId,
              league_id: "premier_league",
              name: "Promoted FC",
              name_zh: null,
              logo_url: "https://cdn.example.com/logo-v1.png",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        data: {
          items: [
            {
              team_id: promotedId,
              league_id: "premier_league",
              name: "Promoted FC",
              name_zh: "升班马竞技",
              logo_url: "https://cdn.example.com/logo-v2.png",
            },
          ],
        },
      });
    const service = loadService("teams.js", request);

    // 1. First lookup caches English name + v1 logo in wx storage and in-memory cache
    const first = await service.resolveFavoriteTeamRemote(promotedId, {
      presentTeam,
      placeholder: "placeholder.png",
    });
    expect(first).toEqual({
      favoriteTeamId: promotedId,
      favoriteTeamText: "Promoted FC",
      favoriteTeamLogo: "https://cdn.example.com/logo-v1.png",
    });
    expect(store.get(`team_name:${promotedId}`)).toBe("Promoted FC");
    expect(store.get(`team_logo:${promotedId}`)).toBe("https://cdn.example.com/logo-v1.png");

    // Within memory TTL, sync resolution uses fresh memory cache without requesting remote
    const withinTtl = service.resolveFavoriteTeamSync(promotedId, {
      findTeam: () => null,
      presentTeam,
      placeholder: "placeholder.png",
    });
    expect(withinTtl.needsRemoteLookup).toBe(false);
    expect(withinTtl.favoriteTeamText).toBe("Promoted FC");

    // 2. Simulate process restart / TTL expiry (clear in-memory cache while preserving wx storage)
    service.clearTeamsCache();
    const afterRestartSync = service.resolveFavoriteTeamSync(promotedId, {
      findTeam: () => null,
      presentTeam,
      placeholder: "placeholder.png",
    });
    expect(afterRestartSync.favoriteTeamText).toBe("Promoted FC");
    expect(afterRestartSync.favoriteTeamLogo).toBe("https://cdn.example.com/logo-v1.png");
    expect(afterRestartSync.needsRemoteLookup).toBe(true);

    // 3. Remote refresh fetches updated name_zh + v2 logo and updates wx storage
    const refreshed = await service.resolveFavoriteTeamRemote(promotedId, {
      presentTeam,
      placeholder: "placeholder.png",
    });
    expect(refreshed).toEqual({
      favoriteTeamId: promotedId,
      favoriteTeamText: "升班马竞技",
      favoriteTeamLogo: "https://cdn.example.com/logo-v2.png",
    });
    expect(store.get(`team_name:${promotedId}`)).toBe("升班马竞技");
    expect(store.get(`team_logo:${promotedId}`)).toBe("https://cdn.example.com/logo-v2.png");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("[CR44-03] resolveFavoriteTeamRemote falls back to GET /v1/teams/:team_id for inactive out-of-bundle teams", async () => {
    const inactiveId = "00000000-0000-4000-8000-000000000502";
    const store = new Map();
    Object.defineProperty(globalThis, "wx", {
      configurable: true,
      writable: true,
      value: {
        getStorageSync: (key) => store.get(key),
        setStorageSync: (key, value) => store.set(key, value),
        removeStorageSync: (key) => store.delete(key),
      },
    });
    const presentTeam = (team) => ({
      nameZh: (team && (team.name_zh || team.name)) || "球队资料待补全",
      logo: (team && team.logo_url) || "placeholder.png",
    });
    const request = vi.fn(async (options) => {
      if (options.path === "/v1/teams") {
        return { statusCode: 200, data: { items: [] } };
      }
      if (options.path === `/v1/teams/${inactiveId}`) {
        return {
          statusCode: 200,
          data: {
            team_id: inactiveId,
            league_id: "premier_league",
            name: "Relegated FC",
            name_zh: "降级老队",
            logo_url: "https://cdn.example.com/relegated.png",
          },
        };
      }
      return { statusCode: 404, code: "NOT_FOUND" };
    });
    const service = loadService("teams.js", request);

    const resolved = await service.resolveFavoriteTeamRemote(inactiveId, {
      presentTeam,
      placeholder: "placeholder.png",
    });
    expect(resolved).toEqual({
      favoriteTeamId: inactiveId,
      favoriteTeamText: "降级老队",
      favoriteTeamLogo: "https://cdn.example.com/relegated.png",
    });
    expect(request).toHaveBeenCalledWith({ method: "GET", path: "/v1/teams", auth: "optional" });
    expect(request).toHaveBeenCalledWith({ method: "GET", path: `/v1/teams/${inactiveId}`, auth: "optional" });
    expect(store.get(`team_name:${inactiveId}`)).toBe("降级老队");
    expect(store.get(`team_logo:${inactiveId}`)).toBe("https://cdn.example.com/relegated.png");

    // In-memory cache avoids repeated /v1/teams/:id calls within TTL
    const syncHit = service.resolveFavoriteTeamSync(inactiveId, {
      findTeam: () => null,
      presentTeam,
      placeholder: "placeholder.png",
    });
    expect(syncHit.needsRemoteLookup).toBe(false);
    expect(syncHit.favoriteTeamText).toBe("降级老队");
    expect(request).toHaveBeenCalledTimes(2);
  });
});
