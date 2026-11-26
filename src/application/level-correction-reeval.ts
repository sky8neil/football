import { FIXED_CONFIG_V1 } from "../domain/config.js";
import {
  LevelHistoryReason,
  LevelScope,
  SCHEMA_VERSION,
  SettlementDocStatus,
  SettlementItemStatus,
  SettlementPhase,
  SyncJobType,
  UserStatus,
} from "../domain/enums.js";
import { internalError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import {
  buildLevelInputs,
  type LevelEvalState,
  type LevelInputs,
} from "../domain/levels.js";
import {
  levelProtectionEndAsOf,
  levelSeasonOf,
  nextMondayEvalAt,
} from "../domain/time.js";
import {
  defaultLevelState,
  type LevelHistoryEntry,
  type LevelState,
  type SettlementDoc,
  type User,
  type UserSeasonStats,
} from "../domain/types.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";
import {
  buildReplayFacts,
  loadAppliedSettlementFacts,
} from "./rebuild-service-support.js";
import { assertValidServerNow } from "./period-finalize.js";
import {
  catchUpCareerWeeklyStepsInTransaction,
  catchUpSeasonWeeklyStepsInTransaction,
  eligibleSeasonStats,
  evaluateWithProtection,
  isSettlementAlreadyRunning,
  levelScopeLockKey,
} from "./weekly-level-eval.js";

export const LEVEL_CORRECTION_REEVAL_LOCK_KEY = `sync:${SyncJobType.LevelCorrectionReeval}`;
const LEVEL_JOB_LEASE_MILLISECONDS = FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000;
const LEVEL_LOCK_RENEW_BATCH_USERS = 20;
const LEVEL_LOCK_RENEW_INTERVAL_MS = 2 * 60 * 1000;
const WEEK_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

function levelLeaseDeadline(anchor: Date): Date {
  return new Date(Math.max(anchor.getTime(), Date.now()) + LEVEL_JOB_LEASE_MILLISECONDS);
}

export type LevelCorrectionReevalDeferredReason =
  | "user_lock_held"
  | "weekly_eval_incomplete"
  | "settlement_already_running"
  | "lock_lost"
  | "unknown";

const DEFERRED_REASON_PRIORITY: readonly LevelCorrectionReevalDeferredReason[] = [
  "lock_lost",
  "unknown",
  "weekly_eval_incomplete",
  "settlement_already_running",
  "user_lock_held",
];

function primaryDeferredReason(
  reasons: ReadonlySet<LevelCorrectionReevalDeferredReason>,
): LevelCorrectionReevalDeferredReason | undefined {
  return DEFERRED_REASON_PRIORITY.find((reason) => reasons.has(reason));
}

export interface LevelCorrectionReevalOutcome {
  kind: "completed" | "skipped" | "deferred";
  settlement_id: string;
  as_of: Date | null;
  evaluated_count: number;
  changed_count: number;
  skipped_count: number;
  deferred_reason?: LevelCorrectionReevalDeferredReason;
  deferred_reasons?: LevelCorrectionReevalDeferredReason[];
  deferred_user_ids?: string[];
}

export interface LevelCorrectionReevalCompensationOutcome {
  kind: "completed" | "skipped" | "deferred";
  scanned_count: number;
  completed_count: number;
  pending_count: number;
  deferred_reason?: LevelCorrectionReevalDeferredReason;
  deferred_reasons?: LevelCorrectionReevalDeferredReason[];
  deferred_user_ids?: string[];
}

interface LevelScopeEvalOutcome {
  evaluated: boolean;
  changed: boolean;
  skipped: boolean;
  deferred: boolean;
  deferredReason?: LevelCorrectionReevalDeferredReason;
}

function currentWeeklyCycleAsOf(asOf: Date): Date {
  const candidate = nextMondayEvalAt(asOf);
  return candidate.getTime() <= asOf.getTime()
    ? candidate
    : new Date(candidate.getTime() - WEEK_MILLISECONDS);
}

function weeklyEvaluationIsIncomplete(
  cycleAsOf: Date,
  serverNow: Date,
  completedWeeklyAsOf: Date | null,
): boolean {
  // 时间宽限或锁释放不能证明任务完成；用户的本周 week_base 在下方单独检查。
  return completedWeeklyAsOf?.getTime() !== cycleAsOf.getTime() &&
    currentWeeklyCycleAsOf(serverNow).getTime() === cycleAsOf.getTime();
}

function stateForCorrection(
  current: LevelEvalState,
  state: LevelState,
  asOf: Date,
  firstEvalAsOf: Date | null,
  weeklyTaskIncomplete: boolean,
): { base: LevelEvalState; nextState: LevelState; deferred: boolean; stale: boolean } {
  const cycleAsOf = currentWeeklyCycleAsOf(asOf);
  const baseStoredForCycle = state.week_base_as_of?.getTime() === cycleAsOf.getTime();
  const weeklyDue = firstEvalAsOf === null || cycleAsOf.getTime() >= firstEvalAsOf.getTime();
  if (weeklyDue && cycleAsOf.getTime() <= asOf.getTime() && !baseStoredForCycle && weeklyTaskIncomplete) {
    return { base: current, nextState: state, deferred: true, stale: false };
  }
  const correctionAlreadyThisCycle =
    state.last_eval_as_of !== null &&
    state.last_eval_as_of.getTime() >= cycleAsOf.getTime() &&
    state.last_eval_as_of.getTime() < cycleAsOf.getTime() + WEEK_MILLISECONDS &&
    state.week_base_level !== null;
  const useStoredBase = baseStoredForCycle || correctionAlreadyThisCycle;
  if (
    state.last_eval_as_of !== null && state.last_eval_as_of.getTime() > asOf.getTime()
  ) {
    return { base: current, nextState: state, deferred: false, stale: true };
  }
  const base = useStoredBase
    ? {
        level: state.week_base_level ?? current.level,
        best_level: current.best_level,
        below_count: state.week_base_below_count ?? current.below_count,
      }
    : current;
  return {
    base,
    nextState: {
      ...state,
      week_base_level: base.level,
      week_base_below_count: base.below_count,
      week_base_as_of: cycleAsOf,
    },
    deferred: false,
    stale: false,
  };
}

function sameDate(left: Date | null, right: Date | null): boolean {
  return left?.getTime() === right?.getTime();
}

function sameLevelState(left: LevelState, right: LevelState): boolean {
  return (
    left.below_count === right.below_count &&
    left.week_base_level === right.week_base_level &&
    left.week_base_below_count === right.week_base_below_count &&
    sameDate(left.week_base_as_of, right.week_base_as_of) &&
    sameDate(left.last_eval_as_of, right.last_eval_as_of) &&
    left.last_eval_n === right.last_eval_n &&
    left.last_eval_score_sum === right.last_eval_score_sum &&
    left.last_eval_b_points === right.last_eval_b_points &&
    left.last_eval_rule_version === right.last_eval_rule_version
  );
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
  settlementId: string;
}): LevelHistoryEntry {
  return {
    schema_version: SCHEMA_VERSION,
    level_history_id: newUuid(),
    user_id: params.userId,
    scope: params.scope,
    level_season_id: params.seasonId,
    from_level: params.fromLevel,
    to_level: params.toLevel,
    reason: LevelHistoryReason.CorrectionReeval,
    eval_as_of: params.asOf,
    window_n: params.inputs.n,
    window_score_sum: params.inputs.S,
    b_points: params.inputs.b_points,
    level_rule_version: FIXED_CONFIG_V1.LEVEL_RULE_VERSION,
    settlement_id: params.settlementId,
    changed_at: params.changedAt,
  };
}

