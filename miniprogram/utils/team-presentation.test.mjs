import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const BAYERN_ID = "88a310b9-311f-46c8-83ed-8d14b93ce5c4";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

function loadCommonJs(file, requireShim) {
  const module = { exports: {} };
  const factory = runInThisContext(`(function(module, exports, require) {\n${readFileSync(file, "utf8")}\n})`, {
    filename: file,
  });
  factory(module, module.exports, requireShim);
  return module.exports;
}

const registry = loadCommonJs(join(HERE, "team-registry.js"), () => {
  throw new Error("team-registry has no dependencies");
});

function loadPresentation(getTeamLogo) {
  return loadCommonJs(join(HERE, "team-presentation.js"), (id) => {
    if (id === "./team-registry.js") return registry;
    if (id === "./logo-registry.js") return { getTeamLogo };
    throw new Error(`Unexpected require: ${id}`);
  });
}

describe("presentTeam", () => {
  it("returns the registered Chinese name for a known team_id", () => {
    const getTeamLogo = vi.fn(() => "logo.png");
    const { presentTeam } = loadPresentation(getTeamLogo);
    const sourceName = registry.findTeam(BAYERN_ID).source_name;
    const team = { team_id: BAYERN_ID, name: sourceName };
    const result = presentTeam(team, "bundesliga");
    expect(result.teamId).toBe(BAYERN_ID);
    expect(result.nameZh).toBe("拜仁慕尼黑");
    expect(result.missing).toBe(false);
    expect(result.logo).toBe("logo.png");
    expect(team.name).toBe(sourceName);
  });

  it("uses a valid server name for an unknown team_id", () => {
    const getTeamLogo = vi.fn(() => "placeholder.png");
    const { presentTeam } = loadPresentation(getTeamLogo);
    const team = { team_id: UNKNOWN_ID, name: "FC Mystery" };
    const result = presentTeam(team, "bundesliga");
    expect(result.teamId).toBe(UNKNOWN_ID);
    expect(result.nameZh).toBe("FC Mystery");
    expect(result.missing).toBe(false);
    expect(result.logo).toBe("placeholder.png");
  });

  it("prefers the registered Chinese name over a valid server name", () => {
    const getTeamLogo = vi.fn(() => "logo.png");
    const { presentTeam } = loadPresentation(getTeamLogo);
    const result = presentTeam({ team_id: BAYERN_ID, name: "FC Bayern Munich" }, "bundesliga");
    expect(result.nameZh).toBe("拜仁慕尼黑");
    expect(result.missing).toBe(false);
  });

  it("trims server names and keeps a valid name when the crest is missing", () => {
    const getTeamLogo = vi.fn(() => "placeholder.png");
    const { presentTeam } = loadPresentation(getTeamLogo);
    expect(presentTeam({ team_id: UNKNOWN_ID, name: "  长春亚泰  " }, "chinese_super_league"))
      .toMatchObject({ nameZh: "长春亚泰", missing: false, logo: "placeholder.png" });
  });

  it("falls back to the missing placeholder for blank names or the missing hint itself", () => {
    const getTeamLogo = vi.fn(() => "placeholder.png");
    const { presentTeam } = loadPresentation(getTeamLogo);
    expect(presentTeam({ team_id: UNKNOWN_ID, name: "   " }, "bundesliga"))
      .toMatchObject({ nameZh: "球队资料待补全", missing: true });
    expect(presentTeam({ team_id: UNKNOWN_ID, name: "球队资料待补全" }, "bundesliga"))
      .toMatchObject({ nameZh: "球队资料待补全", missing: true });
  });

  it("uses the missing branch for null team or missing name without throwing", () => {
    const getTeamLogo = vi.fn(() => "placeholder.png");
    const { presentTeam } = loadPresentation(getTeamLogo);
    expect(() => presentTeam(null, "bundesliga")).not.toThrow();
    expect(() => presentTeam(undefined, "bundesliga")).not.toThrow();
    expect(() => presentTeam({}, "premier_league")).not.toThrow();
    expect(() => presentTeam({ name: "Arsenal FC" }, "premier_league")).not.toThrow();
    expect(presentTeam(null, "bundesliga")).toMatchObject({ nameZh: "球队资料待补全", missing: true });
    expect(presentTeam({}, "premier_league")).toMatchObject({ nameZh: "球队资料待补全", missing: true });
    expect(presentTeam({ name: "Arsenal FC" }, "premier_league")).toMatchObject({
      nameZh: "Arsenal FC",
      missing: false,
    });
  });

  it("passes the original English source_name to getTeamLogo", () => {
    const getTeamLogo = vi.fn(() => "logo.png");
    const { presentTeam } = loadPresentation(getTeamLogo);
    const sourceName = registry.findTeam(BAYERN_ID).source_name;
    const team = { team_id: BAYERN_ID, name: sourceName };
    presentTeam(team, "bundesliga");
    expect(getTeamLogo).toHaveBeenCalledWith("bundesliga", team);
    expect(getTeamLogo.mock.calls[0][1].name).toBe(sourceName);
    expect(getTeamLogo.mock.calls[0][1].name).toBe("FC Bayern München");
    expect(getTeamLogo.mock.calls[0][1]).toBe(team);
    expect(team.name).toBe("FC Bayern München");
  });

  it("fills registry source_name when the caller only has team_id", () => {
    const getTeamLogo = vi.fn(() => "logo.png");
    const { presentTeam } = loadPresentation(getTeamLogo);
    const result = presentTeam({ team_id: BAYERN_ID }, "unknown_league");
    expect(result.nameZh).toBe("拜仁慕尼黑");
    expect(result.missing).toBe(false);
    expect(getTeamLogo).toHaveBeenCalledTimes(1);
    expect(getTeamLogo.mock.calls[0][1]).toMatchObject({
      team_id: BAYERN_ID,
      name: "FC Bayern München",
    });
  });

  it("[Q-PLAN-2] prioritizes server team.name_zh over local registry and falls back to safe server logo_url when local logo misses", () => {
    const getTeamLogo = vi.fn((_leagueId, team) =>
      team && team.team_id === BAYERN_ID ? "../../assets/logos/teams/bundesliga/bayern-munchen.png" : "../../assets/logos/placeholders/team-placeholder.png",
    );
    const { presentTeam } = loadPresentation(getTeamLogo);

    // 1. Server name_zh overrides registry; local 114 PNG cache still wins over server logo_url
    expect(presentTeam({
      team_id: BAYERN_ID,
      name: "FC Bayern München",
      name_zh: "拜仁（服务端覆盖）",
      logo_url: "https://cdn.example.com/ignored-when-local-exists.png",
    }, "bundesliga")).toEqual({
      teamId: BAYERN_ID,
      nameZh: "拜仁（服务端覆盖）",
      logo: "../../assets/logos/teams/bundesliga/bayern-munchen.png",
      missing: false,
    });

    // 2. Unknown promoted team uses server name_zh and valid https:// logo_url
    expect(presentTeam({
      team_id: UNKNOWN_ID,
      name: "Promoted United FC",
      name_zh: "  升班马联  ",
      logo_url: "  https://cdn.example.com/promoted-united.png  ",
    }, "premier_league")).toEqual({
      teamId: UNKNOWN_ID,
      nameZh: "升班马联",
      logo: "https://cdn.example.com/promoted-united.png",
      missing: false,
    });

    // 3. Relative path starting with / is accepted when local logo misses
    expect(presentTeam({
      team_id: UNKNOWN_ID,
      name: "Promoted City",
      name_zh: "升班马城",
      logo_url: "/assets/custom/promoted-city.png",
    }, "premier_league")).toEqual({
      teamId: UNKNOWN_ID,
      nameZh: "升班马城",
      logo: "/assets/custom/promoted-city.png",
      missing: false,
    });

    // 4. Unsafe or malformed logo_url (http://, //evil, javascript:) falls back to local placeholder
    for (const badUrl of ["http://insecure.example/a.png", "//evil.example/a.png", "javascript:alert(1)", "relative/a.png", "   ", null]) {
      expect(presentTeam({
        team_id: UNKNOWN_ID,
        name: "Promoted FC",
        name_zh: null,
        logo_url: badUrl,
      }, "premier_league")).toEqual({
        teamId: UNKNOWN_ID,
        nameZh: "Promoted FC",
        logo: "../../assets/logos/placeholders/team-placeholder.png",
        missing: false,
      });
    }
  });
});
