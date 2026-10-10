import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const LEAGUE_IDS = ["bundesliga", "serie_a"];

function loadLogoRegistry() {
  const moduleShim = { exports: {} };
  const source = readFileSync(join(HERE, "logo-registry.js"), "utf8");
  runInNewContext(source, { module: moduleShim, exports: moduleShim.exports });
  return moduleShim.exports;
}

describe("mini program league logos", () => {
  it("resolves the Bundesliga and Serie A logos from packaged assets", () => {
    const registry = loadLogoRegistry();
    const logoPaths = {
      bundesliga: "../../assets/logos/leagues/bundesliga.png",
      serie_a: "../../assets/logos/leagues/serie_a.png",
    };

    for (const [leagueId, logoPath] of Object.entries(logoPaths)) {
      expect(registry.getLeagueLogo(leagueId)).toBe(logoPath);
      expect(existsSync(join(ROOT, "assets", "logos", "leagues", `${leagueId}.png`))).toBe(true);
      expect(registry.getTeamLogo(leagueId, "unknown-team")).toBe(registry.PLACEHOLDER);
    }
  });

  it("keeps the design and mini program manifests in sync for the new leagues", () => {
    const paths = [
      join(ROOT, "assets", "logos", "manifest.json"),
      join(ROOT, "..", "docs", "design", "assets", "logos", "manifest.json"),
    ];
    const manifests = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));

    for (const manifest of manifests) {
      for (const leagueId of LEAGUE_IDS) {
        expect(manifest.league_logos[leagueId]).toBe(`assets/logos/leagues/${leagueId}.png`);
        expect(manifest.team_logos[leagueId]).toEqual({});
      }
    }
  });
});


describe("team display-name lookup", () => {
  it("normalizes accents, case, spaces and repeated punctuation", () => {
    const r = loadLogoRegistry();
    expect(r.normalizeTeamName("  Atlético -- Madrid! ")).toBe("atletico-madrid");
    expect(r.getTeamLogo("la_liga", "Atlético Madrid")).toBe(r.MANIFEST.la_liga.teams["atletico-madrid"]);
  });
  it("uses API names even when team_id is a UUID", () => {
    const r = loadLogoRegistry();
    expect(r.getTeamLogo("premier_league", { team_id: "uuid", name: "Arsenal" })).toBe(r.MANIFEST.premier_league.teams.arsenal);
  });
  it("resolves common aliases and preserves missing-asset fallback", () => {
    const r = loadLogoRegistry();
    for (const [name, slug] of [["Manchester United", "manchester-united"], ["Man United", "manchester-united"], ["Tottenham Hotspur", "tottenham"], ["Tottenham", "tottenham"], ["Brighton & Hove Albion", "brighton"]]) {
      expect(r.getTeamLogo("premier_league", name)).toBe(r.MANIFEST.premier_league.teams[slug]);
    }
    expect(r.TEAM_ALIASES.premier_league["wolverhampton-wanderers"]).toBe("wolves");
    expect(r.getTeamLogo("premier_league", "Wolverhampton Wanderers")).toBe(r.getTeamLogo("premier_league", "Wolves"));
    expect(r.getTeamLogo("premier_league", "Unknown Club")).toBe(r.PLACEHOLDER);
    expect(r.getTeamLogo("unknown", "Arsenal")).toBe(r.PLACEHOLDER);
  });
  it.each([
    ["premier_league", "Arsenal", "arsenal"], ["la_liga", "Real Madrid", "real-madrid"],
    ["ligue_1", "PSG", "paris-saint-germain"], ["chinese_super_league", "Beijing Guoan", "beijing-guoan"],
    ["bundesliga", "Bayern München", null], ["serie_a", "Juventus", null],
  ])("covers %s with packaged asset or explicit missing-asset fallback", (league, name, slug) => {
    const r = loadLogoRegistry();
    const expected = slug ? r.MANIFEST[league].teams[slug] : r.PLACEHOLDER;
    expect(r.getTeamLogo(league, { team_id: "uuid", name })).toBe(expected);
    expect(existsSync(join(ROOT, "pages", "matches", expected))).toBe(true);
  });
});
