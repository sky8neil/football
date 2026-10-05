import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { UserStatus } from "../domain/enums.js";
import {
  conflictError,
  internalError,
  notFoundError,
  validationError,
} from "../domain/errors.js";
import { isValidUuid } from "../domain/ids.js";
import { levelSeasonOf, nextMondayEvalAt } from "../domain/time.js";
import {
  assertSeasonStatsInvariants,
  assertUserCareerInvariants,
} from "../domain/invariants.js";
import type { UserSeasonStats } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";

export interface CareerLevelData {
  level: number;
  best_level: number;
  is_rated: boolean;
  valid_predictions: number;
  remaining_to_rated: number;
  last_evaluated_at: string | null;
  next_evaluation_at: string;
  is_former_top: boolean;
}

export interface SeasonLevelData {
  level_season_id: string;
  level: number;
  best_level: number;
  is_rated: boolean;
  valid_predictions: number;
  remaining_to_rated: number;
  is_frozen: boolean;
}

export interface LevelsData {
  career: CareerLevelData;
  season: SeasonLevelData;
  rule_version: string;
}

function remainingToRated(validPredictions: number): number {
  return Math.max(0, FIXED_CONFIG_V1.LEVEL_RATED_MIN_VALID - validPredictions);
}

function isRated(validPredictions: number): boolean {
  return validPredictions >= FIXED_CONFIG_V1.LEVEL_RATED_MIN_VALID;
}

function emptySeasonStats(levelSeasonId: string): SeasonLevelData {
  return {
    level_season_id: levelSeasonId,
    level: 1,
    best_level: 1,
    is_rated: false,
    valid_predictions: 0,
    remaining_to_rated: FIXED_CONFIG_V1.LEVEL_RATED_MIN_VALID,
    is_frozen: false,
  };
}

function seasonLevelStats(stats: UserSeasonStats | null, levelSeasonId: string): SeasonLevelData {
  if (stats === null) {
    return emptySeasonStats(levelSeasonId);
  }
  assertSeasonStatsInvariants(stats);
  return {
    level_season_id: stats.level_season_id,
    level: stats.level,
    best_level: stats.best_level,
    is_rated: isRated(stats.valid_predictions),
    valid_predictions: stats.valid_predictions,
    remaining_to_rated: remainingToRated(stats.valid_predictions),
    is_frozen: stats.is_level_frozen ?? false,
  };
}

export class LevelsQueryService {
  constructor(
    private readonly repo: Pick<AppRepository, "users" | "userSeasonStats">,
  ) {}

  async getLevels(userId: string, serverNow: Date = new Date()): Promise<LevelsData> {
    if (!isValidUuid(userId)) {
      throw validationError("user_id 必须为 UUID v4", { field: "user_id" });
    }
    if (this.repo.userSeasonStats === undefined) {
      throw internalError("levels query 缺少 season stats repository");
    }

    const user = await this.repo.users.findById(userId);
    if (user === null) {
      throw notFoundError("USER");
    }
    if (user.status !== UserStatus.Active) {
      throw conflictError("USER_DELETED", "该账号已被注销");
    }
    assertUserCareerInvariants(user);

    const levelSeasonId = levelSeasonOf(serverNow);
    const seasonStats = await this.repo.userSeasonStats.findByUserAndSeason(userId, levelSeasonId);
    const careerState = user.career_level_state;
    return {
      career: {
        level: user.career_level,
        best_level: user.career_best_level,
        is_rated: isRated(user.career_valid_predictions),
        valid_predictions: user.career_valid_predictions,
        remaining_to_rated: remainingToRated(user.career_valid_predictions),
        last_evaluated_at: careerState?.last_eval_as_of?.toISOString() ?? null,
        next_evaluation_at: nextMondayEvalAt(serverNow).toISOString(),
        is_former_top: user.career_best_level === FIXED_CONFIG_V1.LEVEL_MAX &&
          user.career_level < FIXED_CONFIG_V1.LEVEL_MAX,
      },
      season: seasonLevelStats(seasonStats, levelSeasonId),
      rule_version: FIXED_CONFIG_V1.LEVEL_RULE_VERSION,
    };
  }
}
