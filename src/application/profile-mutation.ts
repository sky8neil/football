import { TeamStatus, UserStatus } from "../domain/enums.js";
import {
  conflictError,
  internalError,
  notFoundError,
  validationError,
} from "../domain/errors.js";
import { isValidUuid } from "../domain/ids.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";
import { validateNickname } from "./session.js";
import { ProfileQueryService, type MyProfileData } from "./profile.js";
import { assertValidServerNow } from "./period-finalize.js";

export interface ProfilePatch {
  nickname?: string;
  favorite_team_id?: string | null;
}

export interface DeleteProfileResult {
  user_id: string;
  deleted: true;
}

const PROFILE_PATCH_FIELDS = new Set(["nickname", "favorite_team_id"]);

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

/** 用户资料写操作；注销只保留永久 user_id，并将身份改为不可登录墓碑值。 */
export class ProfileMutationService {
  constructor(private readonly repo: AppRepository) {}

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
      const user = await tx.users.findById(userId);
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

      await tx.users.update({
        ...user,
        ...(Object.prototype.hasOwnProperty.call(patch, "nickname")
          ? { nickname: patch.nickname }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(patch, "favorite_team_id")
          ? { favorite_team_id: patch.favorite_team_id }
          : {}),
        updated_at: serverNow,
      });

      return new ProfileQueryService(tx).getMyProfile(userId);
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

    return this.repo.withTransaction(async (tx) => {
      const user = await tx.users.findById(userId);
      if (user === null) {
        throw notFoundError("USER");
      }
      if (user.status !== UserStatus.Active) {
        throw conflictError("USER_DELETED", "该账号已被注销");
      }

      await tx.users.update({
        ...user,
        openid: `deleted:${user.user_id}`,
        unionid: null,
        nickname: null,
        favorite_team_id: null,
        status: UserStatus.Deleted,
        deleted_at: serverNow,
        updated_at: serverNow,
      });

      return { user_id: user.user_id, deleted: true };
    });
  }
}
