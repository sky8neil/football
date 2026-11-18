import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

const { formatLevelSeasonLabel } = (() => {
  const module = { exports: {} };
  const factory = runInThisContext(
    `(function(module, exports) {\n${readFileSync(join(HERE, "level-season.js"), "utf8")}\n})`,
    { filename: join(HERE, "level-season.js") },
  );
  factory(module, module.exports);
  return module.exports;
})();

describe("formatLevelSeasonLabel", () => {
  it("formats a normal level season id with a Chinese dash", () => {
    expect(formatLevelSeasonLabel("2026_2027")).toBe("2026—2027 赛季");
  });

  it("joins underscore-form ids with an em dash instead of the underscore", () => {
    expect(formatLevelSeasonLabel("2025_2026")).toBe("2025—2026 赛季");
    expect(formatLevelSeasonLabel("2025_2026")).not.toContain("_");
    expect(formatLevelSeasonLabel("2025_2026")).toContain("—");
  });

  it("returns an empty string for missing values", () => {
    expect(formatLevelSeasonLabel("")).toBe("");
    expect(formatLevelSeasonLabel(null)).toBe("");
    expect(formatLevelSeasonLabel(undefined)).toBe("");
  });

  it("returns an empty string for values that are not XXXX_XXXX", () => {
    expect(formatLevelSeasonLabel("2026")).toBe("");
    expect(formatLevelSeasonLabel("2026-2027")).toBe("");
    expect(formatLevelSeasonLabel("2026_27")).toBe("");
    expect(formatLevelSeasonLabel("abcd_efgh")).toBe("");
    expect(formatLevelSeasonLabel("2026_2027_2028")).toBe("");
  });
});
