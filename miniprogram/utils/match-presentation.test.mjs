import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

const presentation = (() => {
  const module = { exports: {} };
  const factory = runInThisContext(
    `(function(module, exports) {\n${readFileSync(join(HERE, "match-presentation.js"), "utf8")}\n})`,
    { filename: join(HERE, "match-presentation.js") },
  );
  factory(module, module.exports);
  return module.exports;
})();

const { formatRound, formatKickoff, formatShanghaiDate } = presentation;

const originalLocaleString = Date.prototype.toLocaleString;
const originalLocaleDateString = Date.prototype.toLocaleDateString;

afterEach(() => {
  Date.prototype.toLocaleString = originalLocaleString;
  Date.prototype.toLocaleDateString = originalLocaleDateString;
});

function disableLocaleFormatting() {
  Date.prototype.toLocaleString = () => {
    throw new RangeError("locale data missing");
  };
  Date.prototype.toLocaleDateString = () => {
    throw new RangeError("locale data missing");
  };
}

describe("formatRound", () => {
  it("formats a numeric round as 第 N 轮", () => {
    expect(formatRound(10)).toBe("第 10 轮");
    expect(formatRound("10")).toBe("第 10 轮");
  });

  it("keeps labeled rounds and knockout stages unchanged", () => {
    expect(formatRound("第10轮")).toBe("第10轮");
    expect(formatRound("半决赛")).toBe("半决赛");
    expect(formatRound("1/4决赛")).toBe("1/4决赛");
  });

  it("returns an empty string for missing or blank values", () => {
    expect(formatRound("")).toBe("");
    expect(formatRound(null)).toBe("");
    expect(formatRound(undefined)).toBe("");
    expect(formatRound("   ")).toBe("");
  });

  it("trims surrounding whitespace before formatting", () => {
    expect(formatRound(" 10 ")).toBe("第 10 轮");
    expect(formatRound(" 半决赛 ")).toBe("半决赛");
    expect(formatRound(" 第10轮 ")).toBe("第10轮");
  });
});

describe("formatKickoff", () => {
  it("formats kickoff in Beijing time without locale APIs", () => {
    disableLocaleFormatting();
    expect(formatKickoff("2026-10-06T04:00:00.000Z")).toBe("10月6日周二 12:00");
    expect(formatKickoff("2026-10-06T15:59:00.000Z")).toBe("10月6日周二 23:59");
    expect(formatKickoff("2026-10-06T16:05:00.000Z")).toBe("10月7日周三 00:05");
  });

  it("returns an empty string for invalid values", () => {
    disableLocaleFormatting();
    expect(formatKickoff("")).toBe("");
    expect(formatKickoff(null)).toBe("");
    expect(formatKickoff("not-a-date")).toBe("");
  });
});

describe("formatShanghaiDate", () => {
  it("formats the Beijing calendar date without locale APIs", () => {
    disableLocaleFormatting();
    expect(formatShanghaiDate("2026-11-06T19:50:00.000Z")).toBe("2026/11/07");
    expect(formatShanghaiDate("2026-11-06T15:59:00.000Z")).toBe("2026/11/06");
    expect(formatShanghaiDate("2026-01-01T16:00:00.000Z")).toBe("2026/01/02");
  });

  it("returns an empty string for invalid values", () => {
    disableLocaleFormatting();
    expect(formatShanghaiDate("")).toBe("");
    expect(formatShanghaiDate(undefined)).toBe("");
    expect(formatShanghaiDate("not-a-date")).toBe("");
  });
});
