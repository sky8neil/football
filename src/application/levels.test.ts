import { describe, expect, it } from "vitest";
import { MVP_SEASON } from "../domain/config.js";
import type { User, UserSeasonStats } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { LevelsQueryService } from "./levels.js";

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
    career_best_level: 7,
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
    season_id: MVP_SEASON.season_id,
    points: 120,
    valid_predictions: 20,
    wdl_hits: 12,
    exact_hits: 3,
    level: 4,
    best_level: 5,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe("LevelsQueryService", () => {
  it("returns career and current MVP season level data with display accuracy", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);
    await repo.userSeasonStats.insert(makeSeasonStats());

    await expect(new LevelsQueryService(repo).getLevels(user.user_id)).resolves.toEqual({
      season: {
        season_id: MVP_SEASON.season_id,
        valid_predictions: 20,
        wdl_hits: 12,
        wdl_accuracy_percent: "60.0",
        level: 4,
        best_level: 5,
      },
      career: {
        valid_predictions: 76,
        wdl_hits: 46,
        wdl_accuracy_percent: "60.5",
        level: 6,
        best_level: 7,
      },
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

    await expect(new LevelsQueryService(repo).getLevels(user.user_id)).resolves.toMatchObject({
      season: {
        season_id: MVP_SEASON.season_id,
        valid_predictions: 0,
        wdl_hits: 0,
        wdl_accuracy_percent: null,
        level: 1,
        best_level: 1,
      },
    });
  });

  it("rejects deleted users and invalid user ids", async () => {
    const repo = new InMemoryRepository();
    const deleted = makeUser({
      status: "deleted",
      nickname: null,
      deleted_at: NOW,
    });
    await repo.users.insert(deleted);

    await expect(new LevelsQueryService(repo).getLevels(deleted.user_id)).rejects.toMatchObject({
      code: "USER_DELETED",
    });
    await expect(new LevelsQueryService(repo).getLevels("not-a-uuid")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});
