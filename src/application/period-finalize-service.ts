import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { DomainError, internalError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import { periodEndAt } from "../domain/time.js";
import { PeriodType, RankingBoard, SCHEMA_VERSION, SyncJobStatus, SyncJobType } from "../domain/enums.js";
import { compareRankingEntry, isDeletedForPeriod, rankForPosition } from "../domain/ranking.js";
import type { RankingEntry, SyncLog, User } from "../domain/types.js";
import type {
  AppRepository,
  RankingRepository,
  SyncLogRepository,
  UnitOfWork,
  UserSeasonStatsRepository,
} from "../infrastructure/repositories.js";
import { assertValidServerNow, finalizeRankingEntry } from "./period-finalize.js";
import { rankingPeriodLockKey } from "./settlement-item-application-service.js";

const PERIOD_FINALIZE_LOCK_KEY = "sync:period_finalize";

export interface PeriodFinalizeOutcome {
  period_type: PeriodType;
  period_key: string;
  due: boolean;
  skipped: boolean;
  finalized_count: number;
  skipped_count: number;
}

type FinalizeRankingPort = RankingRepository & {
  findByPeriodAndUserForUpdate: NonNullable<RankingRepository["findByPeriodAndUserForUpdate"]>;
  patchFields: NonNullable<RankingRepository["patchFields"]>;
};

type FinalizeSeasonPort = UserSeasonStatsRepository & {
  findByUserAndSeasonForUpdate: NonNullable<UserSeasonStatsRepository["findByUserAndSeasonForUpdate"]>;
};

function assertRankingPort(tx: UnitOfWork): asserts tx is UnitOfWork & { rankings: FinalizeRankingPort } {
  if (
    tx.rankings?.findByPeriodAndUserForUpdate === undefined ||
    tx.rankings.patchFields === undefined
  ) {
    throw internalError("period_finalize 缺少 rankings 行锁与局部更新端口");
  }
}

function assertAggregateLockPorts(
  tx: UnitOfWork,
): asserts tx is UnitOfWork & { userSeasonStats: FinalizeSeasonPort; rankings: FinalizeRankingPort } {
  assertRankingPort(tx);
  if (
    tx.users.findByIdForUpdate === undefined ||
    tx.userSeasonStats?.findByUserAndSeasonForUpdate === undefined
  ) {
    throw internalError("period_finalize 缺少 users/user_season_stats 行锁端口");
  }
}

function compareId(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function requireSyncLogs(
  repo: Pick<AppRepository, "syncLogs">,
): SyncLogRepository {
  if (repo.syncLogs === undefined) {
    throw internalError("period_finalize 缺少 sync_logs repository port");
  }
  return repo.syncLogs;
}

function errorCode(error: unknown): string {
  return error instanceof DomainError ? error.code : "INTERNAL_ERROR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "period finalize failed";
}

/**
 * 封存一个已知周期。周期枚举/边界仍由 domain time 统一校验，写入只发生在事务内。
 * 调度器负责按小时枚举需要处理的周期；锁保证同一 period_finalize job 不并发。
 */
export class PeriodFinalizeService {
  constructor(private readonly repo: AppRepository) {}

  async finalize(
    periodType: PeriodType,
    periodKey: string,
    serverNow: Date,
  ): Promise<PeriodFinalizeOutcome> {
    assertValidServerNow(serverNow);
    if (periodType !== PeriodType.Week) {
      throw new DomainError("VALIDATION_ERROR", "period finalize 只支持 week", {
        period_type: periodType,
      });
    }
    const endAt = periodEndAt(periodType, periodKey);
    if (serverNow.getTime() < endAt.getTime()) {
      return {
        period_type: periodType,
        period_key: periodKey,
        due: false,
        skipped: false,
        finalized_count: 0,
        skipped_count: 0,
      };
    }

    assertAggregateLockPorts(this.repo);
    const syncLogs = requireSyncLogs(this.repo);

    const ownerId = newUuid();
    const rankingOwnerId = newUuid();
    const rankingLockKey = rankingPeriodLockKey(periodType, periodKey);
    const leaseUntil = new Date(
      Math.max(serverNow.getTime(), Date.now()) + FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60_000,
    );
    const acquired = await this.repo.jobLocks.acquire(
      PERIOD_FINALIZE_LOCK_KEY,
      ownerId,
      leaseUntil,
    );
    if (!acquired) {
      return {
        period_type: periodType,
        period_key: periodKey,
        due: true,
        skipped: true,
        finalized_count: 0,
        skipped_count: 0,
      };
    }

    let rankingLockHeld = false;
    try {
      rankingLockHeld = await this.repo.jobLocks.acquire(
        rankingLockKey,
        rankingOwnerId,
        leaseUntil,
      );
      if (!rankingLockHeld) {
        return {
          period_type: periodType,
          period_key: periodKey,
          due: true,
          skipped: true,
          finalized_count: 0,
          skipped_count: 0,
        };
      }

      const runningLog: SyncLog = {
        schema_version: SCHEMA_VERSION,
        sync_job_id: newUuid(),
        job_type: SyncJobType.PeriodFinalize,
        status: SyncJobStatus.Running,
        started_at: serverNow,
        finished_at: null,
        attempt_count: 1,
        items_read: 0,
        items_changed: 0,
        items_failed: 0,
        last_error_code: null,
        last_error_message: null,
        created_at: serverNow,
      };
      await syncLogs.insert(runningLog);

      let itemsRead = 0;
      try {
        const outcome = await this.repo.withTransaction(async (tx) => {
          assertAggregateLockPorts(tx);
          const entries = await tx.rankings.findByPeriod(periodType, periodKey);
          itemsRead = entries.length;
          const userIds = [...new Set(entries.map((entry) => entry.user_id))].sort(compareId);
          const lockedUsersById = new Map<string, User | null>();
          for (const userId of userIds) {
            lockedUsersById.set(userId, await tx.users.findByIdForUpdate!(userId));
          }
          const seasonRefs: Array<{ userId: string; levelSeasonId: string }> = [];
          for (const userId of userIds) {
            for (const stats of await tx.userSeasonStats.findByUser(userId)) {
              seasonRefs.push({ userId: stats.user_id, levelSeasonId: stats.level_season_id });
            }
          }
          seasonRefs.sort(
            (left, right) => compareId(left.userId, right.userId) || compareId(left.levelSeasonId, right.levelSeasonId),
          );
          for (const ref of seasonRefs) {
            await tx.userSeasonStats.findByUserAndSeasonForUpdate(ref.userId, ref.levelSeasonId);
          }

          const lockedEntries: Array<RankingEntry | null> = [];
          for (const userId of userIds) {
            lockedEntries.push(
              await tx.rankings.findByPeriodAndUserForUpdate(periodType, periodKey, userId),
            );
          }
          const presentEntries = lockedEntries.filter((entry): entry is RankingEntry => entry !== null);
          const hasDeletedUser = presentEntries.some((entry) => {
            const lockedUser = lockedUsersById.get(entry.user_id) ?? null;
            return lockedUser !== null && isDeletedForPeriod(lockedUser, endAt);
          });
          const recomputedRankByUser = new Map<string, number | null>();
          if (hasDeletedUser) {
            const comparable = presentEntries.map((entry) => ({
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
            let rankPosition = 0;
            for (const item of comparable) {
              const lockedUser = lockedUsersById.get(item.entry.user_id) ?? null;
              const deletedForPeriod = lockedUser !== null && isDeletedForPeriod(lockedUser, endAt);
              const nextRank = deletedForPeriod || item.entry.valid_predictions < 1
                ? null
                : rankForPosition(item.entry.valid_predictions, ++rankPosition);
              recomputedRankByUser.set(item.entry.user_id, nextRank);
            }
          }

          let finalizedCount = 0;
          let skippedCount = 0;
          for (const locked of lockedEntries) {
            if (locked === null) {
              skippedCount += 1;
              continue;
            }
            const finalized = finalizeRankingEntry(locked, serverNow);
            if (finalized === locked) {
              skippedCount += 1;
              continue;
            }
            const patch: Partial<RankingEntry> = hasDeletedUser &&
              locked.global_rank !== (recomputedRankByUser.get(locked.user_id) ?? null)
              ? { is_final: true, global_rank: recomputedRankByUser.get(locked.user_id) ?? null }
              : { is_final: true };
            await tx.rankings.patchFields(periodType, periodKey, locked.user_id, patch);
            finalizedCount += 1;
          }

          return {
            period_type: periodType,
            period_key: periodKey,
            due: true,
            skipped: false,
            finalized_count: finalizedCount,
            skipped_count: skippedCount,
          };
        });
        await syncLogs.update({
          ...runningLog,
          status: SyncJobStatus.Success,
          finished_at: serverNow,
          items_read: itemsRead,
          items_changed: outcome.finalized_count,
        });
        return outcome;
      } catch (error) {
        await syncLogs.update({
          ...runningLog,
          status: SyncJobStatus.Failed,
          finished_at: serverNow,
          items_read: itemsRead,
          items_failed: 1,
          last_error_code: errorCode(error),
          last_error_message: errorMessage(error),
        });
        throw error;
      }
    } finally {
      if (rankingLockHeld) {
        await this.repo.jobLocks.release(rankingLockKey, rankingOwnerId).catch(() => undefined);
      }
      await this.repo.jobLocks.release(PERIOD_FINALIZE_LOCK_KEY, ownerId);
    }
  }
}

export { PERIOD_FINALIZE_LOCK_KEY };
