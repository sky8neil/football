import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function loadService(name, request) {
  const file = new URL(name, import.meta.url);
  const module = { exports: {} };
  runInThisContext(`(function(module, exports, require) {\n${readFileSync(file, "utf8")}\n})`)(module, module.exports, (id) => {
    if (id === "./api.js") return { request };
    throw new Error(`Unexpected require: ${id}`);
  });
  return module.exports;
}

describe("listMyPredictions", () => {
  it("omits league_id and season_id when called with empty options", () => {
    const request = vi.fn();
    loadService("predictions.js", request).listMyPredictions({});
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/predictions/me",
      query: {},
    });
  });

  it("includes only league_id when leagueId is set", () => {
    const request = vi.fn();
    loadService("predictions.js", request).listMyPredictions({ leagueId: "premier_league" });
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/predictions/me",
      query: { league_id: "premier_league" },
    });
  });

  it("forwards leagueId, seasonId, limit, and cursor together", () => {
    const request = vi.fn();
    loadService("predictions.js", request).listMyPredictions({
      leagueId: "premier_league",
      seasonId: "2025_2026",
      limit: 20,
      cursor: "abc",
    });
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/predictions/me",
      query: {
        league_id: "premier_league",
        season_id: "2025_2026",
        limit: 20,
        cursor: "abc",
      },
    });
  });

  it("does not treat empty string or null leagueId/seasonId as query values", () => {
    const request = vi.fn();
    const service = loadService("predictions.js", request);
    service.listMyPredictions({ leagueId: "", seasonId: null });
    service.listMyPredictions({ leagueId: null, seasonId: "" });
    expect(request.mock.calls.map(([call]) => call)).toEqual([
      { method: "GET", path: "/v1/predictions/me", query: {} },
      { method: "GET", path: "/v1/predictions/me", query: {} },
    ]);
  });
});
