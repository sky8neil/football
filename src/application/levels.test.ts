import { describe, expect, it } from "vitest";
import { FIXED_CONFIG_V1, MVP_SEASON } from "../domain/config.js";
import type { User, UserSeasonStats } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { LevelsQueryService } from "./levels.js";
import { defaultLevelState } from "../domain/types.js";

const NOW = new Date("2026-08-10T00:00:00.000Z");

function makeUser(overrides: Partial<User> = {}): User {
  return {
    schema_version: 1,
    user_id: "00000000-0000-4000-8000-000000000001",
    openid: "openid-levels",
    unionid: null,
    nickname: "Sky",
    favorite_team_id: null,
    status: "active",
    career_points: 428,
    career_valid_predictions: 76,
    career_wdl_hits: 46,
    career_exact_hits: 8,
    career_level: 6,
    career_best_level: 6,
    career_last_scoring_match_at: null,
    career_level_state: defaultLevelState(),
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeSeasonStats(overrides: Partial<UserSeasonStats> = {}): UserSeasonStats {
  return {
    schema_version: 1,
    user_id: "00000000-0000-4000-8000-000000000001",
    level_season_id: MVP_SEASON.season_id,
    points: 120,
    valid_predictions: 20,
    wdl_hits: 12,
    exact_hits: 3,
    last_scoring_match_at: NOW,
    level: 4,
    best_level: 5,
    level_state: defaultLevelState(),
    is_level_frozen: false,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe("LevelsQueryService", () => {
  it("returns the public career and season level shape", async () => {
    const repo = new InMemoryRepository();
    const lastEval = new Date("2026-08-03T02:00:00.000Z");
    const user = makeUser({
      career_level_state: { ...defaultLevelState(), last_eval_as_of: lastEval },
    });
    await repo.users.insert(user);
    await repo.userSeasonStats.insert(makeSeasonStats());

    await expect(new LevelsQueryService(repo).getLevels(user.user_id, NOW)).resolves.toEqual({
      season: {
        level_season_id: MVP_SEASON.season_id,
        level: 4,
        best_level: 5,
        is_rated: true,
        valid_predictions: 20,
        remaining_to_rated: 0,
        is_frozen: false,
      },
      career: {
        level: 6,
        best_level: 6,
        is_rated: true,
        valid_predictions: 76,
        remaining_to_rated: 0,
        last_evaluated_at: lastEval.toISOString(),
        next_evaluation_at: "2026-08-10T02:00:00.000Z",
        is_former_top: false,
      },
      rule_version: FIXED_CONFIG_V1.LEVEL_RULE_VERSION,
    });
  });

  it("uses a zero current-season view when no season stats document exists", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({
      career_points: 0,
      career_valid_predictions: 0,
      career_wdl_hits: 0,
      career_exact_hits: 0,
      career_level: 1,
      career_best_level: 1,
    });
    await repo.users.insert(user);

    await expect(new LevelsQueryService(repo).getLevels(user.user_id, NOW)).resolves.toMatchObject({
      season: {
        level_season_id: MVP_SEASON.season_id,
        level: 1,
        best_level: 1,
        is_rated: false,
        valid_predictions: 0,
        remaining_to_rated: FIXED_CONFIG_V1.LEVEL_RATED_MIN_VALID,
        is_frozen: false,
      },
      rule_version: FIXED_CONFIG_V1.LEVEL_RULE_VERSION,
    });
  });

  it("exposes the former-top flag and cached frozen state", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({ career_level: 5, career_best_level: 6 });
    await repo.users.insert(user);
    await repo.userSeasonStats.insert(makeSeasonStats({ is_level_frozen: true }));

    const levels = await new LevelsQueryService(repo).getLevels(user.user_id, NOW);
    expect(levels.career.is_former_top).toBe(true);
    expect(levels.season.is_frozen).toBe(true);
  });

  it("rejects deleted users and invalid user ids", async () => {
    const repo = new InMemoryRepository();
    const deleted = makeUser({
      status: "deleted",
      nickname: null,
      deleted_at: NOW,
    });
    await repo.users.insert(deleted);

    await expect(new LevelsQueryService(repo).getLevels(deleted.user_id, NOW)).rejects.toMatchObject({
      code: "USER_DELETED",
    });
    await expect(new LevelsQueryService(repo).getLevels("not-a-uuid", NOW)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});
