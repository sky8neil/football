import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MATCHES_JS = join(HERE, "matches.js");
const originalPage = Object.getOwnPropertyDescriptor(globalThis, "Page");
const originalWx = Object.getOwnPropertyDescriptor(globalThis, "wx");
const NOW = new Date("2026-11-15T16:00:00.000Z");

function loadCommonJs(file, requires) {
  const module = { exports: {} };
  const factory = runInThisContext(`(function (module, exports, require) {\n${readFileSync(file, "utf8")}\n})`, {
    filename: file,
  });
  factory(module, module.exports, requires);
  return module.exports;
}

function createPage(listMatches, wx = {}) {
  let definition;
  Object.defineProperty(globalThis, "Page", {
    value: (value) => { definition = value; },
    configurable: true,
  });
  Object.defineProperty(globalThis, "wx", { value: wx, configurable: true });
  const helpers = loadCommonJs(MATCHES_JS, (id) => {
    if (id === "../../utils/ui-layout.js") return { headerHeight: () => 88 };
    if (id === "../../utils/logo-registry.js") return { getTeamLogo: () => "", getLeagueLogo: () => "" };
    if (id === "../../utils/nickname.js") return { resolveNickname: () => "", truncateNickname: (value) => value };
    if (id === "../../services/matches.js") return { listMatches };
    if (id === "../../utils/matches-default-league.js") return { resolveDefaultLeague: () => Promise.resolve({}) };
    if (id === "../../services/predictions.js") return { createUuidV4: () => "", submitPrediction: () => Promise.resolve({}) };
    if (id === "../../utils/crowd-copy.js") return { COPY: { homeLink: "" } };
    throw new Error(`Unexpected require: ${id}`);
  });
  const page = Object.assign({}, definition, {
    data: {
      ...definition.data,
      selectedLeague: "chinese_super_league",
      selectedDate: "2026-11-16",
      dates: helpers.buildDates(new Date()),
      activeLeagueIds: ["chinese_super_league", "la_liga"],
    },
    requestSerial: 0,
    setData(update) { Object.assign(this.data, update); },
    closeEditors() {},
  });
  return { page, helpers };
}

function response(items, extra = {}) {
  return { statusCode: 200, data: { items, ...extra } };
}

function scheduledMatch(kickoffAt) {
  return {
    match_id: "next-match",
    league_id: "chinese_super_league",
    home_team: { name: "主队" },
    away_team: { name: "客队" },
    kickoff_at: kickoffAt,
    match_status: "scheduled",
    can_predict: false,
    can_predict_reason: null,
    regular_home_score: null,
    regular_away_score: null,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  if (originalPage) Object.defineProperty(globalThis, "Page", originalPage);
  else delete globalThis.Page;
  if (originalWx) Object.defineProperty(globalThis, "wx", originalWx);
  else delete globalThis.wx;
});

