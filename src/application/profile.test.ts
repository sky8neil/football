import { describe, expect, it } from "vitest";
import { newUuid } from "../domain/ids.js";
import { MVP_SEASON } from "../domain/config.js";
import type { User, UserSeasonStats } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { ProfileQueryService } from "./profile.js";
import { defaultLevelState } from "../domain/types.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");

function makeUser(overrides: Partial<User> = {}): User {
  return {
    schema_version: 1,
    user_id: newUuid(),
    openid: `openid-${newUuid()}`,
    unionid: null,
    nickname: "Sky",
    favorite_team_id: newUuid(),
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

function makeSeasonStats(userId: string, overrides: Partial<UserSeasonStats> = {}): UserSeasonStats {
  return {
    schema_version: 1,
    user_id: userId,
    level_season_id: MVP_SEASON.season_id,
    points: 120,
    valid_predictions: 20,
    wdl_hits: 12,
    exact_hits: 3,
    level: 4,
    best_level: 5,
    level_state: defaultLevelState(),
    is_level_frozen: false,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe("ProfileQueryService", () => {
  it("返回当前 active 用户的私有完整生涯资料", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);

    await expect(new ProfileQueryService(repo).getMyProfile(user.user_id)).resolves.toEqual({
      user_id: user.user_id,
      nickname: "Sky",
      favorite_team_id: user.favorite_team_id,
      career_points: 428,
      career_valid_predictions: 76,
      career_exact_hits: 8,
      career_level: 6,
      career_best_level: 6,
      season_level: 1,
    });
  });

  it("从当前等级赛季缓存读取 season_level", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);
    await repo.userSeasonStats.insert(makeSeasonStats(user.user_id));

    await expect(new ProfileQueryService(repo).getMyProfile(user.user_id, NOW)).resolves.toMatchObject({
      season_level: 4,
    });
  });

  it("私有资料拒绝已注销用户", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({ status: "deleted", nickname: null, deleted_at: NOW });
    await repo.users.insert(user);

    await expect(new ProfileQueryService(repo).getMyProfile(user.user_id)).rejects.toMatchObject({
      code: "USER_DELETED",
    });
  });

  it("返回 active 用户公开战绩", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);
    await repo.userSeasonStats.insert(makeSeasonStats(user.user_id));

    await expect(new ProfileQueryService(repo).getPublicProfile(user.user_id, NOW)).resolves.toEqual({
      user_id: user.user_id,
      display_name: "Sky",
      favorite_team_id: user.favorite_team_id,
      career_points: 428,
      career_valid_predictions: 76,
      career_exact_hits: 8,
      career_level: 6,
      career_best_level: 6,
      season_level: 4,
    });
  });

  it("deleted 用户使用固定展示名并清空主队，但保留历史战绩", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({
      status: "deleted",
      nickname: null,
      favorite_team_id: null,
      deleted_at: NOW,
    });
    await repo.users.insert(user);

    await expect(new ProfileQueryService(repo).getPublicProfile(user.user_id)).resolves.toEqual({
      user_id: user.user_id,
      display_name: "已注销用户",
      favorite_team_id: null,
      career_points: 428,
      career_valid_predictions: 76,
      career_exact_hits: 8,
      career_level: 6,
      career_best_level: 6,
      season_level: 1,
    });
  });

  it("没有用户时返回 USER_NOT_FOUND", async () => {
    await expect(
      new ProfileQueryService(new InMemoryRepository()).getPublicProfile(newUuid()),
    ).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
  });

  it("不返回准确率字段", async () => {
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

    const result = await new ProfileQueryService(repo).getPublicProfile(user.user_id, NOW);
    expect(result).not.toHaveProperty("career_wdl_accuracy_percent");
  });
});
