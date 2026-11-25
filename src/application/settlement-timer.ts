import { FIXED_CONFIG_V1 } from "../domain/config.js";
import {
  MatchStatus,
  SettlementDocStatus,
  SettlementStatus,
} from "../domain/enums.js";
import type { Match } from "../domain/types.js";
import { parseLevelFirstEvalAsOf } from "../gateway/config.js";
import type {
  AppRepository,
  SettlementTodoQuery,
} from "../infrastructure/repositories.js";
import type { SchedulerStateStore } from "../infrastructure/cloudbase-scheduler-state.js";
import { LevelCorrectionReevalService } from "./level-correction-reeval.js";
import { SettlementOrchestrationService } from "./settlement-orchestration-service.js";
import {
  DEFAULT_SETTLEMENT_TODO_BATCH,
  SETTLEMENT_FALLBACK_INTERVAL_MS,
  settlementTodoBatch,
  shouldRunFallback,
} from "./settlement-todo-batch.js";

export {
  DEFAULT_SETTLEMENT_TODO_BATCH,
  SETTLEMENT_FALLBACK_INTERVAL_MS,
  settlementTodoBatch,
  shouldRunFallback,
};

export interface SettlementTimerOutcome {
  match_id: string;
  outcome: unknown;
}

export interface SettlementTimerOptions {
  env?: Record<string, string | undefined>;
  schedulerState?: SchedulerStateStore;
  levelFirstEvalAsOf?: Date | null;
}

/** 每次定时触发都推进结算，独立于 Provider 是否有同步配额。 */
export async function runSettlementTimer(
  repo: AppRepository,
  now: Date,
  options: SettlementTimerOptions = {},
): Promise<SettlementTimerOutcome[]> {
  const firstEvalAsOf = options.levelFirstEvalAsOf !== undefined
    ? options.levelFirstEvalAsOf
    : (options.env !== undefined
      ? parseLevelFirstEvalAsOf(options.env, options.env.FOOTBALL_ENVIRONMENT)
      : FIXED_CONFIG_V1.LEVEL_FIRST_EVAL_AS_OF);
  const service = new SettlementOrchestrationService(
    repo,
    new LevelCorrectionReevalService(repo, firstEvalAsOf),
  );
  const limit = settlementTodoBatch(options.env ?? {});
  const examined = new Set<string>();
  const ids = new Set(
    await collectExecutableSettlementTodoIds(repo, limit, examined),
  );
  for (const status of [
    SettlementDocStatus.Running,
    SettlementDocStatus.Failed,
  ]) {
    for (const settlement of await repo.settlements.findByStatus(status)) {
      if (examined.has(settlement.match_id)) continue;
      examined.add(settlement.match_id);
      ids.add(settlement.match_id);
    }
  }
  const outcomes: SettlementTimerOutcome[] = [];
  for (const matchId of ids) {
    outcomes.push(await settleOneMatch(repo, service, matchId, now));
  }
  if (options.schedulerState) {
    const fallback = await runSettlementFallbackScan(repo, service, now, {
      limit,
      schedulerState: options.schedulerState,
      skipMatchIds: examined,
    });
    outcomes.push(...fallback);
  }
  return outcomes;
}

