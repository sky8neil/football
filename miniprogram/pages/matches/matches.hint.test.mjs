import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MATCHES_JS = join(HERE, "matches.js");
const originalPage = Object.getOwnPropertyDescriptor(globalThis, "Page");

function loadCommonJs(file, requires) {
  const module = { exports: {} };
  const factory = runInThisContext(`(function (module, exports, require) {\n${readFileSync(file, "utf8")}\n})`, {
    filename: file,
  });
  factory(module, module.exports, requires);
  return module.exports;
}

function loadHintHelpers() {
  Object.defineProperty(globalThis, "Page", { value: () => {}, configurable: true });
  return loadCommonJs(MATCHES_JS, (id) => {
    if (id === "../../utils/ui-layout.js") return { headerHeight: () => 88 };
    if (id === "../../utils/logo-registry.js") return { getTeamLogo: () => "", getLeagueLogo: () => "" };
    if (id === "../../utils/team-presentation.js") {
      return { presentTeam: (team) => ({ teamId: team && team.team_id, nameZh: "球队资料待补全", logo: "", missing: true }) };
    }
    if (id === "../../utils/nickname.js") return { resolveNickname: () => "", truncateNickname: (value) => value };
    if (id === "../../services/matches.js") return { listMatches: () => Promise.resolve({ statusCode: 200 }) };
    if (id === "../../services/leagues.js") return { getLeagueStatus: () => Promise.resolve({ statusCode: 200, data: { items: [] } }) };
    if (id === "../../utils/matches-default-league.js") return { resolveDefaultLeagueFromStatus: () => ({ leagueId: "premier_league", activeLeagueIds: [] }) };
    if (id === "../../services/predictions.js") return { createUuidV4: () => "", submitPrediction: () => Promise.resolve({}) };
    if (id === "../../utils/crowd-copy.js") return { COPY: { homeLink: "" } };
    if (id === "../../utils/match-presentation.js") return { formatRound: (value) => value || "", formatKickoff: () => "" };
    if (id === "../../utils/match-card-state.js") {
      return loadCommonJs(join(HERE, "..", "..", "utils", "match-card-state.js"), () => {
        throw new Error("match-card-state has no dependencies");
      });
    }
    if (id === "../../utils/rankings-view-model.js") return { currentSeasonId: () => "2026_2027" };
    if (id === "../../utils/level-season.js") return { formatLevelSeasonLabel: () => "" };
    throw new Error(`Unexpected require: ${id}`);
  });
}

const { buildHintText } = loadHintHelpers();

afterEach(() => {
  if (originalPage) Object.defineProperty(globalThis, "Page", originalPage);
  else delete globalThis.Page;
});

describe("buildHintText", () => {
  it("uses 今天 for the Beijing calendar today", () => {
    const text = buildHintText({
      selectedDate: "2026-11-18",
      todayKey: "2026-11-18",
      openCount: 5,
      doneCount: 1,
      hasMore: false,
    });
    expect(text).toContain("今天 · 待预测 5 场 · 已预测 1 场");
    expect(text).not.toContain("今日");
  });

  it("formats a non-today date as M 月 D 日 and never says 今日", () => {
    const text = buildHintText({
      selectedDate: "2026-11-21",
      todayKey: "2026-11-18",
      openCount: 5,
      doneCount: 1,
      hasMore: false,
    });
    expect(text).toContain("11 月 21 日");
    expect(text).not.toContain("今日");
  });

  it("marks incomplete pages with + and a load-more hint", () => {
    const text = buildHintText({
      selectedDate: "2026-11-18",
      todayKey: "2026-11-18",
      openCount: 5,
      doneCount: 1,
      hasMore: true,
    });
    expect(text).toContain("待预测 5+ 场");
    expect(text).toContain("已预测 1+ 场");
    expect(text).toContain("继续加载可看全部");
  });

  it("renders openCount 0 as 待预测 0 场 without extra copy", () => {
    const text = buildHintText({
      selectedDate: "2026-11-18",
      todayKey: "2026-11-18",
      openCount: 0,
      doneCount: 0,
      hasMore: false,
    });
    expect(text).toContain("待预测 0 场");
    expect(text).toBe("今天 · 待预测 0 场 · 已预测 0 场");
  });
});
