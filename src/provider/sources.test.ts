import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findSupportedLeagueById, findSupportedLeagueByProviderId, providerSeasonRef } from "../domain/config.js";
import { loadProviderSources } from "./sources.js";

describe("loadProviderSources", () => {
  it("保留来源的静态赛季配置", () => {
    const env = { FOOTBALL_PROVIDER_SOURCES: "fd,of", FOOTBALL_PROVIDER_KEY_FD: "fd-secret", FOOTBALL_PROVIDER_KEY_OF: "of-secret", FOOTBALL_SYNC_LEAGUES: "premier_league" };
    const original = loadProviderSources(env);
    expect(original.sources.find((source) => source.source_id === "of")?.leagues[0]?.season_ref).toBe("2026");
  });

  it("binds independent credentials and request configuration to each source", () => {
    const config = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "fd,bsd",
      FOOTBALL_PROVIDER_KEY_FD: "fd-secret",
      FOOTBALL_PROVIDER_KEY_BSD: "bsd-secret",
      FOOTBALL_SYNC_PROFILE: "test",
      FOOTBALL_SYNC_LEAGUES: "premier_league,chinese_super_league",
    });
    expect(config.sources).toMatchObject([
      { source_id: "fd", api_key: "fd-secret", auth: { header: "X-Auth-Token", scheme: "raw" }, base_url: "https://api.football-data.org/v4" },
      { source_id: "bsd", api_key: "bsd-secret", auth: { header: "Authorization", scheme: "token" }, base_url: "https://sports.bzzoiro.com/api/v2" },
    ]);
    expect([...config.sync_leagues]).toEqual(["premier_league", "chinese_super_league"]);
  });

  it("reports a missing key by source and environment-variable name only", () => {
    expect(() => loadProviderSources({ FOOTBALL_PROVIDER_SOURCES: "bsd" }))
      .toThrow("DIAG_PROVIDER_KEY_MISSING source_id=bsd variable=FOOTBALL_PROVIDER_KEY_BSD");
  });

  it("requires HTTPS provider base URLs", () => {
    expect(() => loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "fd",
      FOOTBALL_PROVIDER_KEY_FD: "fd-secret",
      FOOTBALL_PROVIDER_URL_FD: "http://api.football-data.org/v4",
    })).toThrow("provider base_url must use https");
  });

  it("exposes configured source league overrides through the shared league mapping", () => {
    const config = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "5d",
      FOOTBALL_PROVIDER_KEY_5D: "5d-secret",
      FOOTBALL_PROVIDER_LEAGUE_REF_5D: JSON.stringify({ premier_league: "999" }),
      FOOTBALL_SYNC_LEAGUES: "premier_league",
    });
    expect(config.sources[0]!.leagues).toContainEqual(
      expect.objectContaining({ league_id: "premier_league", source_league_ref: "999" }),
    );
    expect(findSupportedLeagueByProviderId("999", "5dollar", config.league_refs)).toMatchObject({
      league_id: "premier_league",
      season_id: "2026_2027",
    });
    expect(findSupportedLeagueByProviderId("999", "5dollar")).toBeUndefined();
  });

  it("keeps each configuration's resolved league mapping isolated", () => {
    const first = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "5d",
      FOOTBALL_PROVIDER_KEY_5D: "5d-secret",
      FOOTBALL_PROVIDER_LEAGUE_REF_5D: JSON.stringify({ premier_league: "999" }),
      FOOTBALL_SYNC_LEAGUES: "premier_league",
    });
    const second = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "5d",
      FOOTBALL_PROVIDER_KEY_5D: "5d-secret",
      FOOTBALL_PROVIDER_LEAGUE_REF_5D: JSON.stringify({ premier_league: "888" }),
      FOOTBALL_SYNC_LEAGUES: "premier_league",
    });
    expect(findSupportedLeagueByProviderId("999", "5dollar", first.league_refs)).toMatchObject({
      league_id: "premier_league",
    });
    expect(findSupportedLeagueByProviderId("888", "5dollar", second.league_refs)).toMatchObject({
      league_id: "premier_league",
    });
    expect(findSupportedLeagueByProviderId("888", "5dollar", first.league_refs)).toBeUndefined();
    expect(findSupportedLeagueByProviderId("999", "5dollar", second.league_refs)).toBeUndefined();
  });

  it("does not change an earlier configuration when a later load fails", () => {
    const first = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "5d",
      FOOTBALL_PROVIDER_KEY_5D: "5d-secret",
      FOOTBALL_PROVIDER_LEAGUE_REF_5D: JSON.stringify({ premier_league: "999" }),
      FOOTBALL_SYNC_LEAGUES: "premier_league",
    });
    expect(() => loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "5d",
      FOOTBALL_PROVIDER_KEY_5D: "5d-secret",
      FOOTBALL_PROVIDER_LEAGUE_REF_5D: JSON.stringify({ premier_league: "999", la_liga: "999" }),
      FOOTBALL_SYNC_LEAGUES: "premier_league,la_liga",
    })).toThrow("DIAG_PROVIDER_LEAGUE_REF_CONFLICT");
    expect(findSupportedLeagueByProviderId("999", "5dollar", first.league_refs)).toMatchObject({
      league_id: "premier_league",
    });
  });

  it("registers OpenFoot season query values separately from internal season ids", () => {
    expect(providerSeasonRef(findSupportedLeagueById("premier_league")!, "of")).toBe("2026/27");
    expect(providerSeasonRef(findSupportedLeagueById("chinese_super_league")!, "of")).toBe("2026");
    expect(findSupportedLeagueById("premier_league")!.season_id).toBe("2026_2027");
    expect(findSupportedLeagueById("chinese_super_league")!.season_id).toBe("2026");
  });

  it("assigns OpenFoot as secondary result verification for the five European leagues", () => {
    const config = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "fd,bsd,of",
      FOOTBALL_PROVIDER_KEY_FD: "fd-secret",
      FOOTBALL_PROVIDER_KEY_BSD: "bsd-secret",
      FOOTBALL_PROVIDER_KEY_OF: "of-secret",
      FOOTBALL_SYNC_LEAGUES: "premier_league,la_liga,serie_a,bundesliga,ligue_1,chinese_super_league",
    });
    const ofSource = config.sources.find((source) => source.source_id === "of");
    expect(ofSource).toBeDefined();
    for (const leagueId of ["premier_league", "la_liga", "serie_a", "bundesliga", "ligue_1"] as const) {
      expect(ofSource!.leagues.find((entry) => entry.league_id === leagueId)?.roles.result).toBe("secondary");
    }
    expect(ofSource!.leagues.find((entry) => entry.league_id === "chinese_super_league")?.roles).toMatchObject({
      result: "secondary",
      reconcile: "historical",
    });
  });

  it("ops/vps env templates enable fd,5d,of,bsd,sp and declare all matching keys (D-S3-01)", () => {
    for (const relPath of ["ops/vps/football.env.example", "ops/vps/cloudbase.env.example"]) {
      const content = readFileSync(resolve(process.cwd(), relPath), "utf8");
      const env: Record<string, string> = {};
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        env[line.slice(0, eq)] = line.slice(eq + 1);
      }
      expect(env.FOOTBALL_PROVIDER_SOURCES).toBe("fd,5d,of,bsd,sp");
      const loaded = loadProviderSources(env);
      expect(loaded.sources.map((s) => s.source_id)).toEqual(["fd", "5d", "of", "bsd", "sp"]);
    }
  });
});
