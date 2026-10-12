import { InMemoryRepository } from "../infrastructure/repositories.js";
import { COLLECTION_DEFINITIONS } from "../schema/collections.js";
import { createGatewayRepository } from "../gateway/repository-factory.js";
import { loadGatewayRuntimeConfig } from "../gateway/config.js";
import { MatchQueryService } from "../application/match-query.js";
import { SessionService } from "../application/session.js";
import { SharedRateLimiter } from "../api/v1/rate-limit-store.js";
import { CloudBaseRateLimitStore, loadCloudBaseRateLimitStoreConfig } from "../api/v1/cloudbase-rate-limit-store.js";
import { CloudBaseWxRateLimitDatabase } from "../infrastructure/cloudbase-wx-rate-limit.js";
import { createCloudBaseWxDb, type CloudBaseSdkDatabase } from "../infrastructure/cloudbase-wx-db.js";
import { handleGatewayRequest } from "../gateway/assemble.js";
import { makeRequestId } from "../api/v1/validation.js";
import { classifyCloudError, missingCloudEnvironmentKeys } from "../infrastructure/cloud-diagnostics.js";
import { cloudBaseCollectionName } from "../infrastructure/cloudbase-db.js";
import { CloudBaseProviderUsageStore } from "../infrastructure/cloudbase-provider-usage.js";
import { CloudBaseProviderKeyStateStore } from "../infrastructure/cloudbase-provider-key-state.js";
import { CloudBaseProviderLeagueStateStore } from "../infrastructure/cloudbase-provider-league-state.js";
import { ProviderBudget } from "../provider/budget.js";
import { ProviderRegistry } from "../provider/registry.js";
import { loadProviderSources, type ProviderSourceId } from "../provider/sources.js";
import { ProviderFutureScheduleService } from "../application/provider-sync-service.js";
import { ProviderFullScheduleVerifyService } from "../application/provider-full-schedule.js";
import { ProviderNearMatchService } from "../application/provider-near-match.js";
import { ProviderLiveMatchService } from "../application/provider-live-match.js";
import { ProviderPostFinishVerifyService } from "../application/provider-post-finish.js";
import { ProviderReconcileService } from "../application/provider-reconcile.js";
import { ProviderSyncDispatcher, type ProviderSyncJobType } from "../application/provider-sync-dispatcher.js";
import { SyncJobType } from "../domain/enums.js";
import { SUPPORTED_LEAGUES } from "../domain/config.js";
import { activeWindow } from "../application/provider-active-window.js";
import type { Match } from "../domain/types.js";
import { createCloudFunctionHandler, type CloudFunctionContextLike, type CloudFunctionEvent } from "./index.js";

export interface CloudFunctionRuntimeOptions {
  env: Record<string, string | undefined>;
  db: CloudBaseSdkDatabase;
  sdkVersion: string;
  nodeVersion: string;
  buildTime?: string;
  log?: (entry: Record<string, unknown>) => void;
}

function requireCloudRuntimeConfig(env: Record<string, string | undefined>) {
  const missing = missingCloudEnvironmentKeys(env);
  if (missing.length) throw new Error(`Required environment configuration missing: ${missing.join(", ")}`);
  if (env.FOOTBALL_ENVIRONMENT === "prod" && env.FOOTBALL_MOCK_TRUSTED_OPENID?.trim()) {
    throw new Error("prod environment cannot configure mock identity");
  }
  const config = loadGatewayRuntimeConfig(env);
  if (config.repository_backend !== "cloudbase" || !config.cloudbase_repository) {
    throw new Error("CloudBase runtime requires FOOTBALL_REPOSITORY_BACKEND=cloudbase");
  }
  return config;
}

