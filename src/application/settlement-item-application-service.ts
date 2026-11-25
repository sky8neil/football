/**
 * settlement item 原子应用服务。
 *
 * 一个 item 的账本 delta 是唯一输入；本服务在同一事务中更新 prediction、聚合缓存、
 * 解锁和 item 状态。旧聚合不是事实来源，但结算增量必须基于事务内当前值。
 * global_rank 在全部 item 完成后按第 15.8 节重算。
 */
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import {
  MatchScoreValue,
  PeriodType,
  RankingBoard,
  SCHEMA_VERSION,
  SettlementDocStatus,
  SettlementItemStatus,
} from "../domain/enums.js";
import { assertPredictionInvariants, assertRankingInvariants, assertSeasonStatsInvariants, assertUserCareerInvariants } from "../domain/invariants.js";
import { DomainError, conflictError, internalError, notFoundError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import {
  compareRankingEntry,
  isDeletedForPeriod,
  lastScoringForPeriodScore,
  rankForPosition,
} from "../domain/ranking.js";
import { calculatePeriodKey, levelSeasonOf, periodEndAt } from "../domain/time.js";
import {
  defaultLevelState,
  type Match,
  type MatchResult,
  type Prediction,
  type RankingEntry,
  type SettlementDoc,
  type SettlementItem,
  type User,
  type UserSeasonStats,
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
import { resolveEffectiveMatchesByIds } from "./match-identity.js";
import type { SettlementItemWorker, SettlementItemWorkerContext } from "./first-settlement-service.js";

const INVALID_LEDGER = "INVALID_LEDGER" as const;

function invalidLedger(message: string): DomainError {
  return new DomainError(INVALID_LEDGER, message);
}

type AggregationPorts = {
  userSeasonStats: UserSeasonStatsRepository & {
    findByUserAndSeasonForUpdate: NonNullable<UserSeasonStatsRepository["findByUserAndSeasonForUpdate"]>;
    patchFields: NonNullable<UserSeasonStatsRepository["patchFields"]>;
  };
  rankings: RankingRepository & {
    findByPeriodAndUserForUpdate: NonNullable<RankingRepository["findByPeriodAndUserForUpdate"]>;
    patchFields: NonNullable<RankingRepository["patchFields"]>;
  };
};

function requireAggregationPorts(tx: UnitOfWork): AggregationPorts {
  const userSeasonStats = tx.userSeasonStats;
  const rankings = tx.rankings;
  const findSeason = userSeasonStats?.findByUserAndSeasonForUpdate;
  const patchSeason = userSeasonStats?.patchFields;
  const findRanking = rankings?.findByPeriodAndUserForUpdate;
  const patchRanking = rankings?.patchFields;
  if (
    tx.users.findByIdForUpdate === undefined ||
    tx.users.patchFields === undefined ||
    userSeasonStats === undefined ||
    findSeason === undefined ||
    patchSeason === undefined ||
    rankings === undefined ||
    findRanking === undefined ||
    patchRanking === undefined
  ) {
    throw internalError("结算 item 缺少 users/user_season_stats/rankings 行锁与局部更新端口");
  }
  return {
    userSeasonStats: {
      ...userSeasonStats,
      findByUserAndSeasonForUpdate: findSeason,
      patchFields: patchSeason,
    },
    rankings: {
      ...rankings,
      findByPeriodAndUserForUpdate: findRanking,
      patchFields: patchRanking,
    },
  };
}

function userScorePatch(user: User): Partial<User> {
  return {
    career_points: user.career_points,
    career_valid_predictions: user.career_valid_predictions,
    career_wdl_hits: user.career_wdl_hits,
    career_exact_hits: user.career_exact_hits,
    career_last_scoring_match_at: user.career_last_scoring_match_at,
    updated_at: user.updated_at,
  };
}

function seasonScorePatch(stats: UserSeasonStats): Partial<UserSeasonStats> {
  return {
    points: stats.points,
    valid_predictions: stats.valid_predictions,
    wdl_hits: stats.wdl_hits,
    exact_hits: stats.exact_hits,
    last_scoring_match_at: stats.last_scoring_match_at,
    updated_at: stats.updated_at,
  };
}

function rankingScorePatch(entry: RankingEntry): Partial<RankingEntry> {
  return {
    period_score: entry.period_score,
    valid_predictions: entry.valid_predictions,
    wdl_hits: entry.wdl_hits,
    exact_hits: entry.exact_hits,
    last_scoring_match_at: entry.last_scoring_match_at,
    updated_at: entry.updated_at,
  };
}

async function insertOrPatch<T>(
  existing: T | null,
  row: T,
  insert: (row: T) => Promise<void>,
  patch: (row: T) => Promise<void>,
): Promise<void> {
  if (existing !== null) {
    await patch(row);
    return;
  }
  await insert(row);
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

function emptyRanking(
  periodType: typeof PeriodType.Week,
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

async function findLatestScoringAnchorAt(
  effectiveMatches: ReadonlyMap<string, Match>,
  predictions: readonly Prediction[],
  updatedPrediction: Prediction,
  includeMatch: (match: Match) => boolean = () => true,
): Promise<Date | null> {
  let latest: Date | null = null;
  for (const original of predictions) {
    const prediction = original.prediction_id === updatedPrediction.prediction_id
      ? updatedPrediction
      : original;
    if (scoreOf(prediction) <= MatchScoreValue.Miss || prediction.applied_result_version < 1) {
      continue;
    }
    const match = effectiveMatches.get(prediction.match_id) ?? null;
    if (match === null || match.period_anchor_at === null) {
      throw invalidLedger(`计分 prediction 缺少 match 或 period_anchor_at（prediction_id=${prediction.prediction_id}）`);
    }
    if (!includeMatch(match)) {
      continue;
    }
    if (latest === null || match.period_anchor_at.getTime() > latest.getTime()) {
      latest = match.period_anchor_at;
    }
  }
  return latest;
}

function maxScoringAt(existing: Date | null, matchAnchorAt: Date): Date {
  return existing === null || existing.getTime() < matchAnchorAt.getTime()
    ? matchAnchorAt
    : existing;
}

/** 第 15.8 节：全局 rank 按周期重算锁。 */
export function rankingPeriodLockKey(
  periodType: typeof PeriodType.Week,
  periodKey: string,
): string {
  return `ranking:${periodType}:${periodKey}`;
}

/** 已持有周期 ranking 锁时，事务内只计算并原子局部更新 global_rank。 */
export async function rebuildGlobalRanksInTransaction(
  tx: UnitOfWork,
  periodType: typeof PeriodType.Week,
  periodKey: string,
  now: Date,
): Promise<void> {
  const rankings = tx.rankings;
  if (rankings === undefined) {
    throw internalError("结算 rank 重算缺少 rankings repository port");
  }
  const updateGlobalRank = rankings.updateGlobalRank;
  if (updateGlobalRank === undefined) {
    throw internalError("结算 rank 重算缺少 rankings.updateGlobalRank port");
  }

  const entries = await rankings.findByPeriod(periodType, periodKey);
  const comparable = entries.map((entry) => ({
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
  comparable.sort((a, b) => compareRankingEntry(RankingBoard.Week, a.value, b.value));
  const periodEnd = periodEndAt(periodType, periodKey);
  const deletedUserIds = new Set(
    (await tx.users.findAll())
      .filter((user) => isDeletedForPeriod(user, periodEnd))
      .map((user) => user.user_id),
  );
  let position = 0;
  for (const item of comparable) {
    const globalRank = deletedUserIds.has(item.entry.user_id)
      ? null
      : item.entry.valid_predictions < 1
        ? null
        : rankForPosition(item.entry.valid_predictions, ++position);
    if (item.entry.global_rank !== globalRank) {
      await updateGlobalRank.call(
        rankings,
        periodType,
        periodKey,
        item.entry.user_id,
        globalRank,
        now,
      );
    }
  }
}

const RANKING_REBUILD_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 周期 ranking 锁必须在 repo.withTransaction 之外 acquire/release。 */
export async function rebuildGlobalRanks(
  repo: AppRepository,
  periodType: typeof PeriodType.Week,
  periodKey: string,
  now: Date,
  options?: { retryDelaysMs?: readonly number[] },
): Promise<void> {
  const lockKey = rankingPeriodLockKey(periodType, periodKey);
  const ownerId = newUuid();
  const retryDelaysMs = options?.retryDelaysMs ?? RANKING_REBUILD_RETRY_DELAYS_MS;
  let acquired = false;
  for (let attempt = 0; ; attempt += 1) {
    const leaseUntil = new Date(
      Math.max(now.getTime(), Date.now()) + FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000,
    );
    acquired = await repo.jobLocks.acquire(lockKey, ownerId, leaseUntil);
    if (acquired) {
      break;
    }
    if (attempt >= retryDelaysMs.length) {
      throw conflictError("RANKING_REBUILD_ALREADY_RUNNING", "周期排行榜重算锁被占用", {
        lock_key: lockKey,
      });
    }
    await delay(retryDelaysMs[attempt]!);
  }

  try {
    await repo.withTransaction((tx) =>
      rebuildGlobalRanksInTransaction(tx, periodType, periodKey, now),
    );
  } finally {
    // 释放失败不得掩盖原始事务异常。
    await repo.jobLocks.release(lockKey, ownerId).catch(() => undefined);
  }
}

export async function rebuildSettlementWeekRanks(
  repo: AppRepository,
  periodAnchorAt: Date,
  now: Date,
  options?: { retryDelaysMs?: readonly number[] },
): Promise<void> {
  await rebuildGlobalRanks(
    repo,
    PeriodType.Week,
    calculatePeriodKey(PeriodType.Week, periodAnchorAt),
    now,
    options,
  );
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

    const lockUser = tx.users.findByIdForUpdate;
    const patchUser = tx.users.patchFields;
    if (lockUser === undefined || patchUser === undefined) {
      throw internalError("结算 item 缺少 users 行锁与局部更新端口");
    }
    const user = await lockUser(currentItem.user_id);
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
    if (match.period_anchor_at === null) {
      throw invalidLedger(`finished match 缺少 period_anchor_at（match_id=${match.match_id}）`);
    }
    const periodAnchorAt = match.period_anchor_at;
    const levelSeasonId = levelSeasonOf(periodAnchorAt);
    const needsZeroCorrectionRebuild =
      settlement.is_correction &&
      currentItem.old_score > MatchScoreValue.Miss &&
      currentItem.new_score === MatchScoreValue.Miss;
    const existingCareerLastScoringAt = user.career_last_scoring_match_at ?? null;
    let scoringHistoryContextPromise:
      | Promise<{ predictions: Prediction[]; effectiveMatches: Map<string, Match> }>
      | null = null;
    const getScoringHistoryContext = async () => {
      scoringHistoryContextPromise ??= (async () => {
        const predictions = await tx.predictions.findByUser(user.user_id);
        const scoringMatchIds = predictions
          .map((original) => original.prediction_id === updatedPrediction.prediction_id ? updatedPrediction : original)
          .filter((prediction) => scoreOf(prediction) > MatchScoreValue.Miss && prediction.applied_result_version >= 1)
          .map((prediction) => prediction.match_id);
        const effectiveMatches = await resolveEffectiveMatchesByIds(
          tx.matches,
          scoringMatchIds,
          { lenient: true },
        );
        return { predictions, effectiveMatches };
      })();
      return scoringHistoryContextPromise;
    };
    const careerNeedsRebuild =
      needsZeroCorrectionRebuild &&
      existingCareerLastScoringAt?.getTime() === periodAnchorAt.getTime();
    const updatedUser: User = {
      ...user,
      career_points: updatedUserBase.career_points,
      career_valid_predictions: updatedUserBase.career_valid_predictions,
      career_wdl_hits: updatedUserBase.career_wdl_hits,
      career_exact_hits: updatedUserBase.career_exact_hits,
      career_last_scoring_match_at: careerNeedsRebuild
        ? await (async () => {
            const ctx = await getScoringHistoryContext();
            return findLatestScoringAnchorAt(ctx.effectiveMatches, ctx.predictions, updatedPrediction);
          })()
        : currentItem.new_score > MatchScoreValue.Miss
          ? maxScoringAt(existingCareerLastScoringAt, periodAnchorAt)
          : existingCareerLastScoringAt,
      updated_at: serverNow,
    };
    assertUserCareerInvariants(updatedUser);

    const seasonStats = await ports.userSeasonStats.findByUserAndSeasonForUpdate(
      user.user_id,
      levelSeasonId,
    );
    if (seasonStats === null && currentItem.valid_prediction_delta !== 1) {
      throw invalidLedger(`修正 item 缺少已有 season stats（level_season_id=${levelSeasonId}）`);
    }
    const buildSeason = async (seasonBase: UserSeasonStats): Promise<UserSeasonStats> => {
      const updatedSeasonBase = applyStatsDelta(seasonBase, currentItem);
      const existingSeasonLastScoringAt = seasonBase.last_scoring_match_at ?? null;
      const seasonNeedsRebuild =
        needsZeroCorrectionRebuild &&
        existingSeasonLastScoringAt?.getTime() === periodAnchorAt.getTime();
      const seasonLastScoring = seasonNeedsRebuild
        ? await (async () => {
            const ctx = await getScoringHistoryContext();
            return findLatestScoringAnchorAt(
              ctx.effectiveMatches,
              ctx.predictions,
              updatedPrediction,
              (resolvedMatch) => levelSeasonOf(resolvedMatch.period_anchor_at as Date) === levelSeasonId,
            );
          })()
        : currentItem.new_score > MatchScoreValue.Miss
          ? maxScoringAt(existingSeasonLastScoringAt, periodAnchorAt)
          : existingSeasonLastScoringAt;
      const updatedSeason: UserSeasonStats = {
        ...seasonBase,
        ...updatedSeasonBase,
        last_scoring_match_at: lastScoringForPeriodScore(
          updatedSeasonBase.points,
          seasonLastScoring,
        ),
        updated_at: serverNow,
      };
      assertSeasonStatsInvariants(updatedSeason);
      return updatedSeason;
    };
    const updatedSeason = await buildSeason(
      seasonStats ?? emptySeasonStats(user.user_id, levelSeasonId, serverNow),
    );

    const periodRefs = [
      {
        period_type: PeriodType.Week,
        period_key: calculatePeriodKey(PeriodType.Week, periodAnchorAt),
      },
    ] as const;
    const rankingUpdates: Array<{
      previous: RankingEntry | null;
      next: RankingEntry;
      periodType: typeof PeriodType.Week;
      periodKey: string;
    }> = [];
    for (const ref of periodRefs) {
      const existing = await ports.rankings.findByPeriodAndUserForUpdate(
        ref.period_type,
        ref.period_key,
        user.user_id,
      );
      if (existing === null && currentItem.valid_prediction_delta !== 1) {
        throw invalidLedger(`修正 item 缺少已有 ranking（${ref.period_type}:${ref.period_key}）`);
      }
      const buildRanking = async (base: RankingEntry): Promise<RankingEntry> => {
        const rankingNeedsRebuild =
          needsZeroCorrectionRebuild &&
          base.last_scoring_match_at?.getTime() === periodAnchorAt.getTime();
        const lastScoring = rankingNeedsRebuild
          ? await (async () => {
              const ctx = await getScoringHistoryContext();
              return findLatestScoringAnchorAt(
                ctx.effectiveMatches,
                ctx.predictions,
                updatedPrediction,
                (resolvedMatch) => calculatePeriodKey(ref.period_type, resolvedMatch.period_anchor_at as Date) === ref.period_key,
              );
            })()
          : currentItem.new_score > MatchScoreValue.Miss
            ? maxScoringAt(base.last_scoring_match_at, periodAnchorAt)
            : base.last_scoring_match_at;
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
          updated_at: serverNow,
        };
        assertRankingInvariants(next);
        return next;
      };
      const next = await buildRanking(
        existing ?? emptyRanking(ref.period_type, ref.period_key, user.user_id, serverNow),
      );
      rankingUpdates.push({
        previous: existing,
        next,
        periodType: ref.period_type,
        periodKey: ref.period_key,
      });
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
    await patchUser(updatedUser.user_id, userScorePatch(updatedUser));
    await insertOrPatch(
      seasonStats,
      updatedSeason,
      (row) => ports.userSeasonStats.insert(row),
      (row) => ports.userSeasonStats.patchFields(
        user.user_id,
        levelSeasonId,
        seasonScorePatch(row),
      ),
    );
    for (const ranking of rankingUpdates) {
      await insertOrPatch(
        ranking.previous,
        ranking.next,
        (row) => ports.rankings.insert(row),
        (row) => ports.rankings.patchFields(
          ranking.periodType,
          ranking.periodKey,
          user.user_id,
          rankingScorePatch(row),
        ),
      );
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
