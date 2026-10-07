import {
  LevelHistoryReason,
  LevelScope,
  MatchScoreValue,
  SCHEMA_VERSION,
  SettlementItemStatus,
} from "../domain/enums.js";
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { conflictError, notFoundError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import { assertSeasonStatsInvariants, assertUserCareerInvariants } from "../domain/invariants.js";
import {
  replayLevel,
  type LevelEvalState,
  type LevelInputs,
  type LevelPredictionFact,
  type ReplayLevelResult,
} from "../domain/levels.js";
import {
  levelProtectionEndAsOf,
  levelSeasonOf,
  seasonFinalEvalAsOf,
} from "../domain/time.js";
import { rebuildStatsFromLedger, type RebuiltSeasonStats } from "./stats-rebuild.js";
import { decideUnlockGrants } from "./unlock-decision.js";
import {
  activeSettlement,
  assertStatsAggregationPorts,
  buildReplayFacts,
  invalidLedger,
  loadAppliedSettlementFacts,
} from "./rebuild-service-support.js";
import { assertValidServerNow } from "./period-finalize.js";
import {
  defaultLevelState,
  type LevelState,
  type LevelHistoryEntry,
  type Unlock,
  type User,
  type UserSeasonStats,
} from "../domain/types.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";
import type { AppliedSettlementFact } from "./rebuild-service-support.js";

const REBUILD_LEASE_MILLISECONDS = FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000;

export interface RebuildUserStatsOutcome {
  user: User;
  season_stats: UserSeasonStats[];
  created_level_history: LevelHistoryEntry[];
  created_unlocks: Unlock[];
  level_state_changed: boolean;
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
    if (entry.scope === scope && entry.level_season_id === seasonId) {
      max = Math.max(max, entry.to_level);
    }
  }
  return max;
}

function careerLastScoringMatchAt(facts: readonly AppliedSettlementFact[]): Date | null {
  const latestByPrediction = new Map<string, AppliedSettlementFact>();
  for (const fact of facts) {
    const previous = latestByPrediction.get(fact.item.prediction_id);
    if (
      previous === undefined ||
      fact.item.source_result_version > previous.item.source_result_version
    ) {
      latestByPrediction.set(fact.item.prediction_id, fact);
    }
  }

  let latest: Date | null = null;
  for (const fact of latestByPrediction.values()) {
    const anchorAt = fact.match.period_anchor_at;
    if (
      fact.item.new_score > MatchScoreValue.Miss &&
      anchorAt !== null &&
      (latest === null || anchorAt.getTime() > latest.getTime())
    ) {
      latest = anchorAt;
    }
  }
  return latest;
}

function statsForSeason(
  seasons: readonly RebuiltSeasonStats[],
  seasonId: string,
): RebuiltSeasonStats {
  return (
    seasons.find((season) => season.level_season_id === seasonId) ?? {
      user_id: "",
      level_season_id: seasonId,
      points: 0,
      valid_predictions: 0,
      wdl_hits: 0,
      exact_hits: 0,
      last_scoring_match_at: null,
    }
  );
}

function buildLevelHistory(
  userId: string,
  scope: LevelScope,
  seasonId: string | null,
  fromLevel: number,
  toLevel: number,
  inputs: LevelInputs,
  evalAsOf: Date,
  changedAt: Date,
): LevelHistoryEntry {
  return {
    schema_version: SCHEMA_VERSION,
    level_history_id: newUuid(),
    user_id: userId,
    scope,
    level_season_id: seasonId,
    from_level: fromLevel,
    to_level: toLevel,
    reason: LevelHistoryReason.Rebuild,
    eval_as_of: evalAsOf,
    window_n: inputs.n,
    window_score_sum: inputs.S,
    b_points: inputs.b_points,
    level_rule_version: FIXED_CONFIG_V1.LEVEL_RULE_VERSION,
    settlement_id: null,
    changed_at: changedAt,
  };
}

