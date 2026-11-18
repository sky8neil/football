import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

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

const { formatRound, formatKickoff } = presentation;

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
  it("formats kickoff in Beijing time", () => {
    expect(formatKickoff("2026-10-06T04:00:00.000Z")).toMatch(/12:00/);
  });
});
