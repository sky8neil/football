import { describe, expect, it } from "vitest";
import { loadProviderSources } from "./sources.js";

describe("loadProviderSources", () => {
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
});
