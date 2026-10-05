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
const WEEK_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

export interface WeeklyLevelEvalOutcome {
  kind: "completed" | "skipped";
  as_of: Date;
  evaluated_count: number;
  changed_count: number;
  skipped_count: number;
}

function weeklyEvalAsOf(serverNow: Date): Date {
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

function seasonFinalEvalAsOf(levelSeasonId: string): Date {
  const match = /^(\d{4})_(\d{4})$/.exec(levelSeasonId);
  if (match === null || Number(match[2]) !== Number(match[1]) + 1) {
    throw new DomainError("INVALID_LEDGER", `level_season_id 非法（level_season_id=${levelSeasonId}）`);
  }
  const seasonEnd = new Date(Date.UTC(Number(match[2]), 6, 1) - 8 * 60 * 60 * 1000);
  return nextMondayEvalAt(seasonEnd);
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
      };
      await new BoardSnapshotService(this.repo).generate(RankingBoard.Strength, serverNow);
      return outcome;
    }

    const ownerId = newUuid();
    const acquired = await this.repo.jobLocks.acquire(
      WEEKLY_LEVEL_EVAL_LOCK_KEY,
      ownerId,
      new Date(serverNow.getTime() + LEVEL_JOB_LEASE_MILLISECONDS),
    );
    if (!acquired) {
      return { kind: "skipped", as_of: asOf, evaluated_count: 0, changed_count: 0, skipped_count: 0 };
    }

    let evaluatedCount = 0;
    let changedCount = 0;
    let skippedCount = 0;
    let outcome: WeeklyLevelEvalOutcome;
    try {
      const { LevelCorrectionReevalService } = await import("./level-correction-reeval.js");
      const correctionReeval = new LevelCorrectionReevalService(this.repo, this.firstEvalAsOf);
      await correctionReeval.runPendingBefore(asOf, serverNow);
      const users = await this.repo.users.findAll();
      for (const candidate of users) {
        if (candidate.status !== UserStatus.Active) continue;
        if (candidate.career_valid_predictions >= 1) {
          const career = await this.evaluateCareer(candidate.user_id, asOf, serverNow);
          evaluatedCount += career.evaluated ? 1 : 0;
          changedCount += career.changed ? 1 : 0;
          skippedCount += career.skipped ? 1 : 0;
        }

        const seasonResults = await this.evaluateSeasons(candidate.user_id, asOf, serverNow);
        for (const result of seasonResults) {
          evaluatedCount += result.evaluated ? 1 : 0;
          changedCount += result.changed ? 1 : 0;
          skippedCount += result.skipped ? 1 : 0;
        }
      }
      await correctionReeval.runPending(asOf, serverNow);
      outcome = {
        kind: "completed",
        as_of: asOf,
        evaluated_count: evaluatedCount,
        changed_count: changedCount,
        skipped_count: skippedCount,
      };
    } finally {
      await this.repo.jobLocks.release(WEEKLY_LEVEL_EVAL_LOCK_KEY, ownerId);
    }
    await new BoardSnapshotService(this.repo).generate(RankingBoard.Strength, serverNow);
    return outcome;
  }

  private async evaluateCareer(
    userId: string,
    asOf: Date,
    changedAt: Date,
  ): Promise<{ evaluated: boolean; changed: boolean; skipped: boolean }> {
    const lockKey = levelScopeLockKey(userId, LevelScope.Career, null);
    const ownerId = newUuid();
    if (!(await this.repo.jobLocks.acquire(
      lockKey,
      ownerId,
      new Date(changedAt.getTime() + LEVEL_JOB_LEASE_MILLISECONDS),
    ))) {
      return { evaluated: false, changed: false, skipped: true };
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
  ): Promise<Array<{ evaluated: boolean; changed: boolean; skipped: boolean }>> {
    const statsRows = this.repo.userSeasonStats === undefined
      ? []
      : await this.repo.userSeasonStats.findByUser(userId);
    const results: Array<{ evaluated: boolean; changed: boolean; skipped: boolean }> = [];
    for (const row of statsRows) {
      if (!eligibleSeasonStats(row, asOf)) continue;
      const lockKey = levelScopeLockKey(userId, LevelScope.Season, row.level_season_id);
      const ownerId = newUuid();
      if (!(await this.repo.jobLocks.acquire(
        lockKey,
        ownerId,
        new Date(changedAt.getTime() + LEVEL_JOB_LEASE_MILLISECONDS),
      ))) {
        results.push({ evaluated: false, changed: false, skipped: true });
        continue;
      }
      try {
        results.push(await this.repo.withTransaction(async (tx) => {
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
          const result = evaluateWithProtection(base, inputs, asOf, this.firstEvalAsOf);
          const nextState = levelStateAfterEval(previous, base, result, inputs, asOf);
          const changed = result.level !== stats.level;
          if (changed) {
            await tx.levelHistory.insert(historyEntry({
              userId,
              scope: LevelScope.Season,
              seasonId: stats.level_season_id,
              fromLevel: stats.level,
              toLevel: result.level,
              inputs,
              asOf,
              changedAt,
            }));
          }
          const freeze = levelSeasonOf(asOf) !== stats.level_season_id;
          await tx.userSeasonStats.update({
            ...stats,
            level: result.level,
            best_level: Math.max(stats.best_level, result.level),
            level_state: nextState,
            is_level_frozen: freeze,
            updated_at: changedAt,
          });
          return { evaluated: true, changed, skipped: false };
        }));
      } finally {
        await this.repo.jobLocks.release(lockKey, ownerId);
      }
    }
    return results;
  }
}
