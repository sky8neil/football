import { describe, expect, it, vi } from "vitest";
import {
  AdminRole,
  AdminStatus,
  GroupMemberStatus,
  GroupStatus,
  MatchScoreValue,
  MatchStatus,
  PeriodType,
  Result,
  SettlementDocStatus,
  SettlementItemStatus,
  SettlementPhase,
  SettlementStatus,
  TeamStatus,
  UserStatus,
} from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import { calculatePeriodKey } from "../domain/time.js";
import type {
  Admin,
  Group,
  GroupMember,
  Match,
  MatchResult,
  Prediction,
  SettlementDoc,
  SettlementItem,
  Team,
  User,
  UserSeasonStats,
} from "../domain/types.js";
import { InMemoryRepository, type UnitOfWork } from "../infrastructure/repositories.js";
import { DailyConsistencyService, DAILY_CONSISTENCY_ANOMALY_MATCH_ID, DAILY_CONSISTENCY_MISMATCH_CODE } from "./daily-consistency-service.js";
import { RepositoryDailyConsistencySnapshotSource } from "./daily-consistency-snapshot.js";
import { ProfileMutationService } from "./profile-mutation.js";
import { ProfileQueryService } from "./profile.js";
import {
  SettlementItemApplicationService,
  rankingPeriodLockKey,
  rebuildSettlementWeekRanks,
} from "./settlement-item-application-service.js";
import { defaultLevelState } from "../domain/types.js";

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
    career_last_scoring_match_at: null,
    career_level_state: defaultLevelState(),
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
    league_id: "premier_league",
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

