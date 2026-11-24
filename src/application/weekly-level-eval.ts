import { FIXED_CONFIG_V1 } from "../domain/config.js";
import {
  LevelHistoryReason,
  LevelScope,
  RankingBoard,
  SCHEMA_VERSION,
  SyncJobType,
  UserStatus,
} from "../domain/enums.js";
import { DomainError, internalError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import {
  buildLevelInputs,
  evaluateLevel,
  type LevelEvalState,
  type LevelInputs,
  type LevelPredictionFact,
} from "../domain/levels.js";
import {
  levelProtectionEndAsOf,
  levelSeasonOf,
  nextMondayEvalAt,
  seasonFinalEvalAsOf,
} from "../domain/time.js";
import {
  defaultLevelState,
  type LevelHistoryEntry,
  type LevelState,
  type User,
  type UserSeasonStats,
} from "../domain/types.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";
import {
  buildReplayFacts,
  loadAppliedSettlementFacts,
} from "./rebuild-service-support.js";
import { assertValidServerNow } from "./period-finalize.js";
import { BoardSnapshotService } from "./board-snapshot.js";

export const WEEKLY_LEVEL_EVAL_LOCK_KEY = `sync:${SyncJobType.WeeklyLevelEval}`;
const LEVEL_EVAL_START_DELAY_MILLISECONDS =
  FIXED_CONFIG_V1.LEVEL_EVAL_START_DELAY_MINUTES * 60 * 1000;
const LEVEL_JOB_LEASE_MILLISECONDS = FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000;
const LEVEL_LOCK_RENEW_BATCH_USERS = 20;
const LEVEL_LOCK_RENEW_INTERVAL_MS = 2 * 60 * 1000;
const WEEK_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

function levelLeaseDeadline(anchor: Date): Date {
  return new Date(Math.max(anchor.getTime(), Date.now()) + LEVEL_JOB_LEASE_MILLISECONDS);
}

export interface WeeklyLevelEvalOutcome {
  kind: "completed" | "skipped";
  as_of: Date;
  evaluated_count: number;
  changed_count: number;
  skipped_count: number;
  settlement_skipped_count?: number;
  failed_count?: number;
  deferred_count?: number;
}

export function isSettlementAlreadyRunning(error: unknown): error is DomainError {
  return error instanceof DomainError && error.code === "SETTLEMENT_ALREADY_RUNNING";
}

export function weeklyEvalAsOf(serverNow: Date): Date {
  const cutoff = new Date(serverNow.getTime() - LEVEL_EVAL_START_DELAY_MILLISECONDS);
  const candidate = nextMondayEvalAt(cutoff);
  return candidate.getTime() <= cutoff.getTime()
    ? candidate
    : new Date(candidate.getTime() - WEEK_MILLISECONDS);
}

function seasonStartAt(levelSeasonId: string): Date {
  const match = /^(\d{4})_(\d{4})$/.exec(levelSeasonId);
  if (match === null || Number(match[2]) !== Number(match[1]) + 1) {
    throw new DomainError("INVALID_LEDGER", `level_season_id 非法（level_season_id=${levelSeasonId}）`);
  }
  return new Date(Date.UTC(Number(match[1]), 6, 1) - 8 * 60 * 60 * 1000);
}

export async function listDueSeasonFinalIds(
  repo: AppRepository,
  asOf: Date,
): Promise<string[]> {
  if (repo.userSeasonStats === undefined || repo.boardSnapshots === undefined) {
    throw internalError("weekly level eval 缺少赛季统计或快照 repository");
  }
  const currentStartYear = Number(levelSeasonOf(asOf).slice(0, 4));
  const candidateSeasonIds: string[] = [];
  for (let year = currentStartYear - 5; year <= currentStartYear; year += 1) {
    candidateSeasonIds.push(`${year}_${year + 1}`);
  }
  const due: string[] = [];
  for (const seasonId of candidateSeasonIds) {
    if (asOf.getTime() < seasonFinalEvalAsOf(seasonId).getTime()) continue;
    if ((await repo.boardSnapshots.findFinalBySeason(seasonId)).length > 0) continue;
    const stats = await repo.userSeasonStats.findByLevelSeason(seasonId);
    if (stats.length === 0) continue;
    let blockedByActiveUnfrozen = false;
    const checkedActiveUsers = new Map<string, boolean>();
    for (const row of stats) {
      if (row.is_level_frozen === true) continue;
      let isActive = checkedActiveUsers.get(row.user_id);
      if (isActive === undefined) {
        const owner = await repo.users.findById(row.user_id);
        isActive = owner?.status === UserStatus.Active;
        checkedActiveUsers.set(row.user_id, isActive);
      }
      if (isActive) {
        blockedByActiveUnfrozen = true;
        break;
      }
    }
    if (blockedByActiveUnfrozen) continue;
    due.push(seasonId);
  }
  return due;
}

async function generateDueSeasonFinals(
  repo: AppRepository,
  asOf: Date,
  serverNow: Date,
): Promise<void> {
  const snapshots = new BoardSnapshotService(repo);
  for (const seasonId of await listDueSeasonFinalIds(repo, asOf)) {
    await snapshots.generateSeasonFinal(seasonId, serverNow);
  }
}

function evalState(level: number, bestLevel: number, belowCount: number): LevelEvalState {
  return { level, best_level: bestLevel, below_count: belowCount };
}

export function evaluateWithProtection(
  state: LevelEvalState,
  inputs: LevelInputs,
  asOf: Date,
  firstEvalAsOf: Date | null,
): LevelEvalState {
  if (firstEvalAsOf !== null) {
    return evaluateLevel(
      state,
      inputs,
      FIXED_CONFIG_V1.LEVEL_RULE_VERSION,
      asOf,
      levelProtectionEndAsOf(firstEvalAsOf),
    );
  }

  const protectedResult = evaluateLevel(
    state,
    inputs,
    FIXED_CONFIG_V1.LEVEL_RULE_VERSION,
    asOf,
    new Date(asOf.getTime() + 1),
  );
  const unprotectedResult = evaluateLevel(
    state,
    inputs,
    FIXED_CONFIG_V1.LEVEL_RULE_VERSION,
    asOf,
    asOf,
  );
  if (
    protectedResult.level !== unprotectedResult.level ||
    protectedResult.below_count !== unprotectedResult.below_count
  ) {
    throw new DomainError(
      "SPEC_GAP",
      "LEVEL_FIRST_EVAL_AS_OF 未登记，当前评估结果受保护期影响",
    );
  }
  return protectedResult;
}

function levelFacts(facts: Parameters<typeof buildReplayFacts>[0]): LevelPredictionFact[] {
  return buildReplayFacts(facts).facts;
}

function historyEntry(params: {
  userId: string;
  scope: typeof LevelScope.Career | typeof LevelScope.Season;
  seasonId: string | null;
  fromLevel: number;
  toLevel: number;
  inputs: LevelInputs;
  asOf: Date;
  changedAt: Date;
}): LevelHistoryEntry {
  return {
    schema_version: SCHEMA_VERSION,
    level_history_id: newUuid(),
    user_id: params.userId,
    scope: params.scope,
    level_season_id: params.seasonId,
    from_level: params.fromLevel,
    to_level: params.toLevel,
    reason: LevelHistoryReason.WeeklyEval,
    eval_as_of: params.asOf,
    window_n: params.inputs.n,
    window_score_sum: params.inputs.S,
    b_points: params.inputs.b_points,
    level_rule_version: FIXED_CONFIG_V1.LEVEL_RULE_VERSION,
    settlement_id: null,
    changed_at: params.changedAt,
  };
}

function levelStateAfterEval(
  previous: LevelState,
  base: LevelEvalState,
  result: LevelEvalState,
  inputs: LevelInputs,
  asOf: Date,
): LevelState {
  return {
    ...previous,
    below_count: result.below_count,
    week_base_level: base.level,
    week_base_below_count: base.below_count,
    week_base_as_of: asOf,
    last_eval_as_of: asOf,
    last_eval_n: inputs.n,
    last_eval_score_sum: inputs.S,
    last_eval_b_points: inputs.b_points,
    last_eval_rule_version: FIXED_CONFIG_V1.LEVEL_RULE_VERSION,
  };
}

export function levelScopeLockKey(
  userId: string,
  scope: typeof LevelScope.Career | typeof LevelScope.Season,
  seasonId: string | null,
): string {
  return `sync:level_scope:${userId}:${scope}:${seasonId ?? "career"}`;
}

function requireLevelPorts(tx: UnitOfWork): asserts tx is UnitOfWork & {
  userSeasonStats: NonNullable<UnitOfWork["userSeasonStats"]>;
  levelHistory: NonNullable<UnitOfWork["levelHistory"]>;
} {
  if (tx.userSeasonStats === undefined || tx.levelHistory === undefined) {
    throw internalError("weekly level eval 缺少 season stats 或 level_history repository");
  }
}

async function userFacts(
  tx: UnitOfWork,
  userId: string,
  asOf: Date,
): Promise<LevelPredictionFact[]> {
  const items = await tx.settlementItems.findAppliedByUserBefore(userId, asOf);
  return levelFacts(await loadAppliedSettlementFacts(tx, items));
}

export function eligibleSeasonStats(stats: UserSeasonStats, asOf: Date): boolean {
  if (stats.is_level_frozen === true || asOf.getTime() < seasonStartAt(stats.level_season_id).getTime()) {
    return false;
  }
  return levelSeasonOf(asOf) === stats.level_season_id ||
    asOf.getTime() >= seasonFinalEvalAsOf(stats.level_season_id).getTime();
}

export class WeeklyLevelEvalService {
  constructor(
    private readonly repo: AppRepository,
    private readonly firstEvalAsOf: Date | null = FIXED_CONFIG_V1.LEVEL_FIRST_EVAL_AS_OF,
    private readonly log?: (entry: Record<string, unknown>) => void,
  ) {}

  async run(serverNow: Date): Promise<WeeklyLevelEvalOutcome> {
    assertValidServerNow(serverNow);
    const asOf = weeklyEvalAsOf(serverNow);
    if (this.firstEvalAsOf !== null && asOf.getTime() < this.firstEvalAsOf.getTime()) {
      const outcome = {
        kind: "completed" as const,
        as_of: asOf,
        evaluated_count: 0,
        changed_count: 0,
        skipped_count: 0,
        settlement_skipped_count: 0,
        failed_count: 0,
        deferred_count: 0,
      };
      await new BoardSnapshotService(this.repo).generate(RankingBoard.Strength, serverNow);
      await generateDueSeasonFinals(this.repo, asOf, serverNow);
      return outcome;
    }

    const ownerId = newUuid();
    const leaseDeadline = (): Date => levelLeaseDeadline(serverNow);
    const acquired = await this.repo.jobLocks.acquire(
      WEEKLY_LEVEL_EVAL_LOCK_KEY,
      ownerId,
      leaseDeadline(),
    );
    if (!acquired) {
      return {
        kind: "skipped",
        as_of: asOf,
        evaluated_count: 0,
        changed_count: 0,
        skipped_count: 0,
        settlement_skipped_count: 0,
        failed_count: 0,
        deferred_count: 0,
      };
    }

    let evaluatedCount = 0;
    let changedCount = 0;
    let skippedCount = 0;
    let settlementSkippedCount = 0;
    let failedCount = 0;
    let deferredCount = 0;
    let outcome: WeeklyLevelEvalOutcome;
    try {
      const { LevelCorrectionReevalService } = await import("./level-correction-reeval.js");
      const correctionReeval = new LevelCorrectionReevalService(this.repo, this.firstEvalAsOf);
      const renewWeeklyLock = async (): Promise<void> => {
        const renewed = await this.repo.jobLocks.renew(
          WEEKLY_LEVEL_EVAL_LOCK_KEY,
          ownerId,
          leaseDeadline(),
        );
        if (!renewed) {
          throw new Error("weekly level eval lock lost during correction reeval");
        }
      };
      await correctionReeval.runPendingBefore(asOf, serverNow, renewWeeklyLock);
      const users = await this.repo.users.findAll();
      let processedActiveUsers = 0;
      let lastRenewWallMs = Date.now();
      for (const candidate of users) {
        if (candidate.status !== UserStatus.Active) continue;
        if (candidate.career_valid_predictions >= 1) {
          try {
            const career = await this.evaluateCareer(candidate.user_id, asOf, serverNow);
            evaluatedCount += career.evaluated ? 1 : 0;
            changedCount += career.changed ? 1 : 0;
            skippedCount += career.skipped ? 1 : 0;
            deferredCount += career.deferred ? 1 : 0;
          } catch (error) {
            if (isSettlementAlreadyRunning(error)) {
              skippedCount += 1;
              settlementSkippedCount += 1;
              this.log?.({
                event: "weekly_level_eval_user_skipped",
                user_id: candidate.user_id,
                scope: LevelScope.Career,
                as_of: asOf.toISOString(),
                reason: error.code,
                message: error.message,
              });
            } else {
              failedCount += 1;
              this.log?.({
                event: "weekly_level_eval_user_failed",
                user_id: candidate.user_id,
                scope: LevelScope.Career,
                as_of: asOf.toISOString(),
                error_code: error instanceof DomainError ? error.code : "INTERNAL_ERROR",
                error_message: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }

        try {
          const seasonResults = await this.evaluateSeasons(candidate.user_id, asOf, serverNow);
          for (const result of seasonResults) {
            evaluatedCount += result.evaluated ? 1 : 0;
            changedCount += result.changed ? 1 : 0;
            skippedCount += result.skipped ? 1 : 0;
            settlementSkippedCount += result.settlementSkipped ? 1 : 0;
            failedCount += result.failed ? 1 : 0;
            deferredCount += result.deferred ? 1 : 0;
          }
        } catch (error) {
          if (isSettlementAlreadyRunning(error)) {
            skippedCount += 1;
            settlementSkippedCount += 1;
            this.log?.({
              event: "weekly_level_eval_user_skipped",
              user_id: candidate.user_id,
              scope: LevelScope.Season,
              as_of: asOf.toISOString(),
              reason: error.code,
              message: error.message,
            });
          } else {
            failedCount += 1;
            this.log?.({
              event: "weekly_level_eval_user_failed",
              user_id: candidate.user_id,
              scope: LevelScope.Season,
              as_of: asOf.toISOString(),
              error_code: error instanceof DomainError ? error.code : "INTERNAL_ERROR",
              error_message: error instanceof Error ? error.message : String(error),
            });
          }
        }

        processedActiveUsers += 1;
        const nowWallMs = Date.now();
        if (
          processedActiveUsers % LEVEL_LOCK_RENEW_BATCH_USERS === 0 ||
          nowWallMs - lastRenewWallMs >= LEVEL_LOCK_RENEW_INTERVAL_MS
        ) {
          let renewed = false;
          try {
            renewed = await this.repo.jobLocks.renew(
              WEEKLY_LEVEL_EVAL_LOCK_KEY,
              ownerId,
              leaseDeadline(),
            );
          } catch {
            renewed = false;
          }
          lastRenewWallMs = Date.now();
          if (!renewed) {
            this.log?.({
              event: "weekly_level_eval_lock_lost",
              as_of: asOf.toISOString(),
              processed_users: processedActiveUsers,
            });
            return {
              kind: "skipped",
              as_of: asOf,
              evaluated_count: evaluatedCount,
              changed_count: changedCount,
              skipped_count: skippedCount,
              settlement_skipped_count: settlementSkippedCount,
              failed_count: failedCount,
              deferred_count: deferredCount,
            };
          }
        }
      }
      const weeklyComplete =
        failedCount === 0 && settlementSkippedCount === 0 && deferredCount === 0;
      if (weeklyComplete) {
        await correctionReeval.runPending(asOf, serverNow, renewWeeklyLock);
      }
      outcome = {
        kind: "completed",
        as_of: asOf,
        evaluated_count: evaluatedCount,
        changed_count: changedCount,
        skipped_count: skippedCount,
        settlement_skipped_count: settlementSkippedCount,
        failed_count: failedCount,
        deferred_count: deferredCount,
      };
    } finally {
      await this.repo.jobLocks.release(WEEKLY_LEVEL_EVAL_LOCK_KEY, ownerId);
    }
    if (failedCount === 0 && settlementSkippedCount === 0 && deferredCount === 0) {
      await new BoardSnapshotService(this.repo).generate(RankingBoard.Strength, serverNow);
      await generateDueSeasonFinals(this.repo, asOf, serverNow);
    }
    return outcome;
  }

  private async evaluateCareer(
    userId: string,
    asOf: Date,
    changedAt: Date,
  ): Promise<{ evaluated: boolean; changed: boolean; skipped: boolean; deferred?: boolean }> {
    const lockKey = levelScopeLockKey(userId, LevelScope.Career, null);
    const ownerId = newUuid();
    if (!(await this.repo.jobLocks.acquire(
      lockKey,
      ownerId,
      levelLeaseDeadline(changedAt),
    ))) {
      return { evaluated: false, changed: false, skipped: false, deferred: true };
    }
    try {
      return await this.repo.withTransaction(async (tx) => {
        const user = await tx.users.findById(userId);
        if (user === null || user.status !== UserStatus.Active || user.career_valid_predictions < 1) {
          return { evaluated: false, changed: false, skipped: true };
        }
        const previous = user.career_level_state ?? defaultLevelState();
        if (
          previous.last_eval_as_of?.getTime() === asOf.getTime() ||
          previous.week_base_as_of?.getTime() === asOf.getTime()
        ) {
          return { evaluated: false, changed: false, skipped: true };
        }
        const facts = await userFacts(tx, userId, asOf);
        const inputs = buildLevelInputs(facts, LevelScope.Career, asOf);
        const base = evalState(user.career_level, user.career_best_level, previous.below_count);
        const result = evaluateWithProtection(base, inputs, asOf, this.firstEvalAsOf);
        const nextState = levelStateAfterEval(previous, base, result, inputs, asOf);
        const changed = result.level !== user.career_level;
        requireLevelPorts(tx);
        if (changed) {
          await tx.levelHistory.insert(historyEntry({
            userId,
            scope: LevelScope.Career,
            seasonId: null,
            fromLevel: user.career_level,
            toLevel: result.level,
            inputs,
            asOf,
            changedAt,
          }));
        }
        await tx.users.update({
          ...user,
          career_level: result.level,
          career_best_level: Math.max(user.career_best_level, result.level),
          career_level_state: nextState,
          updated_at: changedAt,
        });
        return { evaluated: true, changed, skipped: false };
      });
    } finally {
      await this.repo.jobLocks.release(lockKey, ownerId);
    }
  }

  private async evaluateSeasons(
    userId: string,
    asOf: Date,
    changedAt: Date,
  ): Promise<Array<{
    evaluated: boolean;
    changed: boolean;
    skipped: boolean;
    settlementSkipped: boolean;
    failed: boolean;
    deferred?: boolean;
  }>> {
    const statsRows = this.repo.userSeasonStats === undefined
      ? []
      : await this.repo.userSeasonStats.findByUser(userId);
    const results: Array<{
      evaluated: boolean;
      changed: boolean;
      skipped: boolean;
      settlementSkipped: boolean;
      failed: boolean;
      deferred?: boolean;
    }> = [];
    for (const row of statsRows) {
      if (!eligibleSeasonStats(row, asOf)) continue;
      const lockKey = levelScopeLockKey(userId, LevelScope.Season, row.level_season_id);
      const ownerId = newUuid();
      if (!(await this.repo.jobLocks.acquire(
        lockKey,
        ownerId,
        levelLeaseDeadline(changedAt),
      ))) {
        results.push({
          evaluated: false,
          changed: false,
          skipped: false,
          settlementSkipped: false,
          failed: false,
          deferred: true,
        });
        continue;
      }
      try {
        const result = await this.repo.withTransaction(async (tx) => {
          requireLevelPorts(tx);
          const user = await tx.users.findById(userId);
          const stats = await tx.userSeasonStats.findByUserAndSeason(userId, row.level_season_id);
          if (
            user === null || user.status !== UserStatus.Active || stats === null ||
            stats.is_level_frozen === true || !eligibleSeasonStats(stats, asOf)
          ) {
            return { evaluated: false, changed: false, skipped: true };
          }
          const previous = stats.level_state ?? defaultLevelState();
          if (
            previous.last_eval_as_of?.getTime() === asOf.getTime() ||
            previous.week_base_as_of?.getTime() === asOf.getTime()
          ) {
            return { evaluated: false, changed: false, skipped: true };
          }
          const facts = await userFacts(tx, userId, asOf);
          const inputs = buildLevelInputs(facts, LevelScope.Season, asOf, stats.level_season_id);
          const base = evalState(stats.level, stats.best_level, previous.below_count);
          const evalResult = evaluateWithProtection(base, inputs, asOf, this.firstEvalAsOf);
          const nextState = levelStateAfterEval(previous, base, evalResult, inputs, asOf);
          const changed = evalResult.level !== stats.level;
          if (changed) {
            await tx.levelHistory.insert(historyEntry({
              userId,
              scope: LevelScope.Season,
              seasonId: stats.level_season_id,
              fromLevel: stats.level,
              toLevel: evalResult.level,
              inputs,
              asOf,
              changedAt,
            }));
          }
          const freeze = levelSeasonOf(asOf) !== stats.level_season_id;
          await tx.userSeasonStats.update({
            ...stats,
            level: evalResult.level,
            best_level: Math.max(stats.best_level, evalResult.level),
            level_state: nextState,
            is_level_frozen: freeze,
            updated_at: changedAt,
          });
          return { evaluated: true, changed, skipped: false };
        });
        results.push({ ...result, settlementSkipped: false, failed: false });
      } catch (error) {
        if (isSettlementAlreadyRunning(error)) {
          this.log?.({
            event: "weekly_level_eval_user_skipped",
            user_id: userId,
            scope: LevelScope.Season,
            level_season_id: row.level_season_id,
            as_of: asOf.toISOString(),
            reason: error.code,
            message: error.message,
          });
          results.push({ evaluated: false, changed: false, skipped: true, settlementSkipped: true, failed: false });
        } else {
          this.log?.({
            event: "weekly_level_eval_user_failed",
            user_id: userId,
            scope: LevelScope.Season,
            level_season_id: row.level_season_id,
            as_of: asOf.toISOString(),
            error_code: error instanceof DomainError ? error.code : "INTERNAL_ERROR",
            error_message: error instanceof Error ? error.message : String(error),
          });
          results.push({ evaluated: false, changed: false, skipped: false, settlementSkipped: false, failed: true });
        }
      } finally {
        await this.repo.jobLocks.release(lockKey, ownerId);
      }
    }
    return results;
  }
}