describe("matches offseason and next match states", () => {
  it("shows the next match when the first 30-day follow-up finds one", async () => {
    const kickoffAt = "2026-11-20T12:00:00+08:00";
    const listMatches = vi.fn()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([scheduledMatch(kickoffAt)]));
    const { page } = createPage(listMatches);

    await page.loadFirstPage();

    expect(page.data.state).toBe("no-match");
    expect(page.data.nextMatch).toMatchObject({
      date: "2026-11-20",
      label: "11月20日（周五）",
      daysUntil: 4,
      inDateStrip: true,
    });
    expect(listMatches).toHaveBeenCalledTimes(2);
    expect(listMatches.mock.calls[1][0]).toMatchObject({
      league_id: "chinese_super_league",
      from: "2026-11-16T16:00:00.000Z",
      to: "2026-12-15T16:00:00.000Z",
      limit: 1,
    });
  });

  it("shows a new-season countdown when only the 120-day window finds a match", async () => {
    const listMatches = vi.fn()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([scheduledMatch("2026-12-08T12:00:00+08:00")]));
    const { page } = createPage(listMatches);

    await page.loadFirstPage();

    expect(page.data.state).toBe("offseason");
    expect(page.data.offseasonInfo).toMatchObject({
      title: "中超 本赛季已收官",
      nextSeasonDate: "2026-12-08T12:00:00+08:00",
      countdownDays: 22,
      activeLeagueId: "la_liga",
      activeLeagueName: "西甲",
    });
  });

  it("shows the offseason card without a countdown when both windows are empty", async () => {
    const listMatches = vi.fn()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([]));
    const { page } = createPage(listMatches);

    await page.loadFirstPage();

    expect(page.data.state).toBe("offseason");
    expect(page.data.offseasonInfo).toMatchObject({
      title: "中超 本赛季已收官",
      nextSeasonDate: null,
      countdownDays: null,
    });
    expect(page.data.nextMatch).toBeNull();
  });

  it("jumps to an in-strip match date and only shows a day count outside the strip", async () => {
    const inRangeKickoff = "2026-11-22T12:00:00+08:00";
    const inRangeList = vi.fn()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([scheduledMatch(inRangeKickoff)]))
      .mockResolvedValueOnce(response([scheduledMatch(inRangeKickoff)]));
    const { page: inRangePage } = createPage(inRangeList);

    await inRangePage.loadFirstPage();
    expect(inRangePage.data.nextMatch.displayText).toBe("跳到下一轮比赛日：11月22日（周日）→");
    await inRangePage.onNextMatchTap({ currentTarget: { dataset: { date: "2026-11-22" } } });
    expect(inRangePage.data.selectedDate).toBe("2026-11-22");
    expect(inRangePage.data.state).toBe("list");

    const outOfRangeKickoff = "2026-12-01T12:00:00+08:00";
    const outOfRangeList = vi.fn()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([scheduledMatch(outOfRangeKickoff)]));
    const { page: outOfRangePage } = createPage(outOfRangeList);
    await outOfRangePage.loadFirstPage();

    expect(outOfRangePage.data.nextMatch).toMatchObject({
      inDateStrip: false,
      daysUntil: 15,
      displayText: "距下一轮比赛日还有 15 天（12月1日）",
    });
    outOfRangePage.onNextMatchTap({ currentTarget: { dataset: { date: "2026-12-01" } } });
    expect(outOfRangePage.data.selectedDate).toBe("2026-11-16");
    expect(outOfRangeList).toHaveBeenCalledTimes(2);
  });

  it("clears offseason card data and returns to loading when the league changes", async () => {
    const listMatches = vi.fn()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([]));
    const { page } = createPage(listMatches);
    await page.loadFirstPage();

    page.onLeagueTap({ currentTarget: { dataset: { id: "la_liga" } } });

    expect(page.data.selectedLeague).toBe("la_liga");
    expect(page.data.state).toBe("loading");
    expect(page.data.nextMatch).toBeNull();
    expect(page.data.offseasonInfo).toBeNull();
  });

  it("discards a follow-up response after the user switches leagues", async () => {
    let resolveFollowup;
    const followup = new Promise((resolve) => { resolveFollowup = resolve; });
    const listMatches = vi.fn()
      .mockResolvedValueOnce(response([]))
      .mockReturnValueOnce(followup);
    const { page } = createPage(listMatches);
    const pendingLoad = page.loadFirstPage();
    await Promise.resolve();
    await Promise.resolve();

    expect(listMatches).toHaveBeenCalledTimes(2);
    page.onLeagueTap({ currentTarget: { dataset: { id: "la_liga" } } });
    resolveFollowup(response([scheduledMatch("2026-11-20T12:00:00+08:00")]));
    await pendingLoad;

    expect(page.data.selectedLeague).toBe("la_liga");
    expect(page.data.state).toBe("loading");
    expect(page.data.nextMatch).toBeNull();
    expect(page.data.offseasonInfo).toBeNull();
  });

  it("treats failed follow-up requests as no results without entering the error state", async () => {
    const listMatches = vi.fn()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce({ statusCode: 503 })
      .mockRejectedValueOnce(new Error("network unavailable"));
    const { page } = createPage(listMatches);

    await expect(page.loadFirstPage()).resolves.toBeUndefined();

    expect(page.data.state).toBe("offseason");
    expect(page.data.errorMessage).toBe("");
    expect(page.data.offseasonInfo.countdownDays).toBeNull();
  });
});