function makeGroup(overrides: Partial<Group> = {}): Group {
  return {
    schema_version: 1,
    group_id: "00000000-0000-4000-8000-000000000021",
    owner_user_id: "00000000-0000-4000-8000-000000000022",
    invite_code: "ABCDEFGH",
    status: GroupStatus.Active,
    member_count: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeGroupMember(
  groupId: string,
  userId: string,
  status: GroupMember["status"] = GroupMemberStatus.Active,
): GroupMember {
  return {
    schema_version: 1,
    group_id: groupId,
    user_id: userId,
    status,
    joined_at: NOW,
    left_at: status === GroupMemberStatus.Left ? NOW : null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeAdmin(overrides: Partial<Admin> = {}): Admin {
  return {
    schema_version: 1,
    admin_id: "00000000-0000-4000-8000-000000000031",
    openid: "openid-profile-mutation",
    status: AdminStatus.Active,
    role: AdminRole.Admin,
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

  it("支持更新 gender 为 male / female / undisclosed / null，未传时保留原值，非法值返回 422", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);
    const service = new ProfileMutationService(repo);

    for (const gender of ["male", "female", "undisclosed"] as const) {
      await expect(service.updateMyProfile(user.user_id, { gender }, NOW)).resolves.toMatchObject({
        gender,
      });
      await expect(repo.users.findById(user.user_id)).resolves.toMatchObject({ gender });
    }

    // 未传 gender 时保持原有值不变
    await expect(
      service.updateMyProfile(user.user_id, { nickname: "KeepGender" }, NOW),
    ).resolves.toMatchObject({
      nickname: "KeepGender",
      gender: "undisclosed",
    });
    await expect(repo.users.findById(user.user_id)).resolves.toMatchObject({
      nickname: "KeepGender",
      gender: "undisclosed",
    });

    // 允许显式清空为 null
    await expect(service.updateMyProfile(user.user_id, { gender: null }, NOW)).resolves.toMatchObject({
      gender: null,
    });
    await expect(repo.users.findById(user.user_id)).resolves.toMatchObject({ gender: null });

    // 非法值拒绝并返回 VALIDATION_ERROR
    for (const invalid of ["", "other", "MALE", 1, true, undefined]) {
      await expect(
        service.updateMyProfile(user.user_id, { gender: invalid }, NOW),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        details: { field: "gender" },
      });
    }
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

  it("将 active 用户写成规范定义的注销墓碑并保留 user_id，同时清空 gender", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({ gender: "male" });
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
      gender: null,
      status: UserStatus.Deleted,
      deleted_at: NOW,
      updated_at: NOW,
    });
    await expect(new ProfileQueryService(repo).getPublicProfile(user.user_id, NOW)).resolves.toMatchObject({
      user_id: user.user_id,
      display_name: "已注销用户",
      favorite_team_id: null,
      gender: null,
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

  it("注销账号同时将未冻结的 user_season_stats 标记为 is_level_frozen=true", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);
    await repo.userSeasonStats.insert({
      schema_version: 1,
      user_id: user.user_id,
      level_season_id: "2026_2027",
      points: 18,
      valid_predictions: 2,
      wdl_hits: 2,
      exact_hits: 1,
      last_scoring_match_at: NOW,
      level: 1,
      best_level: 1,
      level_state: defaultLevelState(),
      is_level_frozen: false,
      created_at: NOW,
      updated_at: NOW,
    });

    await new ProfileMutationService(repo).deleteMyProfile(user.user_id, NOW);
    await expect(
      repo.userSeasonStats.findByUserAndSeason(user.user_id, "2026_2027"),
    ).resolves.toMatchObject({
      is_level_frozen: true,
      points: 18,
      updated_at: NOW,
    });
  });

  it("A-S1-02：注销吊销原 openid 的全部 auth_sessions", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);
    const deletedOpenids: string[] = [];
    const authSessions = {
      async deleteByOpenid(openid: string) {
        deletedOpenids.push(openid);
        return 2;
      },
    };

    await new ProfileMutationService(repo, { authSessions })
      .deleteMyProfile(user.user_id, NOW);

    expect(deletedOpenids).toEqual([user.openid]);
  });

  it("auth_sessions 吊销失败时注销事务回滚，用户不会处于已注销但 Token 仍有效状态", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);
    const authSessions = {
      async deleteByOpenid(): Promise<number> {
        throw new Error("auth session store unavailable");
      },
    };

    await expect(
      new ProfileMutationService(repo, { authSessions }).deleteMyProfile(user.user_id, NOW),
    ).rejects.toThrow("auth session store unavailable");

    await expect(repo.users.findById(user.user_id)).resolves.toEqual(user);
    await expect(repo.deletedOpenidMappings.findByOriginalOpenid(user.openid)).resolves.toBeNull();
  });

  it("A-S5-05：注销退出全部 active 群并扣减 member_count，群主群保留 active", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);
    const ownedGroup = makeGroup({
      group_id: "00000000-0000-4000-8000-000000000041",
      owner_user_id: user.user_id,
      invite_code: "ABCDEFGH",
      member_count: 2,
    });
    const joinedGroup = makeGroup({
      group_id: "00000000-0000-4000-8000-000000000042",
      owner_user_id: "00000000-0000-4000-8000-000000000043",
      invite_code: "BCDEFGHJ",
      member_count: 3,
    });
    const leftMembershipGroup = makeGroup({
      group_id: "00000000-0000-4000-8000-000000000044",
      owner_user_id: "00000000-0000-4000-8000-000000000045",
      invite_code: "CDEFGHJK",
      member_count: 1,
    });
    for (const group of [ownedGroup, joinedGroup, leftMembershipGroup]) {
      await repo.groups.insert(group);
    }
    await repo.groupMembers.insert(makeGroupMember(ownedGroup.group_id, user.user_id));
    await repo.groupMembers.insert(makeGroupMember(ownedGroup.group_id, "00000000-0000-4000-8000-000000000046"));
    await repo.groupMembers.insert(makeGroupMember(joinedGroup.group_id, user.user_id));
    await repo.groupMembers.insert(makeGroupMember(leftMembershipGroup.group_id, user.user_id, GroupMemberStatus.Left));

    await new ProfileMutationService(repo).deleteMyProfile(user.user_id, NOW);

    await expect(repo.groupMembers.findByGroupAndUser(ownedGroup.group_id, user.user_id))
      .resolves.toMatchObject({
        status: GroupMemberStatus.Left,
        left_at: NOW,
        updated_at: NOW,
      });
    await expect(repo.groupMembers.findByGroupAndUser(joinedGroup.group_id, user.user_id))
      .resolves.toMatchObject({ status: GroupMemberStatus.Left, left_at: NOW });
    await expect(repo.groupMembers.findByGroupAndUser(leftMembershipGroup.group_id, user.user_id))
      .resolves.toMatchObject({
        status: GroupMemberStatus.Left,
        left_at: NOW,
        updated_at: NOW,
      });
    await expect(repo.groups.findById(ownedGroup.group_id)).resolves.toMatchObject({
      status: GroupStatus.Active,
      member_count: 1,
      updated_at: NOW,
    });
    await expect(repo.groups.findById(joinedGroup.group_id)).resolves.toMatchObject({
      status: GroupStatus.Active,
      member_count: 2,
      updated_at: NOW,
    });
    await expect(repo.groups.findById(leftMembershipGroup.group_id)).resolves.toMatchObject({
      status: GroupStatus.Active,
      member_count: 1,
    });
  });

  it("A-S8-04：注销禁用同 openid 的 active 管理员，其他管理员不受影响", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);
    const sameOpenidAdmin = makeAdmin({ openid: user.openid });
    const otherAdmin = makeAdmin({
      admin_id: "00000000-0000-4000-8000-000000000032",
      openid: "other-admin-openid",
    });
    await repo.admins.insert(sameOpenidAdmin);
    await repo.admins.insert(otherAdmin);

    await new ProfileMutationService(repo).deleteMyProfile(user.user_id, NOW);

    await expect(repo.admins.findByOpenid(user.openid)).resolves.toMatchObject({
      admin_id: sameOpenidAdmin.admin_id,
      status: AdminStatus.Disabled,
      updated_at: NOW,
    });
    await expect(repo.admins.findByOpenid(otherAdmin.openid)).resolves.toEqual(otherAdmin);
  });

  it("事务内存在 authSessions 端口时优先使用，不调用事务外的 store", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);
    const txDeleted: string[] = [];
    const outsideDeleted: string[] = [];
    const original = repo.withTransaction.bind(repo);
    repo.withTransaction = (async (fn) => original(async (tx) => {
      const proxied = new Proxy(tx, {
        get(target, prop) {
          if (prop === "authSessions") {
            return {
              deleteByOpenid: async (openid: string) => {
                txDeleted.push(openid);
                return 2;
              },
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return fn(proxied as UnitOfWork);
    })) as InMemoryRepository["withTransaction"];

    await new ProfileMutationService(repo, {
      authSessions: {
        deleteByOpenid: async (openid: string) => {
          outsideDeleted.push(openid);
          return 1;
        },
      },
    }).deleteMyProfile(user.user_id, NOW);

    expect(txDeleted).toEqual([user.openid]);
    expect(outsideDeleted).toEqual([]);
  });

  it("群成员在等群锁期间已被并发退群时，注销不重复扣减 member_count", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);
    const otherUserId = "00000000-0000-4000-8000-000000000047";
    const group = makeGroup({
      group_id: "00000000-0000-4000-8000-000000000048",
      owner_user_id: "00000000-0000-4000-8000-000000000049",
      invite_code: "DEFGHJKL",
      member_count: 2,
    });
    await repo.groups.insert(group);
    await repo.groupMembers.insert(makeGroupMember(group.group_id, user.user_id));
    await repo.groupMembers.insert(makeGroupMember(group.group_id, otherUserId));
    installConcurrentLeave(repo, group.group_id, user.user_id);

    await new ProfileMutationService(repo).deleteMyProfile(user.user_id, NOW);

    await expect(repo.groupMembers.findByGroupAndUser(group.group_id, user.user_id))
      .resolves.toMatchObject({
        status: GroupMemberStatus.Left,
        left_at: CONCURRENT_LEFT_AT,
        updated_at: CONCURRENT_LEFT_AT,
      });
    await expect(repo.groups.findById(group.group_id)).resolves.toMatchObject({
      status: GroupStatus.Active,
      member_count: 1,
      updated_at: CONCURRENT_LEFT_AT,
    });
  });

});

