import { describe, expect, it } from "vitest";
import { TeamStatus, UserStatus } from "../domain/enums.js";
import type { Team, User } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { ProfileMutationService } from "./profile-mutation.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");

function makeUser(overrides: Partial<User> = {}): User {
  return {
    schema_version: 1,
    user_id: "00000000-0000-4000-8000-000000000010",
    openid: "openid-profile-mutation",
    unionid: "unionid-1",
    nickname: "Sky",
    favorite_team_id: "00000000-0000-4000-8000-000000000011",
    status: UserStatus.Active,
    career_points: 12,
    career_valid_predictions: 1,
    career_wdl_hits: 1,
    career_exact_hits: 1,
    career_level: 1,
    career_best_level: 1,
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    schema_version: 1,
    team_id: "00000000-0000-4000-8000-000000000011",
    name: "Arsenal",
    short_name: "ARS",
    primary_color: null,
    secondary_color: null,
    status: TeamStatus.Active,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe("ProfileMutationService.updateMyProfile", () => {
  it("无效 server_now 时 Fail Closed，且不更新资料", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);

    await expect(
      new ProfileMutationService(repo).updateMyProfile(
        user.user_id,
        { nickname: "Alice" },
        new Date("invalid"),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "server_now" },
    });
    await expect(repo.users.findById(user.user_id)).resolves.toEqual(user);
  });

  it("在事务内 trim nickname 并设置 active 主队，保留其它用户事实", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    const team = makeTeam();
    await repo.users.insert(user);
    await repo.teams.insert(team);

    await expect(
      new ProfileMutationService(repo).updateMyProfile(user.user_id, {
        nickname: "  Alice  ",
        favorite_team_id: team.team_id,
      }, NOW),
    ).resolves.toMatchObject({
      user_id: user.user_id,
      nickname: "Alice",
      favorite_team_id: team.team_id,
    });

    await expect(repo.users.findById(user.user_id)).resolves.toMatchObject({
      user_id: user.user_id,
      openid: user.openid,
      nickname: "Alice",
      favorite_team_id: team.team_id,
      career_points: user.career_points,
      updated_at: NOW,
    });
  });

  it("允许显式清空主队，并拒绝空 patch、无效或非 active team", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);
    const inactiveTeam = makeTeam({
      team_id: "00000000-0000-4000-8000-000000000012",
      status: TeamStatus.Inactive,
    });
    await repo.teams.insert(inactiveTeam);
    const service = new ProfileMutationService(repo);

    await expect(service.updateMyProfile(user.user_id, {}, NOW)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      service.updateMyProfile(user.user_id, { favorite_team_id: "not-a-uuid" }, NOW),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      service.updateMyProfile(user.user_id, { favorite_team_id: inactiveTeam.team_id }, NOW),
    ).rejects.toMatchObject({ code: "TEAM_NOT_FOUND" });

    await expect(
      service.updateMyProfile(user.user_id, { favorite_team_id: null }, NOW),
    ).resolves.toMatchObject({ favorite_team_id: null });
    await expect(repo.users.findById(user.user_id)).resolves.toMatchObject({
      nickname: user.nickname,
      favorite_team_id: null,
    });
  });

  it("已注销用户不能更新资料", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({ status: UserStatus.Deleted, nickname: null });
    await repo.users.insert(user);

    await expect(
      new ProfileMutationService(repo).updateMyProfile(user.user_id, { nickname: "Alice" }, NOW),
    ).rejects.toMatchObject({ code: "USER_DELETED" });
  });
});

describe("ProfileMutationService.deleteMyProfile", () => {
  it("无效 server_now 时 Fail Closed，且不注销用户", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);

    await expect(
      new ProfileMutationService(repo).deleteMyProfile(user.user_id, new Date("invalid")),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "server_now" },
    });
    await expect(repo.users.findById(user.user_id)).resolves.toEqual(user);
  });

  it("将 active 用户写成规范定义的注销墓碑并保留 user_id", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);

    await expect(
      new ProfileMutationService(repo).deleteMyProfile(user.user_id, NOW),
    ).resolves.toEqual({ user_id: user.user_id, deleted: true });

    await expect(repo.users.findById(user.user_id)).resolves.toMatchObject({
      user_id: user.user_id,
      openid: `deleted:${user.user_id}`,
      unionid: null,
      nickname: null,
      favorite_team_id: null,
      status: UserStatus.Deleted,
      deleted_at: NOW,
      updated_at: NOW,
    });
    await expect(repo.users.findByOpenid(user.openid)).resolves.toBeNull();
  });

  it("用户不存在或已注销时拒绝写入，且不产生 mapping", async () => {
    const repo = new InMemoryRepository();
    const service = new ProfileMutationService(repo);

    await expect(service.deleteMyProfile(makeUser().user_id, NOW)).rejects.toMatchObject({
      code: "USER_NOT_FOUND",
    });
    expect(await repo.deletedOpenidMappings.findByOriginalOpenid("openid-profile-mutation")).toBeNull();

    const user = makeUser();
    await repo.users.insert({ ...user, status: UserStatus.Deleted, nickname: null });
    await expect(service.deleteMyProfile(user.user_id, NOW)).rejects.toMatchObject({
      code: "USER_DELETED",
    });
    expect(await repo.deletedOpenidMappings.findByOriginalOpenid(user.openid)).toBeNull();
  });

  it("D1：注销同事务写入 deleted_openid_mappings（original_openid → user_id）", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);

    await new ProfileMutationService(repo).deleteMyProfile(user.user_id, NOW);

    const mapping = await repo.deletedOpenidMappings.findByOriginalOpenid(user.openid);
    expect(mapping).toMatchObject({
      original_openid: user.openid,
      deleted_user_id: user.user_id,
      deleted_at: NOW,
      created_at: NOW,
      updated_at: NOW,
      schema_version: 1,
    });
    const byUserId = await repo.deletedOpenidMappings.findByDeletedUserId(user.user_id);
    expect(byUserId).toBe(mapping);
  });

  it("D9：同 openid 重注册后再注销，mapping upsert 到新 deleted_user_id，旧 user 仍墓碑", async () => {
    const repo = new InMemoryRepository();
    const service = new ProfileMutationService(repo);
    const first = makeUser();
    await repo.users.insert(first);
    await service.deleteMyProfile(first.user_id, NOW);

    const second = makeUser({ user_id: "00000000-0000-4000-8000-000000000020", nickname: "Alice" });
    await repo.users.insert(second);
    const later = new Date("2026-08-10T00:00:00.000Z");
    await service.deleteMyProfile(second.user_id, later);

    const mapping = await repo.deletedOpenidMappings.findByOriginalOpenid(first.openid);
    expect(mapping).toMatchObject({
      deleted_user_id: second.user_id,
      deleted_at: later,
      created_at: NOW,
      updated_at: later,
    });
    const firstUser = await repo.users.findById(first.user_id);
    expect(firstUser).toMatchObject({
      openid: `deleted:${first.user_id}`,
      status: UserStatus.Deleted,
    });
  });

});