function storedLevelState(replay: ReplayLevelResult, existing: LevelState | undefined): LevelState {
  if (replay.last_eval_as_of === null || replay.last_inputs === null) {
    return existing ?? defaultLevelState();
  }
  return {
    below_count: replay.below_count,
    week_base_level: replay.week_base.level,
    week_base_below_count: replay.week_base.below_count,
    week_base_as_of: replay.week_base_as_of,
    last_eval_as_of: replay.last_eval_as_of,
    last_eval_n: replay.last_inputs.n,
    last_eval_score_sum: replay.last_inputs.S,
    last_eval_b_points: replay.last_inputs.b_points,
    last_eval_rule_version: FIXED_CONFIG_V1.LEVEL_RULE_VERSION,
  };
}

function levelStatesEqual(left: LevelState | undefined, right: LevelState): boolean {
  return JSON.stringify(left ?? defaultLevelState()) === JSON.stringify(right);
}

function replayScope(params: {
  scope: LevelScope;
  facts: readonly LevelPredictionFact[];
  correctionSettledAts: readonly Date[];
  firstEvalAsOf: Date | null;
  untilAsOf: Date;
  currentLevel: number;
  currentBestLevel: number;
  currentLevelState: LevelState | undefined;
  bestFloor: number;
  levelSeasonId?: string;
  isLevelFrozen?: boolean;
}): { replay: ReplayLevelResult; levelState: LevelState; bestLevel: number } {
  const untilAsOf = params.isLevelFrozen && params.levelSeasonId !== undefined
    ? new Date(Math.min(params.untilAsOf.getTime(), seasonFinalEvalAsOf(params.levelSeasonId).getTime()))
    : params.untilAsOf;
  const currentState: LevelEvalState = {
    level: params.currentLevel,
    best_level: Math.max(params.currentBestLevel, params.bestFloor),
    below_count: params.currentLevelState?.below_count ?? 0,
  };
  const replay = replayLevel({
    scope: params.scope,
    facts: params.facts,
    firstEvalAsOf: params.firstEvalAsOf,
    untilAsOf,
    correctionSettledAts: params.correctionSettledAts,
    ruleVersion: FIXED_CONFIG_V1.LEVEL_RULE_VERSION,
    protectionEndAsOf: params.firstEvalAsOf === null
      ? null
      : levelProtectionEndAsOf(params.firstEvalAsOf),
    initialState: currentState,
    ...(params.levelSeasonId === undefined ? {} : { levelSeasonId: params.levelSeasonId }),
  });
  const levelState = storedLevelState(replay, params.currentLevelState);
  return {
    replay,
    levelState,
    bestLevel: Math.max(params.bestFloor, replay.best_level, replay.level),
  };
}