function requireHistoryPort(tx: UnitOfWork): asserts tx is UnitOfWork & {
  levelHistory: NonNullable<UnitOfWork["levelHistory"]>;
} {
  if (tx.levelHistory === undefined) {
    throw internalError("level correction reeval 缺少 level_history repository");
  }
}

function requireUserRowLock(tx: UnitOfWork) {
  const findByIdForUpdate = tx.users.findByIdForUpdate;
  const patchFields = tx.users.patchFields;
  if (findByIdForUpdate === undefined || patchFields === undefined) {
    throw internalError("level correction reeval 缺少 users 行锁或局部更新");
  }
  return { findByIdForUpdate, patchFields };
}

function requireSeasonRowLock(tx: UnitOfWork) {
  const stats = tx.userSeasonStats;
  if (
    stats?.findByUserAndSeasonForUpdate === undefined ||
    stats.patchFields === undefined
  ) {
    throw internalError("level correction reeval 缺少 user_season_stats 行锁或局部更新");
  }
  return {
    findByUserAndSeasonForUpdate: stats.findByUserAndSeasonForUpdate,
    patchFields: stats.patchFields,
  };
}

async function factsForUser(tx: UnitOfWork, userId: string, asOf: Date) {
  const items = await tx.settlementItems.findAppliedByUserBefore(userId, asOf);
  return buildReplayFacts(await loadAppliedSettlementFacts(tx, items)).facts;
}