export function createCloudFunctionRuntime(options: CloudFunctionRuntimeOptions) {
  const { env, db } = options;
  const logger = options.log ?? ((entry) => console.log(JSON.stringify(entry)));
  let config;
  try {
    config = requireCloudRuntimeConfig(env);
  } catch (error) {
    const diagnostic = classifyCloudError(error);
    logger({
      event: "startup_error",
      diag_code: diagnostic.diag_code,
      layer: diagnostic.layer,
      hint: diagnostic.hint,
      sdk_code: diagnostic.sdk_code,
      missing_environment_keys: missingCloudEnvironmentKeys(env),
    });
    throw error;
  }
  const namespace = config.cloudbase_repository!.resource_namespace;
  const cloudDb = createCloudBaseWxDb(db, namespace);
  const repo = createGatewayRepository(config, cloudDb);
  if (repo instanceof InMemoryRepository) throw new Error("CloudBase runtime cannot use the memory repository");
  let providerSources: ReturnType<typeof loadProviderSources>;
  try {
    providerSources = loadProviderSources(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const missingKey = /^DIAG_PROVIDER_KEY_MISSING source_id=([a-z]+) variable=([A-Z0-9_]+)$/.exec(message);
    if (missingKey !== null) {
      logger({
        event: "startup_error",
        diag_code: "DIAG_PROVIDER_KEY_MISSING",
        source_id: missingKey[1],
        variable: missingKey[2],
      });
    }
    throw error;
  }
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
    new CloudBaseProviderUsageStore(cloudDb, namespace),
    logger,
  );
  const providerRegistry = new ProviderRegistry({
    config: providerSources,
    budget: providerBudget,
    keyStateStore: new CloudBaseProviderKeyStateStore(cloudDb, namespace),
    leagueStateStore: new CloudBaseProviderLeagueStateStore(cloudDb, namespace),
    minimumGapMs: Number(env.FOOTBALL_PROVIDER_MIN_GAP_SECONDS ?? "3") * 1000,
    log: logger,
  });
  const providerClient = providerRegistry.asClient();
  const providerDispatcher = new ProviderSyncDispatcher({
    [SyncJobType.FutureSchedule]: (now, leagueId) => new ProviderFutureScheduleService(repo, providerClient).run(now, leagueId),
    [SyncJobType.FullScheduleVerify]: (now, leagueId) => new ProviderFullScheduleVerifyService(repo, providerClient).run(now, leagueId),
    [SyncJobType.NearMatch]: (now) => new ProviderNearMatchService(repo, providerClient).run(now),
    [SyncJobType.LiveMatch]: (now) => new ProviderLiveMatchService(repo, providerClient).run(now),
    [SyncJobType.PostFinishVerify]: (now) => new ProviderPostFinishVerifyService(repo, providerClient).run(now),
  });
  const providerReconcile = new ProviderReconcileService(repo, providerClient);
  const services = {
    session: new SessionService(repo),
    matches: new MatchQueryService(repo, config.match_cursor_secret),
  };
  const limiterConfig = loadCloudBaseRateLimitStoreConfig(env);
  const rateLimiter = new SharedRateLimiter(new CloudBaseRateLimitStore(
    limiterConfig,
    new CloudBaseWxRateLimitDatabase(db, namespace),
  ));
  const requiredEnvironmentKeys = [
    "FOOTBALL_ENVIRONMENT", "FOOTBALL_MATCH_CURSOR_SECRET", "FOOTBALL_REPOSITORY_BACKEND",
    "FOOTBALL_CLOUD_ENVIRONMENT_ID", "FOOTBALL_RESOURCE_NAMESPACE",
  ];
  logger({
    event: "startup",
    environment: config.environment,
    cloud_environment_id: config.cloudbase_repository!.cloud_environment_id,
    resource_namespace: namespace,
    repository_backend: config.repository_backend,
    environment_keys: Object.fromEntries(requiredEnvironmentKeys.map((key) => [key, Boolean(env[key]?.trim())])),
    provider_sources: providerSources.sources.map((source) => ({
      source_id: source.source_id,
      key_configured: Boolean(source.api_key),
      key_count: source.api_keys.length,
      base_url_host: new URL(source.base_url).host,
    })),
    wx_server_sdk_version: options.sdkVersion,
    node_version: options.nodeVersion,
  });

  const handler = createCloudFunctionHandler({
    assemble: handleGatewayRequest,
    config,
    services,
    repo,
    rate_limiter: rateLimiter,
    log: (entry) => logger({ event: "request", ...entry }),
    classifyError: classifyCloudError,
  });

  return async (event: CloudFunctionEvent, context: CloudFunctionContextLike & { ENV?: string }) => {
    if (event.action === "diag") {
      if (config.environment === "prod") return { result: { status: 404, body: { code: "NOT_FOUND", request_id: makeRequestId() } } };
      return { result: await runDiagnostics({ options, namespace, context, providerSources, providerBudget, providerRegistry, repo }) };
    }
    if (event.action === "sync") {
      if (config.environment === "prod") return { result: { status: 404, body: { code: "NOT_FOUND", request_id: makeRequestId() } } };
      if (!isProviderSyncJobType(event.job)) {
        return { result: { status: 400, body: { code: "VALIDATION_ERROR", request_id: makeRequestId() } } };
      }
      const leagueScopedJob = event.job === SyncJobType.FutureSchedule || event.job === SyncJobType.FullScheduleVerify;
      if (event.league !== undefined && (!leagueScopedJob || !SUPPORTED_LEAGUES.some((league) => league.league_id === event.league))) {
        return { result: { status: 400, body: { code: "VALIDATION_ERROR", request_id: makeRequestId() } } };
      }
      const serverNow = new Date();
      const scheduledLeague = leagueScopedJob && event.league === undefined
        ? (await providerRegistry.orderLeagues([...providerSources.sync_leagues], event.job, serverNow))[0]
        : event.league;
      if (leagueScopedJob && scheduledLeague === undefined) {
        return { result: { status: 200, body: { data: { kind: "skipped", reason: "no_configured_leagues" }, request_id: makeRequestId() } } };
      }
      const data = await providerDispatcher.run(event.job, serverNow, scheduledLeague);
      return { result: { status: 200, body: { data, request_id: makeRequestId() } } };
    }
    if (event.Type === "Timer") {
      const data = await runDueProviderJobs({
        cloudDb,
        dispatcher: providerDispatcher,
        providerRegistry,
        syncLeagueIds: [...providerSources.sync_leagues],
        sourceIds: providerSources.sources.map((source) => source.source_id),
        profile: providerSources.sync_profile,
        reconcile: providerReconcile,
        serverNow: new Date(),
        log: logger,
      });
      return { result: { status: 200, body: { data, request_id: makeRequestId() } } };
    }
    return handler(event, context);
  };
}

