import { FIXED_CONFIG_V1, MVP_SEASON } from "../domain/config.js";
import { PeriodType, SCHEMA_VERSION, SettlementItemStatus } from "../domain/enums.js";
import { conflictError, internalError, validationError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import { calculatePeriodKey, isValidPeriodKey } from "../domain/time.js";
import type { Match, RankingEntry } from "../domain/types.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";
import { rebuildPeriodRankings } from "./ranking-rebuild.js";
import {
  activeSettlement,
  assertRankingPort,
  invalidLedger,
  loadAppliedSettlementFacts,
} from "./rebuild-service-support.js";
import { assertValidServerNow } from "./period-finalize.js";
import { rankingPeriodLockKey } from "./settlement-item-application-service.js";

const REBUILD_LEASE_MILLISECONDS = FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000;

export interface RebuildPeriodRankingsOutcome {
  rankings: RankingEntry[];
  created_count: number;
  updated_count: number;
}

export function periodRankingsRebuildLockKey(
  periodType: PeriodType,
  periodKey: string,
): string {
  return `maintenance:rebuild:rankings:${periodType}:${periodKey}`;
}

export function assertPeriodType(periodType: PeriodType): void {
  if (periodType !== PeriodType.Week && periodType !== PeriodType.Month) {
    throw validationError("未知 period_type", { period_type: periodType });
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
  targetMatchIds: ReadonlySet<string>,
): Promise<Awaited<ReturnType<UnitOfWork["settlementItems"]["findByStatus"]>>> {
  const selected = [] as Awaited<ReturnType<UnitOfWork["settlementItems"]["findByStatus"]>>;
  const applied = await tx.settlementItems.findByStatus(SettlementItemStatus.Applied);
  for (const item of applied) {
    const settlement = await tx.settlements.findById(item.settlement_id);
    if (settlement === null) {
      throw invalidLedger(`applied item 缺少 settlement（prediction_id=${item.prediction_id}）`);
    }
    if (targetMatchIds.has(settlement.match_id)) {
      selected.push(item);
    }
  }
  return selected;
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
      new Date(serverNow.getTime() + REBUILD_LEASE_MILLISECONDS),
    );
    if (!acquired) {
      throw conflictError(
        "SETTLEMENT_ALREADY_RUNNING",
        "目标周期存在并发 rebuild",
      );
    }

    try {
      return await this.repo.withTransaction((tx) =>
        this.rebuildPeriodRankingsInTransaction(tx, periodType, periodKey, serverNow),
      );
    } finally {
      await this.repo.jobLocks.release(lockKey, ownerId);
    }
  }

  /** Caller must hold periodRankingsRebuildLockKey; 本方法内再获取第 15.8 节 ranking 周期锁。 */
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

    const jobLocks = tx.jobLocks;
    if (jobLocks === undefined) {
      throw internalError("排行榜 rebuild 缺少 jobLocks repository port");
    }
    const rankingLockKey = rankingPeriodLockKey(periodType, periodKey);
    const rankingOwnerId = newUuid();
    const rankingLeaseUntil = new Date(
      serverNow.getTime() + FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000,
    );
    const rankingAcquired = await jobLocks.acquire(
      rankingLockKey,
      rankingOwnerId,
      rankingLeaseUntil,
    );
    if (!rankingAcquired) {
      throw conflictError("SETTLEMENT_ALREADY_RUNNING", "周期排行榜重算锁被占用", {
        lock_key: rankingLockKey,
      });
    }

    try {
      return await this.rebuildPeriodRankingsWhileHoldingRankingLock(
        tx,
        periodType,
        periodKey,
        serverNow,
      );
    } finally {
      await jobLocks.release(rankingLockKey, rankingOwnerId);
    }
  }

  private async rebuildPeriodRankingsWhileHoldingRankingLock(
    tx: UnitOfWork,
    periodType: PeriodType,
    periodKey: string,
    serverNow: Date,
  ): Promise<RebuildPeriodRankingsOutcome> {
    assertRankingPort(tx);
    const matches = await tx.matches.findBySeason(MVP_SEASON.season_id);
    const selectedMatches = targetMatches(matches, periodType, periodKey);
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
      new Set(selectedMatches.map((match) => match.match_id)),
    );
    const facts = await loadAppliedSettlementFacts(tx, items);
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
    const rebuilt = rebuildPeriodRankings(items, periodByPrediction, anchorByPrediction);

    const saved: RankingEntry[] = [];
    let createdCount = 0;
    let updatedCount = 0;
    const rebuiltUserIds = new Set(rebuilt.map((entry) => entry.user_id));
    for (const entry of rebuilt) {
      const existing = await tx.rankings.findByPeriodAndUser(
        periodType,
        periodKey,
        entry.user_id,
      );
      if (existing === null) {
        const created: RankingEntry = {
          schema_version: SCHEMA_VERSION,
          ...entry,
          is_final: false,
          created_at: serverNow,
          updated_at: serverNow,
        };
        await tx.rankings.insert(created);
        saved.push(created);
        createdCount += 1;
      } else {
        const updated: RankingEntry = {
          ...existing,
          period_score: entry.period_score,
          valid_predictions: entry.valid_predictions,
          wdl_hits: entry.wdl_hits,
          exact_hits: entry.exact_hits,
          last_scoring_match_at: entry.last_scoring_match_at,
          global_rank: entry.global_rank,
          updated_at: serverNow,
        };
        await tx.rankings.update(updated);
        saved.push(updated);
        updatedCount += 1;
      }
    }

    // rankings 是可重建缓存，目标周期中没有事实账本的旧条目也必须被清零；历史封存标记保留。
    const staleRankings = (await tx.rankings.findByPeriod(periodType, periodKey))
      .filter((entry) => !rebuiltUserIds.has(entry.user_id))
      .sort((a, b) => a.user_id.localeCompare(b.user_id));
    for (const existing of staleRankings) {
      const cleared: RankingEntry = {
        ...existing,
        period_score: 0,
        valid_predictions: 0,
        wdl_hits: 0,
        exact_hits: 0,
        last_scoring_match_at: null,
        global_rank: null,
        updated_at: serverNow,
      };
      await tx.rankings.update(cleared);
      saved.push(cleared);
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
}

export { RebuildPeriodRankingsService as PeriodRankingsRebuildService };
