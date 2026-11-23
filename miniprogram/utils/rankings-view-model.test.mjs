import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const CONFIG = new URL("../config.js", import.meta.url);
const COPY = new URL("./rankings-copy.js", import.meta.url);
const MODEL = new URL("./rankings-view-model.js", import.meta.url);

function loadModule(url, dependencies = {}) {
  const module = { exports: {} };
  runInNewContext(readFileSync(url, "utf8"), {
    module,
    exports: module.exports,
    require: (name) => dependencies[name],
  });
  return module.exports;
}

const copy = loadModule(COPY);
const model = loadModule(MODEL, {
  "../config.js": loadModule(CONFIG),
  "./rankings-copy.js": copy,
});

describe("rankings view model", () => {
  it("keeps the usual full board free of cold-start blocks", () => {
    const result = model.buildRankingViewModel({
      board: "week",
      scope: "global",
      serverNow: "2026-08-09T12:00:00.000Z",
      hasGroups: true,
      payload: {
        board: "week",
        current_period_key: "2026-W32",
        period_key: "2026-W32",
        updated_at: "2026-08-09T11:45:00.000Z",
        available_boards: ["week", "career", "strength"],
        entry_count: 20,
        seasons_participated: 3,
        items: Array(20).fill({}),
      },
    });
    expect(result).toMatchObject({
      tabs: ["week", "career", "strength"],
      showPodium: true,
      listTitleKind: "top20",
      emptyKind: "none",
      notices: [],
      updatedText: "更新于 15 分钟前",
      guestPlaceholder: false,
      showGroupLocked: false,
      showRecap: false,
    });
    expect(result.weekOptions.map((item) => item.key)).toEqual(["2026-W32", "2026-W31"]);
  });

  it.each([1, 2, 3, 19, 20])("uses the correct people tier for %i entries", (entryCount) => {
    const result = model.buildRankingViewModel({
      board: "week",
      scope: "global",
      serverNow: "2026-08-09T12:00:00.000Z",
      hasGroups: false,
      payload: { current_period_key: "2026-W32", entry_count: entryCount, available_boards: ["week"] },
    });
    expect(result.showPodium).toBe(entryCount >= 3);
    expect(result.listTitleKind).toBe(entryCount >= 20 ? "top20" : "all_n");
    expect(result.showGroupLocked).toBe(true);
    expect(result.notices.some((item) => item.kind === "invite")).toBe(entryCount < 20);
  });

  it("builds empty and guest placeholders without relying on member data", () => {
    const result = model.buildRankingViewModel({
      board: "week",
      scope: "global",
      guest: true,
      serverNow: "2026-08-09T12:00:00.000Z",
      payload: { current_period_key: "2026-W32", entry_count: 0, available_boards: ["week"] },
    });
    expect(result).toMatchObject({ guestPlaceholder: true, emptyKind: "week_global", showPodium: false });
    expect(result.emptyText).toContain("第一场预测结算后");
    expect(result.weekOptions.map((item) => item.key)).toEqual(["2026-W32", "2026-W31"]);
  });

  it("shows the first-season, season-start, provisional, and recap states", () => {
    const now = "2026-07-15T04:00:00.000Z";
    const career = model.buildRankingViewModel({
      board: "career",
      serverNow: now,
      payload: { seasons_participated: 1, entry_count: 1, available_boards: ["week", "career"] },
    });
    expect(career.notices).toEqual([
      { kind: "first-season", text: copy.firstSeasonCareer },
      { kind: "invite", text: copy.inviteGlobal },
    ]);

    const season = model.buildRankingViewModel({
      board: "season",
      serverNow: now,
      payload: { level_season_id: "2026_2027", is_provisional: false, entry_count: 1 },
    });
    expect(season.notices.map((item) => item.kind)).toEqual(["season-start", "invite"]);

    const provisional = model.buildRankingViewModel({
      board: "season",
      serverNow: now,
      payload: { level_season_id: "2025_2026", is_provisional: true, entry_count: 1 },
      previousSeason: { points: 28, best_level: 3 },
      currentSeasonRanked: false,
    });
    expect(provisional.notices.map((item) => item.kind)).toEqual(["provisional", "invite"]);
    expect(provisional.showRecap).toBe(true);
    expect(provisional.recapText).toContain("28 分");
  });

  it("shows readable dates for past weeks, including month and year boundaries", () => {
    expect(model.buildWeekOptions("2026-W41", "2026-W40").map(item => item.label))
      .toEqual(["本周", "9.28-10.4"]);
    expect(model.buildWeekOptions("2026-W02", "2025-W52").map(item => item.label))
      .toEqual(["本周", "12.29-1.4", "12.22-12.28"]);
  });

  it("formats age from the supplied server time and respects the registered first week", () => {
    expect(model.formatUpdatedAt("2026-08-09T11:59:30.000Z", "2026-08-09T12:00:00.000Z"))
      .toBe("刚刚更新");
    expect(model.buildWeekOptions("2026-W02", "2025-W52").map((item) => item.key))
      .toEqual(["2026-W02", "2026-W01", "2025-W52"]);
  });

  it("prefers payload.first_period_key over the local rankingFirstPeriodKey fallback", () => {
    const result = model.buildRankingViewModel({
      board: "week",
      payload: {
        current_period_key: "2026-W47",
        first_period_key: "2026-W45",
        entry_count: 1,
        available_boards: ["week"],
      },
    });
    expect(result.weekOptions.map((item) => item.key)).toEqual([
      "2026-W47",
      "2026-W46",
      "2026-W45",
    ]);
  });

  it("falls back to rankingFirstPeriodKey when first_period_key is missing", () => {
    const missing = model.buildRankingViewModel({
      board: "week",
      payload: {
        current_period_key: "2026-W32",
        entry_count: 1,
        available_boards: ["week"],
      },
    });
    const empty = model.buildRankingViewModel({
      board: "week",
      payload: {
        current_period_key: "2026-W32",
        first_period_key: "",
        entry_count: 1,
        available_boards: ["week"],
      },
    });
    expect(missing.weekOptions.map((item) => item.key)).toEqual(["2026-W32", "2026-W31"]);
    expect(empty.weekOptions.map((item) => item.key)).toEqual(["2026-W32", "2026-W31"]);
  });

  it("builds week options across a year boundary from payload.first_period_key", () => {
    const result = model.buildRankingViewModel({
      board: "week",
      payload: {
        current_period_key: "2027-W02",
        first_period_key: "2026-W53",
        entry_count: 1,
        available_boards: ["week"],
      },
    });
    expect(result.weekOptions.map((item) => item.key)).toEqual([
      "2027-W02",
      "2027-W01",
      "2026-W53",
    ]);
  });

  it("keeps empty copy board-specific and never promises first place", () => {
    const emptyPayload = { entry_count: 0, available_boards: ["week", "career", "strength", "season"] };
    const week = model.buildRankingViewModel({ board: "week", scope: "global", payload: emptyPayload });
    const strength = model.buildRankingViewModel({ board: "strength", scope: "global", payload: emptyPayload });
    const career = model.buildRankingViewModel({ board: "career", scope: "global", payload: emptyPayload });
    const season = model.buildRankingViewModel({ board: "season", scope: "global", payload: emptyPayload });
    const group = model.buildRankingViewModel({ board: "week", scope: "group", payload: emptyPayload });
    for (const result of [week, strength, career, season, group]) {
      expect(result.emptyText).not.toContain("你就是第一名");
    }
    expect(week.emptyText).not.toBe(strength.emptyText);
    expect(strength.emptyText).toContain("50");
    expect(week.emptyText).toContain("第一场预测结算后");
  });

  it("does not claim a missing prediction when me is null", () => {
    const result = model.buildRankingViewModel({
      board: "week",
      scope: "global",
      payload: { entry_count: 0, me: null, available_boards: ["week"] },
    });
    expect(result.standingStatus).toBe(copy.standingNeutral);
    expect(result.standingStatus).not.toMatch(/没有预测/);
    expect(result.emptyText).not.toMatch(/没有预测/);
    expect(result.standingStatus).not.toMatch(/待结算/);
    expect(result.emptyText).not.toMatch(/待结算/);
  });

  it("states a ranked place once without repeating the rank", () => {
    const result = model.buildRankingViewModel({
      board: "week",
      scope: "global",
      payload: {
        entry_count: 20,
        me: { status: "ranked", rank: 2 },
        available_boards: ["week", "career", "strength"],
      },
    });
    expect(result.standingStatus).toBe("你位于全站第 2 名。");
    expect(result.standingStatus).not.toContain("排名第");
  });
});
