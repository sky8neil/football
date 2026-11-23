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

  it("returns the missing placeholder for an unknown team_id", () => {
    const getTeamLogo = vi.fn(() => "placeholder.png");
    const { presentTeam } = loadPresentation(getTeamLogo);
    const team = { team_id: UNKNOWN_ID, name: "FC Mystery" };
    const result = presentTeam(team, "bundesliga");
    expect(result.teamId).toBe(UNKNOWN_ID);
    expect(result.nameZh).toBe("球队资料待补全");
    expect(result.missing).toBe(true);
  });

  it("uses the missing branch for null team or missing team_id without throwing", () => {
    const getTeamLogo = vi.fn(() => "placeholder.png");
    const { presentTeam } = loadPresentation(getTeamLogo);
    expect(() => presentTeam(null, "bundesliga")).not.toThrow();
    expect(() => presentTeam(undefined, "bundesliga")).not.toThrow();
    expect(() => presentTeam({}, "premier_league")).not.toThrow();
    expect(() => presentTeam({ name: "Arsenal FC" }, "premier_league")).not.toThrow();
    expect(presentTeam(null, "bundesliga")).toMatchObject({ nameZh: "球队资料待补全", missing: true });
    expect(presentTeam({}, "premier_league")).toMatchObject({ nameZh: "球队资料待补全", missing: true });
    expect(presentTeam({ name: "Arsenal FC" }, "premier_league")).toMatchObject({
      nameZh: "球队资料待补全",
      missing: true,
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
});
