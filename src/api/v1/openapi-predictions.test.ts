import { readFile } from "node:fs/promises";
import Ajv from "ajv";
import YAML from "yaml";
import { describe, expect, it } from "vitest";

const SPEC_ID = "https://football.local/openapi.json";

const HISTORY_ITEM = {
  prediction_id: "00000000-0000-4000-8000-000000000020",
  match_id: "00000000-0000-4000-8000-000000000010",
  league_id: "premier_league",
  season_id: "2026_2027",
  round_id: "01",
  home_team_id: "00000000-0000-4000-8000-000000000031",
  away_team_id: "00000000-0000-4000-8000-000000000032",
  home_team: { team_id: "00000000-0000-4000-8000-000000000031", name: "Arsenal FC" },
  away_team: { team_id: "00000000-0000-4000-8000-000000000032", name: "Chelsea FC" },
  kickoff_at: "2026-08-08T14:00:00.000Z",
  pred_home_score: 2,
  pred_away_score: 1,
  derived_result: "HOME",
  submitted_at: "2026-08-08T12:00:00.000Z",
  scoring_rule_version: "scoring_v1",
  match_status: "finished",
  regular_home_score: 2,
  regular_away_score: 1,
  match_score: 12,
  wdl_hit: true,
  exact_hit: true,
};

describe("prediction submit OpenAPI contract", () => {
  it("declares the frozen POST /predictions request and 200/201 responses", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");

    expect(specification).toMatch(
      /  \/predictions:\n    post:[\s\S]*?\$ref: '#\/components\/schemas\/PredictionSubmitRequest'/,
    );
    expect(specification).toMatch(
      /  \/predictions:[\s\S]*?'200':[\s\S]*?PredictionSubmitEnvelope[\s\S]*?'201':[\s\S]*?PredictionSubmitEnvelope/,
    );
    expect(specification).toMatch(
      /  \/predictions:[\s\S]*?'429':[\s\S]*?RateLimited/,
    );
    expect(specification).toMatch(
      /    PredictionSubmitRequest:[\s\S]*?required: \[idempotency_key, match_id, home_score, away_score\][\s\S]*?additionalProperties: false/,
    );
    expect(specification).toMatch(
      /    PredictionSubmitData:[\s\S]*?required: \[prediction_id, match_id, pred_home_score, pred_away_score, derived_result, submitted_at, scoring_rule_version\]/,
    );
  });

  it("accepts PredictionHistoryItem only when home_team and away_team are present", async () => {
    const specification = YAML.parse(
      await readFile(new URL("./openapi.yaml", import.meta.url), "utf8"),
    ) as { components: { schemas: Record<string, unknown> } };
    const ajv = new Ajv({ nullable: false, allErrors: true });
    ajv.addSchema({ $id: SPEC_ID, components: specification.components });
    const validate = ajv.compile({
      $ref: `${SPEC_ID}#/components/schemas/PredictionHistoryItem`,
    });

    expect(validate(HISTORY_ITEM)).toBe(true);
    const withoutHomeTeam: Record<string, unknown> = { ...HISTORY_ITEM };
    delete withoutHomeTeam.home_team;
    expect(validate(withoutHomeTeam)).toBe(false);
  });

  it("declares the frozen 49.2 POST /predictions error codes", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");

    const postBlock = specification.match(/  \/predictions:\n    post:[\s\S]*?\n  \/predictions\/me:/);
    expect(postBlock).not.toBeNull();
    const post = postBlock?.[0] ?? "";

    expect(post).toMatch(/'401':\n          \$ref: '#\/components\/responses\/Unauthorized'/);
    expect(post).toMatch(/'409':\n          \$ref: '#\/components\/responses\/PredictionRejected'/);

    const rejected = specification.match(
      /    PredictionRejected:\n      description: "409 预测拒绝（49.2 映射）：([\s\S]*?)"\n/,
    );
    expect(rejected).not.toBeNull();
    expect(rejected?.[1]).toMatch(/USER_DELETED/);
    expect(rejected?.[1]).toMatch(/PREDICTION_ALREADY_SUBMITTED/);
    expect(rejected?.[1]).toMatch(/MATCH_NOT_PREDICTABLE/);
    expect(rejected?.[1]).toMatch(/PREDICTION_LOCKED/);

    expect(specification).toMatch(/    Unauthorized:\n      description: 401 UNAUTHORIZED/);
  });
});