const SCORE_AT = new Date("2026-08-11T03:04:05.000Z");
const CONCURRENT_LEFT_AT = new Date("2026-08-09T00:30:00.000Z");

function installConcurrentLeave(
  repo: InMemoryRepository,
  groupId: string,
  userId: string,
): void {
  const original = repo.withTransaction.bind(repo);
  repo.withTransaction = (async (fn) => original(async (tx) => {
    const groups = tx.groups;
    const groupMembers = tx.groupMembers;
    if (groups === undefined || groupMembers === undefined) {
      throw new Error("测试需要 groups/groupMembers 仓储");
    }
    let simulated = false;
    const proxiedGroups = {
      ...groups,
      findByIdForUpdate: async (id: string) => {
        if (!simulated && id === groupId) {
          simulated = true;
          const member = await groupMembers.findByGroupAndUser(id, userId);
          if (member?.status === GroupMemberStatus.Active) {
            await groupMembers.update({
              ...member,
              status: GroupMemberStatus.Left,
              left_at: CONCURRENT_LEFT_AT,
              updated_at: CONCURRENT_LEFT_AT,
            });
            const current = await groups.findById(id);
            if (current !== null) {
              await groups.patchFields!(id, {
                member_count: Math.max(0, current.member_count - 1),
                updated_at: CONCURRENT_LEFT_AT,
              });
            }
          }
        }
        return groups.findByIdForUpdate!(id);
      },
    };
    const proxied = new Proxy(tx, {
      get(target, prop) {
        if (prop === "groups") return proxiedGroups;
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return fn(proxied as UnitOfWork);
  })) as InMemoryRepository["withTransaction"];
}

function installScoreRace(repo: InMemoryRepository, log: string[]): void {
  const injected = new Set<string>();
  const original = repo.withTransaction.bind(repo);
  repo.withTransaction = (async (fn) => original(async (tx) => {
    const rawUsers = tx.users;
    const rawStats = tx.userSeasonStats;
    const users = {
      ...rawUsers,
      findByIdForUpdate: async (userId: string) => {
        log.push(`users.findByIdForUpdate|${userId}`);
        const user = await rawUsers.findByIdForUpdate!(userId);
        if (user !== null && !injected.has(`user:${userId}`)) {
          injected.add(`user:${userId}`);
          await rawUsers.update({
            ...user,
            career_points: 7777,
            career_last_scoring_match_at: SCORE_AT,
          });
        }
        return user;
      },
      update: async (user: User) => {
        log.push(`users.update|${user.user_id}`);
        return rawUsers.update(user);
      },
      patchFields: async (userId: string, fields: Partial<User>) => {
        log.push(`users.patchFields|${userId}|${Object.keys(fields).sort().join(",")}`);
        return rawUsers.patchFields!(userId, fields);
      },
    };
    const stats = rawStats === undefined ? undefined : {
      ...rawStats,
      findByUserAndSeasonForUpdate: async (userId: string, seasonId: string) => {
        log.push(`stats.findByUserAndSeasonForUpdate|${seasonId}`);
        const row = await rawStats.findByUserAndSeasonForUpdate!(userId, seasonId);
        const key = `stats:${userId}:${seasonId}`;
        if (row !== null && !injected.has(key)) {
          injected.add(key);
          await rawStats.update({
            ...row,
            points: 8888,
            last_scoring_match_at: SCORE_AT,
          });
        }
        return row;
      },
      update: async (row: UserSeasonStats) => {
        log.push(`stats.update|${row.level_season_id}`);
        return rawStats.update(row);
      },
      patchFields: async (
        userId: string,
        seasonId: string,
        fields: Partial<UserSeasonStats>,
      ) => {
        log.push(`stats.patchFields|${seasonId}|${Object.keys(fields).sort().join(",")}`);
        return rawStats.patchFields!(userId, seasonId, fields);
      },
    };
    const proxied = new Proxy(tx, {
      get(target, prop) {
        if (prop === "users") return users;
        if (prop === "userSeasonStats") return stats;
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    log.push("tx:begin");
    try {
      return await fn(proxied as UnitOfWork);
    } finally {
      log.push("tx:end");
    }
  })) as InMemoryRepository["withTransaction"];
}

function writeTransactions(log: string[]): string[][] {
  const groups: string[][] = [];
  let current: string[] | null = null;
  for (const line of log) {
    if (line === "tx:begin") current = [];
    else if (line === "tx:end") {
      if (current !== null) groups.push(current);
      current = null;
    } else if (current !== null) current.push(line);
  }
  return groups.filter((events) => events.some((event) =>
    event.startsWith("users.patchFields") ||
    event.startsWith("stats.patchFields") ||
    event.startsWith("users.update") ||
    event.startsWith("stats.update") ||
    event.includes("ForUpdate"),
  ));
}

function seasonStats(
  userId: string,
  levelSeasonId: string,
  points: number,
  isLevelFrozen: boolean,
): UserSeasonStats {
  return {
    schema_version: 1,
    user_id: userId,
    level_season_id: levelSeasonId,
    points,
    valid_predictions: 20,
    wdl_hits: 1,
    exact_hits: 1,
    last_scoring_match_at: NOW,
    level: 1,
    best_level: 1,
    level_state: defaultLevelState(),
    is_level_frozen: isLevelFrozen,
    created_at: NOW,
    updated_at: NOW,
  };
}

describe("ProfileMutationService A-S4-01", () => {
  it("更新资料时行锁用户并局部写入，不覆盖并发结算积分", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    const team = makeTeam();
    await repo.users.insert(user);
    await repo.teams.insert(team);
    const log: string[] = [];
    installScoreRace(repo, log);

    await new ProfileMutationService(repo).updateMyProfile(user.user_id, {
      nickname: "Alice",
      favorite_team_id: team.team_id,
    }, NOW);

    expect(writeTransactions(log)).toEqual([[
      `users.findByIdForUpdate|${user.user_id}`,
      `users.patchFields|${user.user_id}|favorite_team_id,nickname,updated_at`,
    ]]);
    await expect(repo.users.findById(user.user_id)).resolves.toMatchObject({
      nickname: "Alice",
      favorite_team_id: team.team_id,
      career_points: 7777,
      career_valid_predictions: user.career_valid_predictions,
      career_wdl_hits: user.career_wdl_hits,
      career_exact_hits: user.career_exact_hits,
      career_last_scoring_match_at: SCORE_AT,
      career_level: user.career_level,
      updated_at: NOW,
    });
  });

  it("注销按 users 后 user_season_stats 的 id 升序加锁，只冻结未冻结赛季且不覆盖积分", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);
    await repo.userSeasonStats.insert(seasonStats(user.user_id, "2027_2028", 4, false));
    await repo.userSeasonStats.insert(seasonStats(user.user_id, "2025_2026", 9, true));
    await repo.userSeasonStats.insert(seasonStats(user.user_id, "2026_2027", 18, false));
    const log: string[] = [];
    installScoreRace(repo, log);

    await new ProfileMutationService(repo).deleteMyProfile(user.user_id, NOW);

    expect(writeTransactions(log)).toEqual([[
      `users.findByIdForUpdate|${user.user_id}`,
      `users.patchFields|${user.user_id}|deleted_at,favorite_team_id,gender,nickname,openid,status,unionid,updated_at`,
      "stats.findByUserAndSeasonForUpdate|2025_2026",
      "stats.findByUserAndSeasonForUpdate|2026_2027",
      "stats.patchFields|2026_2027|is_level_frozen,updated_at",
      "stats.findByUserAndSeasonForUpdate|2027_2028",
      "stats.patchFields|2027_2028|is_level_frozen,updated_at",
    ]]);
    await expect(repo.users.findById(user.user_id)).resolves.toMatchObject({
      status: UserStatus.Deleted,
      openid: `deleted:${user.user_id}`,
      career_points: 7777,
      career_valid_predictions: user.career_valid_predictions,
      career_exact_hits: user.career_exact_hits,
      career_last_scoring_match_at: SCORE_AT,
    });
    await expect(repo.userSeasonStats.findByUserAndSeason(user.user_id, "2025_2026"))
      .resolves.toMatchObject({
        is_level_frozen: true,
        points: 8888,
        level: 1,
        last_scoring_match_at: SCORE_AT,
      });
    await expect(repo.userSeasonStats.findByUserAndSeason(user.user_id, "2026_2027"))
      .resolves.toMatchObject({
        is_level_frozen: true,
        points: 8888,
        valid_predictions: 20,
        level: 1,
        last_scoring_match_at: SCORE_AT,
      });
    await expect(repo.userSeasonStats.findByUserAndSeason(user.user_id, "2027_2028"))
      .resolves.toMatchObject({
        is_level_frozen: true,
        points: 8888,
        level: 1,
        last_scoring_match_at: SCORE_AT,
      });
  });
});

async function setupWeekRankingFixture(repo: InMemoryRepository) {
  const firstEval = new Date("2026-08-03T02:00:00.000Z");
  // 2026-08-08 (周六) 属于 2026-W32（周期至 2026-08-09T16:00:00Z 结束）
  const anchorAt = new Date("2026-08-08T06:00:00.000Z");
  const settledAt = new Date("2026-08-08T08:00:00.000Z");
  const deleteAt = new Date("2026-08-08T12:00:00.000Z");
  const checkAt = new Date("2026-08-09T00:00:00.000Z");
  const weekKey = calculatePeriodKey(PeriodType.Week, anchorAt);

  const u1 = makeUser({
    user_id: "00000000-0000-4000-8000-000000000101",
    openid: "openid-rank-del-1",
    nickname: "TopUser",
    favorite_team_id: null,
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    created_at: anchorAt,
    updated_at: anchorAt,
  });
  const u2 = makeUser({
    user_id: "00000000-0000-4000-8000-000000000102",
    openid: "openid-rank-del-2",
    nickname: "SecondUser",
    favorite_team_id: null,
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    created_at: anchorAt,
    updated_at: anchorAt,
  });
  await repo.users.insert(u1);
  await repo.users.insert(u2);

  const matchId = newUuid();
  const match: Match = {
    schema_version: 1,
    match_id: matchId,
    canonical_match_id: matchId,
    superseded_by: null,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: newUuid(),
    away_team_id: newUuid(),
    kickoff_at: anchorAt,
    kickoff_confirmed: true,
    prediction_deadline_at: new Date(anchorAt.getTime() - 600_000),
    prediction_closed_at: new Date(anchorAt.getTime() - 600_000),
    period_anchor_at: anchorAt,
    match_status: MatchStatus.Finished,
    settlement_status: SettlementStatus.Settled,
    regular_home_score: 2,
    regular_away_score: 1,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 1,
    settled_result_version: 1,
    result_source: "provider",
    scoring_rule_version: "scoring_v1",
    finish_detected_at: settledAt,
    settled_at: settledAt,
    created_at: anchorAt,
    updated_at: anchorAt,
  };
  await repo.matches.insert(match);

  const matchResult: MatchResult = {
    schema_version: 1,
    match_id: matchId,
    result_version: 1,
    regular_home_score: 2,
    regular_away_score: 1,
    source: "provider",
    provider_status: "FT",
    admin_id: null,
    reason: null,
    created_at: settledAt,
  };
  await repo.matchResults.insert(matchResult);

  const p1: Prediction = {
    schema_version: 1,
    prediction_id: newUuid(),
    user_id: u1.user_id,
    match_id: matchId,
    canonical_match_id: matchId,
    idempotency_key: newUuid(),
    pred_home_score: 2,
    pred_away_score: 1,
    derived_result: Result.Home,
    submitted_at: new Date(anchorAt.getTime() - 3_600_000),
    scoring_rule_version: "scoring_v1",
    match_score: MatchScoreValue.Miss,
    wdl_hit: false,
    exact_hit: false,
    applied_result_version: 0,
    created_at: anchorAt,
    updated_at: anchorAt,
  };
  const p2: Prediction = {
    ...p1,
    prediction_id: newUuid(),
    user_id: u2.user_id,
    idempotency_key: newUuid(),
    pred_home_score: 1,
    pred_away_score: 0,
  };
  await repo.predictions.insert(p1);
  await repo.predictions.insert(p2);

  const settlementId = newUuid();
  const settlement: SettlementDoc = {
    schema_version: 1,
    settlement_id: settlementId,
    match_id: matchId,
    result_version: 1,
    rule_version: "scoring_v1",
    status: SettlementDocStatus.Running,
    phase: SettlementPhase.ApplyItems,
    is_correction: false,
    started_at: settledAt,
    settled_at: null,
    attempt_count: 1,
    last_error_code: null,
    last_error_message: null,
    created_at: settledAt,
    updated_at: settledAt,
  };
  await repo.settlements.insert(settlement);

  const makePendingItem = (predId: string, uid: string, score: MatchScoreValue, exact: boolean): SettlementItem => ({
    schema_version: 1,
    settlement_id: settlementId,
    prediction_id: predId,
    user_id: uid,
    old_score: MatchScoreValue.Miss,
    new_score: score,
    score_delta: score,
    old_wdl_hit: false,
    new_wdl_hit: true,
    old_exact_hit: false,
    new_exact_hit: exact,
    valid_prediction_delta: 1,
    source_result_version: 1,
    status: SettlementItemStatus.Pending,
    applied_at: null,
    attempt_count: 0,
    last_error_code: null,
    last_error_message: null,
    created_at: settledAt,
    updated_at: settledAt,
  });
  await repo.settlementItems.insert(makePendingItem(p1.prediction_id, u1.user_id, MatchScoreValue.ExactHit, true));
  await repo.settlementItems.insert(makePendingItem(p2.prediction_id, u2.user_id, MatchScoreValue.WdlHit, false));

  const itemService = new SettlementItemApplicationService(repo);
  await itemService.apply(settlementId, p1.prediction_id, settledAt);
  await itemService.apply(settlementId, p2.prediction_id, settledAt);
  await repo.settlements.update({
    ...settlement,
    status: SettlementDocStatus.Settled,
    phase: SettlementPhase.Done,
    settled_at: settledAt,
    updated_at: settledAt,
  });
  await rebuildSettlementWeekRanks(repo, anchorAt, settledAt);

  return { firstEval, anchorAt, settledAt, deleteAt, checkAt, weekKey, u1, u2 };
}

describe("ProfileMutationService CR42-04 / CR43-02 注销与未封板周榜原子重排", () => {
  it("锁序验证：先在事务外按序获取 ranking:week:* 锁，再进单事务原子注销与重排，每日对账无中间态", async () => {
    const repo = new InMemoryRepository();
    const { firstEval, deleteAt, checkAt, weekKey, u1, u2 } = await setupWeekRankingFixture(repo);

    expect(await repo.rankings.findByPeriodAndUser(PeriodType.Week, weekKey, u1.user_id))
      .toMatchObject({ period_score: 12, global_rank: 1, is_final: false });
    expect(await repo.rankings.findByPeriodAndUser(PeriodType.Week, weekKey, u2.user_id))
      .toMatchObject({ period_score: 3, global_rank: 2, is_final: false });

    const consistencyBefore = await new DailyConsistencyService(
      repo,
      new RepositoryDailyConsistencySnapshotSource(repo, firstEval),
      firstEval,
    ).run(checkAt);
    expect(consistencyBefore).toMatchObject({ kind: "completed", differences: [] });

    // 验证锁序与单事务提交：周榜锁必须在注销事务开始前获取、事务提交后逆序释放
    const lockTrace: string[] = [];
    let activeTxDepth = 0;
    let inTxMidCheck: Promise<unknown> | null = null;
    const jobLocks = repo.jobLocks;
    const origWithTx = repo.withTransaction.bind(repo);
    const origAcquire = jobLocks.acquire.bind(jobLocks);
    const origRelease = jobLocks.release.bind(jobLocks);
    const acquireSpy = vi.spyOn(jobLocks, "acquire").mockImplementation(async (key, owner, lease) => {
      lockTrace.push(`lock:${key}:inTx=${activeTxDepth}`);
      return origAcquire(key, owner, lease);
    });
    const releaseSpy = vi.spyOn(jobLocks, "release").mockImplementation(async (key, owner) => {
      lockTrace.push(`release:${key}:inTx=${activeTxDepth}`);
      return origRelease(key, owner);
    });
    const trackedRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "jobLocks") return jobLocks;
        if (prop === "withTransaction") {
          return (async (fn, options) => {
            activeTxDepth += 1;
            lockTrace.push("tx:enter");
            try {
              return await origWithTx(async (tx) => {
                const rawUsers = tx.users;
                const wrappedUsers = {
                  ...rawUsers,
                  patchFields: async (uid: string, fields: Parameters<NonNullable<typeof rawUsers.patchFields>>[1]) => {
                    await rawUsers.patchFields!(uid, fields);
                    // 模拟在用户写墓碑之后立刻并发发起每日对账，必须等原子事务提交后读取，差异恒为 0
                    inTxMidCheck ??= new DailyConsistencyService(
                      repo,
                      new RepositoryDailyConsistencySnapshotSource(repo, firstEval),
                      firstEval,
                    ).run(checkAt);
                  },
                };
                const wrappedTx = new Proxy(tx, {
                  get(txTarget, txProp, txReceiver) {
                    if (txProp === "users") return wrappedUsers;
                    const value = Reflect.get(txTarget, txProp, txReceiver);
                    return typeof value === "function" ? value.bind(txTarget) : value;
                  },
                });
                return fn(wrappedTx as UnitOfWork);
              }, options);
            } finally {
              lockTrace.push("tx:exit");
              activeTxDepth -= 1;
            }
          }) as InMemoryRepository["withTransaction"];
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    await new ProfileMutationService(trackedRepo).deleteMyProfile(u1.user_id, deleteAt);
    acquireSpy.mockRestore();
    releaseSpy.mockRestore();

    expect(lockTrace).toEqual([
      `lock:ranking:week:${weekKey}:inTx=0`,
      "tx:enter",
      "tx:exit",
      `release:ranking:week:${weekKey}:inTx=0`,
    ]);

    expect(await inTxMidCheck).toMatchObject({ kind: "completed", differences: [] });

    expect(await repo.rankings.findByPeriodAndUser(PeriodType.Week, weekKey, u1.user_id))
      .toMatchObject({ period_score: 12, global_rank: null, is_final: false });
    expect(await repo.rankings.findByPeriodAndUser(PeriodType.Week, weekKey, u2.user_id))
      .toMatchObject({ period_score: 3, global_rank: 1, is_final: false });

    const consistency = await new DailyConsistencyService(
      repo,
      new RepositoryDailyConsistencySnapshotSource(repo, firstEval),
      firstEval,
    ).run(checkAt);
    expect(consistency.kind).toBe("completed");
    if (consistency.kind === "completed") {
      expect(consistency.differences).toEqual([]);
    }
    const mismatchKey = `${DAILY_CONSISTENCY_ANOMALY_MATCH_ID}:${DAILY_CONSISTENCY_MISMATCH_CODE}`;
    expect(await repo.anomalies.findByKey(mismatchKey)).toBeNull();
  });

  it("锁竞争验证：周榜锁被占用时失败报错且账号保持 Active 与原名次不变，释放后重试原子生效", async () => {
    const repo = new InMemoryRepository();
    const { firstEval, deleteAt, checkAt, weekKey, u1, u2 } = await setupWeekRankingFixture(repo);
    const lockKey = rankingPeriodLockKey(PeriodType.Week, weekKey);
    const holderId = newUuid();
    expect(
      await repo.jobLocks.acquire(lockKey, holderId, new Date(Date.now() + 60_000)),
    ).toBe(true);

    const service = new ProfileMutationService(repo);
    await expect(service.deleteMyProfile(u1.user_id, deleteAt)).rejects.toMatchObject({
      code: "RANKING_REBUILD_ALREADY_RUNNING",
    });

    // 账号未被半注销，原 openid、状态、mapping 与周榜名次全部保持一致
    await expect(repo.users.findById(u1.user_id)).resolves.toMatchObject({
      user_id: u1.user_id,
      openid: u1.openid,
      nickname: u1.nickname,
      status: UserStatus.Active,
      deleted_at: null,
    });
    await expect(repo.deletedOpenidMappings.findByOriginalOpenid(u1.openid)).resolves.toBeNull();
    await expect(repo.rankings.findByPeriodAndUser(PeriodType.Week, weekKey, u1.user_id))
      .resolves.toMatchObject({ global_rank: 1 });
    await expect(repo.rankings.findByPeriodAndUser(PeriodType.Week, weekKey, u2.user_id))
      .resolves.toMatchObject({ global_rank: 2 });
    await expect(
      new DailyConsistencyService(
        repo,
        new RepositoryDailyConsistencySnapshotSource(repo, firstEval),
        firstEval,
      ).run(checkAt),
    ).resolves.toMatchObject({ kind: "completed", differences: [] });

    // 释放锁后重试：账号注销与周榜重排同事务原子生效
    await repo.jobLocks.release(lockKey, holderId);
    await expect(service.deleteMyProfile(u1.user_id, deleteAt)).resolves.toEqual({
      user_id: u1.user_id,
      deleted: true,
    });
    await expect(repo.users.findById(u1.user_id)).resolves.toMatchObject({
      user_id: u1.user_id,
      openid: `deleted:${u1.user_id}`,
      status: UserStatus.Deleted,
      deleted_at: deleteAt,
    });
    await expect(repo.rankings.findByPeriodAndUser(PeriodType.Week, weekKey, u1.user_id))
      .resolves.toMatchObject({ global_rank: null });
    await expect(repo.rankings.findByPeriodAndUser(PeriodType.Week, weekKey, u2.user_id))
      .resolves.toMatchObject({ global_rank: 1 });
    await expect(
      new DailyConsistencyService(
        repo,
        new RepositoryDailyConsistencySnapshotSource(repo, firstEval),
        firstEval,
      ).run(checkAt),
    ).resolves.toMatchObject({ kind: "completed", differences: [] });
  });

  it("多周锁序：按字典序获取多周锁，后一周失败时立即释放已获锁且未进事务，成功时逆序释放", async () => {
    const repo = new InMemoryRepository();
    const { deleteAt, weekKey, u1, u2 } = await setupWeekRankingFixture(repo);
    const nextWeekAnchor = new Date("2026-08-15T06:00:00.000Z");
    const nextWeekKey = calculatePeriodKey(PeriodType.Week, nextWeekAnchor);
    expect(weekKey < nextWeekKey).toBe(true);

    await repo.rankings.insert({
      schema_version: 1,
      period_type: PeriodType.Week,
      period_key: nextWeekKey,
      user_id: u1.user_id,
      period_score: 6,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 0,
      last_scoring_match_at: nextWeekAnchor,
      global_rank: 1,
      is_final: false,
      created_at: deleteAt,
      updated_at: deleteAt,
    });
    await repo.rankings.insert({
      schema_version: 1,
      period_type: PeriodType.Week,
      period_key: nextWeekKey,
      user_id: u2.user_id,
      period_score: 3,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 0,
      last_scoring_match_at: nextWeekAnchor,
      global_rank: 2,
      is_final: false,
      created_at: deleteAt,
      updated_at: deleteAt,
    });

    const events: string[] = [];
    let txCount = 0;
    const jobLocks = repo.jobLocks;
    const origAcquire = jobLocks.acquire.bind(jobLocks);
    const origRelease = jobLocks.release.bind(jobLocks);
    const origWithTx = repo.withTransaction.bind(repo);
    const acquireSpy = vi.spyOn(jobLocks, "acquire").mockImplementation(async (key, owner, lease) => {
      events.push(`acquire:${key}`);
      return origAcquire(key, owner, lease);
    });
    const releaseSpy = vi.spyOn(jobLocks, "release").mockImplementation(async (key, owner) => {
      events.push(`release:${key}`);
      return origRelease(key, owner);
    });
    const trackedRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "jobLocks") return jobLocks;
        if (prop === "withTransaction") {
          return (async (fn, options) => {
            txCount += 1;
            events.push("tx:enter");
            try {
              return await origWithTx(fn, options);
            } finally {
              events.push("tx:exit");
            }
          }) as InMemoryRepository["withTransaction"];
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const nextWeekLockKey = rankingPeriodLockKey(PeriodType.Week, nextWeekKey);
    const blockerOwner = newUuid();
    await origAcquire(nextWeekLockKey, blockerOwner, new Date(Date.now() + 60_000));

    await expect(
      new ProfileMutationService(trackedRepo).deleteMyProfile(u1.user_id, deleteAt),
    ).rejects.toMatchObject({ code: "RANKING_REBUILD_ALREADY_RUNNING" });

    expect(txCount).toBe(0);
    expect(await repo.jobLocks.isHeld(rankingPeriodLockKey(PeriodType.Week, weekKey), new Date())).toBe(false);
    expect(events[0]).toBe(`acquire:ranking:week:${weekKey}`);
    expect(events[events.length - 1]).toBe(`release:ranking:week:${weekKey}`);
    await expect(repo.users.findById(u1.user_id)).resolves.toMatchObject({ status: UserStatus.Active });

    await origRelease(nextWeekLockKey, blockerOwner);
    events.length = 0;
    await expect(
      new ProfileMutationService(trackedRepo).deleteMyProfile(u1.user_id, deleteAt),
    ).resolves.toEqual({ user_id: u1.user_id, deleted: true });

    expect(events).toEqual([
      `acquire:ranking:week:${weekKey}`,
      `acquire:ranking:week:${nextWeekKey}`,
      "tx:enter",
      "tx:exit",
      `release:ranking:week:${nextWeekKey}`,
      `release:ranking:week:${weekKey}`,
    ]);
    await expect(repo.rankings.findByPeriodAndUser(PeriodType.Week, nextWeekKey, u1.user_id))
      .resolves.toMatchObject({ global_rank: null });
    await expect(repo.rankings.findByPeriodAndUser(PeriodType.Week, nextWeekKey, u2.user_id))
      .resolves.toMatchObject({ global_rank: 1 });

    acquireSpy.mockRestore();
    releaseSpy.mockRestore();
  });

  it("极端并发场景：事务内发现新增未封板周榜时安全回滚并重新补锁提交", async () => {
    const repo = new InMemoryRepository();
    const { deleteAt, weekKey, u1, u2 } = await setupWeekRankingFixture(repo);
    const nextWeekAnchor = new Date("2026-08-15T06:00:00.000Z");
    const nextWeekKey = calculatePeriodKey(PeriodType.Week, nextWeekAnchor);

    const origWithTx = repo.withTransaction.bind(repo);
    let attempt = 0;
    const realRaceRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop !== "withTransaction") {
          return Reflect.get(target, prop, receiver);
        }
        return (async (fn, options) => {
          attempt += 1;
          if (attempt === 1) {
            await repo.rankings.insert({
              schema_version: 1,
              period_type: PeriodType.Week,
              period_key: nextWeekKey,
              user_id: u1.user_id,
              period_score: 12,
              valid_predictions: 1,
              wdl_hits: 1,
              exact_hits: 1,
              last_scoring_match_at: nextWeekAnchor,
              global_rank: 1,
              is_final: false,
              created_at: deleteAt,
              updated_at: deleteAt,
            });
            await repo.rankings.insert({
              schema_version: 1,
              period_type: PeriodType.Week,
              period_key: nextWeekKey,
              user_id: u2.user_id,
              period_score: 3,
              valid_predictions: 1,
              wdl_hits: 1,
              exact_hits: 0,
              last_scoring_match_at: nextWeekAnchor,
              global_rank: 2,
              is_final: false,
              created_at: deleteAt,
              updated_at: deleteAt,
            });
          }
          return origWithTx(fn, options);
        }) as InMemoryRepository["withTransaction"];
      },
    });

    await expect(
      new ProfileMutationService(realRaceRepo).deleteMyProfile(u1.user_id, deleteAt),
    ).resolves.toEqual({ user_id: u1.user_id, deleted: true });

    expect(attempt).toBe(2);
    await expect(repo.users.findById(u1.user_id)).resolves.toMatchObject({ status: UserStatus.Deleted });
    await expect(repo.rankings.findByPeriodAndUser(PeriodType.Week, weekKey, u1.user_id))
      .resolves.toMatchObject({ global_rank: null });
    await expect(repo.rankings.findByPeriodAndUser(PeriodType.Week, weekKey, u2.user_id))
      .resolves.toMatchObject({ global_rank: 1 });
    await expect(repo.rankings.findByPeriodAndUser(PeriodType.Week, nextWeekKey, u1.user_id))
      .resolves.toMatchObject({ global_rank: null });
    await expect(repo.rankings.findByPeriodAndUser(PeriodType.Week, nextWeekKey, u2.user_id))
      .resolves.toMatchObject({ global_rank: 1 });
  });
});
