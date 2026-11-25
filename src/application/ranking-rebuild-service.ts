import { activeSeasonIds, FIXED_CONFIG_V1, SUPPORTED_LEAGUES } from "../domain/config.js";
import {
  PeriodType,
  RankingBoard,
  SCHEMA_VERSION,
  SettlementItemStatus,
} from "../domain/enums.js";
import { conflictError, internalError, validationError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import { isDeletedForPeriod } from "../domain/ranking.js";
import {
  calculatePeriodKey,
  isValidPeriodKey,
  periodEndAt,
  periodStartAt,
} from "../domain/time.js";
import type { BoardSnapshot, Match, RankingEntry } from "../domain/types.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";
import { rebuildPeriodRankings } from "./ranking-rebuild.js";
import {
  activeSettlement,
  assertRankingPort,
  loadAppliedSettlementFacts,
} from "./rebuild-service-support.js";
import { assertValidServerNow } from "./period-finalize.js";
import { rankingPeriodLockKey } from "./settlement-item-application-service.js";
import { writeBoardSnapshotInTransaction } from "./board-snapshot.js";

const REBUILD_LEASE_MILLISECONDS = FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000;

function rebuildLeaseDeadline(serverNow: Date): Date {
  return new Date(Math.max(serverNow.getTime(), Date.now()) + REBUILD_LEASE_MILLISECONDS);
}

export interface RebuildPeriodRankingsOutcome {
  rankings: RankingEntry[];
  created_count: number;
  updated_count: number;
}

export interface RebuildBoardSnapshotOutcome {
  snapshots: BoardSnapshot[];
  rebuilt_entry_count: number;
}

export function periodRankingsRebuildLockKey(
  periodType: PeriodType,
  periodKey: string,
): string {
  return `maintenance:rebuild:rankings:${periodType}:${periodKey}`;
}

export function boardSnapshotRebuildLockKey(
  board: BoardSnapshot["board"],
): string {
  return `maintenance:rebuild:board_snapshot:${board}`;
}

export function assertPeriodType(
  periodType: PeriodType,
): asserts periodType is typeof PeriodType.Week {
  if (periodType !== PeriodType.Week) {
    throw validationError("period_type 只支持 week", { period_type: periodType });
  }
}

export function assertPeriodKey(periodType: PeriodType, periodKey: string): void {
  if (!isValidPeriodKey(periodType, periodKey)) {
    throw validationError("period_key 格式与 period_type 不匹配", {
      period_type: periodType,
      period_key: periodKey,
    });
  }
}

function targetMatches(matches: readonly Match[], periodType: PeriodType, periodKey: string): Match[] {
  return matches.filter(
    (match) =>
      match.period_anchor_at !== null &&
      calculatePeriodKey(periodType, match.period_anchor_at) === periodKey,
  );
}

async function selectTargetItems(
  tx: UnitOfWork,
  targetMatchIds: readonly string[],
): Promise<Awaited<ReturnType<UnitOfWork["settlementItems"]["findByStatus"]>>> {
  const settlements = tx.settlements.findByMatchIds !== undefined
    ? await tx.settlements.findByMatchIds(targetMatchIds)
    : (await Promise.all(
        targetMatchIds.map((matchId) => tx.settlements.findByMatch(matchId)),
      )).flat();
  const settlementIds = settlements.map((settlement) => settlement.settlement_id);
  if (settlementIds.length === 0) return [];
  return tx.settlementItems.findBySettlementIdsAndStatus !== undefined
    ? await tx.settlementItems.findBySettlementIdsAndStatus(
        settlementIds,
        SettlementItemStatus.Applied,
      )
    : (await Promise.all(
        settlementIds.map((settlementId) =>
          tx.settlementItems.findBySettlementAndStatus(
            settlementId,
            SettlementItemStatus.Applied,
          ),
        ),
      )).flat();
}

export class RebuildPeriodRankingsService {
  constructor(private readonly repo: AppRepository) {}

  async rebuildPeriodRankings(
    periodType: PeriodType,
    periodKey: string,
    serverNow: Date,
  ): Promise<RebuildPeriodRankingsOutcome> {
    assertPeriodType(periodType);
    assertPeriodKey(periodType, periodKey);
    assertValidServerNow(serverNow);

    const lockKey = periodRankingsRebuildLockKey(periodType, periodKey);
    const ownerId = newUuid();
    const acquired = await this.repo.jobLocks.acquire(
      lockKey,
      ownerId,
      rebuildLeaseDeadline(serverNow),
    );
    if (!acquired) {
      throw conflictError(
        "SETTLEMENT_ALREADY_RUNNING",
        "目标周期存在并发 rebuild",
      );
    }

    const rankingLockKey = rankingPeriodLockKey(periodType, periodKey);
    const rankingOwnerId = newUuid();
    let rankingAcquired = false;
    try {
      rankingAcquired = await this.repo.jobLocks.acquire(
        rankingLockKey,
        rankingOwnerId,
        rebuildLeaseDeadline(serverNow),
      );
      if (!rankingAcquired) {
        throw conflictError("SETTLEMENT_ALREADY_RUNNING", "周期排行榜重算锁被占用", {
          lock_key: rankingLockKey,
        });
      }
      return await this.repo.withTransaction((tx) =>
        this.rebuildPeriodRankingsInTransaction(tx, periodType, periodKey, serverNow),
      );
    } finally {
      if (rankingAcquired) {
        await this.repo.jobLocks.release(rankingLockKey, rankingOwnerId).catch(() => undefined);
      }
      await this.repo.jobLocks.release(lockKey, ownerId);
    }
  }

  /** Caller must hold periodRankingsRebuildLockKey 与 rankingPeriodLockKey，且二者都在 withTransaction 之外。 */
  async rebuildPeriodRankingsInTransaction(
    tx: UnitOfWork,
    periodType: PeriodType,
    periodKey: string,
    serverNow: Date,
  ): Promise<RebuildPeriodRankingsOutcome> {
    assertPeriodType(periodType);
    assertPeriodKey(periodType, periodKey);
    assertValidServerNow(serverNow);
    assertRankingPort(tx);
    return this.rebuildPeriodRankingsWhileHoldingRankingLock(
      tx,
      periodType,
      periodKey,
      serverNow,
    );
  }

  private async rebuildPeriodRankingsWhileHoldingRankingLock(
    tx: UnitOfWork,
    periodType: typeof PeriodType.Week,
    periodKey: string,
    serverNow: Date,
  ): Promise<RebuildPeriodRankingsOutcome> {
    assertRankingPort(tx);
    const findRankingForUpdate = tx.rankings.findByPeriodAndUserForUpdate;
    const patchRankingFields = tx.rankings.patchFields;
    const findMatchForUpdate = tx.matches.findByIdForUpdate;
    if (
      findRankingForUpdate === undefined ||
      patchRankingFields === undefined ||
      findMatchForUpdate === undefined
    ) {
      throw internalError("ranking rebuild 缺少 rankings/matches 行锁与局部更新端口");
    }

    const supportedLeagueIds = new Set(SUPPORTED_LEAGUES.map((league) => league.league_id));
    const startAt = periodStartAt(periodType, periodKey);
    const endAt = periodEndAt(periodType, periodKey);
    const anchorMatches = tx.matches.findByPeriodAnchorWindow !== undefined
      ? await tx.matches.findByPeriodAnchorWindow(startAt, endAt)
      : (await Promise.all(
          [...supportedLeagueIds].map((leagueId) => tx.matches.findByLeague(leagueId)),
        )).flat();
    const matchesById = new Map<string, Match>();
    for (const match of anchorMatches) {
      if (supportedLeagueIds.has(match.league_id)) {
        matchesById.set(match.match_id, match);
      }
    }
    const candidateMatches = targetMatches([...matchesById.values()], periodType, periodKey);
    const existingRankings = await tx.rankings.findByPeriod(periodType, periodKey);
    const candidateItems = candidateMatches.length === 0
      ? []
      : await selectTargetItems(
          tx,
          candidateMatches.map((match) => match.match_id),
        );
    const candidateUserIds = [
      ...new Set([
        ...existingRankings.map((entry) => entry.user_id),
        ...candidateItems.map((item) => item.user_id),
      ]),
    ].sort((a, b) => a.localeCompare(b));

    // 跨表锁序必须遵守 users → user_season_stats → rankings → matches → groups，避免与并发结算/封榜死锁。
    const lockedRankingsByUser = new Map<string, RankingEntry | null>();
    for (const userId of candidateUserIds) {
      lockedRankingsByUser.set(
        userId,
        await findRankingForUpdate(periodType, periodKey, userId),
      );
    }

    const lockedMatches: Match[] = [];
    const sortedMatchIds = [...new Set(candidateMatches.map((match) => match.match_id))].sort((a, b) =>
      a.localeCompare(b),
    );
    for (const matchId of sortedMatchIds) {
      const lockedMatch = await findMatchForUpdate(matchId);
      if (lockedMatch !== null) {
        lockedMatches.push(lockedMatch);
      }
    }
    const selectedMatches = targetMatches(lockedMatches, periodType, periodKey);
    for (const match of selectedMatches) {
      if (activeSettlement(match)) {
        throw conflictError(
          "SETTLEMENT_ALREADY_RUNNING",
          "目标周期存在正在结算的比赛",
          { match_id: match.match_id },
        );
      }
    }

    const items = await selectTargetItems(
      tx,
      selectedMatches.map((match) => match.match_id),
    );
    const facts = await loadAppliedSettlementFacts(tx, items);
    const isHistoricalPeriod = periodEndAt(periodType, periodKey).getTime() <= serverNow.getTime();
    const periodByPrediction = new Map(
      facts.map((fact) => [
        fact.prediction.prediction_id,
        {
          period_type: periodType,
          period_key: periodKey,
        },
      ]),
    );
    const anchorByPrediction = new Map(
      facts.map((fact) => [fact.prediction.prediction_id, fact.match.period_anchor_at as Date]),
    );
    // 注销用户保留账本周统计累加值（修正 delta 闭合），仅按周期结束时刻区分是否占名次。
    const deletedUserIds = new Set(
      (await tx.users.findAll())
        .filter((user) => isDeletedForPeriod(user, endAt))
        .map((user) => user.user_id),
    );
    const rebuilt = rebuildPeriodRankings(
      items,
      periodByPrediction,
      anchorByPrediction,
      deletedUserIds,
    );

    const saved: RankingEntry[] = [];
    let createdCount = 0;
    let updatedCount = 0;
    const rebuiltUserIds = new Set(rebuilt.map((entry) => entry.user_id));
    for (const entry of rebuilt) {
      if (!lockedRankingsByUser.has(entry.user_id)) {
        throw conflictError(
          "SETTLEMENT_ALREADY_RUNNING",
          "目标周期存在并发结算新增排行条目",
          { user_id: entry.user_id },
        );
      }
      const existing = lockedRankingsByUser.get(entry.user_id) ?? null;
      if (existing === null) {
        const created: RankingEntry = {
          schema_version: SCHEMA_VERSION,
          ...entry,
          is_final: isHistoricalPeriod,
          created_at: serverNow,
          updated_at: serverNow,
        };
        await tx.rankings.insert(created);
        saved.push(created);
        createdCount += 1;
      } else {
        const isFinal = isHistoricalPeriod || existing.is_final;
        await patchRankingFields(periodType, periodKey, entry.user_id, {
          period_score: entry.period_score,
          valid_predictions: entry.valid_predictions,
          wdl_hits: entry.wdl_hits,
          exact_hits: entry.exact_hits,
          last_scoring_match_at: entry.last_scoring_match_at,
          global_rank: entry.global_rank,
          is_final: isFinal,
          updated_at: serverNow,
        });
        saved.push({
          ...existing,
          period_score: entry.period_score,
          valid_predictions: entry.valid_predictions,
          wdl_hits: entry.wdl_hits,
          exact_hits: entry.exact_hits,
          last_scoring_match_at: entry.last_scoring_match_at,
          global_rank: entry.global_rank,
          is_final: isFinal,
          updated_at: serverNow,
        });
        updatedCount += 1;
      }
    }

    // rankings 是可重建缓存，目标周期中没有事实账本的旧条目也必须被清零；历史封存标记保留。
    const staleRankings = [...lockedRankingsByUser.entries()]
      .filter(([userId, existing]) => existing !== null && !rebuiltUserIds.has(userId))
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [, existing] of staleRankings) {
      if (existing === null) continue;
      await patchRankingFields(periodType, periodKey, existing.user_id, {
        period_score: 0,
        valid_predictions: 0,
        wdl_hits: 0,
        exact_hits: 0,
        last_scoring_match_at: null,
        global_rank: null,
        updated_at: serverNow,
      });
      saved.push({
        ...existing,
        period_score: 0,
        valid_predictions: 0,
        wdl_hits: 0,
        exact_hits: 0,
        last_scoring_match_at: null,
        global_rank: null,
        updated_at: serverNow,
      });
      updatedCount += 1;
    }

    return {
      rankings: saved,
      created_count: createdCount,
      updated_count: updatedCount,
    };
  }

  rebuild(
    periodType: PeriodType,
    periodKey: string,
    serverNow: Date,
  ): Promise<RebuildPeriodRankingsOutcome> {
    return this.rebuildPeriodRankings(periodType, periodKey, serverNow);
  }

  async rebuildBoardSnapshot(
    board: BoardSnapshot["board"],
    serverNow: Date,
  ): Promise<RebuildBoardSnapshotOutcome> {
    assertValidServerNow(serverNow);
    if (
      board !== RankingBoard.Career &&
      board !== RankingBoard.Strength &&
      board !== RankingBoard.Season
    ) {
      throw validationError("board snapshot 只支持 career、strength 或 season", { board });
    }

    const lockKey = boardSnapshotRebuildLockKey(board);
    const ownerId = newUuid();
    const acquired = await this.repo.jobLocks.acquire(
      lockKey,
      ownerId,
      rebuildLeaseDeadline(serverNow),
    );
    if (!acquired) {
      throw conflictError("SETTLEMENT_ALREADY_RUNNING", "目标榜单存在并发 rebuild", {
        lock_key: lockKey,
      });
    }

    try {
      return await this.repo.withTransaction((tx) =>
        this.rebuildBoardSnapshotInTransaction(tx, board, serverNow),
      );
    } finally {
      await this.repo.jobLocks.release(lockKey, ownerId);
    }
  }

  async rebuildBoardSnapshotInTransaction(
    tx: UnitOfWork,
    board: BoardSnapshot["board"],
    serverNow: Date,
  ): Promise<RebuildBoardSnapshotOutcome> {
    assertValidServerNow(serverNow);
    const supportedLeagueIds = new Set(SUPPORTED_LEAGUES.map((league) => league.league_id));
    const seasonIds = new Set(
      SUPPORTED_LEAGUES.flatMap((league) => activeSeasonIds(league, serverNow)),
    );
    for (const seasonId of seasonIds) {
      for (const match of await tx.matches.findBySeason(seasonId)) {
        if (supportedLeagueIds.has(match.league_id) && activeSettlement(match)) {
          throw conflictError(
            "SETTLEMENT_ALREADY_RUNNING",
            "存在正在结算的比赛，不能重建榜单快照",
            { match_id: match.match_id },
          );
        }
      }
    }
    const snapshots = await writeBoardSnapshotInTransaction(tx, board, serverNow, {
      onExisting: "reject",
    });
    return { snapshots, rebuilt_entry_count: snapshots.length };
  }
}

export { RebuildPeriodRankingsService as PeriodRankingsRebuildService };