function emptySeasonStats(userId: string, seasonId: string, now: Date): UserSeasonStats {
  return {
    schema_version: SCHEMA_VERSION,
    user_id: userId,
    level_season_id: seasonId,
    points: 0,
    valid_predictions: 0,
    wdl_hits: 0,
    exact_hits: 0,
    last_scoring_match_at: null,
    level: 1,
    best_level: 1,
    level_state: defaultLevelState(),
    is_level_frozen: false,
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
  constructor(
    private readonly repo: AppRepository,
    private readonly firstEvalAsOf: Date | null = FIXED_CONFIG_V1.LEVEL_FIRST_EVAL_AS_OF,
  ) {}

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
    const levelSeasonByPrediction = new Map(
      facts.map((fact) => {
        if (fact.match.period_anchor_at === null) {
          throw invalidLedger(`finished match 缺少 period_anchor_at（match_id=${fact.match.match_id}）`);
        }
        return [fact.item.prediction_id, levelSeasonOf(fact.match.period_anchor_at)] as const;
      }),
    );
    const periodAnchorByPrediction = new Map(
      facts.map((fact) => [fact.item.prediction_id, fact.match.period_anchor_at as Date] as const),
    );
    const rebuilt = rebuildStatsFromLedger(
      appliedItems,
      levelSeasonByPrediction,
      periodAnchorByPrediction,
    );
    const replayFacts = buildReplayFacts(facts);
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
    const careerLevel = replayScope({
      scope: LevelScope.Career,
      facts: replayFacts.facts,
      correctionSettledAts: replayFacts.correctionSettledAts,
      firstEvalAsOf: this.firstEvalAsOf,
      untilAsOf: serverNow,
      currentLevel: user.career_level,
      currentBestLevel: user.career_best_level,
      currentLevelState: user.career_level_state,
      bestFloor: careerBestFloor,
    });
    if (careerLevel.replay.level !== user.career_level) {
      const inputs = careerLevel.replay.last_inputs ?? {
        n: 0,
        S: 0,
        b_points: 0,
        valid_total: 0,
      };
      const entry = buildLevelHistory(
        userId,
        LevelScope.Career,
        null,
        user.career_level,
        careerLevel.replay.level,
        inputs,
        careerLevel.replay.last_eval_as_of ?? serverNow,
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
      career_last_scoring_match_at: careerLastScoringMatchAt(facts),
      career_level: careerLevel.replay.level,
      career_best_level: careerLevel.bestLevel,
      career_level_state: careerLevel.levelState,
      updated_at: serverNow,
    };
    assertUserCareerInvariants(updatedUser);
    await tx.users.update(updatedUser);

    const existingSeasonStats = await tx.userSeasonStats.findByUser(userId);
    const existingSeasonIds = new Set(existingSeasonStats.map((stats) => stats.level_season_id));
    const bySeason = new Map(
      existingSeasonStats.map((stats) => [stats.level_season_id, stats]),
    );
    for (const season of rebuilt.seasons) {
      bySeason.set(season.level_season_id, bySeason.get(season.level_season_id) ?? emptySeasonStats(
        userId,
        season.level_season_id,
        serverNow,
      ));
    }
    for (const entry of history) {
      if (entry.scope === LevelScope.Season && entry.level_season_id) {
        bySeason.set(entry.level_season_id, bySeason.get(entry.level_season_id) ?? emptySeasonStats(
          userId,
          entry.level_season_id,
          serverNow,
        ));
      }
    }

    const seasonStats: UserSeasonStats[] = [];
    let levelStateChanged =
      user.career_level !== updatedUser.career_level ||
      user.career_best_level !== updatedUser.career_best_level ||
      !levelStatesEqual(user.career_level_state, careerLevel.levelState);
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
      const level = replayScope({
        scope: LevelScope.Season,
        facts: replayFacts.facts,
        correctionSettledAts: replayFacts.correctionSettledAts,
        firstEvalAsOf: this.firstEvalAsOf,
        untilAsOf: serverNow,
        currentLevel: oldStats.level,
        currentBestLevel: oldStats.best_level,
        currentLevelState: oldStats.level_state,
        bestFloor,
        levelSeasonId: seasonId,
        isLevelFrozen: oldStats.is_level_frozen ?? false,
      });
      if (level.replay.level !== oldStats.level) {
        const inputs = level.replay.last_inputs ?? {
          n: 0,
          S: 0,
          b_points: 0,
          valid_total: 0,
        };
        const entry = buildLevelHistory(
          userId,
          LevelScope.Season,
          seasonId,
          oldStats.level,
          level.replay.level,
          inputs,
          level.replay.last_eval_as_of ?? serverNow,
          serverNow,
        );
        await tx.levelHistory.insert(entry);
        createdLevelHistory.push(entry);
      }

      const updated: UserSeasonStats = {
        ...oldStats,
        level_season_id: seasonId,
        points: target.points,
        valid_predictions: target.valid_predictions,
        wdl_hits: target.wdl_hits,
        exact_hits: target.exact_hits,
        last_scoring_match_at: target.last_scoring_match_at,
        level: level.replay.level,
        best_level: level.bestLevel,
        level_state: level.levelState,
        updated_at: serverNow,
      };
      levelStateChanged ||=
        oldStats.level !== updated.level ||
        oldStats.best_level !== updated.best_level ||
        !levelStatesEqual(oldStats.level_state, level.levelState);
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
      level_state_changed: levelStateChanged,
    };
  }

  rebuild(userId: string, serverNow: Date): Promise<RebuildUserStatsOutcome> {
    return this.rebuildUserStats(userId, serverNow);
  }
}

export { RebuildUserStatsService as UserStatsRebuildService };