function isProviderSyncJobType(value: unknown): value is ProviderSyncJobType {
  return value === SyncJobType.FutureSchedule ||
    value === SyncJobType.FullScheduleVerify ||
    value === SyncJobType.NearMatch ||
    value === SyncJobType.LiveMatch ||
    value === SyncJobType.PostFinishVerify;
}

function providerJobIntervalMs(
  job: ProviderSyncJobType,
  profile: "test" | "prod",
): number {
  const minute = 60_000;
  const hour = 60 * minute;
  if (job === SyncJobType.FutureSchedule) return (profile === "test" ? 12 : 6) * hour;
  if (job === SyncJobType.FullScheduleVerify) return 24 * hour;
  if (job === SyncJobType.NearMatch) return minute;
  if (job === SyncJobType.PostFinishVerify) return (profile === "test" ? 5 : 3) * minute;
  return minute;
}

async function runDueProviderJobs(input: {
  cloudDb: ReturnType<typeof createCloudBaseWxDb>;
  dispatcher: ProviderSyncDispatcher;
  providerRegistry: ProviderRegistry;
  syncLeagueIds: readonly string[];
  sourceIds: readonly ProviderSourceId[];
  profile: "test" | "prod";
  reconcile: ProviderReconcileService;
  serverNow: Date;
  log: (entry: Record<string, unknown>) => void;
}): Promise<Record<string, unknown>> {
  const jobs: ProviderSyncJobType[] = [
    SyncJobType.PostFinishVerify,
    SyncJobType.LiveMatch,
    SyncJobType.NearMatch,
    SyncJobType.FutureSchedule,
    SyncJobType.FullScheduleVerify,
  ];
  if (input.sourceIds.length === 0) return { outcome: "skipped", reason: "no_provider_sources" };
  const ran: string[] = [];
  for (const jobType of jobs) {
    if (jobType === SyncJobType.FutureSchedule || jobType === SyncJobType.FullScheduleVerify) {
      const dueLeagues = await input.providerRegistry.dueLeagues(
        input.syncLeagueIds,
        jobType,
        input.serverNow,
        providerJobIntervalMs(jobType, input.profile),
      );
      const leagueId = dueLeagues[0];
      if (leagueId === undefined) continue;
      const outcome = await input.dispatcher.run(jobType, input.serverNow, leagueId);
      input.log({ event: "provider_schedule", job_type: jobType, league_id: leagueId, outcome: "started" });
      ran.push(`${jobType}:${leagueId}`);
      void outcome;
      continue;
    }
    const logs = await input.cloudDb.query("sync_logs", { job_type: jobType }, {
      order_by: "started_at",
      direction: "desc",
      limit: 1,
    });
    const lastStartedAt = logs[0]?.started_at;
    const lastStartedMs = lastStartedAt instanceof Date
      ? lastStartedAt.getTime()
      : typeof lastStartedAt === "string" ? Date.parse(lastStartedAt) : Number.NaN;
    const interval = providerJobIntervalMs(jobType, input.profile);
    if (Number.isFinite(lastStartedMs) && input.serverNow.getTime() - lastStartedMs < interval) continue;
    const outcome = await input.dispatcher.run(jobType, input.serverNow);
    input.log({ event: "provider_schedule", job_type: jobType, outcome: "started" });
    ran.push(jobType);
    void outcome;
  }
  const reconcileLogs = await input.cloudDb.query("sync_logs", { job_type: SyncJobType.ProviderReconcile }, {
    order_by: "started_at",
    direction: "desc",
    limit: 1,
  });
  const lastReconcileAt = reconcileLogs[0]?.started_at;
  const lastReconcileMs = lastReconcileAt instanceof Date
    ? lastReconcileAt.getTime()
    : typeof lastReconcileAt === "string" ? Date.parse(lastReconcileAt) : Number.NaN;
  if (!Number.isFinite(lastReconcileMs) || input.serverNow.getTime() - lastReconcileMs >= 24 * 60 * 60_000) {
    const outcome = await input.reconcile.run(input.serverNow);
    if (outcome.kind === "completed") ran.push(SyncJobType.ProviderReconcile);
    input.log({ event: "provider_schedule", job_type: SyncJobType.ProviderReconcile, outcome: outcome.kind });
  }
  return { outcome: "completed", jobs_run: ran };
}