export class LevelCorrectionReevalService {
  constructor(
    private readonly repo: AppRepository,
    private readonly firstEvalAsOf: Date | null = FIXED_CONFIG_V1.LEVEL_FIRST_EVAL_AS_OF,
  ) {}

  async runForSettlement(
    settlementId: string,
    serverNow: Date,
  ): Promise<LevelCorrectionReevalOutcome> {
    return this.runForSettlementInternal(settlementId, serverNow, null);
  }

  private async runForSettlementInternal(
    settlementId: string,
    serverNow: Date,
    completedWeeklyAsOf: Date | null,
    onStep?: () => Promise<void>,
    blockedUsers?: ReadonlyMap<string, LevelCorrectionReevalDeferredReason>,
  ): Promise<LevelCorrectionReevalOutcome> {
    assertValidServerNow(serverNow);
    const ownerId = newUuid();
    if (!(await this.repo.jobLocks.acquire(
      LEVEL_CORRECTION_REEVAL_LOCK_KEY,
      ownerId,
      levelLeaseDeadline(serverNow),
    ))) {
      return {
        kind: "skipped",
        settlement_id: settlementId,
        as_of: null,
        evaluated_count: 0,
        changed_count: 0,
        skipped_count: 0,
      };
    }

    let evaluatedCount = 0;
    let changedCount = 0;
    let skippedCount = 0;
    let deferred = false;
    let asOf: Date | null = null;
    let globalDeferredReason: LevelCorrectionReevalDeferredReason | undefined;
    const deferredUsers = new Map<string, LevelCorrectionReevalDeferredReason>();
    const deferredReasons = new Set<LevelCorrectionReevalDeferredReason>();
    const recordDeferredUser = (
      userId: string,
      reason: LevelCorrectionReevalDeferredReason,
    ): void => {
      deferred = true;
      if (!deferredUsers.has(userId)) deferredUsers.set(userId, reason);
      deferredReasons.add(reason);
    };
    try {
      const settlement = await this.repo.settlements.findById(settlementId);
      if (
        settlement === null || !settlement.is_correction ||
        settlement.status !== SettlementDocStatus.Settled ||
        settlement.phase !== SettlementPhase.Done || settlement.settled_at === null
      ) {
        return {
          kind: "completed",
          settlement_id: settlementId,
          as_of: null,
          evaluated_count: 0,
          changed_count: 0,
          skipped_count: 0,
        };
      }
      asOf = settlement.settled_at;
      // 紧随 finalize 之后以单一时钟快照调用时，确保 effectiveNow >= settled_at。
      const effectiveNow = new Date(Math.max(serverNow.getTime(), asOf.getTime()));
      const items = await this.repo.settlementItems.findBySettlementAndStatus(
        settlementId,
        SettlementItemStatus.Applied,
      );
      const users = [...new Set(items.map((item) => item.user_id))];
      const match = await this.repo.matches.findById(settlement.match_id);
      const cycleAsOf = currentWeeklyCycleAsOf(asOf);
      const weeklyTaskIncomplete = weeklyEvaluationIsIncomplete(
        cycleAsOf,
        effectiveNow,
        completedWeeklyAsOf,
      );
      let processedUsers = 0;
      let lastRenewWallMs = Date.now();
      for (const userId of users) {
        const blockedReason = blockedUsers?.get(userId);
        if (blockedReason !== undefined) {
          skippedCount += 1;
          recordDeferredUser(userId, blockedReason);
        } else {
          const career = await this.evaluateCareer(
            userId,
            settlementId,
            asOf,
            effectiveNow,
            weeklyTaskIncomplete,
          );
          evaluatedCount += career.evaluated ? 1 : 0;
          changedCount += career.changed ? 1 : 0;
          skippedCount += career.skipped ? 1 : 0;
          if (career.deferred) {
            recordDeferredUser(userId, career.deferredReason ?? "unknown");
          }

          if (
            match?.period_anchor_at !== null && match?.period_anchor_at !== undefined &&
            this.repo.userSeasonStats !== undefined
          ) {
            const season = await this.repo.userSeasonStats.findByUserAndSeason(
              userId,
              levelSeasonOf(match.period_anchor_at),
            );
            if (season !== null && season.is_level_frozen !== true) {
              const outcome = await this.evaluateSeason(
                userId,
                season,
                settlementId,
                asOf,
                effectiveNow,
                weeklyTaskIncomplete,
              );
              evaluatedCount += outcome.evaluated ? 1 : 0;
              changedCount += outcome.changed ? 1 : 0;
              skippedCount += outcome.skipped ? 1 : 0;
              if (outcome.deferred) {
                recordDeferredUser(userId, outcome.deferredReason ?? "unknown");
              }
            }
          }
        }

        processedUsers += 1;
        const nowWallMs = Date.now();
        if (
          processedUsers % LEVEL_LOCK_RENEW_BATCH_USERS === 0 ||
          nowWallMs - lastRenewWallMs >= LEVEL_LOCK_RENEW_INTERVAL_MS
        ) {
          const renewed = await this.repo.jobLocks.renew(
            LEVEL_CORRECTION_REEVAL_LOCK_KEY,
            ownerId,
            levelLeaseDeadline(effectiveNow),
          ).catch(() => false);
          lastRenewWallMs = Date.now();
          if (!renewed) {
            deferred = true;
            globalDeferredReason = "lock_lost";
            deferredReasons.add(globalDeferredReason);
            break;
          }
          await onStep?.();
        }
      }
      const reevalCompletedAt = new Date(Math.max(effectiveNow.getTime(), asOf.getTime()));
      if (!deferred) {
        await this.repo.settlements.update({
          ...settlement,
          level_reeval_status: "completed",
          level_reeval_completed_at: reevalCompletedAt,
          updated_at: new Date(
            Math.max(settlement.updated_at.getTime(), reevalCompletedAt.getTime()),
          ),
        });
      }
      if (deferred && deferredReasons.size === 0) {
        deferredReasons.add("unknown");
      }
      const deferredReason = primaryDeferredReason(deferredReasons) ??
        globalDeferredReason;
      return {
        kind: deferred ? "deferred" : "completed",
        settlement_id: settlementId,
        as_of: asOf,
        evaluated_count: evaluatedCount,
        changed_count: changedCount,
        skipped_count: skippedCount,
        ...(deferred
          ? {
              deferred_reason: deferredReason ?? "unknown",
              deferred_reasons: [...deferredReasons],
              deferred_user_ids: [...deferredUsers.keys()],
            }
          : {}),
      };
    } finally {
      await this.repo.jobLocks.release(LEVEL_CORRECTION_REEVAL_LOCK_KEY, ownerId);
    }
  }

