import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function loadDateHelpers() {
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
    if (id === "../../services/auth.js") return { getLoginGeneration: () => 0 };
    throw new Error(`Unexpected require: ${id}`);
  });
}

const { buildDates, beijingParts, upcomingMatchInfo } = loadDateHelpers();

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalPage) Object.defineProperty(globalThis, "Page", originalPage);
  else delete globalThis.Page;
});

describe("matches date strip", () => {
  it("uses the Beijing calendar day in UTC, UTC-8, and UTC+13 device time zones", () => {
    const anchors = [new Date("2026-11-15T02:00:00.000Z"), new Date("2026-11-15T16:30:00.000Z")];
    const zones = ["UTC", "Etc/GMT+8", "Etc/GMT-13"];

    for (const anchor of anchors) {
      const expectedKey = beijingParts(anchor).key;
      const keysByZone = zones.map((timezone) => {
        vi.stubEnv("TZ", timezone);
        const dates = buildDates(anchor);
        expect(dates).toHaveLength(23);
        expect(dates[11]).toEqual({ key: expectedKey, label: "今天", day: expectedKey.slice(-2) });
        return dates.map(({ key }) => key);
      });
      expect(keysByZone[1]).toEqual(keysByZone[0]);
      expect(keysByZone[2]).toEqual(keysByZone[0]);
    }
  });

  it("[Q-PLAN-4] builds 23 consecutive Beijing dates (-11..+11) with yesterday, today centered at index 11, tomorrow, and weekdays", () => {
    const dates = buildDates(new Date("2026-11-15T16:30:00.000Z"));
    const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

    expect(dates).toHaveLength(23);
    expect(dates[10].label).toBe("昨天");
    expect(dates[11].label).toBe("今天");
    expect(dates[12].label).toBe("明天");
    dates.forEach((date, index) => {
      expect(date.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(date.day).toMatch(/^\d{2}$/);
      expect(date.day).toBe(date.key.slice(-2));
      if (index < 10 || index > 12) {
        const beijingNoon = new Date(`${date.key}T04:00:00.000Z`);
        expect(date.label).toBe(weekdays[beijingNoon.getUTCDay()]);
      }
      if (index > 0) {
        const previous = new Date(`${dates[index - 1].key}T00:00:00.000Z`);
        previous.setUTCDate(previous.getUTCDate() + 1);
        expect(date.key).toBe(previous.toISOString().slice(0, 10));
      }
    });
  });
});

describe("beijingParts arithmetic", () => {
  it("returns independent Beijing parts across day, month, year, leap, and 00:00 boundaries", () => {
    expect(beijingParts("2026-11-15T15:59:59.000Z")).toEqual({
      year: 2026, month: 11, day: 15, hour: 23, minute: 59, key: "2026-11-15",
    });
    expect(beijingParts("2026-11-15T16:00:00.000Z")).toEqual({
      year: 2026, month: 11, day: 16, hour: 0, minute: 0, key: "2026-11-16",
    });
    expect(beijingParts("2026-11-15T16:30:00.000Z")).toEqual({
      year: 2026, month: 11, day: 16, hour: 0, minute: 30, key: "2026-11-16",
    });
    expect(beijingParts("2026-01-31T16:00:00.000Z")).toEqual({
      year: 2026, month: 2, day: 1, hour: 0, minute: 0, key: "2026-02-01",
    });
    expect(beijingParts("2026-12-31T16:00:00.000Z")).toEqual({
      year: 2027, month: 1, day: 1, hour: 0, minute: 0, key: "2027-01-01",
    });
    expect(beijingParts("2024-02-28T16:00:00.000Z")).toEqual({
      year: 2024, month: 2, day: 29, hour: 0, minute: 0, key: "2024-02-29",
    });
    expect(beijingParts("2024-02-29T16:00:00.000Z")).toEqual({
      year: 2024, month: 3, day: 1, hour: 0, minute: 0, key: "2024-03-01",
    });
    expect(beijingParts("2025-02-28T16:00:00.000Z")).toEqual({
      year: 2025, month: 3, day: 1, hour: 0, minute: 0, key: "2025-03-01",
    });
  });

  it("keeps existing invalid-input semantics", () => {
    expect(beijingParts("not-a-date")).toBeNull();
    expect(beijingParts("2026-13-40")).toBeNull();
    expect(buildDates("not-a-date")).toEqual([]);
    expect(buildDates("2026-13-40")).toEqual([]);
  });

  it("matches independent Beijing keys in UTC, UTC-8, and UTC+13", () => {
    const cases = [
      { iso: "2026-11-15T15:59:59.000Z", key: "2026-11-15" },
      { iso: "2026-11-15T16:00:00.000Z", key: "2026-11-16" },
    ];
    for (const timezone of ["UTC", "Etc/GMT+8", "Etc/GMT-13"]) {
      vi.stubEnv("TZ", timezone);
      for (const { iso, key } of cases) {
        expect(beijingParts(iso).key).toBe(key);
        const dates = buildDates(iso);
        expect(dates).toHaveLength(23);
        expect(dates[11]).toEqual({ key, label: "今天", day: key.slice(-2) });
      }
    }
  });
});

describe("buildDates arithmetic", () => {
  it("[Q-PLAN-4] returns 23 consecutive Beijing dates (-11..+11) with yesterday, today centered, tomorrow, and weekday labels", () => {
    const dates = buildDates("2026-11-15T16:30:00.000Z");
    expect(dates).toHaveLength(23);
    expect(dates[0]).toEqual({ key: "2026-11-05", label: "周四", day: "05" });
    expect(dates[10]).toEqual({ key: "2026-11-15", label: "昨天", day: "15" });
    expect(dates[11]).toEqual({ key: "2026-11-16", label: "今天", day: "16" });
    expect(dates[12]).toEqual({ key: "2026-11-17", label: "明天", day: "17" });
    expect(dates[22]).toEqual({ key: "2026-11-27", label: "周五", day: "27" });
  });

  it("crosses leap day, month, and year with independent keys across the 23-day window", () => {
    const leapDates = buildDates("2024-02-28T20:00:00.000Z").map(({ key, label, day }) => ({ key, label, day }));
    expect(leapDates).toHaveLength(23);
    expect(leapDates[0]).toEqual({ key: "2024-02-18", label: "周日", day: "18" });
    expect(leapDates[10]).toEqual({ key: "2024-02-28", label: "昨天", day: "28" });
    expect(leapDates[11]).toEqual({ key: "2024-02-29", label: "今天", day: "29" });
    expect(leapDates[12]).toEqual({ key: "2024-03-01", label: "明天", day: "01" });
    expect(leapDates[22]).toEqual({ key: "2024-03-11", label: "周一", day: "11" });

    const newYearDates = buildDates("2026-12-31T16:00:00.000Z").map(({ key, label, day }) => ({ key, label, day }));
    expect(newYearDates).toHaveLength(23);
    expect(newYearDates[0]).toEqual({ key: "2026-12-21", label: "周一", day: "21" });
    expect(newYearDates[10]).toEqual({ key: "2026-12-31", label: "昨天", day: "31" });
    expect(newYearDates[11]).toEqual({ key: "2027-01-01", label: "今天", day: "01" });
    expect(newYearDates[12]).toEqual({ key: "2027-01-02", label: "明天", day: "02" });
    expect(newYearDates[22]).toEqual({ key: "2027-01-12", label: "周二", day: "12" });
  });
});

describe("locale independence", () => {
  it("beijingParts and buildDates do not use toLocaleString or toLocaleDateString", () => {
    const toLocaleString = Date.prototype.toLocaleString;
    const toLocaleDateString = Date.prototype.toLocaleDateString;
    Date.prototype.toLocaleString = function toLocaleStringMock() {
      throw new Error("toLocaleString should not be used");
    };
    Date.prototype.toLocaleDateString = function toLocaleDateStringMock() {
      throw new Error("toLocaleDateString should not be used");
    };
    try {
      expect(beijingParts("2026-11-15T16:00:00.000Z")).toEqual({
        year: 2026, month: 11, day: 16, hour: 0, minute: 0, key: "2026-11-16",
      });
      const built = buildDates("2026-11-15T16:00:00.000Z");
      expect(built).toHaveLength(23);
      expect(built.slice(10, 14)).toEqual([
        { key: "2026-11-15", label: "昨天", day: "15" },
        { key: "2026-11-16", label: "今天", day: "16" },
        { key: "2026-11-17", label: "明天", day: "17" },
        { key: "2026-11-18", label: "周三", day: "18" },
      ]);
      expect(upcomingMatchInfo(
        { kickoff_at: "2026-11-20T12:00:00+08:00" },
        "2026-11-16T00:00:00+08:00",
        built,
      )).toEqual({
        date: "2026-11-20",
        label: "11月20日（周五）",
        daysUntil: 4,
        inDateStrip: true,
        displayText: "跳到下一轮比赛日：11月20日（周五）→",
      });
    } finally {
      Date.prototype.toLocaleString = toLocaleString;
      Date.prototype.toLocaleDateString = toLocaleDateString;
    }
  });
});
