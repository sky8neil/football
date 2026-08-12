import { MVP_SEASON } from "../domain/config.js";
import { UserStatus } from "../domain/enums.js";
import {
  conflictError,
  internalError,
  notFoundError,
  validationError,
} from "../domain/errors.js";
import { isValidUuid } from "../domain/ids.js";
import {
  assertSeasonStatsInvariants,
  assertUserCareerInvariants,
} from "../domain/invariants.js";
import type { UserSeasonStats } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";

export interface LevelStatsData {
  valid_predictions: number;
  wdl_hits: number;
  wdl_accuracy_percent: string | null;
  level: number;
  best_level: number;
}

export interface SeasonLevelStatsData extends LevelStatsData {
  season_id: string;
}

export interface LevelsData {
  season: SeasonLevelStatsData;
  career: LevelStatsData;
}

function formatAccuracyPercent(validPredictions: number, wdlHits: number): string | null {
  if (validPredictions === 0) {
    return null;
  }
  return (wdlHits * 100 / validPredictions).toFixed(1);
}

function levelStats(
  validPredictions: number,
  wdlHits: number,
  level: number,
  bestLevel: number,
): LevelStatsData {
  return {
    valid_predictions: validPredictions,
    wdl_hits: wdlHits,
    wdl_accuracy_percent: formatAccuracyPercent(validPredictions, wdlHits),
    level,
    best_level: bestLevel,
  };
}

function emptySeasonStats(): SeasonLevelStatsData {
  return {
    season_id: MVP_SEASON.season_id,
    ...levelStats(0, 0, 1, 1),
  };
}

function seasonLevelStats(stats: UserSeasonStats | null): SeasonLevelStatsData {
  if (stats === null) {
    return emptySeasonStats();
  }
  assertSeasonStatsInvariants(stats);
  return {
    season_id: stats.season_id,
    ...levelStats(stats.valid_predictions, stats.wdl_hits, stats.level, stats.best_level),
  };
}

export class LevelsQueryService {
  constructor(
    private readonly repo: Pick<AppRepository, "users" | "userSeasonStats">,
  ) {}

  async getLevels(userId: string): Promise<LevelsData> {
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

    const seasonStats = await this.repo.userSeasonStats.findByUserAndSeason(
      userId,
      MVP_SEASON.season_id,
    );
    return {
      season: seasonLevelStats(seasonStats),
      career: levelStats(
        user.career_valid_predictions,
        user.career_wdl_hits,
        user.career_level,
        user.career_best_level,
      ),
    };
  }
}
