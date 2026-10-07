import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { UserStatus } from "../domain/enums.js";
import {
  conflictError,
  internalError,
  notFoundError,
  validationError,
} from "../domain/errors.js";
import { isValidUuid } from "../domain/ids.js";
import { assertUserCareerInvariants } from "../domain/invariants.js";
import { levelSeasonOf } from "../domain/time.js";
import type { User, UserSeasonStats } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";

export interface PublicProfileData {
  user_id: string;
  display_name: string;
  favorite_team_id: string | null;
  career_points: number;
  career_valid_predictions: number;
  career_exact_hits: number;
  career_level: number;
  career_best_level: number;
  season_level: number;
}

export interface MyProfileData {
  user_id: string;
  nickname: string;
  favorite_team_id: string | null;
  career_points: number;
  career_valid_predictions: number;
  career_exact_hits: number;
  career_level: number;
  career_best_level: number;
  season_level: number;
  previous_season: {
    level_season_id: string;
    points: number;
    valid_predictions: number;
    exact_hits: number;
    best_level: number;
  } | null;
}

function seasonStartYear(levelSeasonId: string): number {
  return Number(levelSeasonId.slice(0, 4));
}

function previousSeason(
  stats: readonly UserSeasonStats[],
  currentLevelSeasonId: string,
): MyProfileData["previous_season"] {
  const currentStartYear = seasonStartYear(currentLevelSeasonId);
  const previous = stats
    .filter((item) =>
      item.valid_predictions >= FIXED_CONFIG_V1.SEASON_BOARD_MIN_VALID &&
      seasonStartYear(item.level_season_id) < currentStartYear
    )
    .sort((a, b) => seasonStartYear(b.level_season_id) - seasonStartYear(a.level_season_id))[0];
  if (previous === undefined) return null;
  return {
    level_season_id: previous.level_season_id,
    points: previous.points,
    valid_predictions: previous.valid_predictions,
    exact_hits: previous.exact_hits,
    best_level: previous.best_level,
  };
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
  constructor(private readonly repo: Pick<AppRepository, "users" | "userSeasonStats">) {}

  async getMyProfile(userId: string, serverNow: Date = new Date()): Promise<MyProfileData> {
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
    const currentLevelSeasonId = levelSeasonOf(serverNow);
    const allSeasonStats = await this.repo.userSeasonStats?.findByUser(userId) ?? [];
    const seasonStats = allSeasonStats.find((item) => item.level_season_id === currentLevelSeasonId);

    return {
      user_id: user.user_id,
      nickname: user.nickname,
      favorite_team_id: user.favorite_team_id,
      career_points: user.career_points,
      career_valid_predictions: user.career_valid_predictions,
      career_exact_hits: user.career_exact_hits,
      career_level: user.career_level,
      career_best_level: user.career_best_level,
      season_level: seasonStats?.level ?? 1,
      previous_season: previousSeason(allSeasonStats, currentLevelSeasonId),
    };
  }

  async getPublicProfile(userId: string, serverNow: Date = new Date()): Promise<PublicProfileData> {
    if (!isValidUuid(userId)) {
      throw validationError("user_id 必须为 UUID v4", { field: "user_id" });
    }

    const user = await this.repo.users.findById(userId);
    if (user === null) {
      throw notFoundError("USER");
    }
    assertUserCareerInvariants(user);
    const seasonStats = await this.repo.userSeasonStats?.findByUserAndSeason(
      userId,
      levelSeasonOf(serverNow),
    );

    return {
      user_id: user.user_id,
      display_name: displayName(user),
      favorite_team_id: user.status === UserStatus.Deleted ? null : user.favorite_team_id,
      career_points: user.career_points,
      career_valid_predictions: user.career_valid_predictions,
      career_exact_hits: user.career_exact_hits,
      career_level: user.career_level,
      career_best_level: user.career_best_level,
      season_level: seasonStats?.level ?? 1,
    };
  }
}
