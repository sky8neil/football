import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runInThisContext } from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const LEAGUE_IDS = ["bundesliga", "serie_a"];
const ALAVES_ID = "00235af4-869b-4953-a3b7-afc3f8024d81";
const REAL_MADRID_ID = "393c67e2-45f7-48a2-b3cd-9684901614ef";
const DEPORTIVO_ID = "8fe05bcc-784f-4435-ab49-b7bf039575c8";
const LIAONING_ID = "4d9ba1a3-a44a-4c32-a641-f9b1f7500d91";
const INTER_ID = "8ded21ad-f15a-482e-a4d4-113ce7481e65";
const BAYER_ID = "bec2ad65-57d9-4954-805b-6411664c9ea2";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

function loadCommonJs(file, requireShim) {
  const module = { exports: {} };
  const factory = runInThisContext(`(function(module, exports, require) {\n${readFileSync(file, "utf8")}\n})`, {
    filename: file,
  });
  factory(module, module.exports, requireShim);
  return module.exports;
}

function loadTeamRegistry() {
  return loadCommonJs(join(HERE, "team-registry.js"), () => {
    throw new Error("team-registry has no dependencies");
  });
}

function loadLogoRegistry() {
  const teamRegistry = loadTeamRegistry();
  return loadCommonJs(join(HERE, "logo-registry.js"), (id) => {
    if (id === "./team-registry.js") return teamRegistry;
    throw new Error(`Unexpected logo-registry require: ${id}`);
  });
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
        expect(manifest.team_logos[leagueId]).toEqual(manifests[0].team_logos[leagueId]);
        const registered = loadLogoRegistry().MANIFEST[leagueId].teams;
        expect(Object.keys(registered).length).toBe(leagueId === "bundesliga" ? 18 : 20);
        expect(Object.fromEntries(Object.entries(registered).map(([slug, path]) => [slug, path.replace("../../", "")]))).toEqual(manifest.team_logos[leagueId]);
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
  it("resolves football-data club names with a trailing FC suffix", () => {
    const r = loadLogoRegistry();
    expect(r.getTeamLogo("premier_league", "Arsenal FC")).toBe(r.MANIFEST.premier_league.teams.arsenal);
    expect(r.getTeamLogo("premier_league", "Chelsea Football Club")).toBe(r.MANIFEST.premier_league.teams.chelsea);
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
    ["bundesliga", "Bayern München", "bayern-munchen"], ["serie_a", "Juventus", "juventus"],
  ])("covers %s with packaged asset or explicit missing-asset fallback", (league, name, slug) => {
    const r = loadLogoRegistry();
    const expected = slug ? r.MANIFEST[league].teams[slug] : r.PLACEHOLDER;
    expect(r.getTeamLogo(league, { team_id: "uuid", name })).toBe(expected);
    expect(existsSync(join(ROOT, "pages", "matches", expected))).toBe(true);
  });
});


