import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import {
  MatchScoreValue,
  MatchStatus,
  PeriodType,
  RankingBoard,
  SettlementStatus,
  SyncJobType,
} from "../domain/enums.js";
import { defaultLevelState, type Match, type MatchResult, type Prediction, type RankingEntry, type User, type UserSeasonStats } from "../domain/types.js";
import { CloudBaseAppRepository } from "../infrastructure/cloudbase-app-repository.js";
import { createCountingDb } from "../infrastructure/db-op-counter.js";
import {
  applyPostgresSchema,
  buildPostgresSchemaPlan,
  quoteIdent,
} from "../infrastructure/postgres-schema.js";
import { createPostgresQueryFn } from "../infrastructure/postgres-document-db.js";
import { createPostgresAppRepository, createPostgresDocumentDbFromPool } from "../gateway/repository-factory.js";
import { DAILY_CONSISTENCY_MISMATCH_CODE } from "../application/daily-consistency-service.js";
import { weeklyEvalAsOf } from "../application/weekly-level-eval.js";
import { CloudBaseSchedulerStateStore } from "../infrastructure/cloudbase-scheduler-state.js";
import { createApplicationRuntime } from "../runtime/application-runtime.js";
import { UNWIRED_PERIODIC_TASKS, WIRED_PERIODIC_TASKS } from "../runtime/scheduled-jobs.js";
import { createVpsRuntime } from "../runtime/vps-runtime.js";
import { runJobsTick, type JobsTickHandle } from "./tick.js";

const DATABASE_URL = process.env.FOOTBALL_TEST_DATABASE_URL ?? "";
const ENABLED = DATABASE_URL.length > 0;
const SCHEMA = "football_vps07_tick";
const NAMESPACE = "ft";
const NOW = new Date("2026-08-09T00:00:00.000Z");
const ANCHOR = new Date("2026-08-08T14:00:00.000Z");
const FINISH_AT = new Date(NOW.getTime() - 10 * 60 * 1000);
const RULE = "scoring_v1";
const MATCH_ID = "00000000-0000-4000-8000-000000000070";
const USER_ID = "00000000-0000-4000-8000-000000000071";
const PREDICTION_ID = "00000000-0000-4000-8000-000000000072";
const RANKING_USER_ID = "00000000-0000-4000-8000-000000000076";
const WEEK31_USER_ID = "00000000-0000-4000-8000-000000000077";
const WEEK33_USER_ID = "00000000-0000-4000-8000-000000000078";
const CYCLE_NOW = new Date("2026-08-10T00:00:00.000Z");
const LATER_SAME_HOUR = new Date(CYCLE_NOW.getTime() + 30 * 60_000);

const ENV = {
  FOOTBALL_ENVIRONMENT: "test",
  FOOTBALL_MATCH_CURSOR_SECRET: "vps07-tick-secret",
  FOOTBALL_REPOSITORY_BACKEND: "postgres",
  FOOTBALL_DATABASE_URL: DATABASE_URL,
  FOOTBALL_DATABASE_SCHEMA: SCHEMA,
  FOOTBALL_RESOURCE_NAMESPACE: NAMESPACE,
  FOOTBALL_WECHAT_APP_ID: "wx-test",
  FOOTBALL_WECHAT_APP_SECRET: "wx-secret",
  FOOTBALL_SESSION_TTL_SECONDS: "60",
};

