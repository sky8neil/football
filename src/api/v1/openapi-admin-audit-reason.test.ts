import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

function pathBlock(specification: string, path: string): string {
  const start = specification.indexOf(`  ${path}:\n`);
  const nextPath = specification.indexOf("\n  /", start + 1);
  return specification.slice(start, nextPath === -1 ? undefined : nextPath);
}

describe("admin write reason OpenAPI contract", () => {
  it("requires body reason only for manual correction and rankings rebuild", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");

    expect(pathBlock(specification, "/admin/matches/{match_id}/result-corrections"))
      .toContain("requestBody:");
    expect(specification).toMatch(
      /    AdminResultCorrectionRequest:[\s\S]*?required: \[expected_result_version, regular_home_score, regular_away_score, reason\]/,
    );

    expect(pathBlock(specification, "/admin/rebuild/rankings"))
      .toContain("requestBody:");
    expect(specification).toMatch(
      /    AdminRebuildRankingsRequest:[\s\S]*?required: \[period_type, period_key, reason\]/,
    );
  });

  it("does not declare a request body for retry or user stats rebuild", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");

    expect(pathBlock(specification, "/admin/matches/{match_id}/retry-settlement"))
      .not.toContain("requestBody:");
    expect(pathBlock(specification, "/admin/rebuild/users/{user_id}"))
      .not.toContain("requestBody:");
  });

  it("declares retry consistency failures as 500 INTERNAL_ERROR", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
    const retryPath = pathBlock(specification, "/admin/matches/{match_id}/retry-settlement");

    expect(retryPath).toContain("'500':");
    expect(retryPath).toContain("#/components/responses/InternalError");
  });

  it("declares 500 INTERNAL_ERROR for data consistency failures on every admin write", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
    const paths = [
      "/admin/matches/{match_id}/result-corrections",
      "/admin/matches/{match_id}/retry-settlement",
      "/admin/rebuild/users/{user_id}",
      "/admin/rebuild/rankings",
    ];

    for (const path of paths) {
      const block = pathBlock(specification, path);
      expect(block).toContain("'500':");
      expect(block).toContain("#/components/responses/InternalError");
    }
  });
});