async function runDiagnostics(input: {
  options: CloudFunctionRuntimeOptions;
  namespace: string;
  context: CloudFunctionContextLike & { ENV?: string };
  providerSources: ReturnType<typeof loadProviderSources>;
  providerBudget: ProviderBudget;
  providerRegistry: ProviderRegistry;
  repo: ReturnType<typeof createGatewayRepository>;
}) {
  const { options, namespace, context } = input;
  const { env, db } = options;
  const missing = missingCloudEnvironmentKeys(env);
  const requiredEnvironment = {
    ok: missing.length === 0,
    missing_keys: missing,
    ...(missing.length ? {
      diag_code: "DIAG_FN_ENV_VAR_MISSING",
      hint: "云函数缺少必填环境变量，请按 S17 §17.3 第8步补齐键名",
    } : {}),
  };
  const configuredId = env.FOOTBALL_CLOUD_ENVIRONMENT_ID ?? "";
  const actualId = context.ENV ?? "";
  const environmentMatch = {
    ok: actualId === configuredId,
    configured_id: configuredId,
    runtime_id: actualId || null,
    ...(actualId !== configuredId ? {
      diag_code: "DIAG_ENV_MISMATCH",
      hint: "云函数环境 ID 与 FOOTBALL_CLOUD_ENVIRONMENT_ID 不一致",
    } : {}),
  };
  const namespaceMatch = {
    ok: namespace.endsWith(`_${env.FOOTBALL_ENVIRONMENT}`),
    resource_namespace: namespace,
    environment: env.FOOTBALL_ENVIRONMENT,
    ...(!namespace.endsWith(`_${env.FOOTBALL_ENVIRONMENT}`) ? {
      diag_code: "DIAG_ENV_MISMATCH",
      hint: "资源命名空间后缀应与 FOOTBALL_ENVIRONMENT 一致",
    } : {}),
  };
  const collections: Record<string, { exists: boolean; diag_code?: string; hint?: string }> = {};
  const collectionNames = [
    ...COLLECTION_DEFINITIONS.map((definition) => cloudBaseCollectionName(namespace, definition.collection)),
    cloudBaseCollectionName(namespace, "diag"),
    cloudBaseCollectionName(namespace, "rate_limits"),
    cloudBaseCollectionName(namespace, "provider_key_state"),
  ];
  for (const name of collectionNames) {
    try {
      await db.collection(name).count();
      collections[name] = { exists: true };
    } catch (error) {
      const diagnostic = classifyCloudError(error);
      collections[name] = { exists: false, diag_code: diagnostic.diag_code, hint: diagnostic.hint };
    }
  }
  const probeCollection = `${namespace}_diag`;
  const probeId = `diag_${makeRequestId()}`;
  let readWriteProbe: { ok: boolean; diag_code?: string; hint?: string } = { ok: false };
  try {
    const collection = db.collection(probeCollection);
    await collection.add({ data: { _id: probeId, marker: "cloud-function-diagnostic" } });
    const fetched = await collection.doc(probeId).get();
    if (fetched.data?._id !== probeId) throw new Error("diagnostic probe read mismatch");
    await collection.doc(probeId).remove();
    readWriteProbe = { ok: true };
  } catch (error) {
    const diagnostic = classifyCloudError(error);
    readWriteProbe = { ok: false, diag_code: diagnostic.diag_code, hint: diagnostic.hint };
  }
  let transactionProbe: { ok: boolean; diag_code?: string; hint?: string } = { ok: false };
  const transactionProbeId = `txn_${makeRequestId()}`;
  let transaction;
  try {
    transaction = await db.startTransaction();
    await transaction.collection(probeCollection).add({ data: { _id: transactionProbeId, marker: "cloud-function-transaction-diagnostic" } });
    await transaction.commit();
    await db.collection(probeCollection).doc(transactionProbeId).remove();
    transactionProbe = { ok: true };
  } catch (error) {
    if (transaction) await transaction.rollback().catch(() => undefined);
    const diagnostic = classifyCloudError(error);
    transactionProbe = { ok: false, diag_code: diagnostic.diag_code, hint: diagnostic.hint };
  }
  const indexes = "索引请按 S17 §17.3 第5步人工核对；SDK 不提供可靠的索引存在性检查";
  const ok = requiredEnvironment.ok && environmentMatch.ok && namespaceMatch.ok &&
    Object.values(collections).every((value) => value.exists) && readWriteProbe.ok && transactionProbe.ok;
  return {
    status: ok ? 200 : 503,
    body: {
      data: {
        environment: requiredEnvironment,
        environment_match: environmentMatch,
        namespace_match: namespaceMatch,
        collections,
        read_write_probe: readWriteProbe,
        transaction_probe: transactionProbe,
        identity_available: Boolean(context.OPENID),
        versions: {
          wx_server_sdk: options.sdkVersion,
          node: options.nodeVersion,
          build: options.buildTime ?? process.env.FOOTBALL_BUILD_TIME ?? "unknown",
        },
        provider_sources: await providerDiagnostics(
          input.providerSources.sources,
          input.providerBudget,
          input.providerRegistry,
          input.repo,
        ),
        indexes,
      },
      request_id: makeRequestId(),
    },
  };
}

