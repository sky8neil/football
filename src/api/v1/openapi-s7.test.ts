import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const pathBlock = (specification: string, path: string): string => {
  const start = specification.indexOf(`  ${path}:\n`);
  const nextPath = specification.indexOf("\n  /", start + 1);
  return start === -1 ? "" : specification.slice(start, nextPath === -1 ? undefined : nextPath);
};

describe("S7 OpenAPI baseline", () => {
  it("declares the v2.0 profile, group, share-card, and admin handlers", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
    expect(specification).toMatch(/version: 2\.0\.0/);

    const operations = [
      ["/profile/me", "get"],
      ["/profile/me", "patch"],
      ["/profile/me", "delete"],
      ["/profiles/{user_id}", "get"],
      ["/predictions/me/{prediction_id}", "get"],
      ["/share-card/me", "get"],
      ["/admin/anomalies", "get"],
      ["/admin/matches/{match_id}/result-corrections", "post"],
      ["/admin/matches/{match_id}/retry-settlement", "post"],
      ["/admin/rebuild/users/{user_id}", "post"],
      ["/admin/rebuild/rankings", "post"],
      ["/groups", "post"],
      ["/groups/join", "post"],
      ["/groups/{group_id}/leave", "post"],
      ["/groups/{group_id}", "delete"],
      ["/groups/me", "get"],
      ["/groups/{group_id}", "get"],
    ] as const;

    for (const [path, method] of operations) {
      expect(pathBlock(specification, path)).toContain(`\n    ${method}:\n`);
    }
  });

  it("matches profile, ranking, share-card, and match response shapes", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
    const rankings = pathBlock(specification, "/rankings");
    const shareCard = pathBlock(specification, "/share-card/me");

    expect(rankings).toContain("name: board");
    expect(rankings).toContain("name: level_season_id");
    expect(rankings).toContain("enum: [week, career, strength, season]");
    expect(rankings).toContain("x-requires-trusted-openid: true");
    expect(rankings).not.toContain("security:");
    expect(rankings).toContain("'401':");
    expect(rankings).toContain("'409':");
    expect(rankings).toContain("#/components/responses/Unauthorized");
    expect(rankings).toContain("#/components/responses/RankingUserDeleted");
    expect(rankings).toContain("#/components/responses/NotFound");
    expect(rankings).toContain("'404':");
    expect(rankings).not.toContain("enum: [week, month]");
    expect(specification).toMatch(
      /RankingData:[\s\S]*?required: \[board, scope, period_key, updated_at, server_now, available_boards, seasons_participated, entry_count, items, page, me\]/,
    );
    expect(specification).toMatch(/        server_now:[\s\S]*?format: date-time/);
    expect(specification).toContain("current_period_key:");
    expect(specification).toContain("available_level_seasons:");
    expect(specification).toContain("SeasonRankingItem:");
    expect(specification).toMatch(/const: not_eligible[\s\S]*?seasons_participated:/);
    expect(shareCard).toContain("name: league_id");
    expect(shareCard).toContain("name: season_id");
    expect(shareCard).toContain("name: round_id");

    expect(specification).toMatch(
      /    MyProfileData:[\s\S]*?required: \[user_id, nickname, favorite_team_id, career_points, career_valid_predictions, career_exact_hits, career_level, career_best_level, season_level, previous_season\]/,
    );
    expect(specification).toMatch(
      /    PublicProfileData:[\s\S]*?required: \[user_id, display_name, favorite_team_id, career_points, career_valid_predictions, career_exact_hits, career_level, career_best_level, season_level\]/,
    );
    expect(specification).toMatch(/    MatchListItem:[\s\S]*?league_id:/);
    expect(specification).toMatch(/    PredictionHistoryItem:[\s\S]*?league_id:/);
    expect(specification).not.toContain("wdl_accuracy");

    expect(pathBlock(specification, "/predictions/me/{prediction_id}")).toContain(
      "#/components/responses/PredictionHistoryConflict",
    );
    expect(specification).toMatch(
      /SessionInitRequest:[\s\S]*?nickname:[\s\S]*?description: 按 Unicode grapheme 计数，长度为 1\.\.32。/,
    );
    expect(specification).toMatch(
      /ProfilePatchRequest:[\s\S]*?nickname:[\s\S]*?description: 按 Unicode grapheme 计数，长度为 1\.\.32。/,
    );
    expect(specification).toMatch(
      /AdminResultCorrectionData:[\s\S]*?settlement_status:[\s\S]*?enum: \[waiting, correcting\]/,
    );
  });

  it("documents the six group operations and their response schemas", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
    const expected = [
      ["/groups", "post", "CreateGroupEnvelope"],
      ["/groups/join", "post", "JoinGroupEnvelope"],
      ["/groups/{group_id}/leave", "post", "'204'"],
      ["/groups/{group_id}", "delete", "'204'"],
      ["/groups/me", "get", "MyGroupsEnvelope"],
      ["/groups/{group_id}", "get", "GroupEnvelope"],
    ] as const;

    for (const [path, method, schema] of expected) {
      const block = pathBlock(specification, path);
      expect(block).toContain(`\n    ${method}:\n`);
      expect(block).toContain(schema);
    }

    const myGroups = pathBlock(specification, "/groups/me");
    expect(myGroups).toContain("name: limit");
    expect(myGroups).toContain("name: cursor");
    expect(myGroups).toContain("'422':");
    expect(myGroups).toContain("'409':");
    expect(myGroups).toContain("'404':");
    expect(myGroups).toContain("opaque keyset");
    expect(myGroups).not.toContain("一次返回完整列表");
  });
});
