import { MatchQueryService } from "../application/match-query.js";
import { SessionService } from "../application/session.js";
import { BoardSnapshotService } from "../application/board-snapshot.js";
import { DailyConsistencyService } from "../application/daily-consistency-service.js";
import { RepositoryDailyConsistencySnapshotSource } from "../application/daily-consistency-snapshot.js";
import { PeriodFinalizeService } from "../application/period-finalize-service.js";
import { WeeklyLevelEvalService } from "../application/weekly-level-eval.js";
import { ProviderFutureScheduleService } from "../application/provider-sync-service.js";
import { ProviderFullScheduleVerifyService } from "../application/provider-full-schedule.js";
import { ProviderNearMatchService } from "../application/provider-near-match.js";
import { ProviderLiveMatchService } from "../application/provider-live-match.js";
import { ProviderPostFinishVerifyService } from "../application/provider-post-finish.js";
import { ProviderReconcileService } from "../application/provider-reconcile.js";
import { ProviderSyncDispatcher } from "../application/provider-sync-dispatcher.js";
import type { SettlementTimerOptions } from "../application/settlement-timer.js";
import { SUPPORTED_LEAGUES } from "../domain/config.js";
import { SyncJobType } from "../domain/enums.js";
import type { CloudBaseDb } from "../infrastructure/cloudbase-db.js";
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
  schedulerState: SchedulerStateStore;
  periodFinalize: PeriodFinalizeService;
  dailyConsistency: DailyConsistencyService;
  weeklyLevelEval: WeeklyLevelEvalService;
  boardSnapshot: BoardSnapshotService;
  settlementTimerOptions: SettlementTimerOptions;
  services: {
    session: SessionService;
    matches: MatchQueryService;
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
    }, providerLeagueRefs).run(now),
  });
  const providerReconcile = new ProviderReconcileService(input.repo, providerClient, providerLeagueRefs);
  const schedulerState = new CloudBaseSchedulerStateStore(input.db, input.namespace);
  const periodFinalize = new PeriodFinalizeService(input.repo);
  const dailyConsistency = new DailyConsistencyService(
    input.repo,
    new RepositoryDailyConsistencySnapshotSource(input.repo),
  );
  const weeklyLevelEval = new WeeklyLevelEvalService(input.repo);
  const boardSnapshot = new BoardSnapshotService(input.repo);
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
    schedulerState,
    periodFinalize,
    dailyConsistency,
    weeklyLevelEval,
    boardSnapshot,
    settlementTimerOptions: { env: input.env, schedulerState },
    services: {
      session: new SessionService(input.repo),
      matches: new MatchQueryService(input.repo, input.matchCursorSecret),
    },
  };
}