function makeMatch(): Match {
  return {
    schema_version: 1,
    match_id: MATCH_ID,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: "00000000-0000-4000-8000-000000000073",
    away_team_id: "00000000-0000-4000-8000-000000000074",
    kickoff_at: ANCHOR,
    kickoff_confirmed: true,
    prediction_deadline_at: new Date(ANCHOR.getTime() - 600_000),
    prediction_closed_at: new Date(ANCHOR.getTime() - 600_000),
    period_anchor_at: ANCHOR,
    match_status: MatchStatus.Finished,
    settlement_status: SettlementStatus.Waiting,
    regular_home_score: 2,
    regular_away_score: 1,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 1,
    settled_result_version: 0,
    result_source: "provider",
    scoring_rule_version: RULE,
    finish_detected_at: FINISH_AT,
    settled_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeResult(): MatchResult {
  return {
    schema_version: 1,
    match_id: MATCH_ID,
    result_version: 1,
    regular_home_score: 2,
    regular_away_score: 1,
    source: "provider",
    provider_status: "FT",
    admin_id: null,
    reason: null,
    created_at: FINISH_AT,
  };
}

function makeUser(): User {
  return {
    schema_version: 1,
    user_id: USER_ID,
    openid: "openid_vps07",
    unionid: null,
    nickname: "TickUser",
    favorite_team_id: null,
    status: "active",
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_level: 1,
    career_best_level: 1,
    career_last_scoring_match_at: null,
    career_level_state: defaultLevelState(),
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeRanking(overrides: Partial<RankingEntry> = {}): RankingEntry {
  return {
    schema_version: 1,
    period_type: PeriodType.Week,
    period_key: "2026-W32",
    user_id: RANKING_USER_ID,
    period_score: 12,
    valid_predictions: 1,
    wdl_hits: 1,
    exact_hits: 1,
    last_scoring_match_at: ANCHOR,
    global_rank: null,
    is_final: false,
    created_at: ANCHOR,
    updated_at: ANCHOR,
    ...overrides,
  };
}

function makePrediction(): Prediction {
  return {
    schema_version: 1,
    prediction_id: PREDICTION_ID,
    user_id: USER_ID,
    match_id: MATCH_ID,
    idempotency_key: "00000000-0000-4000-8000-000000000075",
    pred_home_score: 2,
    pred_away_score: 1,
    derived_result: "HOME",
    submitted_at: NOW,
    scoring_rule_version: RULE,
    match_score: null,
    wdl_hit: null,
    exact_hit: null,
    applied_result_version: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

describe.skipIf(!ENABLED)("jobs:tick over isolated postgres", () => {
  let pool!: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
    await applyPostgresSchema(createPostgresQueryFn(pool), buildPostgresSchemaPlan(NAMESPACE, SCHEMA));
  });

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(SCHEMA)} CASCADE`);
    await pool.end();
  });

  async function seedLedger(): Promise<void> {
    const repo = createPostgresAppRepository(pool, {
      database_url: DATABASE_URL,
      database_schema: SCHEMA,
      resource_namespace: NAMESPACE,
    });
    await repo.matches.insert(makeMatch());
    await repo.matchResults.insert(makeResult());
    await repo.users.insert(makeUser());
    await repo.predictions.insert(makePrediction());
  }

  async function snapshot() {
    const repo = createPostgresAppRepository(pool, {
      database_url: DATABASE_URL,
      database_schema: SCHEMA,
      resource_namespace: NAMESPACE,
    });
    const user = await repo.users.findById(USER_ID);
    const match = await repo.matches.findById(MATCH_ID);
    const settlement = await repo.settlements.findByMatchAndVersionAndRule(MATCH_ID, 1, RULE);
    return {
      career_points: user?.career_points ?? null,
      settlement_status: match?.settlement_status ?? null,
      settled_result_version: match?.settled_result_version ?? null,
      settlement_id: settlement?.settlement_id ?? null,
      settlement_status_doc: settlement?.status ?? null,
    };
  }

  it("dry-run prints due jobs and does not write the settlement ledger", async () => {
    await seedLedger();
    const before = await snapshot();
    const log = vi.fn();
    const result = await runJobsTick({
      env: ENV,
      argv: ["--dry-run"],
      now: () => NOW,
      log,
    });
    expect(result.exitCode).toBe(0);
    expect(await snapshot()).toEqual(before);
    const plan = log.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "jobs_tick_plan");
    expect(plan).toEqual(expect.objectContaining({
      dry_run: true,
      settlement_todo_count: 1,
      fifteen_items_complete: true,
      settlement: { task: "settlement", action: "run", reason: "due" },
    }));
    expect(plan?.tasks).toEqual(expect.arrayContaining([
      { task: SyncJobType.LiveMatch, action: "skip", reason: "no_provider_sources" },
      { task: SyncJobType.ProviderReconcile, action: "skip", reason: "no_provider_sources" },
    ]));
    expect(plan?.wired_periodic_tasks).toEqual(WIRED_PERIODIC_TASKS);
    expect(plan?.unwired_periodic_tasks).toEqual(UNWIRED_PERIODIC_TASKS);
    expect(plan?.tasks).toEqual(expect.arrayContaining([
      { task: SyncJobType.PeriodFinalize, action: "run", reason: "due" },
      { task: SyncJobType.DailyConsistency, action: "run", reason: "due" },
      {
        task: SyncJobType.WeeklyLevelEval,
        action: "run",
        reason: "due",
        as_of: weeklyEvalAsOf(NOW).toISOString(),
      },
      { task: SyncJobType.BoardSnapshotCareer, action: "run", reason: "due" },
      { task: SyncJobType.BoardSnapshotSeason, action: "run", reason: "due" },
      { task: SyncJobType.BoardSnapshotStrength, action: "skip", reason: "inline_weekly_refresh" },
      { task: SyncJobType.BoardSnapshotSeasonFinal, action: "skip", reason: "inline_weekly_refresh" },
    ]));
  });

  it("real tick settles once, emits timer_summary, and a second tick does not double-score", async () => {
    const log = vi.fn();
    const first = await runJobsTick({
      env: ENV,
      argv: [],
      now: () => NOW,
      log,
    });
    expect(first.exitCode).toBe(0);
    const afterFirst = await snapshot();
    expect(afterFirst.career_points).toBe(MatchScoreValue.ExactHit);
    expect(afterFirst.settlement_status).toBe(SettlementStatus.Settled);
    const summaries = log.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry.event === "timer_summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual(expect.objectContaining({
      outcome: "ok",
      fifteen_items_complete: true,
    }));
    expect(summaries[0]?.settlements).toEqual(expect.objectContaining({
      attempted: expect.any(Number),
      settled: expect.any(Number),
      failed: 0,
    }));
    expect((summaries[0]?.settlements as { settled: number }).settled).toBeGreaterThanOrEqual(1);
    expect(summaries[0]?.skipped).toEqual(expect.arrayContaining([
      { task: SyncJobType.LiveMatch, reason: "no_provider_sources" },
    ]));
    expect(summaries[0]?.wired_periodic_tasks).toEqual(WIRED_PERIODIC_TASKS);
    expect(summaries[0]?.unwired_periodic_tasks).toEqual(UNWIRED_PERIODIC_TASKS);
    expect(summaries[0]?.ran).toEqual(expect.arrayContaining([
      SyncJobType.PeriodFinalize,
      SyncJobType.DailyConsistency,
      SyncJobType.WeeklyLevelEval,
      SyncJobType.BoardSnapshotCareer,
      SyncJobType.BoardSnapshotSeason,
    ]));
    expect(summaries[0]?.ran ?? []).not.toContain(SyncJobType.BoardSnapshotStrength);

    const secondLog = vi.fn();
    const second = await runJobsTick({
      env: ENV,
      argv: [],
      now: () => NOW,
      log: secondLog,
    });
    expect(second.exitCode).toBe(0);
    expect(await snapshot()).toEqual(afterFirst);
  });

  it("still settles when provider jobs fail and exits non-zero", async () => {
    const waiting = makeMatch();
    waiting.match_id = "00000000-0000-4000-8000-000000000080";
    waiting.home_team_id = "00000000-0000-4000-8000-000000000081";
    waiting.away_team_id = "00000000-0000-4000-8000-000000000082";
    const result = makeResult();
    result.match_id = waiting.match_id;
    const user = makeUser();
    user.user_id = "00000000-0000-4000-8000-000000000083";
    user.openid = "openid_vps07_fail";
    const prediction = makePrediction();
    prediction.prediction_id = "00000000-0000-4000-8000-000000000084";
    prediction.user_id = user.user_id;
    prediction.match_id = waiting.match_id;
    prediction.idempotency_key = "00000000-0000-4000-8000-000000000085";
    const repo = createPostgresAppRepository(pool, {
      database_url: DATABASE_URL,
      database_schema: SCHEMA,
      resource_namespace: NAMESPACE,
    });
    await repo.matches.insert(waiting);
    await repo.matchResults.insert(result);
    await repo.users.insert(user);
    await repo.predictions.insert(prediction);

    const log = vi.fn();
    const tickResult = await runJobsTick({
      env: ENV,
      argv: [],
      now: () => NOW,
      log,
      assemble: async (config): Promise<JobsTickHandle> => {
        if (config.postgres_repository === null) throw new Error("missing postgres");
        const vps = createVpsRuntime({ postgres: config.postgres_repository });
        const counted = createCountingDb(vps.db);
        const countedRepo = new CloudBaseAppRepository(
          { resource_namespace: config.postgres_repository.resource_namespace },
          counted.db,
        );
        const application = createApplicationRuntime({
          env: ENV,
          db: counted.db,
          namespace: config.postgres_repository.resource_namespace,
          repo: countedRepo,
          matchCursorSecret: config.match_cursor_secret,
          log,
        });
        application.providerSources.sources = [{ source_id: "fd" }] as typeof application.providerSources.sources;
        application.providerSources.sync_leagues = new Set(["premier_league"]);
        application.providerDispatcher.run = vi.fn(async () => {
          throw new Error("provider down");
        }) as typeof application.providerDispatcher.run;
        application.providerReconcile.run = vi.fn(async () => ({
          kind: "completed" as const,
          items_read: 0,
          conflicts: 0,
          skipped: 0,
        }));
        return {
          application,
          counter: counted.counter,
          close: () => vps.close(),
        };
      },
    });
    expect(tickResult.exitCode).toBe(1);
    const settledUser = await repo.users.findById(user.user_id);
    const settledMatch = await repo.matches.findById(waiting.match_id);
    expect(settledUser?.career_points).toBe(MatchScoreValue.ExactHit);
    expect(settledMatch?.settlement_status).toBe(SettlementStatus.Settled);
    const summaries = log.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry.event === "timer_summary");
    expect(summaries).toHaveLength(1);
    expect(["failed", "partial"]).toContain(summaries[0]?.outcome);
  });

  it("finalizes ended weeks, alerts consistency mismatches without rewriting caches, and skips the next hour", async () => {
    const repo = createPostgresAppRepository(pool, {
      database_url: DATABASE_URL,
      database_schema: SCHEMA,
      resource_namespace: NAMESPACE,
    });
    const rankings = repo.rankings;
    expect(rankings).toBeDefined();
    const week32Seed = makeRanking();
    const week31Seed = makeRanking({
      user_id: WEEK31_USER_ID,
      period_key: "2026-W31",
    });
    const week33Seed = makeRanking({
      user_id: WEEK33_USER_ID,
      period_key: "2026-W33",
    });
    await rankings!.insert(week32Seed);
    await rankings!.insert(week31Seed);
    await rankings!.insert(week33Seed);
    expect(await rankings!.findByPeriod(PeriodType.Week, "2026-W32")).toEqual(
      expect.arrayContaining([expect.objectContaining({
        user_id: RANKING_USER_ID,
        period_key: "2026-W32",
        is_final: false,
        period_score: 12,
        updated_at: ANCHOR,
      })]),
    );
    expect(await rankings!.findByPeriod(PeriodType.Week, "2026-W31")).toEqual([
      expect.objectContaining({
        user_id: WEEK31_USER_ID,
        period_key: "2026-W31",
        is_final: false,
        period_score: 12,
        updated_at: ANCHOR,
      }),
    ]);
    expect(await rankings!.findByPeriod(PeriodType.Week, "2026-W33")).toEqual([
      expect.objectContaining({
        user_id: WEEK33_USER_ID,
        period_key: "2026-W33",
        is_final: false,
      }),
    ]);
    const user = await repo.users.findById(USER_ID);
    expect(user).not.toBeNull();
    const mismatchedPoints = user!.career_points + 5;
    await repo.users.update({
      ...user!,
      career_points: mismatchedPoints,
      updated_at: CYCLE_NOW,
    });
    const ledgerBefore = await snapshot();
    expect(ledgerBefore.career_points).toBe(mismatchedPoints);

    const planLog = vi.fn();
    const planned = await runJobsTick({
      env: ENV,
      argv: ["--dry-run"],
      now: () => CYCLE_NOW,
      log: planLog,
    });
    expect(planned.exitCode).toBe(0);
    expect(await snapshot()).toEqual(ledgerBefore);
    const duePlan = planLog.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "jobs_tick_plan");
    expect(duePlan?.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        task: SyncJobType.PeriodFinalize,
        action: "run",
        reason: "due",
        due_period_keys: ["2026-W31", "2026-W32"],
      }),
      { task: SyncJobType.DailyConsistency, action: "run", reason: "due" },
    ]));

    const firstLog = vi.fn();
    const first = await runJobsTick({
      env: ENV,
      argv: [],
      now: () => CYCLE_NOW,
      log: firstLog,
    });
    expect(first.exitCode).toBe(0);
    const week32 = await rankings!.findByPeriod(PeriodType.Week, "2026-W32");
    const week31 = await rankings!.findByPeriod(PeriodType.Week, "2026-W31");
    const week33 = await rankings!.findByPeriod(PeriodType.Week, "2026-W33");
    expect(week32.length).toBeGreaterThanOrEqual(1);
    expect(week31).toHaveLength(1);
    expect(week33).toHaveLength(1);
    expect(week32.map((row) => row.user_id)).toEqual(expect.arrayContaining([RANKING_USER_ID]));
    expect(week32.every((row) => row.is_final)).toBe(true);
    expect(week31).toEqual([
      expect.objectContaining({
        user_id: WEEK31_USER_ID,
        period_key: "2026-W31",
        is_final: true,
        period_score: 12,
        updated_at: ANCHOR,
      }),
    ]);
    expect(week32).toEqual(expect.arrayContaining([
      expect.objectContaining({
        user_id: RANKING_USER_ID,
        period_key: "2026-W32",
        is_final: true,
        period_score: 12,
        updated_at: ANCHOR,
      }),
    ]));
    expect(week33).toEqual([
      expect.objectContaining({
        user_id: WEEK33_USER_ID,
        period_key: "2026-W33",
        is_final: false,
        period_score: 12,
        updated_at: ANCHOR,
      }),
    ]);
    expect(await snapshot()).toEqual(ledgerBefore);
    const firstSummary = firstLog.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "timer_summary");
    expect(firstSummary?.ran).toEqual(expect.arrayContaining([
      SyncJobType.PeriodFinalize,
      SyncJobType.DailyConsistency,
    ]));
    const mismatch = firstLog.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "daily_consistency_mismatch");
    expect(mismatch).toEqual(expect.objectContaining({
      event: "daily_consistency_mismatch",
      code: DAILY_CONSISTENCY_MISMATCH_CODE,
      difference_count: expect.any(Number),
      differences: expect.arrayContaining([`career:${USER_ID}`]),
    }));
    expect(mismatch?.difference_count).toBeGreaterThanOrEqual(1);
    const syncLogs = repo.syncLogs;
    expect(syncLogs?.findLatestByJobType).toEqual(expect.any(Function));
    const consistencyLog = await syncLogs!.findLatestByJobType!(SyncJobType.DailyConsistency);
    expect(consistencyLog).toEqual(expect.objectContaining({
      job_type: SyncJobType.DailyConsistency,
      status: "success",
      last_error_code: DAILY_CONSISTENCY_MISMATCH_CODE,
      last_error_message: expect.stringContaining(`career:${USER_ID} [career_points`),
    }));

    const secondLog = vi.fn();
    const second = await runJobsTick({
      env: ENV,
      argv: [],
      now: () => LATER_SAME_HOUR,
      log: secondLog,
    });
    expect(second.exitCode).toBe(0);
    expect(await snapshot()).toEqual(ledgerBefore);
    const secondSummary = secondLog.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "timer_summary");
    expect(secondSummary).toEqual(expect.objectContaining({
      event: "timer_summary",
    }));
    expect(secondSummary?.ran ?? []).not.toContain(SyncJobType.PeriodFinalize);
    expect(secondSummary?.ran ?? []).not.toContain(SyncJobType.DailyConsistency);
    expect(secondSummary?.skipped).toEqual(expect.arrayContaining([
      { task: SyncJobType.PeriodFinalize, reason: "interval_not_due" },
      { task: SyncJobType.DailyConsistency, reason: "interval_not_due" },
    ]));
    expect(secondLog.mock.calls.map(([entry]) => (entry as Record<string, unknown>).event))
      .not.toContain("daily_consistency_mismatch");
    expect(await rankings!.findByPeriod(PeriodType.Week, "2026-W32")).toEqual(week32);
    expect(await rankings!.findByPeriod(PeriodType.Week, "2026-W31")).toEqual(week31);
    expect(await rankings!.findByPeriod(PeriodType.Week, "2026-W33")).toEqual(week33);
  });

  it("waits until Monday 02:10 UTC, refreshes strength once, and skips the repeat tick (isolated postgres, not a real cloud acceptance)", async () => {
    const postgres = {
      database_url: DATABASE_URL,
      database_schema: SCHEMA,
      resource_namespace: NAMESPACE,
    };
    const schedulerState = new CloudBaseSchedulerStateStore(
      createPostgresDocumentDbFromPool(pool, postgres),
      NAMESPACE,
    );
    await schedulerState.upsertPeriodicJobCycle({
      job_type: SyncJobType.WeeklyLevelEval,
      completed_cycle_at: new Date("2026-08-03T02:00:00.000Z"),
      updated_at: new Date("2026-08-03T02:00:00.000Z"),
    });
    await schedulerState.upsertPeriodicJobCycle({
      job_type: SyncJobType.BoardSnapshotStrength,
      completed_cycle_at: new Date("2026-08-09T03:00:00.000Z"),
      updated_at: new Date("2026-08-09T03:00:00.000Z"),
    });
    const repo = createPostgresAppRepository(pool, postgres);
    const snapshots = repo.boardSnapshots;
    expect(snapshots).toBeDefined();
    const beforeStart = new Date("2026-08-10T02:09:00.000Z");
    const start = new Date("2026-08-10T02:10:00.000Z");
    const asOf = new Date("2026-08-10T02:00:00.000Z");
    const repeatAt = new Date("2026-08-10T02:20:00.000Z");

    const earlyPlanLog = vi.fn();
    const earlyPlan = await runJobsTick({
      env: ENV,
      argv: ["--dry-run"],
      now: () => beforeStart,
      log: earlyPlanLog,
    });
    expect(earlyPlan.exitCode).toBe(0);
    const earlyPlanEntry = earlyPlanLog.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "jobs_tick_plan");
    expect(earlyPlanEntry?.tasks).toEqual(expect.arrayContaining([
      { task: SyncJobType.WeeklyLevelEval, action: "skip", reason: "interval_not_due" },
    ]));
    const earlyLog = vi.fn();
    const early = await runJobsTick({
      env: ENV,
      argv: [],
      now: () => beforeStart,
      log: earlyLog,
    });
    expect(early.exitCode).toBe(0);
    const earlySummary = earlyLog.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "timer_summary");
    expect(earlySummary?.ran ?? []).not.toContain(SyncJobType.WeeklyLevelEval);
    expect(await snapshots!.findByBoardAndSnapshotAt(RankingBoard.Strength, beforeStart)).toEqual([]);

    const duePlanLog = vi.fn();
    const duePlan = await runJobsTick({
      env: ENV,
      argv: ["--dry-run"],
      now: () => start,
      log: duePlanLog,
    });
    expect(duePlan.exitCode).toBe(0);
    const duePlanEntry = duePlanLog.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "jobs_tick_plan");
    expect(duePlanEntry?.tasks).toEqual(expect.arrayContaining([
      {
        task: SyncJobType.WeeklyLevelEval,
        action: "run",
        reason: "due",
        as_of: asOf.toISOString(),
      },
    ]));
    expect(duePlanEntry?.unwired_periodic_tasks).toEqual(UNWIRED_PERIODIC_TASKS);
    expect(duePlanEntry?.tasks).toEqual(expect.arrayContaining([
      { task: SyncJobType.BoardSnapshotStrength, action: "skip", reason: "inline_weekly_refresh" },
      { task: SyncJobType.BoardSnapshotSeasonFinal, action: "skip", reason: "inline_weekly_refresh" },
    ]));
    const firstLog = vi.fn();
    const first = await runJobsTick({
      env: ENV,
      argv: [],
      now: () => start,
      log: firstLog,
    });
    expect(first.exitCode).toBe(0);
    const firstSummary = firstLog.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "timer_summary");
    expect(firstSummary?.ran).toEqual(expect.arrayContaining([SyncJobType.WeeklyLevelEval]));
    expect(firstSummary?.ran ?? []).not.toContain(SyncJobType.BoardSnapshotStrength);
    expect(firstSummary?.ran ?? []).not.toContain(SyncJobType.BoardSnapshotSeasonFinal);
    expect(firstSummary?.skipped).toEqual(expect.arrayContaining([
      { task: SyncJobType.BoardSnapshotStrength, reason: "inline_weekly_refresh" },
      { task: SyncJobType.BoardSnapshotSeasonFinal, reason: "inline_weekly_refresh" },
    ]));
    expect(await snapshots!.findByBoardAndSnapshotAt(RankingBoard.Strength, start)).toEqual([
      expect.objectContaining({ snapshot_kind: "head", snapshot_at: start }),
    ]);
    expect(await schedulerState.getPeriodicJobCycle(SyncJobType.WeeklyLevelEval)).toEqual(
      expect.objectContaining({ completed_cycle_at: asOf, updated_at: start }),
    );

    const repeatLog = vi.fn();
    const repeat = await runJobsTick({
      env: ENV,
      argv: [],
      now: () => repeatAt,
      log: repeatLog,
    });
    expect(repeat.exitCode).toBe(0);
    const repeatSummary = repeatLog.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "timer_summary");
    expect(repeatSummary?.ran ?? []).not.toContain(SyncJobType.WeeklyLevelEval);
    expect(repeatSummary?.ran ?? []).not.toContain(SyncJobType.BoardSnapshotStrength);
    expect(repeatSummary?.skipped).toEqual(expect.arrayContaining([
      { task: SyncJobType.WeeklyLevelEval, reason: "interval_not_due" },
      { task: SyncJobType.BoardSnapshotStrength, reason: "interval_not_due" },
      { task: SyncJobType.BoardSnapshotSeasonFinal, reason: "no_due_season" },
    ]));
    expect(await snapshots!.findByBoardAndSnapshotAt(RankingBoard.Strength, repeatAt)).toEqual([]);
    expect(await snapshots!.findByBoardAndSnapshotAt(RankingBoard.Strength, start)).toHaveLength(1);
    expect(await schedulerState.getPeriodicJobCycle(SyncJobType.BoardSnapshotStrength)).toEqual(
      expect.objectContaining({ completed_cycle_at: start, updated_at: start }),
    );
  });

  it("updates career and season hourly and strength daily, skipping a repeat tick (isolated postgres, not a real cloud acceptance)", async () => {
    const postgres = {
      database_url: DATABASE_URL,
      database_schema: SCHEMA,
      resource_namespace: NAMESPACE,
    };
    const schedulerState = new CloudBaseSchedulerStateStore(
      createPostgresDocumentDbFromPool(pool, postgres),
      NAMESPACE,
    );
    const t0 = new Date("2026-08-11T12:00:00.000Z");
    const plus30 = new Date(t0.getTime() + 30 * 60_000);
    const plus60 = new Date(t0.getTime() + 60 * 60_000);
    const plus24 = new Date(t0.getTime() + 24 * 60 * 60_000);
    await schedulerState.upsertPeriodicJobCycle({
      job_type: SyncJobType.WeeklyLevelEval,
      completed_cycle_at: weeklyEvalAsOf(t0),
      updated_at: t0,
    });
    const repo = createPostgresAppRepository(pool, postgres);
    const snapshots = repo.boardSnapshots;
    expect(snapshots).toBeDefined();

    const firstLog = vi.fn();
    const first = await runJobsTick({ env: ENV, argv: [], now: () => t0, log: firstLog });
    expect(first.exitCode).toBe(0);
    const firstSummary = firstLog.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "timer_summary");
    expect(firstSummary?.ran).toEqual(expect.arrayContaining([
      SyncJobType.BoardSnapshotCareer,
      SyncJobType.BoardSnapshotSeason,
      SyncJobType.BoardSnapshotStrength,
    ]));
    expect(firstSummary?.ran ?? []).not.toContain(SyncJobType.WeeklyLevelEval);
    expect(await snapshots!.findByBoardAndSnapshotAt(RankingBoard.Career, t0)).toEqual(
      expect.arrayContaining([expect.objectContaining({ snapshot_at: t0 })]),
    );
    expect(await snapshots!.findByBoardAndSnapshotAt(RankingBoard.Season, t0)).toEqual(
      expect.arrayContaining([expect.objectContaining({ snapshot_at: t0 })]),
    );
    expect(await snapshots!.findByBoardAndSnapshotAt(RankingBoard.Strength, t0)).toEqual(
      expect.arrayContaining([expect.objectContaining({ snapshot_at: t0 })]),
    );

    const repeatLog = vi.fn();
    const repeat = await runJobsTick({ env: ENV, argv: [], now: () => plus30, log: repeatLog });
    expect(repeat.exitCode).toBe(0);
    const repeatSummary = repeatLog.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "timer_summary");
    expect(repeatSummary?.skipped).toEqual(expect.arrayContaining([
      { task: SyncJobType.BoardSnapshotCareer, reason: "interval_not_due" },
      { task: SyncJobType.BoardSnapshotSeason, reason: "interval_not_due" },
      { task: SyncJobType.BoardSnapshotStrength, reason: "interval_not_due" },
    ]));
    expect(await snapshots!.findByBoardAndSnapshotAt(RankingBoard.Career, plus30)).toEqual([]);

    const hourLog = vi.fn();
    const hour = await runJobsTick({ env: ENV, argv: [], now: () => plus60, log: hourLog });
    expect(hour.exitCode).toBe(0);
    const hourSummary = hourLog.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "timer_summary");
    expect(hourSummary?.ran).toEqual(expect.arrayContaining([
      SyncJobType.BoardSnapshotCareer,
      SyncJobType.BoardSnapshotSeason,
    ]));
    expect(hourSummary?.ran ?? []).not.toContain(SyncJobType.BoardSnapshotStrength);
    expect((await snapshots!.findByBoardAndSnapshotAt(RankingBoard.Career, plus60)).length).toBeGreaterThanOrEqual(1);
    expect((await snapshots!.findByBoardAndSnapshotAt(RankingBoard.Season, plus60)).length).toBeGreaterThanOrEqual(1);
    expect(await snapshots!.findByBoardAndSnapshotAt(RankingBoard.Strength, plus60)).toEqual([]);

    const dailyLog = vi.fn();
    const daily = await runJobsTick({ env: ENV, argv: [], now: () => plus24, log: dailyLog });
    expect(daily.exitCode).toBe(0);
    const dailySummary = dailyLog.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "timer_summary");
    expect(dailySummary?.ran).toEqual(expect.arrayContaining([
      SyncJobType.BoardSnapshotCareer,
      SyncJobType.BoardSnapshotSeason,
      SyncJobType.BoardSnapshotStrength,
    ]));
     expect((await snapshots!.findByBoardAndSnapshotAt(RankingBoard.Strength, plus24)).length).toBeGreaterThanOrEqual(1);
   });

  it("does not freeze season finals before the first weekly eval after season end, then writes is_final rows and stays idempotent (isolated postgres, not a real cloud acceptance)", async () => {
    const postgres = {
      database_url: DATABASE_URL,
      database_schema: SCHEMA,
      resource_namespace: NAMESPACE,
    };
    const schedulerState = new CloudBaseSchedulerStateStore(
      createPostgresDocumentDbFromPool(pool, postgres),
      NAMESPACE,
    );
    const beforeStart = new Date("2026-06-29T02:20:00.000Z");
    const start = new Date("2026-07-06T02:10:00.000Z");
    const asOf = new Date("2026-07-06T02:00:00.000Z");
    const repeatAt = new Date("2026-07-06T02:20:00.000Z");
    const catchUpAt = new Date("2026-08-11T13:00:00.000Z");
    await schedulerState.upsertPeriodicJobCycle({
      job_type: SyncJobType.WeeklyLevelEval,
      completed_cycle_at: weeklyEvalAsOf(beforeStart),
      updated_at: beforeStart,
    });
    const repo = createPostgresAppRepository(pool, postgres);
    const snapshots = repo.boardSnapshots;
    expect(snapshots).toBeDefined();
    const seasonUser: User = {
      ...makeUser(),
      user_id: "00000000-0000-4000-8000-000000000210",
      openid: "openid_vps07_season_final",
    };
    const seasonStats: UserSeasonStats = {
      schema_version: 1,
      user_id: seasonUser.user_id,
      level_season_id: "2025_2026",
      points: 48,
      valid_predictions: 4,
      wdl_hits: 3,
      exact_hits: 2,
      last_scoring_match_at: new Date("2026-06-28T10:00:00.000Z"),
      level: 1,
      best_level: 1,
      level_state: defaultLevelState(),
      is_level_frozen: false,
      created_at: beforeStart,
      updated_at: beforeStart,
    };
    await repo.users.insert(seasonUser);
    const seasonStatsRepo = repo.userSeasonStats;
    expect(seasonStatsRepo).toBeDefined();
    await seasonStatsRepo!.insert(seasonStats);

    const earlyPlanLog = vi.fn();
    const earlyPlan = await runJobsTick({
      env: ENV,
      argv: ["--dry-run"],
      now: () => beforeStart,
      log: earlyPlanLog,
    });
    expect(earlyPlan.exitCode).toBe(0);
    const earlyPlanEntry = earlyPlanLog.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "jobs_tick_plan");
    expect(earlyPlanEntry?.tasks).toEqual(expect.arrayContaining([
      { task: SyncJobType.WeeklyLevelEval, action: "skip", reason: "interval_not_due" },
      { task: SyncJobType.BoardSnapshotSeasonFinal, action: "skip", reason: "no_due_season" },
    ]));
    const earlyLog = vi.fn();
    const early = await runJobsTick({ env: ENV, argv: [], now: () => beforeStart, log: earlyLog });
    expect(early.exitCode).toBe(0);
    const earlySummary = earlyLog.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "timer_summary");
    expect(earlySummary?.ran ?? []).not.toContain(SyncJobType.BoardSnapshotSeasonFinal);
    expect(await snapshots!.findFinalBySeason("2025_2026")).toEqual([]);

    const duePlanLog = vi.fn();
    const duePlan = await runJobsTick({
      env: ENV,
      argv: ["--dry-run"],
      now: () => start,
      log: duePlanLog,
    });
    expect(duePlan.exitCode).toBe(0);
    const duePlanEntry = duePlanLog.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "jobs_tick_plan");
    expect(duePlanEntry?.tasks).toEqual(expect.arrayContaining([
      {
        task: SyncJobType.WeeklyLevelEval,
        action: "run",
        reason: "due",
        as_of: asOf.toISOString(),
      },
      { task: SyncJobType.BoardSnapshotSeasonFinal, action: "skip", reason: "inline_weekly_refresh" },
    ]));
    const firstLog = vi.fn();
    const first = await runJobsTick({ env: ENV, argv: [], now: () => start, log: firstLog });
    expect(first.exitCode).toBe(0);
    const firstSummary = firstLog.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "timer_summary");
    expect(firstSummary?.ran).toEqual(expect.arrayContaining([SyncJobType.WeeklyLevelEval]));
    expect(firstSummary?.ran ?? []).not.toContain(SyncJobType.BoardSnapshotSeasonFinal);
    expect(await snapshots!.findFinalBySeason("2025_2026")).toEqual([
      expect.objectContaining({
        is_final: true,
        level_season_id: "2025_2026",
        user_id: seasonUser.user_id,
        season_points: 48,
        snapshot_at: asOf,
      }),
    ]);
    expect(await snapshots!.findByBoardAndSnapshotAt(RankingBoard.Season, asOf)).toEqual([]);

    const currentStats = await seasonStatsRepo!.findByUserAndSeason(seasonUser.user_id, "2025_2026");
    await seasonStatsRepo!.update({ ...currentStats!, points: 60, updated_at: repeatAt });
    const repeatLog = vi.fn();
    const repeat = await runJobsTick({ env: ENV, argv: [], now: () => repeatAt, log: repeatLog });
    expect(repeat.exitCode).toBe(0);
    const repeatSummary = repeatLog.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "timer_summary");
    expect(repeatSummary?.ran ?? []).not.toContain(SyncJobType.BoardSnapshotSeasonFinal);
    expect(repeatSummary?.skipped).toEqual(expect.arrayContaining([
      { task: SyncJobType.BoardSnapshotSeasonFinal, reason: "no_due_season" },
    ]));
    expect(await snapshots!.findFinalBySeason("2025_2026")).toEqual([
      expect.objectContaining({ is_final: true, season_points: 48, snapshot_at: asOf }),
    ]);

    const missedUser: User = {
      ...makeUser(),
      user_id: "00000000-0000-4000-8000-000000000211",
      openid: "openid_vps07_season_final_missed",
    };
    await repo.users.insert(missedUser);
    await seasonStatsRepo!.insert({
      ...seasonStats,
      user_id: missedUser.user_id,
      level_season_id: "2024_2025",
      points: 24,
      last_scoring_match_at: new Date("2025-06-28T10:00:00.000Z"),
      is_level_frozen: true,
    });
    await schedulerState.upsertPeriodicJobCycle({
      job_type: SyncJobType.WeeklyLevelEval,
      completed_cycle_at: weeklyEvalAsOf(catchUpAt),
      updated_at: catchUpAt,
    });
    const catchUpPlanLog = vi.fn();
    const catchUpPlan = await runJobsTick({
      env: ENV,
      argv: ["--dry-run"],
      now: () => catchUpAt,
      log: catchUpPlanLog,
    });
    expect(catchUpPlan.exitCode).toBe(0);
    const catchUpPlanEntry = catchUpPlanLog.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "jobs_tick_plan");
    expect(catchUpPlanEntry?.tasks).toEqual(expect.arrayContaining([
      { task: SyncJobType.WeeklyLevelEval, action: "skip", reason: "interval_not_due" },
      {
        task: SyncJobType.BoardSnapshotSeasonFinal,
        action: "run",
        reason: "due",
        due_level_season_ids: ["2024_2025"],
      },
    ]));
    const catchUpLog = vi.fn();
    const catchUp = await runJobsTick({ env: ENV, argv: [], now: () => catchUpAt, log: catchUpLog });
    expect(catchUp.exitCode).toBe(0);
    const catchUpSummary = catchUpLog.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "timer_summary");
    expect(catchUpSummary?.ran).toEqual(expect.arrayContaining([SyncJobType.BoardSnapshotSeasonFinal]));
    expect(await snapshots!.findFinalBySeason("2024_2025")).toEqual([
      expect.objectContaining({
        is_final: true,
        level_season_id: "2024_2025",
        user_id: missedUser.user_id,
        season_points: 24,
        snapshot_at: new Date("2025-07-07T02:00:00.000Z"),
      }),
    ]);
    expect(await snapshots!.findFinalBySeason("2025_2026")).toEqual([
      expect.objectContaining({ is_final: true, season_points: 48 }),
    ]);
  });
 });
