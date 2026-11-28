import {
  AdminStatus,
  GroupMemberStatus,
  GroupStatus,
  PeriodType,
  SCHEMA_VERSION,
  TeamStatus,
  UserGender,
  UserStatus,
} from "../domain/enums.js";
import {
  conflictError,
  internalError,
  notFoundError,
  validationError,
} from "../domain/errors.js";
import { isValidUuid } from "../domain/ids.js";
import { calculatePeriodKey, periodEndAt } from "../domain/time.js";
import type {
  AppRepository,
  AuthSessionRevoker,
  RankingRepository,
  UnitOfWork,
} from "../infrastructure/repositories.js";
import { validateNickname } from "./session.js";
import { ProfileQueryService, type MyProfileData } from "./profile.js";
import { assertValidServerNow } from "./period-finalize.js";
import {
  rebuildGlobalRanksInTransaction,
  withRankingPeriodLocks,
} from "./settlement-item-application-service.js";

export interface ProfilePatch {
  nickname?: string;
  favorite_team_id?: string | null;
  gender?: UserGender | null;
}

export interface DeleteProfileResult {
  user_id: string;
  deleted: true;
}

export interface ProfileMutationServiceOptions {
  authSessions?: AuthSessionRevoker;
}

const PROFILE_PATCH_FIELDS = new Set(["nickname", "favorite_team_id", "gender"]);
const VALID_USER_GENDERS = new Set<string>(Object.values(UserGender));

export function validateGender(value: unknown): UserGender | null {
  if (value === null) return null;
  if (typeof value !== "string" || !VALID_USER_GENDERS.has(value)) {
    throw validationError("gender 必须为 male、female、undisclosed 或 null", {
      field: "gender",
    });
  }
  return value as UserGender;
}

function assertPatchObject(input: unknown): asserts input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw validationError("资料更新请求体必须为 JSON 对象");
  }
  const keys = Object.keys(input);
  for (const key of keys) {
    if (!PROFILE_PATCH_FIELDS.has(key)) {
      throw validationError("请求包含未定义字段", { field: key });
    }
  }
  if (keys.length === 0) {
    throw validationError("至少需要更新一个资料字段");
  }
}

function parseProfilePatch(input: unknown): ProfilePatch {
  assertPatchObject(input);
  const patch: ProfilePatch = {};

  if (Object.prototype.hasOwnProperty.call(input, "nickname")) {
    patch.nickname = validateNickname(input.nickname);
  }

  if (Object.prototype.hasOwnProperty.call(input, "favorite_team_id")) {
    const favoriteTeamId = input.favorite_team_id;
    if (favoriteTeamId !== null &&
      (typeof favoriteTeamId !== "string" || !isValidUuid(favoriteTeamId))) {
      throw validationError("favorite_team_id 必须为 UUID v4 或 null", {
        field: "favorite_team_id",
      });
    }
    patch.favorite_team_id = favoriteTeamId;
  }

  if (Object.prototype.hasOwnProperty.call(input, "gender")) {
    patch.gender = validateGender(input.gender);
  }

  return patch;
}

function requireTeams(
  tx: UnitOfWork,
): NonNullable<UnitOfWork["teams"]> {
  if (tx.teams === undefined) {
    throw internalError("资料更新缺少 teams repository");
  }
  return tx.teams;
}

function requireUserRowLock(tx: UnitOfWork) {
  const findByIdForUpdate = tx.users.findByIdForUpdate;
  const patchFields = tx.users.patchFields;
  if (findByIdForUpdate === undefined || patchFields === undefined) {
    throw internalError("资料更新缺少 users 行锁或局部更新");
  }
  return { findByIdForUpdate, patchFields };
}

function requireSeasonRowLock(tx: UnitOfWork) {
  const stats = tx.userSeasonStats;
  if (
    stats?.findByUserAndSeasonForUpdate === undefined ||
    stats.patchFields === undefined
  ) {
    throw internalError("资料注销缺少 user_season_stats 行锁或局部更新");
  }
  return {
    findByUserAndSeasonForUpdate: stats.findByUserAndSeasonForUpdate,
    patchFields: stats.patchFields,
  };
}

function requireGroupRepositories(tx: UnitOfWork) {
  const groups = tx.groups;
  const groupMembers = tx.groupMembers;
  if (groups === undefined && groupMembers === undefined) return null;
  if (
    groups?.findByIdForUpdate === undefined ||
    groups.patchFields === undefined ||
    groupMembers === undefined
  ) {
    throw internalError("资料注销缺少 groups/group_members 仓储");
  }
  return {
    groups: {
      findByIdForUpdate: groups.findByIdForUpdate,
      patchFields: groups.patchFields,
    },
    groupMembers,
  };
}

