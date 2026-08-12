import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("levels OpenAPI contract", () => {
  it("declares GET /levels/me and both level scopes", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");

    expect(specification).toMatch(
      /  \/levels\/me:\n    get:[\s\S]*?\$ref: '#\/components\/schemas\/LevelsEnvelope'/,
    );
    expect(specification).toMatch(
      /  \/levels\/me:\n    get:[\s\S]*?'429':[\s\S]*?RateLimited/,
    );
    expect(specification).toMatch(
      /    LevelsData:[\s\S]*?required: \[season, career\][\s\S]*?season:[\s\S]*?SeasonLevelStatsData[\s\S]*?career:[\s\S]*?LevelStatsData/,
    );
  });
});
