import { describe, expect, it } from "vitest";
import {
  AdminRole,
  AdminStatus,
  GroupMemberStatus,
  GroupStatus,
  TeamStatus,
  UserStatus,
} from "../domain/enums.js";
import type {
  Admin,
  Group,
  GroupMember,
  Team,
  User,
  UserSeasonStats,
} from "../domain/types.js";
import { InMemoryRepository, type UnitOfWork } from "../infrastructure/repositories.js";
import { ProfileMutationService } from "./profile-mutation.js";
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
      `users.patchFields|${user.user_id}|deleted_at,favorite_team_id,nickname,openid,status,unionid,updated_at`,
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
