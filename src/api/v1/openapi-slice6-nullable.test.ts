import { readFile } from "node:fs/promises";
import Ajv, { type ValidateFunction } from "ajv";
import YAML from "yaml";
import { describe, expect, it } from "vitest";

const SPEC_ID = "https://football.local/openapi.json";

type OpenApiSpec = {
  openapi: string;
  components: { schemas: Record<string, unknown> };
};

const loadSpec = async (): Promise<OpenApiSpec> => {
  const text = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
  return YAML.parse(text) as OpenApiSpec;
};

const compileRef = (spec: OpenApiSpec, pointer: string): ValidateFunction => {
  const ajv = new Ajv({ nullable: false, allErrors: true });
  ajv.addSchema({ $id: SPEC_ID, components: spec.components });
  return ajv.compile({ $ref: `${SPEC_ID}${pointer}` });
};

const MY_PREDICTION_OBJECT = {
  prediction_id: "00000000-0000-4000-8000-000000000011",
  pred_home_score: 1,
  pred_away_score: 0,
  derived_result: "HOME",
  submitted_at: "2026-08-09T11:00:00.000Z",
  match_score: 12,
  wdl_hit: true,
  exact_hit: true,
};

const rankedWeek = (rank: unknown, topPercent: unknown) => ({
  status: "ranked",
  rank,
  top_percent: topPercent,
  period_score: 20,
  valid_predictions: 5,
  exact_hits: 1,
});

const rankedCareer = (rank: unknown, topPercent: unknown) => ({
  status: "ranked",
  rank,
  top_percent: topPercent,
  career_points: 40,
  career_valid_predictions: 8,
  exact_hits: 2,
});

const rankedSeason = (rank: unknown, topPercent: unknown) => ({
  status: "ranked",
  rank,
  top_percent: topPercent,
  season_points: 30,
  season_valid_predictions: 6,
  exact_hits: 1,
});

const rankedStrength = (rank: unknown, topPercent: unknown) => ({
  status: "ranked",
  rank,
  top_percent: topPercent,
  strength_index: "1.23",
  window_n: 50,
});

describe("Slice6 OpenAPI 3.1 nullable fields", () => {
  it("keeps the 3.1.0 declaration", async () => {
    const spec = await loadSpec();
    expect(spec.openapi).toBe("3.1.0");
  });

  it("accepts guest/unpredicted my_prediction=null and a prediction object, and rejects other types", async () => {
    const spec = await loadSpec();
    const validate = compileRef(spec, "#/components/schemas/MatchListItem/properties/my_prediction");

    expect(validate(null)).toBe(true);
    expect(validate(MY_PREDICTION_OBJECT)).toBe(true);
    expect(validate("prediction")).toBe(false);
    expect(validate(1)).toBe(false);
    expect(validate(true)).toBe(false);
    expect(validate([])).toBe(false);
  });

  it("accepts rank/top_percent as null or integer on all four ranked RankingMe branches, and still rejects mismatched types", async () => {
    const spec = await loadSpec();
    const validate = compileRef(spec, "#/components/schemas/RankingMe");
    const branches = [rankedWeek, rankedCareer, rankedSeason, rankedStrength];
    const allowedPairs = [
      [null, null],
      [null, 21],
      [1, null],
      [4, 10],
    ] as const;

    for (const make of branches) {
      for (const [rank, topPercent] of allowedPairs) {
        expect(validate(make(rank, topPercent))).toBe(true);
      }
      expect(validate(make("1", 10))).toBe(false);
      expect(validate(make(1, "10"))).toBe(false);
      expect(validate(make(1.5, 10))).toBe(false);
      expect(validate(make(1, true))).toBe(false);
    }

    expect(validate({
      status: "ranked",
      rank: 1,
      top_percent: 10,
      period_score: 20,
      valid_predictions: 5,
      exact_hits: 1,
      career_points: 40,
    })).toBe(false);
  });
});
