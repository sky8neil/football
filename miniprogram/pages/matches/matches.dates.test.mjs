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
    if (id === "../../utils/nickname.js") return { resolveNickname: () => "", truncateNickname: (value) => value };
    if (id === "../../services/matches.js") return { listMatches: () => Promise.resolve({ statusCode: 200 }) };
    if (id === "../../services/leagues.js") return { getLeagueStatus: () => Promise.resolve({ statusCode: 200, data: { items: [] } }) };
    if (id === "../../utils/matches-default-league.js") return { resolveDefaultLeagueFromStatus: () => ({ leagueId: "premier_league", activeLeagueIds: [] }) };
    if (id === "../../services/predictions.js") return { createUuidV4: () => "", submitPrediction: () => Promise.resolve({}) };
    if (id === "../../utils/crowd-copy.js") return { COPY: { homeLink: "" } };
    throw new Error(`Unexpected require: ${id}`);
  });
}

const { buildDates, beijingParts } = loadDateHelpers();

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
        expect(dates[0].key).toBe(expectedKey);
        return dates.map(({ key }) => key);
      });
      expect(keysByZone[1]).toEqual(keysByZone[0]);
      expect(keysByZone[2]).toEqual(keysByZone[0]);
    }
  });

  it("builds eleven consecutive Beijing dates with the expected labels and two-digit days", () => {
    const dates = buildDates(new Date("2026-11-15T16:30:00.000Z"));
    const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

    expect(dates).toHaveLength(11);
    expect(dates[0].label).toBe("今天");
    expect(dates[1].label).toBe("明天");
    dates.forEach((date, index) => {
      expect(date.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(date.day).toMatch(/^\d{2}$/);
      expect(date.day).toBe(date.key.slice(-2));
      if (index > 1) {
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