describe("new Bundesliga and Serie A team assets", () => {
  it.each(["bundesliga", "serie_a"])("resolves every registered %s crest to a packaged file", (league) => {
    const r = loadLogoRegistry();
    for (const [slug, path] of Object.entries(r.MANIFEST[league].teams)) {
      expect(r.getTeamLogo(league, { team_id: "uuid", name: slug })).toBe(path);
      expect(existsSync(join(ROOT, "pages", "matches", path))).toBe(true);
      expect(readFileSync(join(ROOT, "pages", "matches", path)).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    }
  });
  it.each([
    ["bundesliga", "Bayern Munich", "bayern-munchen"],
    ["bundesliga", "FC Bayern München", "bayern-munchen"],
    ["bundesliga", "Borussia Mönchengladbach", "borussia-monchengladbach"],
    ["serie_a", "AC Milan", "milan"],
    ["serie_a", "Inter Milan", "inter"],
    ["serie_a", "Como", "como-1907"],
  ])("matches %s API name %s", (league, name, slug) => {
    const r = loadLogoRegistry();
    expect(r.getTeamLogo(league, { team_id: "uuid", name })).toBe(r.MANIFEST[league].teams[slug]);
  });
});

describe("team_id-first logo resolution", () => {
  it("resolves packaged crests from team_id even without a display name", () => {
    const r = loadLogoRegistry();
    expect(r.getTeamLogo("la_liga", { team_id: REAL_MADRID_ID })).toBe(r.MANIFEST.la_liga.teams["real-madrid"]);
    expect(r.getTeamLogo("serie_a", { team_id: INTER_ID })).toBe(r.MANIFEST.serie_a.teams.inter);
    expect(r.getTeamLogo("bundesliga", { team_id: BAYER_ID })).toBe(r.MANIFEST.bundesliga.teams["bayer-leverkusen"]);
    expect(r.getTeamLogo("chinese_super_league", { team_id: LIAONING_ID })).toBe(
      r.MANIFEST.chinese_super_league.teams["liaoning-tiening"],
    );
  });

  it("prefers team_id over a conflicting name and the caller's league id", () => {
    const r = loadLogoRegistry();
    expect(r.getTeamLogo("premier_league", { team_id: REAL_MADRID_ID, name: "Arsenal FC" })).toBe(
      r.MANIFEST.la_liga.teams["real-madrid"],
    );
    expect(r.getTeamLogo("unknown_league", { team_id: DEPORTIVO_ID, name: "Deportivo Alavés" })).toBe(
      r.MANIFEST.la_liga.teams["deportivo-la-coruna"],
    );
  });

  it("does not reuse another club's crest for Alavés or unknown identities", () => {
    const r = loadLogoRegistry();
    expect(r.getTeamLogo("la_liga", { team_id: ALAVES_ID, name: "Deportivo Alavés" })).toBe(r.PLACEHOLDER);
    expect(r.getTeamLogo("la_liga", { team_id: ALAVES_ID, name: "Deportivo" })).toBe(r.PLACEHOLDER);
    expect(r.getTeamLogo("la_liga", "Deportivo Alavés")).toBe(r.PLACEHOLDER);
    expect(r.getTeamLogo("la_liga", { team_id: UNKNOWN_ID, name: "Deportivo Alavés" })).toBe(r.PLACEHOLDER);
    expect(r.getTeamLogo("unknown_league", { team_id: UNKNOWN_ID, name: "Real Madrid CF" })).toBe(r.PLACEHOLDER);
    expect(r.getTeamLogo("la_liga", { team_id: UNKNOWN_ID })).toBe(r.PLACEHOLDER);
    expect(r.getTeamLogo("premier_league", "Wolverhampton Wanderers")).toBe(r.PLACEHOLDER);
  });

  it("falls back to source_name aliases for registered clubs that the old suffix strip missed", () => {
    const r = loadLogoRegistry();
    const teamRegistry = loadTeamRegistry();
    expect(r.getTeamLogo("la_liga", "Real Madrid CF")).toBe(r.MANIFEST.la_liga.teams["real-madrid"]);
    expect(r.getTeamLogo("la_liga", "Club Atlético de Madrid")).toBe(r.MANIFEST.la_liga.teams["atletico-madrid"]);
    expect(r.getTeamLogo("la_liga", "Real Racing Club de Santander")).toBe(r.MANIFEST.la_liga.teams.racing);
    expect(r.getTeamLogo("serie_a", "FC Internazionale Milano")).toBe(r.MANIFEST.serie_a.teams.inter);
    expect(r.getTeamLogo("bundesliga", "Bayer 04 Leverkusen")).toBe(r.MANIFEST.bundesliga.teams["bayer-leverkusen"]);
    expect(r.getTeamLogo("ligue_1", "Racing Club de Lens")).toBe(r.MANIFEST.ligue_1.teams["rc-lens"]);
    expect(r.getTeamLogo("chinese_super_league", "Shenzhen Peng City")).toBe(
      r.MANIFEST.chinese_super_league.teams["shenzhen-xinpengcheng"],
    );
    let missingAsset = 0;
    for (const [teamId, team] of Object.entries(teamRegistry.TEAM_REGISTRY)) {
      const logo = r.getTeamLogo(team.league_id, { team_id: teamId });
      if (teamId === ALAVES_ID) {
        expect(logo).toBe(r.PLACEHOLDER);
        missingAsset += 1;
        continue;
      }
      expect(logo).not.toBe(r.PLACEHOLDER);
      expect(existsSync(join(ROOT, "pages", "matches", logo))).toBe(true);
    }
    expect(missingAsset).toBe(1);
  });
});
