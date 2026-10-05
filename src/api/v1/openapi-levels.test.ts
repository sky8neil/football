import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("levels OpenAPI contract", () => {
  it("declares GET /levels/me using the public v2.0 level shape", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");

    expect(specification).toMatch(
      /  \/levels\/me:\n    get:[\s\S]*?\$ref: '#\/components\/schemas\/LevelsEnvelope'/,
    );
    expect(specification).toMatch(
      /  \/levels\/me:\n    get:[\s\S]*?'429':[\s\S]*?RateLimited/,
    );
    expect(specification).toMatch(
      /    LevelsData:[\s\S]*?required: \[career, season, rule_version\][\s\S]*?career:[\s\S]*?CareerLevelData[\s\S]*?season:[\s\S]*?SeasonLevelData[\s\S]*?rule_version:/,
    );
    expect(specification).toMatch(
      /    CareerLevelData:[\s\S]*?required: \[level, best_level, is_rated, valid_predictions, remaining_to_rated, last_evaluated_at, next_evaluation_at\][\s\S]*?is_former_top:/,
    );
    expect(specification).toMatch(
      /    SeasonLevelData:[\s\S]*?required: \[level_season_id, level, best_level, is_rated, valid_predictions, remaining_to_rated, is_frozen\]/,
    );
    expect(specification).not.toContain("wdl_accuracy_percent");
  });
});