async function providerDiagnostics(
  sources: ReturnType<typeof loadProviderSources>["sources"],
  budget: ProviderBudget,
  registry: ProviderRegistry,
  repo: ReturnType<typeof createGatewayRepository>,
) {
  const now = new Date();
  const sourceUsage = await budget.usageSnapshot(now);
  const matchesBySeason = new Map<string, Promise<Match[]>>();
  const loadSeason = (seasonId: string) => {
    let result = matchesBySeason.get(seasonId);
    if (!result) {
      result = repo.matches.findBySeason(seasonId);
      matchesBySeason.set(seasonId, result);
    }
    return result;
  };
  return Promise.all(sources.map(async (source) => ({
    source_id: source.source_id,
    key_configured: Boolean(source.api_key),
    key_count: source.api_keys.length,
    ...(source.source_id === "fd" ? { keys: await registry.keyDiagnostics(source.source_id, now) } : {}),
    leagues: await Promise.all((await registry.leagueDiagnostics(source.source_id, [
      SyncJobType.PostFinishVerify,
      SyncJobType.LiveMatch,
      SyncJobType.NearMatch,
      SyncJobType.FutureSchedule,
      SyncJobType.FullScheduleVerify,
    ], now)).map(async (league) => {
      const configuredLeague = SUPPORTED_LEAGUES.find((row) => row.league_id === league.league_id);
      const localMatches = configuredLeague
        ? (await loadSeason(configuredLeague.season_id)).filter((match) => match.league_id === league.league_id)
        : [];
      const activeMatchIds = new Set<string>();
      for (const jobType of [SyncJobType.PostFinishVerify, SyncJobType.LiveMatch, SyncJobType.NearMatch]) {
        for (const match of activeWindow(localMatches, now, jobType)) activeMatchIds.add(match.match_id);
      }
      return { ...league, window_match_count: activeMatchIds.size };
    })),
    base_url_host: new URL(source.base_url).host,
    request_usage: sourceUsage[source.source_id],
    last_request: registry.lastRequest(source.source_id),
    cloudflare_blocked: source.source_id === "sp" && (registry.lastRequest(source.source_id)?.status === 403 || registry.lastRequest(source.source_id)?.provider_code === "1010"),
  })));
}
