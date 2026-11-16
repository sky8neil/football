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

describe("league status and summary services", () => {
  it("gets league status without a query", () => {
    const request = vi.fn();
    loadService("leagues.js", request).getLeagueStatus();
    expect(request).toHaveBeenCalledWith({ method: "GET", path: "/v1/leagues/status" });
  });

  it("includes only nonempty league and season parameters", () => {
    const request = vi.fn();
    const service = loadService("predictions.js", request);
    service.getMyLeagueSummary({ leagueId: "la_liga" });
    service.getMyLeagueSummary({ leagueId: "la_liga", seasonId: "2025" });
    service.getMyLeagueSummary({ leagueId: "", seasonId: null });
    expect(request.mock.calls.map(([call]) => call)).toEqual([
      { method: "GET", path: "/v1/predictions/summary", query: { league_id: "la_liga" } },
      { method: "GET", path: "/v1/predictions/summary", query: { league_id: "la_liga", season_id: "2025" } },
      { method: "GET", path: "/v1/predictions/summary", query: {} },
    ]);
  });
});