/** 注销事务内退出全部 active 群成员关系；群主注销后群保留为 active。 */
async function leaveAllGroups(
  tx: UnitOfWork,
  userId: string,
  serverNow: Date,
): Promise<void> {
  const repos = requireGroupRepositories(tx);
  if (repos === null) return;
  const groupIds = (await repos.groupMembers.findByUser(userId))
    .filter((member) => member.status === GroupMemberStatus.Active)
    .map((member) => member.group_id)
    .sort((left, right) => left.localeCompare(right));
  for (const groupId of groupIds) {
    const group = await repos.groups.findByIdForUpdate(groupId);
    if (group === null) {
      throw internalError(`active group_member 缺少 group（group_id=${groupId}）`);
    }
    const member = await repos.groupMembers.findByGroupAndUser(groupId, userId);
    if (member === null || member.status !== GroupMemberStatus.Active) continue;
    await repos.groupMembers.update({
      ...member,
      status: GroupMemberStatus.Left,
      left_at: serverNow,
      updated_at: serverNow,
    });
    if (group.status === GroupStatus.Active) {
      await repos.groups.patchFields(group.group_id, {
        member_count: Math.max(0, group.member_count - 1),
        updated_at: serverNow,
      });
    }
  }
}

async function disableAdminsByOpenid(
  tx: UnitOfWork,
  openid: string,
  serverNow: Date,
): Promise<void> {
  if (tx.admins === undefined) return;
  const admin = await tx.admins.findByOpenid(openid);
  if (admin === null || admin.status !== AdminStatus.Active) return;
  await tx.admins.update({
    ...admin,
    status: AdminStatus.Disabled,
    updated_at: serverNow,
  });
}

class MissingWeekRankingLocksError extends Error {
  constructor(readonly missingPeriodKeys: readonly string[]) {
    super(`注销事务内新增未加锁周榜: ${missingPeriodKeys.join(",")}`);
  }
}

async function findAffectedUnfinalizedWeekKeys(
  rankings: RankingRepository | undefined,
  userId: string,
  serverNow: Date,
): Promise<string[]> {
  if (rankings === undefined || rankings.updateGlobalRank === undefined) {
    return [];
  }
  const currentWeekKey = calculatePeriodKey(PeriodType.Week, serverNow);
  const candidateEntries = rankings.findWeekEntriesSince !== undefined
    ? await rankings.findWeekEntriesSince(currentWeekKey, false)
    : rankings.findUnfinalizedWeeks !== undefined
      ? await rankings.findUnfinalizedWeeks()
      : await rankings.findAll();
  return [...new Set(
    candidateEntries
      .filter((entry) =>
        entry.user_id === userId &&
        entry.period_type === PeriodType.Week &&
        !entry.is_final &&
        periodEndAt(PeriodType.Week, entry.period_key).getTime() > serverNow.getTime(),
      )
      .map((entry) => entry.period_key),
  )].sort((left, right) => left.localeCompare(right));
}

/** 用户资料写操作；注销只保留永久 user_id，并将身份改为不可登录墓碑值。 */
export class ProfileMutationService {
  constructor(
    private readonly repo: AppRepository,
    private readonly options: ProfileMutationServiceOptions = {},
  ) {}

  async updateMyProfile(
    userId: string,
    input: unknown,
    serverNow: Date,
  ): Promise<MyProfileData> {
    assertValidServerNow(serverNow);
    if (!isValidUuid(userId)) {
      throw validationError("user_id 必须为 UUID v4", { field: "user_id" });
    }
    const patch = parseProfilePatch(input);

    return this.repo.withTransaction(async (tx) => {
      const userLock = requireUserRowLock(tx);
      const user = await userLock.findByIdForUpdate(userId);
      if (user === null) {
        throw notFoundError("USER");
      }
      if (user.status !== UserStatus.Active) {
        throw conflictError("USER_DELETED", "该账号已被注销");
      }

      const favoriteTeamId = patch.favorite_team_id;
      if (Object.prototype.hasOwnProperty.call(patch, "favorite_team_id") &&
        favoriteTeamId !== null && favoriteTeamId !== undefined) {
        const team = await requireTeams(tx).findById(favoriteTeamId);
        if (team === null || team.status !== TeamStatus.Active) {
          throw notFoundError("TEAM");
        }
      }

      await userLock.patchFields(userId, {
        ...(Object.prototype.hasOwnProperty.call(patch, "nickname")
          ? { nickname: patch.nickname }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(patch, "favorite_team_id")
          ? { favorite_team_id: patch.favorite_team_id }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(patch, "gender")
          ? { gender: patch.gender }
          : {}),
        updated_at: serverNow,
      });

      return new ProfileQueryService(tx).getMyProfile(userId, serverNow);
    });
  }