  async runPendingBefore(
    asOf: Date,
    serverNow: Date,
    onStep?: () => Promise<void>,
    onBeforeSettlement?: (settlement: SettlementDoc, cycleAsOf: Date) => Promise<void>,
  ): Promise<void> {
    await this.runPendingInWindow(asOf, serverNow, "before", onStep, onBeforeSettlement);
  }

  async runPending(
    afterAsOf: Date,
    serverNow: Date,
    onStep?: () => Promise<void>,
  ): Promise<void> {
    await this.runPendingInWindow(afterAsOf, serverNow, "after", onStep);
  }

  async runPendingCompensation(
    serverNow: Date,
    completedWeeklyAsOf: Date | null = null,
    onStep?: () => Promise<void>,
  ): Promise<LevelCorrectionReevalCompensationOutcome> {
    assertValidServerNow(serverNow);
    if (this.repo.settlements.findSettledCorrectionsPendingReeval === undefined) {
      throw internalError("settlements repository 缺少 findSettledCorrectionsPendingReeval");
    }
    const settlements = (await this.repo.settlements.findSettledCorrectionsPendingReeval())
      .filter((settlement) =>
        settlement.phase === SettlementPhase.Done &&
        settlement.settled_at !== null &&
        settlement.settled_at.getTime() <= serverNow.getTime(),
      )
      .sort((left, right) => left.settled_at!.getTime() - right.settled_at!.getTime());
    let completedCount = 0;
    const blockedUsers = new Map<string, LevelCorrectionReevalDeferredReason>();
    const deferredReasons = new Set<LevelCorrectionReevalDeferredReason>();
    for (const settlement of settlements) {
      await onStep?.();
      const outcome = await this.runForSettlementInternal(
        settlement.settlement_id,
        serverNow,
        completedWeeklyAsOf,
        onStep,
        blockedUsers,
      );
      if (outcome.kind === "completed") {
        completedCount += 1;
        continue;
      }
      if (outcome.kind === "skipped") {
        return {
          kind: "skipped",
          scanned_count: settlements.length,
          completed_count: completedCount,
          pending_count: settlements.length - completedCount,
        };
      }
      const outcomeReasons = outcome.deferred_reasons ??
        [outcome.deferred_reason ?? "unknown"];
      const outcomeReason = outcome.deferred_reason ?? outcomeReasons[0] ?? "unknown";
      for (const reason of outcomeReasons) deferredReasons.add(reason);
      for (const userId of outcome.deferred_user_ids ?? []) {
        if (!blockedUsers.has(userId)) blockedUsers.set(userId, outcomeReason);
      }
      if (
        outcomeReasons.includes("lock_lost") ||
        outcomeReasons.includes("unknown")
      ) {
        // 无法可靠区分其余单据是否可安全续跑：保留 pending，等下一轮从最早一单重试。
        break;
      }
    }
    const kind = completedCount === settlements.length ? "completed" : "deferred";
    return {
      kind,
      scanned_count: settlements.length,
      completed_count: completedCount,
      pending_count: settlements.length - completedCount,
      ...(kind === "deferred"
        ? {
            deferred_reason: primaryDeferredReason(deferredReasons) ?? "unknown",
            deferred_reasons: [...deferredReasons],
            deferred_user_ids: [...blockedUsers.keys()],
          }
        : {}),
    };
  }

