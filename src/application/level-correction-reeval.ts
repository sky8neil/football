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
  eligibleSeasonStats,
  evaluateWithProtection,
  levelScopeLockKey,
  WEEKLY_LEVEL_EVAL_LOCK_KEY,
} from "./weekly-level-eval.js";

export const LEVEL_CORRECTION_REEVAL_LOCK_KEY = `sync:${SyncJobType.LevelCorrectionReeval}`;
const LEVEL_JOB_LEASE_MILLISECONDS = FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000;
const LEVEL_EVAL_START_DELAY_MILLISECONDS =
  FIXED_CONFIG_V1.LEVEL_EVAL_START_DELAY_MINUTES * 60 * 1000;
const WEEK_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

export interface LevelCorrectionReevalOutcome {
  kind: "completed" | "skipped" | "deferred";
  settlement_id: string;
  as_of: Date | null;
  evaluated_count: number;
  changed_count: number;
  skipped_count: number;
}

function currentWeeklyCycleAsOf(asOf: Date): Date {
  const candidate = nextMondayEvalAt(asOf);
  return candidate.getTime() <= asOf.getTime()
    ? candidate
    : new Date(candidate.getTime() - WEEK_MILLISECONDS);
}

async function weeklyEvaluationIsIncomplete(
  repo: AppRepository,
  cycleAsOf: Date,
  serverNow: Date,
  completedWeeklyAsOf: Date | null,
): Promise<boolean> {
  if (
    completedWeeklyAsOf?.getTime() === cycleAsOf.getTime() ||
    currentWeeklyCycleAsOf(serverNow).getTime() !== cycleAsOf.getTime()
  ) {
    return false;
  }
  if (serverNow.getTime() < cycleAsOf.getTime() + LEVEL_EVAL_START_DELAY_MILLISECONDS) {
    return true;
  }
  return repo.jobLocks.isHeld(WEEKLY_LEVEL_EVAL_LOCK_KEY, serverNow);
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
    state.last_eval_as_of !== null && state.last_eval_as_of.getTime() > asOf.getTime() &&
    !useStoredBase
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
  ): Promise<LevelCorrectionReevalOutcome> {
    assertValidServerNow(serverNow);
    const ownerId = newUuid();
    if (!(await this.repo.jobLocks.acquire(
      LEVEL_CORRECTION_REEVAL_LOCK_KEY,
      ownerId,
      new Date(serverNow.getTime() + LEVEL_JOB_LEASE_MILLISECONDS),
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
      const items = (await this.repo.settlementItems.findBySettlementAndStatus(
        settlementId,
        SettlementItemStatus.Applied,
      )).filter((item) => item.score_delta !== 0);
      const users = [...new Set(items.map((item) => item.user_id))];
      const match = await this.repo.matches.findById(settlement.match_id);
      const cycleAsOf = currentWeeklyCycleAsOf(asOf);
      const weeklyTaskIncomplete = await weeklyEvaluationIsIncomplete(
        this.repo,
        cycleAsOf,
        serverNow,
        completedWeeklyAsOf,
      );
      for (const userId of users) {
        const career = await this.evaluateCareer(
          userId,
          settlementId,
          asOf,
          serverNow,
          weeklyTaskIncomplete,
        );
        evaluatedCount += career.evaluated ? 1 : 0;
        changedCount += career.changed ? 1 : 0;
        skippedCount += career.skipped ? 1 : 0;
        deferred ||= career.deferred;

        if (
          match?.period_anchor_at !== null && match?.period_anchor_at !== undefined &&
          levelSeasonOf(match.period_anchor_at) === levelSeasonOf(asOf) &&
          this.repo.userSeasonStats !== undefined
        ) {
          const season = await this.repo.userSeasonStats.findByUserAndSeason(
            userId,
            levelSeasonOf(asOf),
          );
          if (season !== null && season.is_level_frozen !== true) {
            const outcome = await this.evaluateSeason(
              userId,
              season,
              settlementId,
              asOf,
              serverNow,
              weeklyTaskIncomplete,
            );
            evaluatedCount += outcome.evaluated ? 1 : 0;
            changedCount += outcome.changed ? 1 : 0;
            skippedCount += outcome.skipped ? 1 : 0;
            deferred ||= outcome.deferred;
          }
        }
      }
      return {
        kind: deferred ? "deferred" : "completed",
        settlement_id: settlementId,
        as_of: asOf,
        evaluated_count: evaluatedCount,
        changed_count: changedCount,
        skipped_count: skippedCount,
      };
    } finally {
      await this.repo.jobLocks.release(LEVEL_CORRECTION_REEVAL_LOCK_KEY, ownerId);
    }
  }

  async runPendingBefore(asOf: Date, serverNow: Date): Promise<void> {
    await this.runPendingInWindow(asOf, serverNow, "before");
  }

  async runPending(afterAsOf: Date, serverNow: Date): Promise<void> {
    await this.runPendingInWindow(afterAsOf, serverNow, "after");
  }

  private async runPendingInWindow(
    asOf: Date,
    serverNow: Date,
    window: "before" | "after",
  ): Promise<void> {
    const settlements = (await this.repo.settlements.findByStatus(SettlementDocStatus.Settled))
      .filter((settlement) =>
        settlement.is_correction &&
        settlement.phase === SettlementPhase.Done &&
        settlement.settled_at !== null &&
        (window === "before"
          ? settlement.settled_at.getTime() < asOf.getTime()
          : settlement.settled_at.getTime() >= asOf.getTime()) &&
        settlement.settled_at.getTime() <= serverNow.getTime(),
      )
      .sort((left, right) => left.settled_at!.getTime() - right.settled_at!.getTime());
    for (const settlement of settlements) {
      const outcome = await this.runForSettlementInternal(
        settlement.settlement_id,
        serverNow,
        window === "after" ? asOf : null,
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
  ): Promise<{ evaluated: boolean; changed: boolean; skipped: boolean; deferred: boolean }> {
    const lockKey = levelScopeLockKey(userId, LevelScope.Career, null);
    const ownerId = newUuid();
    if (!(await this.repo.jobLocks.acquire(
      lockKey,
      ownerId,
      new Date(changedAt.getTime() + LEVEL_JOB_LEASE_MILLISECONDS),
    ))) {
      return { evaluated: false, changed: false, skipped: true, deferred: true };
    }
    try {
      return await this.repo.withTransaction(async (tx) => {
        const user = await tx.users.findById(userId);
        if (user === null || user.status !== UserStatus.Active) {
          return { evaluated: false, changed: false, skipped: true, deferred: false };
        }
        const previous = user.career_level_state ?? defaultLevelState();
        const current = {
          level: user.career_level,
          best_level: user.career_best_level,
          below_count: previous.below_count,
        };
        const selected = stateForCorrection(
          current,
          previous,
          asOf,
          this.firstEvalAsOf,
          weeklyTaskIncomplete && user.career_valid_predictions >= 1,
        );
        if (selected.deferred) {
          return { evaluated: false, changed: false, skipped: true, deferred: true };
        }
        if (selected.stale) {
          return { evaluated: false, changed: false, skipped: true, deferred: false };
        }
        const inputs = buildLevelInputs(
          await factsForUser(tx, userId, asOf),
          LevelScope.Career,
          asOf,
        );
        const result = evaluateWithProtection(selected.base, inputs, asOf, this.firstEvalAsOf);
        const nextState = this.nextLevelState(selected.nextState, selected.base, result, inputs, asOf);
        const bestLevel = Math.max(user.career_best_level, result.level);
        const changed = user.career_level !== result.level;
        requireHistoryPort(tx);
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
            settlementId,
          }));
        }
        if (
          changed || bestLevel !== user.career_best_level ||
          !sameLevelState(previous, nextState)
        ) {
          await tx.users.update({
            ...user,
            career_level: result.level,
            career_best_level: bestLevel,
            career_level_state: nextState,
            updated_at: changedAt,
          });
        }
        return { evaluated: true, changed, skipped: false, deferred: false };
      });
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
  ): Promise<{ evaluated: boolean; changed: boolean; skipped: boolean; deferred: boolean }> {
    const lockKey = levelScopeLockKey(userId, LevelScope.Season, stats.level_season_id);
    const ownerId = newUuid();
    if (!(await this.repo.jobLocks.acquire(
      lockKey,
      ownerId,
      new Date(changedAt.getTime() + LEVEL_JOB_LEASE_MILLISECONDS),
    ))) {
      return { evaluated: false, changed: false, skipped: true, deferred: true };
    }
    try {
      return await this.repo.withTransaction(async (tx) => {
        if (tx.userSeasonStats === undefined) {
          throw internalError("level correction reeval 缺少 season stats repository");
        }
        const user = await tx.users.findById(userId);
        const currentStats = await tx.userSeasonStats.findByUserAndSeason(
          userId,
          stats.level_season_id,
        );
        if (
          user === null || user.status !== UserStatus.Active || currentStats === null ||
          currentStats.is_level_frozen === true
        ) {
          return { evaluated: false, changed: false, skipped: true, deferred: false };
        }
        const previous = currentStats.level_state ?? defaultLevelState();
        const current = {
          level: currentStats.level,
          best_level: currentStats.best_level,
          below_count: previous.below_count,
        };
        const cycleAsOf = currentWeeklyCycleAsOf(asOf);
        const selected = stateForCorrection(
          current,
          previous,
          asOf,
          this.firstEvalAsOf,
          weeklyTaskIncomplete && eligibleSeasonStats(currentStats, cycleAsOf),
        );
        if (selected.deferred) {
          return { evaluated: false, changed: false, skipped: true, deferred: true };
        }
        if (selected.stale) {
          return { evaluated: false, changed: false, skipped: true, deferred: false };
        }
        const inputs = buildLevelInputs(
          await factsForUser(tx, userId, asOf),
          LevelScope.Season,
          asOf,
          currentStats.level_season_id,
        );
        const result = evaluateWithProtection(selected.base, inputs, asOf, this.firstEvalAsOf);
        const nextState = this.nextLevelState(selected.nextState, selected.base, result, inputs, asOf);
        const bestLevel = Math.max(currentStats.best_level, result.level);
        const changed = currentStats.level !== result.level;
        requireHistoryPort(tx);
        if (changed) {
          await tx.levelHistory.insert(historyEntry({
            userId,
            scope: LevelScope.Season,
            seasonId: currentStats.level_season_id,
            fromLevel: currentStats.level,
            toLevel: result.level,
            inputs,
            asOf,
            changedAt,
            settlementId,
          }));
        }
        if (
          changed || bestLevel !== currentStats.best_level ||
          !sameLevelState(previous, nextState)
        ) {
          await tx.userSeasonStats.update({
            ...currentStats,
            level: result.level,
            best_level: bestLevel,
            level_state: nextState,
            updated_at: changedAt,
          });
        }
        return { evaluated: true, changed, skipped: false, deferred: false };
      });
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