  async deleteMyProfile(
    userId: string,
    serverNow: Date,
  ): Promise<DeleteProfileResult> {
    assertValidServerNow(serverNow);
    if (!isValidUuid(userId)) {
      throw validationError("user_id 必须为 UUID v4", { field: "user_id" });
    }

    const maxAttempts = 3;
    for (let attempt = 1; ; attempt += 1) {
      // 锁序：先在事务外按字典序获取全部受影响未封板周的 ranking:week:* 分布式锁，再进单事务锁定 DB 行。
      const preAffectedWeekKeys = await findAffectedUnfinalizedWeekKeys(
        this.repo.rankings,
        userId,
        serverNow,
      );
      if (preAffectedWeekKeys.length > 0 && this.repo.jobLocks === undefined) {
        throw internalError("注销重排周榜缺少 jobLocks repository");
      }

      try {
        return await withRankingPeriodLocks(
          this.repo,
          PeriodType.Week,
          preAffectedWeekKeys,
          serverNow,
          async (lockedWeekKeys) => {
            const lockedWeekSet = new Set(lockedWeekKeys);
            return this.repo.withTransaction(async (tx) => {
              const userLock = requireUserRowLock(tx);
              const user = await userLock.findByIdForUpdate(userId);
              if (user === null) {
                throw notFoundError("USER");
              }
              if (user.status !== UserStatus.Active) {
                throw conflictError("USER_DELETED", "该账号已被注销");
              }
              // 4.5 墓碑值不可作为 active 用户的事实身份；命中即内部数据异常。
              if (user.openid.startsWith("deleted:")) {
                throw internalError("active 用户 openid 使用了 deleted: 墓碑前缀");
              }

              // D-P1 方案 B：先写/更新注销身份映射（original_openid → 本 user_id），
              // 再墓碑化 users 主记录；同一事务内 upsert 保证 deleted 解析不丢窗口。
              const existing = await tx.deletedOpenidMappings.findByOriginalOpenid(user.openid);
              await tx.deletedOpenidMappings.upsert({
                schema_version: SCHEMA_VERSION,
                original_openid: user.openid,
                deleted_user_id: user.user_id,
                deleted_at: serverNow,
                created_at: existing?.created_at ?? serverNow,
                updated_at: serverNow,
              });

              await userLock.patchFields(user.user_id, {
                openid: `deleted:${user.user_id}`,
                unionid: null,
                nickname: null,
                favorite_team_id: null,
                gender: null,
                status: UserStatus.Deleted,
                deleted_at: serverNow,
                updated_at: serverNow,
              });

              if (tx.userSeasonStats !== undefined) {
                const seasonLock = requireSeasonRowLock(tx);
                const seasonStats = [...await tx.userSeasonStats.findByUser(userId)]
                  .sort((left, right) => left.level_season_id.localeCompare(right.level_season_id));
                for (const stats of seasonStats) {
                  const locked = await seasonLock.findByUserAndSeasonForUpdate(
                    userId,
                    stats.level_season_id,
                  );
                  if (locked === null || locked.is_level_frozen) continue;
                  await seasonLock.patchFields(userId, stats.level_season_id, {
                    is_level_frozen: true,
                    updated_at: serverNow,
                  });
                }
              }

              const txAffectedWeekKeys = await findAffectedUnfinalizedWeekKeys(
                tx.rankings,
                userId,
                serverNow,
              );
              const missingWeekKeys = txAffectedWeekKeys.filter((key) => !lockedWeekSet.has(key));
              if (missingWeekKeys.length > 0) {
                // 极端并发下在获取周榜锁与锁定 users 之间新增了未封板周榜；回滚并释放旧锁后在外层补锁重试。
                throw new MissingWeekRankingLocksError(missingWeekKeys);
              }
              for (const periodKey of txAffectedWeekKeys) {
                await rebuildGlobalRanksInTransaction(tx, PeriodType.Week, periodKey, serverNow);
              }

              await leaveAllGroups(tx, userId, serverNow);
              await disableAdminsByOpenid(tx, user.openid, serverNow);
              const authSessions = tx.authSessions ?? this.options.authSessions;
              if (authSessions !== undefined) {
                await authSessions.deleteByOpenid(user.openid);
              }

              return { user_id: user.user_id, deleted: true as const };
            });
          },
        );
      } catch (error) {
        if (error instanceof MissingWeekRankingLocksError) {
          if (attempt >= maxAttempts) {
            throw conflictError(
              "RANKING_REBUILD_ALREADY_RUNNING",
              "注销期间受影响周榜存在并发新增，请重试",
              { period_keys: [...error.missingPeriodKeys] },
            );
          }
          continue;
        }
        throw error;
      }
    }
  }
}