  private async runPendingInWindow(
    asOf: Date,
    serverNow: Date,
    window: "before" | "after",
    onStep?: () => Promise<void>,
    onBeforeSettlement?: (settlement: SettlementDoc, cycleAsOf: Date) => Promise<void>,
  ): Promise<void> {
    if (this.repo.settlements.findSettledCorrectionsPendingReeval === undefined) {
      throw internalError("settlements repository 缺少 findSettledCorrectionsPendingReeval");
    }
    const settlements = (await this.repo.settlements.findSettledCorrectionsPendingReeval())
      .filter((settlement) =>
        settlement.phase === SettlementPhase.Done &&
        settlement.settled_at !== null &&
        (window === "before"
          ? settlement.settled_at.getTime() < asOf.getTime()
          : settlement.settled_at.getTime() >= asOf.getTime()) &&
        settlement.settled_at.getTime() <= serverNow.getTime(),
      )
      .sort((left, right) => left.settled_at!.getTime() - right.settled_at!.getTime());
    for (const settlement of settlements) {
      await onStep?.();
      if (onBeforeSettlement !== undefined && settlement.settled_at !== null) {
        await onBeforeSettlement(settlement, currentWeeklyCycleAsOf(settlement.settled_at));
      }
      const outcome = await this.runForSettlementInternal(
        settlement.settlement_id,
        serverNow,
        window === "after" ? asOf : null,
        onStep,
      );
      if (outcome.kind !== "completed") {
        throw new Error("SPEC_GAP: completed weekly evaluation could not resume correction re-evaluation");
      }
    }
  }

