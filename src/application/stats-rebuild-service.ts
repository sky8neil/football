import {
  LevelHistoryReason,
  LevelScope,
  SCHEMA_VERSION,
  SettlementItemStatus,
} from "../domain/enums.js";
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { conflictError, notFoundError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import { assertSeasonStatsInvariants, assertUserCareerInvariants } from "../domain/invariants.js";
import { rebuildLevelState } from "./level-rebuild.js";
import { rebuildStatsFromLedger, type RebuiltSeasonStats } from "./stats-rebuild.js";
import { decideUnlockGrants } from "./unlock-decision.js";
import {
  activeSettlement,
  assertStatsAggregationPorts,
  invalidLedger,
  loadAppliedSettlementFacts,
} from "./rebuild-service-support.js";
import { assertValidServerNow } from "./period-finalize.js";
import type {
  LevelHistoryEntry,
  User,
  UserSeasonStats,
  Unlock,
} from "../domain/types.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";

const REBUILD_LEASE_MILLISECONDS = FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000;

export interface RebuildUserStatsOutcome {
  user: User;
  season_stats: UserSeasonStats[];
  created_level_history: LevelHistoryEntry[];
  created_unlocks: Unlock[];
}

export function userStatsRebuildLockKey(userId: string): string {
  return `maintenance:rebuild:user:${userId}`;
}

function maxHistoryLevel(
  history: readonly LevelHistoryEntry[],
  scope: LevelScope,
  seasonId: string | null,
): number {
  let max = 1;
  for (const entry of history) {
    if (entry.scope === scope && entry.season_id === seasonId) {
      max = Math.max(max, entry.to_level);
    }
  }
  return max;
}

function statsForSeason(
  seasons: readonly RebuiltSeasonStats[],
  seasonId: string,
): RebuiltSeasonStats {
  return (
    seasons.find((season) => season.season_id === seasonId) ?? {
      user_id: "",
      season_id: seasonId,
      points: 0,
      valid_predictions: 0,
      wdl_hits: 0,
      exact_hits: 0,
    }
  );
}

function buildLevelHistory(
  userId: string,
  scope: LevelScope,
  seasonId: string | null,
  fromLevel: number,
  toLevel: number,
  validPredictions: number,
  wdlHits: number,
  changedAt: Date,
): LevelHistoryEntry {
  return {
    schema_version: SCHEMA_VERSION,
    level_history_id: newUuid(),
    user_id: userId,
    scope,
    season_id: seasonId,
    from_level: fromLevel,
    to_level: toLevel,
    wdl_hits: wdlHits,
    valid_predictions: validPredictions,
    reason: LevelHistoryReason.Rebuild,
    changed_at: changedAt,
  };
}

function emptySeasonStats(userId: string, seasonId: string, now: Date): UserSeasonStats {
  return {
    schema_version: SCHEMA_VERSION,
    user_id: userId,
    season_id: seasonId,
    points: 0,
    valid_predictions: 0,
    wdl_hits: 0,
    exact_hits: 0,
    level: 1,
    best_level: 1,
    created_at: now,
    updated_at: now,
  };
}

async function persistUnlocks(
  tx: UnitOfWork,
  userId: string,
  careerPoints: number,
  serverNow: Date,
): Promise<Unlock[]> {
  const existing = await tx.unlocks.findByUser(userId);
  const grants = decideUnlockGrants(
    careerPoints,
    new Set(existing.map((unlock) => unlock.unlock_code)),
  );
  const created: Unlock[] = [];
  for (const grant of grants) {
    const unlock: Unlock = {
      schema_version: SCHEMA_VERSION,
      unlock_id: newUuid(),
      user_id: userId,
      unlock_code: grant.unlock_code,
      threshold_points: grant.threshold_points,
      source_version: grant.source_version,
      unlocked_at: serverNow,
    };
    await tx.unlocks.insert(unlock);
    created.push(unlock);
  }
  return created;
}

export class RebuildUserStatsService {
  constructor(private readonly repo: AppRepository) {}

  async rebuildUserStats(
    userId: string,
    serverNow: Date,
  ): Promise<RebuildUserStatsOutcome> {
    assertValidServerNow(serverNow);
    const currentUser = await this.repo.users.findById(userId);
    if (currentUser === null) {
      throw notFoundError("USER");
    }

    const lockKey = userStatsRebuildLockKey(userId);
    const ownerId = newUuid();
    const acquired = await this.repo.jobLocks.acquire(
      lockKey,
      ownerId,
      new Date(serverNow.getTime() + REBUILD_LEASE_MILLISECONDS),
    );
    if (!acquired) {
      throw conflictError(
        "SETTLEMENT_ALREADY_RUNNING",
        "目标用户存在并发 rebuild",
      );
    }

    try {
      return await this.repo.withTransaction((tx) =>
        this.rebuildUserStatsInTransaction(tx, userId, serverNow),
      );
    } finally {
      await this.repo.jobLocks.release(lockKey, ownerId);
    }
  }

  /** Caller must hold userStatsRebuildLockKey before entering this transaction. */
  async rebuildUserStatsInTransaction(
    tx: UnitOfWork,
    userId: string,
    serverNow: Date,
  ): Promise<RebuildUserStatsOutcome> {
    assertStatsAggregationPorts(tx);
    const user = await tx.users.findById(userId);
    if (user === null) {
      throw notFoundError("USER");
    }

    const predictions = await tx.predictions.findByUser(userId);
    for (const prediction of predictions) {
      const match = await tx.matches.findById(prediction.match_id);
      if (match === null) {
        throw invalidLedger(`prediction 缺少 match（prediction_id=${prediction.prediction_id}）`);
      }
      if (activeSettlement(match)) {
        throw conflictError(
          "SETTLEMENT_ALREADY_RUNNING",
          "目标用户存在正在结算的比赛",
          { match_id: match.match_id },
        );
      }
    }

    const appliedItems = (await tx.settlementItems.findByStatus(SettlementItemStatus.Applied))
      .filter((item) => item.user_id === userId);
    const facts = await loadAppliedSettlementFacts(tx, appliedItems);
    const seasonByPrediction = new Map(
      facts.map((fact) => [fact.item.prediction_id, fact.match.season_id]),
    );
    const rebuilt = rebuildStatsFromLedger(appliedItems, seasonByPrediction);
    const career = {
      ...rebuilt.career,
      user_id: userId,
    };
    const history = await tx.levelHistory.findByUser(userId);
    const createdLevelHistory: LevelHistoryEntry[] = [];

    const careerBestFloor = Math.max(
      user.career_best_level,
      maxHistoryLevel(history, LevelScope.Career, null),
    );
    const careerLevel = rebuildLevelState(
      LevelScope.Career,
      career.career_valid_predictions,
      career.career_wdl_hits,
      user.career_level,
      careerBestFloor,
      LevelHistoryReason.Rebuild,
    );
    if (careerLevel.should_record_history) {
      const entry = buildLevelHistory(
        userId,
        LevelScope.Career,
        null,
        careerLevel.from_level ?? user.career_level,
        careerLevel.to_level ?? careerLevel.current_level,
        career.career_valid_predictions,
        career.career_wdl_hits,
        serverNow,
      );
      await tx.levelHistory.insert(entry);
      createdLevelHistory.push(entry);
    }

    const updatedUser: User = {
      ...user,
      career_points: career.career_points,
      career_valid_predictions: career.career_valid_predictions,
      career_wdl_hits: career.career_wdl_hits,
      career_exact_hits: career.career_exact_hits,
      career_level: careerLevel.current_level,
      career_best_level: careerLevel.best_level,
      updated_at: serverNow,
    };
    assertUserCareerInvariants(updatedUser);
    await tx.users.update(updatedUser);

    const existingSeasonStats = await tx.userSeasonStats.findByUser(userId);
    const existingSeasonIds = new Set(existingSeasonStats.map((stats) => stats.season_id));
    const bySeason = new Map(
      existingSeasonStats.map((stats) => [stats.season_id, stats]),
    );
    for (const season of rebuilt.seasons) {
      bySeason.set(season.season_id, bySeason.get(season.season_id) ?? emptySeasonStats(
        userId,
        season.season_id,
        serverNow,
      ));
    }
    for (const entry of history) {
      if (entry.scope === LevelScope.Season && entry.season_id !== null) {
        bySeason.set(entry.season_id, bySeason.get(entry.season_id) ?? emptySeasonStats(
          userId,
          entry.season_id,
          serverNow,
        ));
      }
    }

    const seasonStats: UserSeasonStats[] = [];
    for (const seasonId of [...bySeason.keys()].sort((a, b) => a.localeCompare(b))) {
      const oldStats = bySeason.get(seasonId);
      if (oldStats === undefined) {
        throw invalidLedger(`无法读取 season stats（season_id=${seasonId}）`);
      }
      const target = statsForSeason(rebuilt.seasons, seasonId);
      const bestFloor = Math.max(
        oldStats.best_level,
        maxHistoryLevel(history, LevelScope.Season, seasonId),
      );
      const level = rebuildLevelState(
        LevelScope.Season,
        target.valid_predictions,
        target.wdl_hits,
        oldStats.level,
        bestFloor,
        LevelHistoryReason.Rebuild,
      );
      if (level.should_record_history) {
        const entry = buildLevelHistory(
          userId,
          LevelScope.Season,
          seasonId,
          level.from_level ?? oldStats.level,
          level.to_level ?? level.current_level,
          target.valid_predictions,
          target.wdl_hits,
          serverNow,
        );
        await tx.levelHistory.insert(entry);
        createdLevelHistory.push(entry);
      }

      const updated: UserSeasonStats = {
        ...oldStats,
        points: target.points,
        valid_predictions: target.valid_predictions,
        wdl_hits: target.wdl_hits,
        exact_hits: target.exact_hits,
        level: level.current_level,
        best_level: level.best_level,
        updated_at: serverNow,
      };
      assertSeasonStatsInvariants(updated);
      if (existingSeasonIds.has(seasonId)) {
        await tx.userSeasonStats.update(updated);
      } else {
        await tx.userSeasonStats.insert(updated);
      }
      seasonStats.push(updated);
    }

    const createdUnlocks = await persistUnlocks(
      tx,
      userId,
      updatedUser.career_points,
      serverNow,
    );

    return {
      user: updatedUser,
      season_stats: seasonStats,
      created_level_history: createdLevelHistory,
      created_unlocks: createdUnlocks,
    };
  }

  rebuild(userId: string, serverNow: Date): Promise<RebuildUserStatsOutcome> {
    return this.rebuildUserStats(userId, serverNow);
  }
}

export { RebuildUserStatsService as UserStatsRebuildService };
