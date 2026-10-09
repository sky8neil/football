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