  private async evaluateCareer(
    userId: string,
    settlementId: string,
    asOf: Date,
    changedAt: Date,
    weeklyTaskIncomplete: boolean,
  ): Promise<LevelScopeEvalOutcome> {
    const lockKey = levelScopeLockKey(userId, LevelScope.Career, null);
    const ownerId = newUuid();
    if (!(await this.repo.jobLocks.acquire(
      lockKey,
      ownerId,
      levelLeaseDeadline(changedAt),
    ))) {
      return {
        evaluated: false,
        changed: false,
        skipped: true,
        deferred: true,
        deferredReason: "user_lock_held",
      };
    }
    try {
      return await this.repo.withTransaction(async (tx) => {
        const userLock = requireUserRowLock(tx);
        const user = await userLock.findByIdForUpdate(userId);
        if (user === null || user.status !== UserStatus.Active) {
          return { evaluated: false, changed: false, skipped: true, deferred: false };
        }
        const previous = user.career_level_state ?? defaultLevelState();
        const cycleAsOf = currentWeeklyCycleAsOf(asOf);
        const initialSelection = stateForCorrection(
          {
            level: user.career_level,
            best_level: user.career_best_level,
            below_count: previous.below_count,
          },
          previous,
          asOf,
          this.firstEvalAsOf,
          weeklyTaskIncomplete && user.career_valid_predictions >= 1,
        );
        if (initialSelection.deferred) {
          return {
            evaluated: false,
            changed: false,
            skipped: true,
            deferred: true,
            deferredReason: "weekly_eval_incomplete",
          };
        }
        if (initialSelection.stale) {
          return { evaluated: false, changed: false, skipped: true, deferred: false };
        }
        requireHistoryPort(tx);
        const facts = await factsForUser(tx, userId, asOf);
        let currentLevel = user.career_level;
        let currentBestLevel = user.career_best_level;
        let currentState = previous;
        let weeklyChanged = false;
        if (this.firstEvalAsOf !== null && user.career_valid_predictions >= 1) {
          const catchUp = await catchUpCareerWeeklyStepsInTransaction({
            tx,
            userId,
            level: currentLevel,
            bestLevel: currentBestLevel,
            state: currentState,
            maxAsOf: cycleAsOf,
            firstEvalAsOf: this.firstEvalAsOf,
            changedAt,
            facts,
          });
          currentLevel = catchUp.level;
          currentBestLevel = catchUp.bestLevel;
          currentState = catchUp.state;
          weeklyChanged = catchUp.changed;
        }
        const selected = stateForCorrection(
          {
            level: currentLevel,
            best_level: currentBestLevel,
            below_count: currentState.below_count,
          },
          currentState,
          asOf,
          this.firstEvalAsOf,
          false,
        );
        const inputs = buildLevelInputs(facts, LevelScope.Career, asOf);
        const result = evaluateWithProtection(selected.base, inputs, asOf, this.firstEvalAsOf);
        const nextState = this.nextLevelState(selected.nextState, selected.base, result, inputs, asOf);
        const bestLevel = Math.max(currentBestLevel, result.level);
        const correctionChanged = currentLevel !== result.level;
        if (correctionChanged) {
          await tx.levelHistory.insert(historyEntry({
            userId,
            scope: LevelScope.Career,
            seasonId: null,
            fromLevel: currentLevel,
            toLevel: result.level,
            inputs,
            asOf,
            changedAt,
            settlementId,
          }));
        }
        if (
          result.level !== user.career_level ||
          bestLevel !== user.career_best_level ||
          !sameLevelState(previous, nextState)
        ) {
          await userLock.patchFields(userId, {
            career_level: result.level,
            career_best_level: bestLevel,
            career_level_state: nextState,
            updated_at: changedAt,
          });
        }
        return {
          evaluated: true,
          changed: weeklyChanged || correctionChanged,
          skipped: false,
          deferred: false,
        };
      });
    } catch (error) {
      if (isSettlementAlreadyRunning(error)) {
        return {
          evaluated: false,
          changed: false,
          skipped: true,
          deferred: true,
          deferredReason: "settlement_already_running",
        };
      }
      throw error;
    } finally {
      await this.repo.jobLocks.release(lockKey, ownerId);
    }
  }

