import { MatchQueryService } from "../application/match-query.js";
import { LeagueStatusService } from "../application/league-status-service.js";
import { LeagueSeasonMaintenanceService } from "../application/league-season-maintenance.js";
import { MaintenanceCleanupService } from "../application/maintenance-cleanup.js";
import { SessionService } from "../application/session.js";
import { BoardSnapshotService } from "../application/board-snapshot.js";
import { DailyConsistencyService } from "../application/daily-consistency-service.js";
import { RepositoryDailyConsistencySnapshotSource } from "../application/daily-consistency-snapshot.js";
import { LevelCorrectionReevalService } from "../application/level-correction-reeval.js";
import { PeriodFinalizeService } from "../application/period-finalize-service.js";
import { RebuildUserStatsService } from "../application/stats-rebuild-service.js";
import { WeeklyLevelEvalService } from "../application/weekly-level-eval.js";
import { ProviderFutureScheduleService } from "../application/provider-sync-service.js";
import { ProviderFullScheduleVerifyService } from "../application/provider-full-schedule.js";
import { ProviderNearMatchService } from "../application/provider-near-match.js";
import { ProviderLiveMatchService } from "../application/provider-live-match.js";
import { ProviderPostFinishVerifyService } from "../application/provider-post-finish.js";
import { ProviderReconcileService } from "../application/provider-reconcile.js";
import { ProviderStaleRecoveryService } from "../application/provider-stale-recovery.js";
import { ProviderSyncDispatcher } from "../application/provider-sync-dispatcher.js";
import type { SettlementTimerOptions } from "../application/settlement-timer.js";
import { SUPPORTED_LEAGUES } from "../domain/config.js";
import { SyncJobType } from "../domain/enums.js";
import { parseLevelFirstEvalAsOf } from "../gateway/config.js";
import type { CloudBaseDb } from "../infrastructure/cloudbase-db.js";
import type { AuthSessionStore } from "../infrastructure/postgres-auth-sessions.js";
import { CloudBaseProviderUsageStore } from "../infrastructure/cloudbase-provider-usage.js";
import { CloudBaseProviderKeyStateStore } from "../infrastructure/cloudbase-provider-key-state.js";
import { CloudBaseProviderLeagueStateStore } from "../infrastructure/cloudbase-provider-league-state.js";
import { CloudBaseSchedulerStateStore, type SchedulerStateStore } from "../infrastructure/cloudbase-scheduler-state.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { ProviderBudget } from "../provider/budget.js";
import { ProviderRegistry } from "../provider/registry.js";
import { loadProviderSources, type ProviderSourcesConfig } from "../provider/sources.js";
import { providerJobIntervalMs } from "../sync/config.js";

export interface ApplicationRuntimeInput {
  env: Record<string, string | undefined>;
  db: CloudBaseDb;
  namespace: string;
  repo: AppRepository;
  matchCursorSecret: string;
  authSessions?: AuthSessionStore;
  log?: (entry: Record<string, unknown>) => void;
}

export interface ApplicationRuntime {
  db: CloudBaseDb;
  namespace: string;
  repo: AppRepository;
  log: (entry: Record<string, unknown>) => void;
  providerSources: ProviderSourcesConfig;
  providerBudget: ProviderBudget;
  providerRegistry: ProviderRegistry;
  providerDispatcher: ProviderSyncDispatcher;
  providerReconcile: ProviderReconcileService;
  leagueSeasons: LeagueSeasonMaintenanceService;
  providerStaleRecovery: ProviderStaleRecoveryService;
  schedulerState: SchedulerStateStore;
  levelFirstEvalAsOf: Date | null;
  periodFinalize: PeriodFinalizeService;
  dailyConsistency: DailyConsistencyService;
  weeklyLevelEval: WeeklyLevelEvalService;
  levelCorrectionReeval: LevelCorrectionReevalService;
  statsRebuild: RebuildUserStatsService;
  boardSnapshot: BoardSnapshotService;
  maintenanceCleanup?: MaintenanceCleanupService;
  settlementTimerOptions: SettlementTimerOptions;
  services: {
    session: SessionService;
    matches: MatchQueryService;
    league_status?: LeagueStatusService;
  };
}

