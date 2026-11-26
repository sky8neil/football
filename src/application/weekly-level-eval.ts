import { FIXED_CONFIG_V1 } from "../domain/config.js";
import {
  LevelHistoryReason,
  LevelScope,
  RankingBoard,
  SCHEMA_VERSION,
  SettlementItemStatus,
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

function anchorEvalMs(state: LevelState): number {
  const lastEval = state.last_eval_as_of?.getTime();
  const weekBase = state.week_base_as_of?.getTime();
  if (lastEval !== undefined && weekBase !== undefined) {
    return Math.max(lastEval, weekBase);
  }
  return lastEval ?? weekBase ?? Number.NEGATIVE_INFINITY;
}

function missedWeeklySteps(params: {
  anchorMs: number;
  maxStepMs: number;
  firstEvalAsOf: Date | null;
  seasonStartAtMs?: number;
}): Date[] {
  const { anchorMs, maxStepMs, firstEvalAsOf, seasonStartAtMs } = params;
  if (Number.isFinite(anchorMs)) {
    if (anchorMs >= maxStepMs) {
      return [];
    }
    let next = nextMondayEvalAt(new Date(anchorMs + 1));
    if (firstEvalAsOf !== null && next.getTime() < firstEvalAsOf.getTime()) {
      next = new Date(firstEvalAsOf.getTime());
    }
    if (seasonStartAtMs !== undefined && next.getTime() < seasonStartAtMs) {
      next = nextMondayEvalAt(new Date(seasonStartAtMs));
    }
    const steps: Date[] = [];
    for (
      let ms = next.getTime();
      ms <= maxStepMs;
      ms = nextMondayEvalAt(new Date(ms + 1)).getTime()
    ) {
      steps.push(new Date(ms));
    }
    return steps;
  }

  if (firstEvalAsOf === null) {
    // 兼容未登记 firstEvalAsOf：仅按当前窗口截点评估一次（含保护期 SPEC_GAP 判定）
    return [new Date(maxStepMs)];
  }
  const initialFloorMs = seasonStartAtMs === undefined
    ? firstEvalAsOf.getTime()
    : nextMondayEvalAt(new Date(Math.max(firstEvalAsOf.getTime(), seasonStartAtMs))).getTime();
  if (initialFloorMs > maxStepMs) {
    return [];
  }
  const steps: Date[] = [];
  for (
    let ms = initialFloorMs;
    ms <= maxStepMs;
    ms = nextMondayEvalAt(new Date(ms + 1)).getTime()
  ) {
    steps.push(new Date(ms));
  }
  return steps;
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

function requireUserRowLock(tx: UnitOfWork) {
  const findByIdForUpdate = tx.users.findByIdForUpdate;
  const patchFields = tx.users.patchFields;
  if (findByIdForUpdate === undefined || patchFields === undefined) {
    throw internalError("weekly level eval 缺少 users 行锁或局部更新");
  }
  return { findByIdForUpdate, patchFields };
}

function requireSeasonRowLock(tx: UnitOfWork) {
  const stats = tx.userSeasonStats;
  if (
    stats?.findByUserAndSeasonForUpdate === undefined ||
    stats.patchFields === undefined
  ) {
    throw internalError("weekly level eval 缺少 user_season_stats 行锁或局部更新");
  }
  return {
    findByUserAndSeasonForUpdate: stats.findByUserAndSeasonForUpdate,
    patchFields: stats.patchFields,
  };
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

export interface CareerWeeklyCatchUpResult {
  evaluated: boolean;
  changed: boolean;
  level: number;
  bestLevel: number;
  state: LevelState;
}

export interface SeasonWeeklyCatchUpResult {
  evaluated: boolean;
  changed: boolean;
  freeze: boolean;
  shouldPersistFreezeOnly: boolean;
  level: number;
  bestLevel: number;
  state: LevelState;
}

/** 事务内按遗漏周一 10:00 序列逐周补算 career 等级并写 weekly_eval history。 */
export async function catchUpCareerWeeklyStepsInTransaction(params: {
  tx: UnitOfWork;
  userId: string;
  level: number;
  bestLevel: number;
  state: LevelState;
  maxAsOf: Date;
  firstEvalAsOf: Date | null;
  changedAt: Date;
  facts?: readonly LevelPredictionFact[];
}): Promise<CareerWeeklyCatchUpResult> {
  const steps = missedWeeklySteps({
    anchorMs: anchorEvalMs(params.state),
    maxStepMs: params.maxAsOf.getTime(),
    firstEvalAsOf: params.firstEvalAsOf,
  });
  if (steps.length === 0) {
    return {
      evaluated: false,
      changed: false,
      level: params.level,
      bestLevel: params.bestLevel,
      state: params.state,
    };
  }
  requireLevelPorts(params.tx);
  const facts = params.facts ?? await userFacts(params.tx, params.userId, steps[steps.length - 1]!);
  let currentLevel = params.level;
  let currentBestLevel = params.bestLevel;
  let currentState = params.state;
  let anyChanged = false;
  for (const stepAsOf of steps) {
    const inputs = buildLevelInputs(facts, LevelScope.Career, stepAsOf);
    const base = evalState(currentLevel, currentBestLevel, currentState.below_count);
    const result = evaluateWithProtection(base, inputs, stepAsOf, params.firstEvalAsOf);
    if (result.level !== currentLevel) {
      anyChanged = true;
      await params.tx.levelHistory.insert(historyEntry({
        userId: params.userId,
        scope: LevelScope.Career,
        seasonId: null,
        fromLevel: currentLevel,
        toLevel: result.level,
        inputs,
        asOf: stepAsOf,
        changedAt: params.changedAt,
      }));
    }
    currentState = levelStateAfterEval(currentState, base, result, inputs, stepAsOf);
    currentLevel = result.level;
    currentBestLevel = Math.max(currentBestLevel, result.level);
  }
  return {
    evaluated: true,
    changed: anyChanged,
    level: currentLevel,
    bestLevel: currentBestLevel,
    state: currentState,
  };
}

/** 事务内按遗漏周一 10:00 序列逐周补算 season 等级并写 weekly_eval history。 */
export async function catchUpSeasonWeeklyStepsInTransaction(params: {
  tx: UnitOfWork;
  userId: string;
  stats: UserSeasonStats;
  maxAsOf: Date;
  firstEvalAsOf: Date | null;
  changedAt: Date;
  facts?: readonly LevelPredictionFact[];
}): Promise<SeasonWeeklyCatchUpResult> {
  const previous = params.stats.level_state ?? defaultLevelState();
  const seasonFinal = seasonFinalEvalAsOf(params.stats.level_season_id);
  const maxStepMs = Math.min(params.maxAsOf.getTime(), seasonFinal.getTime());
  const anchorMs = anchorEvalMs(previous);
  const steps = missedWeeklySteps({
    anchorMs,
    maxStepMs,
    firstEvalAsOf: params.firstEvalAsOf,
    seasonStartAtMs: seasonStartAt(params.stats.level_season_id).getTime(),
  });
  if (steps.length === 0) {
    const shouldPersistFreezeOnly =
      !Number.isFinite(anchorMs) && params.maxAsOf.getTime() >= seasonFinal.getTime();
    return {
      evaluated: false,
      changed: false,
      freeze: shouldPersistFreezeOnly || params.stats.is_level_frozen === true,
      shouldPersistFreezeOnly,
      level: params.stats.level,
      bestLevel: params.stats.best_level,
      state: previous,
    };
  }
  requireLevelPorts(params.tx);
  const facts = params.facts ?? await userFacts(params.tx, params.userId, steps[steps.length - 1]!);
  let currentLevel = params.stats.level;
  let currentBestLevel = params.stats.best_level;
  let currentState = previous;
  let anyChanged = false;
  let freeze = false;
  let ranAnyStep = false;
  for (const stepAsOf of steps) {
    const snapshot = {
      ...params.stats,
      level: currentLevel,
      best_level: currentBestLevel,
      level_state: currentState,
      is_level_frozen: freeze,
    };
    if (!eligibleSeasonStats(snapshot, stepAsOf)) continue;
    ranAnyStep = true;
    const inputs = buildLevelInputs(
      facts,
      LevelScope.Season,
      stepAsOf,
      params.stats.level_season_id,
    );
    const base = evalState(currentLevel, currentBestLevel, currentState.below_count);
    const evalResult = evaluateWithProtection(base, inputs, stepAsOf, params.firstEvalAsOf);
    if (evalResult.level !== currentLevel) {
      anyChanged = true;
      await params.tx.levelHistory.insert(historyEntry({
        userId: params.userId,
        scope: LevelScope.Season,
        seasonId: params.stats.level_season_id,
        fromLevel: currentLevel,
        toLevel: evalResult.level,
        inputs,
        asOf: stepAsOf,
        changedAt: params.changedAt,
      }));
    }
    currentState = levelStateAfterEval(currentState, base, evalResult, inputs, stepAsOf);
    currentLevel = evalResult.level;
    currentBestLevel = Math.max(currentBestLevel, evalResult.level);
    // 仅在到达或超过该赛季终评时刻且已切出本赛季时才冻结，避免漏算周提前冻结
    if (
      stepAsOf.getTime() >= seasonFinal.getTime() &&
      levelSeasonOf(stepAsOf) !== params.stats.level_season_id
    ) {
      freeze = true;
      break;
    }
  }
  if (!ranAnyStep) {
    return {
      evaluated: false,
      changed: false,
      freeze: params.stats.is_level_frozen === true,
      shouldPersistFreezeOnly: false,
      level: params.stats.level,
      bestLevel: params.stats.best_level,
      state: previous,
    };
  }
  return {
    evaluated: true,
    changed: anyChanged,
    freeze,
    shouldPersistFreezeOnly: false,
    level: currentLevel,
    bestLevel: currentBestLevel,
    state: currentState,
  };
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

      type ScopeOutcome = {
        evaluated: boolean;
        changed: boolean;
        skipped: boolean;
        settlementSkipped?: boolean;
        failed?: boolean;
        deferred?: boolean;
      };
      const careerPreOutcomes = new Map<string, ScopeOutcome>();
      const seasonPreOutcomes = new Map<string, Map<string, ScopeOutcome>>();
      const mergeOutcome = (
        prev: ScopeOutcome | undefined,
        next: ScopeOutcome,
      ): ScopeOutcome => {
        if (prev === undefined) return next;
        const evaluated = prev.evaluated || next.evaluated;
        const changed = prev.changed || next.changed;
        const deferred = Boolean(prev.deferred || next.deferred);
        const failed = Boolean(prev.failed || next.failed);
        const settlementSkipped = Boolean(prev.settlementSkipped || next.settlementSkipped);
        return {
          evaluated,
          changed,
          skipped: !evaluated && !failed && !deferred && (prev.skipped || next.skipped),
          ...(deferred ? { deferred: true } : {}),
          ...(failed ? { failed: true } : {}),
          ...(settlementSkipped ? { settlementSkipped: true } : {}),
        };
      };
      const recordOutcome = (res: ScopeOutcome): void => {
        evaluatedCount += res.evaluated ? 1 : 0;
        changedCount += res.changed ? 1 : 0;
        skippedCount += res.skipped ? 1 : 0;
        settlementSkippedCount += res.settlementSkipped ? 1 : 0;
        failedCount += res.failed ? 1 : 0;
        deferredCount += res.deferred ? 1 : 0;
      };

      const runCareerScope = async (
        targetUserId: string,
        targetAsOf: Date,
      ): Promise<ScopeOutcome> => {
        try {
          return await this.evaluateCareer(targetUserId, targetAsOf, serverNow);
        } catch (error) {
          if (isSettlementAlreadyRunning(error)) {
            this.log?.({
              event: "weekly_level_eval_user_skipped",
              user_id: targetUserId,
              scope: LevelScope.Career,
              as_of: targetAsOf.toISOString(),
              reason: error.code,
              message: error.message,
            });
            return {
              evaluated: false,
              changed: false,
              skipped: true,
              settlementSkipped: true,
            };
          }
          this.log?.({
            event: "weekly_level_eval_user_failed",
            user_id: targetUserId,
            scope: LevelScope.Career,
            as_of: targetAsOf.toISOString(),
            error_code: error instanceof DomainError ? error.code : "INTERNAL_ERROR",
            error_message: error instanceof Error ? error.message : String(error),
          });
          return { evaluated: false, changed: false, skipped: false, failed: true };
        }
      };

      const runSeasonScopes = async (
        targetUserId: string,
        targetAsOf: Date,
        targetSeasonId?: string,
      ): Promise<Array<{ seasonId: string } & ScopeOutcome>> => {
        try {
          return await this.evaluateSeasons(
            targetUserId,
            targetAsOf,
            serverNow,
            targetSeasonId,
          );
        } catch (error) {
          if (isSettlementAlreadyRunning(error)) {
            this.log?.({
              event: "weekly_level_eval_user_skipped",
              user_id: targetUserId,
              scope: LevelScope.Season,
              as_of: targetAsOf.toISOString(),
              reason: error.code,
              message: error.message,
            });
            return [{
              seasonId: targetSeasonId ?? "*",
              evaluated: false,
              changed: false,
              skipped: true,
              settlementSkipped: true,
            }];
          }
          this.log?.({
            event: "weekly_level_eval_user_failed",
            user_id: targetUserId,
            scope: LevelScope.Season,
            as_of: targetAsOf.toISOString(),
            error_code: error instanceof DomainError ? error.code : "INTERNAL_ERROR",
            error_message: error instanceof Error ? error.message : String(error),
          });
          return [{
            seasonId: targetSeasonId ?? "*",
            evaluated: false,
            changed: false,
            skipped: false,
            failed: true,
          }];
        }
      };

      const onBeforePendingCorrection = async (
        settlement: SettlementDoc,
        cycleAsOf: Date,
      ): Promise<void> => {
        if (this.firstEvalAsOf !== null && cycleAsOf.getTime() < this.firstEvalAsOf.getTime()) {
          return;
        }
        const items = await this.repo.settlementItems.findBySettlementAndStatus(
          settlement.settlement_id,
          SettlementItemStatus.Applied,
        );
        const affectedUsers = [...new Set(items.map((item) => item.user_id))];
        const match = await this.repo.matches.findById(settlement.match_id);
        const matchSeasonId = match?.period_anchor_at ? levelSeasonOf(match.period_anchor_at) : null;
        for (const affectedUserId of affectedUsers) {
          const candidate = await this.repo.users.findById(affectedUserId);
          if (candidate === null || candidate.status !== UserStatus.Active) continue;
          if (candidate.career_valid_predictions >= 1) {
            const res = await runCareerScope(affectedUserId, cycleAsOf);
            careerPreOutcomes.set(
              affectedUserId,
              mergeOutcome(careerPreOutcomes.get(affectedUserId), res),
            );
          }
          if (matchSeasonId !== null) {
            const seasonResults = await runSeasonScopes(affectedUserId, cycleAsOf, matchSeasonId);
            let bySeason = seasonPreOutcomes.get(affectedUserId);
            if (bySeason === undefined) {
              bySeason = new Map();
              seasonPreOutcomes.set(affectedUserId, bySeason);
            }
            for (const seasonRes of seasonResults) {
              bySeason.set(
                seasonRes.seasonId,
                mergeOutcome(bySeason.get(seasonRes.seasonId), seasonRes),
              );
            }
          }
        }
      };

      await correctionReeval.runPendingBefore(
        asOf,
        serverNow,
        renewWeeklyLock,
        onBeforePendingCorrection,
      );
      const users = await this.repo.users.findAll();
      let processedActiveUsers = 0;
      let lastRenewWallMs = Date.now();
      for (const candidate of users) {
        if (candidate.status !== UserStatus.Active) continue;
        if (candidate.career_valid_predictions >= 1) {
          const pre = careerPreOutcomes.get(candidate.user_id);
          const current = await runCareerScope(candidate.user_id, asOf);
          recordOutcome(mergeOutcome(pre, current));
        }

        const preSeasons = seasonPreOutcomes.get(candidate.user_id);
        const seenSeasonIds = new Set<string>();
        for (const result of await runSeasonScopes(candidate.user_id, asOf)) {
          seenSeasonIds.add(result.seasonId);
          recordOutcome(mergeOutcome(preSeasons?.get(result.seasonId), result));
        }
        if (preSeasons !== undefined) {
          for (const [seasonId, pre] of preSeasons) {
            if (!seenSeasonIds.has(seasonId)) {
              recordOutcome(pre);
            }
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
        const userLock = requireUserRowLock(tx);
        const user = await userLock.findByIdForUpdate(userId);
        if (user === null || user.status !== UserStatus.Active || user.career_valid_predictions < 1) {
          return { evaluated: false, changed: false, skipped: true };
        }
        const previous = user.career_level_state ?? defaultLevelState();
        const catchUp = await catchUpCareerWeeklyStepsInTransaction({
          tx,
          userId,
          level: user.career_level,
          bestLevel: user.career_best_level,
          state: previous,
          maxAsOf: asOf,
          firstEvalAsOf: this.firstEvalAsOf,
          changedAt,
        });
        if (!catchUp.evaluated) {
          return { evaluated: false, changed: false, skipped: true };
        }
        await userLock.patchFields(userId, {
          career_level: catchUp.level,
          career_best_level: catchUp.bestLevel,
          career_level_state: catchUp.state,
          updated_at: changedAt,
        });
        return { evaluated: true, changed: catchUp.changed, skipped: false };
      });
    } finally {
      await this.repo.jobLocks.release(lockKey, ownerId);
    }
  }

  private async evaluateSeasons(
    userId: string,
    asOf: Date,
    changedAt: Date,
    targetSeasonId?: string,
  ): Promise<Array<{
    seasonId: string;
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
      seasonId: string;
      evaluated: boolean;
      changed: boolean;
      skipped: boolean;
      settlementSkipped: boolean;
      failed: boolean;
      deferred?: boolean;
    }> = [];
    for (const row of statsRows) {
      if (targetSeasonId !== undefined && row.level_season_id !== targetSeasonId) continue;
      if (!eligibleSeasonStats(row, asOf)) continue;
      const lockKey = levelScopeLockKey(userId, LevelScope.Season, row.level_season_id);
      const ownerId = newUuid();
      if (!(await this.repo.jobLocks.acquire(
        lockKey,
        ownerId,
        levelLeaseDeadline(changedAt),
      ))) {
        results.push({
          seasonId: row.level_season_id,
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
          const userLock = requireUserRowLock(tx);
          const seasonLock = requireSeasonRowLock(tx);
          const user = await userLock.findByIdForUpdate(userId);
          if (user === null || user.status !== UserStatus.Active) {
            return { evaluated: false, changed: false, skipped: true };
          }
          const stats = await seasonLock.findByUserAndSeasonForUpdate(userId, row.level_season_id);
          if (stats === null || stats.is_level_frozen === true || !eligibleSeasonStats(stats, asOf)) {
            return { evaluated: false, changed: false, skipped: true };
          }
          const catchUp = await catchUpSeasonWeeklyStepsInTransaction({
            tx,
            userId,
            stats,
            maxAsOf: asOf,
            firstEvalAsOf: this.firstEvalAsOf,
            changedAt,
          });
          if (catchUp.shouldPersistFreezeOnly) {
            await seasonLock.patchFields(userId, stats.level_season_id, {
              is_level_frozen: true,
              updated_at: changedAt,
            });
            return { evaluated: false, changed: false, skipped: true };
          }
          if (!catchUp.evaluated) {
            return { evaluated: false, changed: false, skipped: true };
          }
          await seasonLock.patchFields(userId, stats.level_season_id, {
            level: catchUp.level,
            best_level: catchUp.bestLevel,
            level_state: catchUp.state,
            is_level_frozen: catchUp.freeze,
            updated_at: changedAt,
          });
          return { evaluated: true, changed: catchUp.changed, skipped: false };
        });
        results.push({ seasonId: row.level_season_id, ...result, settlementSkipped: false, failed: false });
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
          results.push({ seasonId: row.level_season_id, evaluated: false, changed: false, skipped: true, settlementSkipped: true, failed: false });
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
          results.push({ seasonId: row.level_season_id, evaluated: false, changed: false, skipped: false, settlementSkipped: false, failed: true });
        }
      } finally {
        await this.repo.jobLocks.release(lockKey, ownerId);
      }
    }
    return results;
  }
}
