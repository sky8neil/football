import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

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