export function createApplicationRuntime(input: ApplicationRuntimeInput): ApplicationRuntime {
  const logger = input.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const providerSources = loadProviderSources(input.env);
  const providerLeagueRefs = providerSources.league_refs;
  const configuredProviderLeagues = new Set(
    providerSources.sources.flatMap((source) => source.leagues.map((league) => league.league_id)),
  );
  for (const league of SUPPORTED_LEAGUES) {
    if (configuredProviderLeagues.has(league.league_id)) continue;
    logger({
      event: "provider_league_unconfigured",
      diag_code: "DIAG_PROVIDER_LEAGUE_UNCONFIGURED",
      league_id: league.league_id,
    });
  }
  const providerBudget = new ProviderBudget(
    providerSources.sources,
    new CloudBaseProviderUsageStore(input.db, input.namespace),
    logger,
  );
  const providerRegistry = new ProviderRegistry({
    config: providerSources,
    budget: providerBudget,
    keyStateStore: new CloudBaseProviderKeyStateStore(input.db, input.namespace),
    leagueStateStore: new CloudBaseProviderLeagueStateStore(input.db, input.namespace),
    minimumGapMs: Number(input.env.FOOTBALL_PROVIDER_MIN_GAP_SECONDS ?? "3") * 1000,
    log: logger,
  });
  const schedulerState = new CloudBaseSchedulerStateStore(input.db, input.namespace);
  const providerClient = providerRegistry.asClient();
  const profile = providerSources.sync_profile;
  const providerDispatcher = new ProviderSyncDispatcher({
    [SyncJobType.FutureSchedule]: (now, leagueId) => new ProviderFutureScheduleService(input.repo, providerClient, {}, {
      dueIntervalMs: providerJobIntervalMs(SyncJobType.FutureSchedule, profile),
    }, providerLeagueRefs).run(now, leagueId),
    [SyncJobType.FullScheduleVerify]: (now, leagueId) => new ProviderFullScheduleVerifyService(input.repo, providerClient, {}, {
      dueIntervalMs: providerJobIntervalMs(SyncJobType.FullScheduleVerify, profile),
    }, providerLeagueRefs).run(now, leagueId),
    [SyncJobType.NearMatch]: (now) => new ProviderNearMatchService(input.repo, providerClient, {}, {
      dueIntervalMs: providerJobIntervalMs(SyncJobType.NearMatch, profile),
    }, providerLeagueRefs).run(now),
    [SyncJobType.LiveMatch]: (now) => new ProviderLiveMatchService(input.repo, providerClient, {}, {
      dueIntervalMs: providerJobIntervalMs(SyncJobType.LiveMatch, profile),
    }, providerLeagueRefs).run(now),
    [SyncJobType.PostFinishVerify]: (now) => new ProviderPostFinishVerifyService(input.repo, providerClient, {}, {
      dueIntervalMs: providerJobIntervalMs(SyncJobType.PostFinishVerify, profile),
    }, providerLeagueRefs, schedulerState).run(now),
  });
  const providerReconcile = new ProviderReconcileService(input.repo, providerClient, providerLeagueRefs);
  const providerStaleRecovery = new ProviderStaleRecoveryService(input.repo, providerClient, {}, {
    dueIntervalMs: providerJobIntervalMs(SyncJobType.StaleRecovery, profile),
  }, providerLeagueRefs, logger);
  const levelFirstEvalAsOf = parseLevelFirstEvalAsOf(input.env, input.env.FOOTBALL_ENVIRONMENT);
  const periodFinalize = new PeriodFinalizeService(input.repo);
  const dailyConsistency = new DailyConsistencyService(
    input.repo,
    new RepositoryDailyConsistencySnapshotSource(input.repo, levelFirstEvalAsOf),
    levelFirstEvalAsOf,
  );
  const weeklyLevelEval = new WeeklyLevelEvalService(input.repo, levelFirstEvalAsOf, logger);
  const levelCorrectionReeval = new LevelCorrectionReevalService(input.repo, levelFirstEvalAsOf);
  const statsRebuild = new RebuildUserStatsService(input.repo, levelFirstEvalAsOf);
  const boardSnapshot = new BoardSnapshotService(input.repo);
  const maintenanceCleanup = new MaintenanceCleanupService({
    db: input.db,
    namespace: input.namespace,
    ...(input.authSessions === undefined ? {} : { authSessions: input.authSessions }),
    log: logger,
  });
  return {
    db: input.db,
    namespace: input.namespace,
    repo: input.repo,
    log: logger,
    providerSources,
    providerBudget,
    providerRegistry,
    providerDispatcher,
    providerReconcile,
    leagueSeasons: new LeagueSeasonMaintenanceService(input.repo, logger),
    providerStaleRecovery,
    schedulerState,
    levelFirstEvalAsOf,
    periodFinalize,
    dailyConsistency,
    weeklyLevelEval,
    levelCorrectionReeval,
    statsRebuild,
    boardSnapshot,
    maintenanceCleanup,
    settlementTimerOptions: { env: input.env, schedulerState, levelFirstEvalAsOf },
    services: {
      session: new SessionService(input.repo),
      matches: new MatchQueryService(input.repo, input.matchCursorSecret),
      league_status: new LeagueStatusService(input.repo),
    },
  };
}
