import { UserStatus } from "../domain/enums.js";
import {
  conflictError,
  internalError,
  notFoundError,
  validationError,
} from "../domain/errors.js";
import { isValidUuid } from "../domain/ids.js";
import { assertUserCareerInvariants } from "../domain/invariants.js";
import type { User } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";

export interface PublicProfileData {
  user_id: string;
  display_name: string;
  favorite_team_id: string | null;
  career_points: number;
  career_valid_predictions: number;
  career_wdl_accuracy_percent: string | null;
  career_level: number;
  career_best_level: number;
}

export interface MyProfileData {
  user_id: string;
  nickname: string;
  favorite_team_id: string | null;
  career_points: number;
  career_valid_predictions: number;
  career_wdl_hits: number;
  career_exact_hits: number;
  career_wdl_accuracy_percent: string | null;
  career_level: number;
  career_best_level: number;
}

function formatAccuracyPercent(validPredictions: number, wdlHits: number): string | null {
  if (validPredictions === 0) {
    return null;
  }
  return (wdlHits * 100 / validPredictions).toFixed(1);
}

function displayName(user: User): string {
  if (user.status === UserStatus.Deleted) {
    return "已注销用户";
  }
  if (user.nickname === null) {
    throw internalError("active 用户缺少 nickname");
  }
  return user.nickname;
}

export class ProfileQueryService {
  constructor(private readonly repo: Pick<AppRepository, "users">) {}

  async getMyProfile(userId: string): Promise<MyProfileData> {
    if (!isValidUuid(userId)) {
      throw validationError("user_id 必须为 UUID v4", { field: "user_id" });
    }

    const user = await this.repo.users.findById(userId);
    if (user === null) {
      throw notFoundError("USER");
    }
    if (user.status !== UserStatus.Active) {
      throw conflictError("USER_DELETED", "该账号已被注销");
    }
    if (user.nickname === null) {
      throw internalError("active 用户缺少 nickname");
    }
    assertUserCareerInvariants(user);

    return {
      user_id: user.user_id,
      nickname: user.nickname,
      favorite_team_id: user.favorite_team_id,
      career_points: user.career_points,
      career_valid_predictions: user.career_valid_predictions,
      career_wdl_hits: user.career_wdl_hits,
      career_exact_hits: user.career_exact_hits,
      career_wdl_accuracy_percent: formatAccuracyPercent(
        user.career_valid_predictions,
        user.career_wdl_hits,
      ),
      career_level: user.career_level,
      career_best_level: user.career_best_level,
    };
  }

  async getPublicProfile(userId: string): Promise<PublicProfileData> {
    if (!isValidUuid(userId)) {
      throw validationError("user_id 必须为 UUID v4", { field: "user_id" });
    }

    const user = await this.repo.users.findById(userId);
    if (user === null) {
      throw notFoundError("USER");
    }
    assertUserCareerInvariants(user);

    return {
      user_id: user.user_id,
      display_name: displayName(user),
      favorite_team_id: user.status === UserStatus.Deleted ? null : user.favorite_team_id,
      career_points: user.career_points,
      career_valid_predictions: user.career_valid_predictions,
      career_wdl_accuracy_percent: formatAccuracyPercent(
        user.career_valid_predictions,
        user.career_wdl_hits,
      ),
      career_level: user.career_level,
      career_best_level: user.career_best_level,
    };
  }
}
