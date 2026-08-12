/**
 * settlement item 原子应用服务。
 *
 * 一个 item 的账本 delta 是唯一输入；本服务在同一事务中更新 prediction、聚合缓存、
 * 等级历史、解锁和 item 状态。旧聚合不是事实来源，但结算增量必须基于事务内当前值。
 * global_rank 重算按第 15.8 节使用 ranking:{period_type}:{period_key} 锁。
 */
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import {
  LevelHistoryReason,
  LevelScope,
  MatchScoreValue,
  PeriodType,
  SCHEMA_VERSION,
  SettlementDocStatus,
  SettlementItemStatus,
} from "../domain/enums.js";
import { assertPredictionInvariants, assertRankingInvariants, assertSeasonStatsInvariants, assertUserCareerInvariants } from "../domain/invariants.js";
import { DomainError, conflictError, internalError, notFoundError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import { compareRankingEntry, lastScoringForPeriodScore, rankForPosition, type RankingComparable } from "../domain/ranking.js";
import { calculatePeriodKey } from "../domain/time.js";
import type {
  LevelHistoryEntry,
  Match,
  MatchResult,
  Prediction,
  RankingEntry,
  SettlementDoc,
  SettlementItem,
  User,
  UserSeasonStats,
} from "../domain/types.js";
import type {
  AppRepository,
  RankingRepository,
  UnitOfWork,
  UserSeasonStatsRepository,
} from "../infrastructure/repositories.js";
import { assertValidServerNow } from "./period-finalize.js";
import { decideUnlockGrants } from "./unlock-decision.js";
import { applySettlementItemDelta, computeSettlementItemDelta } from "./settlement.js";
import { rebuildLevelState } from "./level-rebuild.js";
import type { SettlementItemWorker, SettlementItemWorkerContext } from "./first-settlement-service.js";

const INVALID_LEDGER = "INVALID_LEDGER" as const;

function invalidLedger(message: string): DomainError {
  return new DomainError(INVALID_LEDGER, message);
}

type AggregationPorts = {
  userSeasonStats: UserSeasonStatsRepository;
  rankings: RankingRepository;
  levelHistory: NonNullable<UnitOfWork["levelHistory"]>;
};

function requireAggregationPorts(tx: UnitOfWork): AggregationPorts {
  if (tx.userSeasonStats === undefined || tx.rankings === undefined || tx.levelHistory === undefined) {
    throw internalError("结算 item 缺少 career/season/ranking/level_history repository ports");
  }
  return {
    userSeasonStats: tx.userSeasonStats,
    rankings: tx.rankings,
    levelHistory: tx.levelHistory,
  };
}

function hitDelta(newHit: boolean, oldHit: boolean): number {
  return (newHit ? 1 : 0) - (oldHit ? 1 : 0);
}

function scoreOf(prediction: Prediction): MatchScoreValue {
  return prediction.match_score ?? MatchScoreValue.Miss;
}

function boolOf(value: boolean | null): boolean {
  return value ?? false;
}

function assertItemMatchesPrediction(item: SettlementItem, prediction: Prediction): void {
  if (
    item.user_id !== prediction.user_id ||
    item.old_score !== scoreOf(prediction) ||
    item.old_wdl_hit !== boolOf(prediction.wdl_hit) ||
    item.old_exact_hit !== boolOf(prediction.exact_hit)
  ) {
    throw invalidLedger(`settlement item old 值与 prediction 当前状态不一致（prediction_id=${item.prediction_id}）`);
  }
}

function assertDeltaMatchesItem(
  item: SettlementItem,
  delta: ReturnType<typeof computeSettlementItemDelta>,
): void {
  if (
    item.old_score !== delta.old_score ||
    item.new_score !== delta.new_score ||
    item.score_delta !== delta.score_delta ||
    item.old_wdl_hit !== delta.old_wdl_hit ||
    item.new_wdl_hit !== delta.new_wdl_hit ||
    item.old_exact_hit !== delta.old_exact_hit ||
    item.new_exact_hit !== delta.new_exact_hit ||
    item.valid_prediction_delta !== delta.valid_prediction_delta
  ) {
    throw invalidLedger(`settlement item delta 与 scoring 结果不一致（prediction_id=${item.prediction_id}）`);
  }
}

function applyStatsDelta<T extends {
  points: number;
  valid_predictions: number;
  wdl_hits: number;
  exact_hits: number;
}>(stats: T, item: SettlementItem): T {
  return {
    ...stats,
    points: stats.points + item.score_delta,
    valid_predictions: stats.valid_predictions + item.valid_prediction_delta,
    wdl_hits: stats.wdl_hits + hitDelta(item.new_wdl_hit, item.old_wdl_hit),
    exact_hits: stats.exact_hits + hitDelta(item.new_exact_hit, item.old_exact_hit),
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

function emptyRanking(
  periodType: PeriodType,
  periodKey: string,
  userId: string,
  now: Date,
): RankingEntry {
  return {
    schema_version: SCHEMA_VERSION,
    period_type: periodType,
    period_key: periodKey,
    user_id: userId,
    period_score: 0,
    valid_predictions: 0,
    wdl_hits: 0,
    exact_hits: 0,
    last_scoring_match_at: null,
    global_rank: null,
    is_final: false,
    created_at: now,
    updated_at: now,
  };
}

function levelHistory(
  userId: string,
  scope: LevelScope,
  seasonId: string | null,
  fromLevel: number,
  toLevel: number,
  validPredictions: number,
  wdlHits: number,
  reason: LevelHistoryReason,
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
    reason,
    changed_at: changedAt,
  };
}

async function lastScoringAt(
  tx: UnitOfWork,
  predictions: Prediction[],
  periodType: PeriodType,
  periodKey: string,
  updatedPrediction: Prediction,
): Promise<Date | null> {
  let latest: Date | null = null;
  for (const original of predictions) {
    const prediction = original.prediction_id === updatedPrediction.prediction_id
      ? updatedPrediction
      : original;
    if (scoreOf(prediction) <= MatchScoreValue.Miss || prediction.applied_result_version < 1) {
      continue;
    }
    const match = await tx.matches.findById(prediction.match_id);
    if (match === null || match.period_anchor_at === null) {
      throw invalidLedger(`计分 prediction 缺少 match 或 period_anchor_at（prediction_id=${prediction.prediction_id}）`);
    }
    if (calculatePeriodKey(periodType, match.period_anchor_at) !== periodKey) {
      continue;
    }
    if (latest === null || match.period_anchor_at.getTime() > latest.getTime()) {
      latest = match.period_anchor_at;
    }
  }
  return latest;
}

/** 第 15.8 节：全局 rank 按周期重算锁。 */
export function rankingPeriodLockKey(periodType: PeriodType, periodKey: string): string {
  return `ranking:${periodType}:${periodKey}`;
}

async function rebuildGlobalRanks(
  tx: UnitOfWork,
  rankings: RankingRepository,
  periodType: PeriodType,
  periodKey: string,
  now: Date,
): Promise<void> {
  const jobLocks = tx.jobLocks;
  if (jobLocks === undefined) {
    throw internalError("结算 global rank 重算缺少 jobLocks repository port");
  }
  const lockKey = rankingPeriodLockKey(periodType, periodKey);
  const ownerId = newUuid();
  const leaseUntil = new Date(now.getTime() + FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000);
  const acquired = await jobLocks.acquire(lockKey, ownerId, leaseUntil);
  if (!acquired) {
    throw conflictError("SETTLEMENT_ALREADY_RUNNING", "周期排行榜重算锁被占用", {
      lock_key: lockKey,
    });
  }

  try {
    const entries = await rankings.findByPeriod(periodType, periodKey);
    const comparable: Array<{ entry: RankingEntry; value: RankingComparable }> = entries.map((entry) => ({
      entry,
      value: {
        period_score: entry.period_score,
        valid_predictions: entry.valid_predictions,
        wdl_hits: entry.wdl_hits,
        exact_hits: entry.exact_hits,
        last_scoring_match_at: entry.last_scoring_match_at,
        user_id: entry.user_id,
      },
    }));
    comparable.sort((a, b) => compareRankingEntry(a.value, b.value));
    for (const [index, item] of comparable.entries()) {
      const globalRank = rankForPosition(item.entry.valid_predictions, index + 1);
      if (item.entry.global_rank !== globalRank) {
        await rankings.update({ ...item.entry, global_rank: globalRank, updated_at: now });
      }
    }
  } finally {
    await jobLocks.release(lockKey, ownerId);
  }
}

export type SettlementItemApplicationOutcome =
  | { kind: "applied"; item: SettlementItem }
  | { kind: "already_applied"; item: SettlementItem };

export class SettlementItemApplicationService {
  constructor(private readonly repo: AppRepository) {}

  /** 独立 item 事务入口。 */
  async apply(
    settlementId: string,
    predictionId: string,
    serverNow: Date,
  ): Promise<SettlementItemApplicationOutcome> {
    assertValidServerNow(serverNow);
    return this.repo.withTransaction(async (tx) => {
      const item = await tx.settlementItems.findBySettlementAndPrediction(
        settlementId,
        predictionId,
      );
      if (item === null) {
        throw notFoundError("SETTLEMENT_ITEM");
      }
      if (item.status === SettlementItemStatus.Applied) {
        return { kind: "already_applied", item };
      }
      const settlement = await tx.settlements.findById(settlementId);
      if (settlement === null) {
        throw notFoundError("SETTLEMENT");
      }
      const result = await tx.matchResults.findByMatchAndVersion(
        settlement.match_id,
        settlement.result_version,
      );
      if (result === null) {
        throw internalError("settlement item 缺少对应 match_results 版本");
      }
      return this.applyInTransaction(tx, item, result, serverNow);
    });
  }

  /** 由结算 orchestration 在其事务上下文中调用。 */
  async applyInTransaction(
    tx: UnitOfWork,
    item: SettlementItem,
    result: MatchResult,
    serverNow: Date,
  ): Promise<SettlementItemApplicationOutcome> {
    assertValidServerNow(serverNow);
    const ports = requireAggregationPorts(tx);
    const currentItem = await tx.settlementItems.findBySettlementAndPrediction(
      item.settlement_id,
      item.prediction_id,
    );
    if (currentItem === null) {
      throw notFoundError("SETTLEMENT_ITEM");
    }
    if (currentItem.status === SettlementItemStatus.Applied) {
      return { kind: "already_applied", item: currentItem };
    }

    const settlement = await tx.settlements.findById(currentItem.settlement_id);
    if (settlement === null) {
      throw notFoundError("SETTLEMENT");
    }
    if (settlement.status !== SettlementDocStatus.Running) {
      throw invalidLedger(`settlement item 所属 settlement 非 running（settlement_id=${settlement.settlement_id}）`);
    }
    const match = await tx.matches.findById(settlement.match_id);
    if (match === null) {
      throw notFoundError("MATCH");
    }
    if (
      result.match_id !== match.match_id ||
      result.result_version !== settlement.result_version ||
      currentItem.source_result_version !== result.result_version
    ) {
      throw invalidLedger(`settlement item/result 版本或比赛不一致（prediction_id=${currentItem.prediction_id}）`);
    }
    if (match.period_anchor_at === null) {
      throw invalidLedger(`finished match 缺少 period_anchor_at（match_id=${match.match_id}）`);
    }

    const prediction = await tx.predictions.findById(currentItem.prediction_id);
    if (prediction === null) {
      throw notFoundError("PREDICTION");
    }
    if (
      prediction.scoring_rule_version !== settlement.rule_version ||
      match.scoring_rule_version !== settlement.rule_version
    ) {
      throw invalidLedger(`settlement rule_version 与 prediction/match 不一致（prediction_id=${prediction.prediction_id}）`);
    }
    if (prediction.applied_result_version === currentItem.source_result_version) {
      if (
        currentItem.user_id !== prediction.user_id ||
        scoreOf(prediction) !== currentItem.new_score ||
        boolOf(prediction.wdl_hit) !== currentItem.new_wdl_hit ||
        boolOf(prediction.exact_hit) !== currentItem.new_exact_hit
      ) {
        throw invalidLedger(`prediction applied 版本与 item new 值不一致（prediction_id=${prediction.prediction_id}）`);
      }
      const appliedItem: SettlementItem = {
        ...currentItem,
        status: SettlementItemStatus.Applied,
        applied_at: currentItem.applied_at ?? serverNow,
        attempt_count: currentItem.attempt_count + 1,
        last_error_code: null,
        last_error_message: null,
        updated_at: serverNow,
      };
      await tx.settlementItems.update(appliedItem);
      return { kind: "applied", item: appliedItem };
    }
    assertItemMatchesPrediction(currentItem, prediction);

    const delta = computeSettlementItemDelta(
      prediction,
      result,
      prediction.scoring_rule_version,
    );
    assertDeltaMatchesItem(currentItem, delta);
    const updatedPrediction = applySettlementItemDelta(
      prediction,
      currentItem.source_result_version,
      delta,
    );
    assertPredictionInvariants(updatedPrediction);

    const user = await tx.users.findById(currentItem.user_id);
    if (user === null) {
      throw notFoundError("USER");
    }
    if (user.user_id !== prediction.user_id) {
      throw invalidLedger(`item user 与 prediction user 不一致（prediction_id=${prediction.prediction_id}）`);
    }
    assertUserCareerInvariants(user);
    const updatedUserBase = {
      career_points: user.career_points + currentItem.score_delta,
      career_valid_predictions: user.career_valid_predictions + currentItem.valid_prediction_delta,
      career_wdl_hits: user.career_wdl_hits + hitDelta(currentItem.new_wdl_hit, currentItem.old_wdl_hit),
      career_exact_hits: user.career_exact_hits + hitDelta(currentItem.new_exact_hit, currentItem.old_exact_hit),
    };
    const reason = settlement.is_correction
      ? LevelHistoryReason.Correction
      : LevelHistoryReason.Settlement;
    const careerLevel = rebuildLevelState(
      LevelScope.Career,
      updatedUserBase.career_valid_predictions,
      updatedUserBase.career_wdl_hits,
      user.career_level,
      user.career_best_level,
      reason,
    );
    const updatedUser: User = {
      ...user,
      career_points: updatedUserBase.career_points,
      career_valid_predictions: updatedUserBase.career_valid_predictions,
      career_wdl_hits: updatedUserBase.career_wdl_hits,
      career_exact_hits: updatedUserBase.career_exact_hits,
      career_level: careerLevel.current_level,
      career_best_level: careerLevel.best_level,
      updated_at: serverNow,
    };
    assertUserCareerInvariants(updatedUser);

    const seasonStats = await ports.userSeasonStats.findByUserAndSeason(
      user.user_id,
      match.season_id,
    );
    if (seasonStats === null && currentItem.valid_prediction_delta !== 1) {
      throw invalidLedger(`修正 item 缺少已有 season stats（season_id=${match.season_id}）`);
    }
    const seasonBase = seasonStats ?? emptySeasonStats(user.user_id, match.season_id, serverNow);
    const updatedSeasonBase = applyStatsDelta(seasonBase, currentItem);
    const seasonLevel = rebuildLevelState(
      LevelScope.Season,
      updatedSeasonBase.valid_predictions,
      updatedSeasonBase.wdl_hits,
      seasonBase.level,
      seasonBase.best_level,
      reason,
    );
    const updatedSeason: UserSeasonStats = {
      ...seasonBase,
      ...updatedSeasonBase,
      level: seasonLevel.current_level,
      best_level: seasonLevel.best_level,
      updated_at: serverNow,
    };
    assertSeasonStatsInvariants(updatedSeason);

    const predictions = await tx.predictions.findByUser(user.user_id);
    const periodRefs = [
      {
        period_type: PeriodType.Week,
        period_key: calculatePeriodKey(PeriodType.Week, match.period_anchor_at),
      },
      {
        period_type: PeriodType.Month,
        period_key: calculatePeriodKey(PeriodType.Month, match.period_anchor_at),
      },
    ] as const;
    const rankingUpdates: Array<{ previous: RankingEntry | null; next: RankingEntry }> = [];
    for (const ref of periodRefs) {
      const existing = await ports.rankings.findByPeriodAndUser(
        ref.period_type,
        ref.period_key,
        user.user_id,
      );
      if (existing === null && currentItem.valid_prediction_delta !== 1) {
        throw invalidLedger(`修正 item 缺少已有 ranking（${ref.period_type}:${ref.period_key}）`);
      }
      const base = existing ?? emptyRanking(ref.period_type, ref.period_key, user.user_id, serverNow);
      const lastScoring = await lastScoringAt(
        tx,
        predictions,
        ref.period_type,
        ref.period_key,
        updatedPrediction,
      );
      const next: RankingEntry = {
        ...base,
        period_score: base.period_score + currentItem.score_delta,
        valid_predictions: base.valid_predictions + currentItem.valid_prediction_delta,
        wdl_hits: base.wdl_hits + hitDelta(currentItem.new_wdl_hit, currentItem.old_wdl_hit),
        exact_hits: base.exact_hits + hitDelta(currentItem.new_exact_hit, currentItem.old_exact_hit),
        last_scoring_match_at: lastScoringForPeriodScore(
          base.period_score + currentItem.score_delta,
          lastScoring,
        ),
        global_rank: null,
        updated_at: serverNow,
      };
      assertRankingInvariants(next);
      rankingUpdates.push({ previous: existing, next });
    }

    const existingUnlocks = await tx.unlocks.findByUser(user.user_id);
    const grants = decideUnlockGrants(
      updatedUser.career_points,
      new Set(existingUnlocks.map((unlock) => unlock.unlock_code)),
    );
    const unlocks = grants.map((grant) => ({
      schema_version: SCHEMA_VERSION,
      unlock_id: newUuid(),
      user_id: user.user_id,
      unlock_code: grant.unlock_code,
      threshold_points: grant.threshold_points,
      source_version: grant.source_version,
      unlocked_at: serverNow,
    }));

    await tx.predictions.update({ ...updatedPrediction, updated_at: serverNow });
    await tx.users.update(updatedUser);
    if (seasonStats === null) {
      await ports.userSeasonStats.insert(updatedSeason);
    } else {
      await ports.userSeasonStats.update(updatedSeason);
    }
    for (const ranking of rankingUpdates) {
      if (ranking.previous === null) {
        await ports.rankings.insert(ranking.next);
      } else {
        await ports.rankings.update(ranking.next);
      }
      await rebuildGlobalRanks(tx, ports.rankings, ranking.next.period_type, ranking.next.period_key, serverNow);
    }
    if (careerLevel.should_record_history) {
      await ports.levelHistory.insert(levelHistory(
        user.user_id,
        LevelScope.Career,
        null,
        careerLevel.from_level as number,
        careerLevel.to_level as number,
        updatedUser.career_valid_predictions,
        updatedUser.career_wdl_hits,
        reason,
        serverNow,
      ));
    }
    if (seasonLevel.should_record_history) {
      await ports.levelHistory.insert(levelHistory(
        user.user_id,
        LevelScope.Season,
        match.season_id,
        seasonLevel.from_level as number,
        seasonLevel.to_level as number,
        updatedSeason.valid_predictions,
        updatedSeason.wdl_hits,
        reason,
        serverNow,
      ));
    }
    for (const unlock of unlocks) {
      await tx.unlocks.insert(unlock);
    }

    const appliedItem: SettlementItem = {
      ...currentItem,
      status: SettlementItemStatus.Applied,
      applied_at: serverNow,
      attempt_count: currentItem.attempt_count + 1,
      last_error_code: null,
      last_error_message: null,
      updated_at: serverNow,
    };
    await tx.settlementItems.update(appliedItem);
    return { kind: "applied", item: appliedItem };
  }
}

/** 将原子应用服务适配到既有结算 orchestration 的事务内 worker。 */
export function createAtomicSettlementItemWorker(
  application: SettlementItemApplicationService,
): SettlementItemWorker {
  return async (item, result, context?: SettlementItemWorkerContext) => {
    if (context === undefined) {
      throw internalError("原子 settlement item worker 缺少事务上下文");
    }
    const outcome = await application.applyInTransaction(
      context.tx,
      item,
      result,
      context.server_now,
    );
    return { item_applied: outcome.kind === "applied" };
  };
}