export async function runSettlementFallbackScan(
  repo: AppRepository,
  service: SettlementOrchestrationService,
  now: Date,
  input: {
    limit: number;
    schedulerState: SchedulerStateStore;
    skipMatchIds?: Set<string>;
  },
): Promise<SettlementTimerOutcome[]> {
  const current = await input.schedulerState.getSettlementFallback();
  const hasCursor =
    current?.cursor_kickoff_at != null && current.cursor_match_id != null;
  if (
    !hasCursor &&
    !shouldRunFallback(current?.last_run_at, now, SETTLEMENT_FALLBACK_INTERVAL_MS)
  ) {
    return [];
  }
  const after =
    hasCursor && current.cursor_kickoff_at != null && current.cursor_match_id != null
      ? { kickoff_at: current.cursor_kickoff_at, match_id: current.cursor_match_id }
      : null;
  const page = await repo.matches.findSettlementFallbackPage({
    limit: input.limit,
    after,
  });
  const skip = input.skipMatchIds ?? new Set<string>();
  const outcomes: SettlementTimerOutcome[] = [];
  for (const match of page) {
    if (skip.has(match.match_id)) continue;
    outcomes.push(await settleOneMatch(repo, service, match.match_id, now));
  }
  const last = page[page.length - 1];
  const exhausted = page.length < input.limit;
  await input.schedulerState.upsertSettlementFallback({
    cursor_kickoff_at: exhausted || last === undefined ? null : last.kickoff_at,
    cursor_match_id: exhausted || last === undefined ? null : last.match_id,
    last_run_at: hasCursor ? current?.last_run_at ?? now : now,
    updated_at: now,
  });
  return outcomes;
}

function alreadyCaughtUp(match: Match): boolean {
  return (
    match.settlement_status === SettlementStatus.Settled &&
    match.settled_result_version >= match.result_version
  );
}

async function hasOpenBlockingAnomaly(
  repo: AppRepository,
  matchId: string,
): Promise<boolean> {
  try {
    return ((await repo.anomalies?.findOpenBlockingByMatch(matchId))?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

async function collectExecutableSettlementTodoIds(
  repo: AppRepository,
  limit: number,
  examined: Set<string>,
): Promise<string[]> {
  const ids: string[] = [];
  let after: SettlementTodoQuery["after"] = null;
  while (ids.length < limit) {
    const page = await repo.matches.findSettlementTodos({ limit, after });
    if (page.length === 0) break;
    for (const match of page) {
      if (ids.length >= limit) break;
      if (examined.has(match.match_id)) continue;
      examined.add(match.match_id);
      if (alreadyCaughtUp(match)) continue;
      if (await hasOpenBlockingAnomaly(repo, match.match_id)) continue;
      ids.push(match.match_id);
    }
    if (page.length < limit) break;
    const last = page[page.length - 1];
    if (last === undefined) break;
    const nextAfter = {
      kickoff_at: last.kickoff_at,
      match_id: last.match_id,
    };
    if (after !== null) {
      const previousKickoff = after.kickoff_at.getTime();
      const nextKickoff = nextAfter.kickoff_at.getTime();
      if (
        nextKickoff < previousKickoff ||
        (nextKickoff === previousKickoff && nextAfter.match_id <= after.match_id)
      ) {
        break;
      }
    }
    after = nextAfter;
  }
  return ids;
}

async function settleOneMatch(
  repo: AppRepository,
  service: SettlementOrchestrationService,
  matchId: string,
  now: Date,
): Promise<SettlementTimerOutcome> {
  try {
    const match = await repo.matches.findById(matchId);
    if (!match || match.match_status !== MatchStatus.Finished) {
      return { match_id: matchId, outcome: { kind: "skipped" } };
    }
    if (alreadyCaughtUp(match)) {
      return { match_id: matchId, outcome: { kind: "skipped" } };
    }
    if ((await repo.anomalies?.findOpenBlockingByMatch(matchId))?.length) {
      return { match_id: matchId, outcome: { kind: "skipped" } };
    }
    const outstanding = (await repo.settlements.findByMatch(matchId))
      .filter(
        (row) =>
          row.status === SettlementDocStatus.Running ||
          row.status === SettlementDocStatus.Failed,
      )
      .sort((a, b) => a.result_version - b.result_version)[0];
    const outcome = outstanding
      ? await service.retry(outstanding.settlement_id, now)
      : match.settled_result_version > 0 &&
          match.result_version > match.settled_result_version
        ? await service.correct(matchId, now)
        : await service.startFirst(matchId, now, false);
    return { match_id: matchId, outcome };
  } catch (error) {
    return {
      match_id: matchId,
      outcome: {
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