  private async evaluateSeason(
    userId: string,
    stats: UserSeasonStats,
    settlementId: string,
    asOf: Date,
    changedAt: Date,
    weeklyTaskIncomplete: boolean,
  ): Promise<LevelScopeEvalOutcome> {
    const lockKey = levelScopeLockKey(userId, LevelScope.Season, stats.level_season_id);
    const ownerId = newUuid();
    if (!(await this.repo.jobLocks.acquire(
      lockKey,
      ownerId,
      levelLeaseDeadline(changedAt),
    ))) {
      return {
        evaluated: false,
        changed: false,
        skipped: true,
        deferred: true,
        deferredReason: "user_lock_held",
      };
    }
    try {
      return await this.repo.withTransaction(async (tx) => {
        if (tx.userSeasonStats === undefined) {
          throw internalError("level correction reeval 缺少 season stats repository");
        }
        const userLock = requireUserRowLock(tx);
        const seasonLock = requireSeasonRowLock(tx);
        const user = await userLock.findByIdForUpdate(userId);
        if (user === null || user.status !== UserStatus.Active) {
          return { evaluated: false, changed: false, skipped: true, deferred: false };
        }
        const currentStats = await seasonLock.findByUserAndSeasonForUpdate(
          userId,
          stats.level_season_id,
        );
        if (currentStats === null || currentStats.is_level_frozen === true) {
          return { evaluated: false, changed: false, skipped: true, deferred: false };
        }
        const previous = currentStats.level_state ?? defaultLevelState();
        const cycleAsOf = currentWeeklyCycleAsOf(asOf);
        const initialSelection = stateForCorrection(
          {
            level: currentStats.level,
            best_level: currentStats.best_level,
            below_count: previous.below_count,
          },
          previous,
          asOf,
          this.firstEvalAsOf,
          weeklyTaskIncomplete && eligibleSeasonStats(currentStats, cycleAsOf),
        );
        if (initialSelection.deferred) {
          return {
            evaluated: false,
            changed: false,
            skipped: true,
            deferred: true,
            deferredReason: "weekly_eval_incomplete",
          };
        }
        if (initialSelection.stale) {
          return { evaluated: false, changed: false, skipped: true, deferred: false };
        }
        requireHistoryPort(tx);
        const facts = await factsForUser(tx, userId, asOf);
        let currentLevel = currentStats.level;
        let currentBestLevel = currentStats.best_level;
        let currentState = previous;
        let weeklyChanged = false;
        if (this.firstEvalAsOf !== null && eligibleSeasonStats(currentStats, cycleAsOf)) {
          const catchUp = await catchUpSeasonWeeklyStepsInTransaction({
            tx,
            userId,
            stats: currentStats,
            maxAsOf: cycleAsOf,
            firstEvalAsOf: this.firstEvalAsOf,
            changedAt,
            facts,
          });
          currentLevel = catchUp.level;
          currentBestLevel = catchUp.bestLevel;
          currentState = catchUp.state;
          weeklyChanged = catchUp.changed;
          if (catchUp.freeze) {
            if (
              catchUp.shouldPersistFreezeOnly ||
              currentLevel !== currentStats.level ||
              currentBestLevel !== currentStats.best_level ||
              !sameLevelState(previous, currentState)
            ) {
              await seasonLock.patchFields(userId, currentStats.level_season_id, {
                level: currentLevel,
                best_level: currentBestLevel,
                level_state: currentState,
                is_level_frozen: true,
                updated_at: changedAt,
              });
            }
            return {
              evaluated: catchUp.evaluated,
              changed: weeklyChanged,
              skipped: !catchUp.evaluated,
              deferred: false,
            };
          }
        }
        const selected = stateForCorrection(
          {
            level: currentLevel,
            best_level: currentBestLevel,
            below_count: currentState.below_count,
          },
          currentState,
          asOf,
          this.firstEvalAsOf,
          false,
        );
        const inputs = buildLevelInputs(
          facts,
          LevelScope.Season,
          asOf,
          currentStats.level_season_id,
        );
        const result = evaluateWithProtection(selected.base, inputs, asOf, this.firstEvalAsOf);
        const nextState = this.nextLevelState(selected.nextState, selected.base, result, inputs, asOf);
        const bestLevel = Math.max(currentBestLevel, result.level);
        const correctionChanged = currentLevel !== result.level;
        if (correctionChanged) {
          await tx.levelHistory.insert(historyEntry({
            userId,
            scope: LevelScope.Season,
            seasonId: currentStats.level_season_id,
            fromLevel: currentLevel,
            toLevel: result.level,
            inputs,
            asOf,
            changedAt,
            settlementId,
          }));
        }
        if (
          result.level !== currentStats.level ||
          bestLevel !== currentStats.best_level ||
          !sameLevelState(previous, nextState)
        ) {
          await seasonLock.patchFields(userId, currentStats.level_season_id, {
            level: result.level,
            best_level: bestLevel,
            level_state: nextState,
            updated_at: changedAt,
          });
        }
        return {
          evaluated: true,
          changed: weeklyChanged || correctionChanged,
          skipped: false,
          deferred: false,
        };
      });
    } catch (error) {
      if (isSettlementAlreadyRunning(error)) {
        return {
          evaluated: false,
          changed: false,
          skipped: true,
          deferred: true,
          deferredReason: "settlement_already_running",
        };
      }
      throw error;
    } finally {
      await this.repo.jobLocks.release(lockKey, ownerId);
    }
  }

  private nextLevelState(
    seed: LevelState,
    base: LevelEvalState,
    result: LevelEvalState,
    inputs: LevelInputs,
    asOf: Date,
  ): LevelState {
    return {
      ...seed,
      below_count: result.below_count,
      week_base_level: base.level,
      week_base_below_count: base.below_count,
      last_eval_as_of: asOf,
      last_eval_n: inputs.n,
      last_eval_score_sum: inputs.S,
      last_eval_b_points: inputs.b_points,
      last_eval_rule_version: FIXED_CONFIG_V1.LEVEL_RULE_VERSION,
    };
  }
}
