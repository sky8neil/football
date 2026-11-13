import { InMemoryRepository } from "../infrastructure/repositories.js";
import { COLLECTION_DEFINITIONS } from "../schema/collections.js";
import { createGatewayRepository } from "../gateway/repository-factory.js";
import { loadGatewayRuntimeConfig } from "../gateway/config.js";
import { SharedRateLimiter } from "../api/v1/rate-limit-store.js";
import { CloudBaseRateLimitStore, loadCloudBaseRateLimitStoreConfig } from "../api/v1/cloudbase-rate-limit-store.js";
import { CloudBaseWxRateLimitDatabase } from "../infrastructure/cloudbase-wx-rate-limit.js";
import { createCloudBaseWxDb, type CloudBaseSdkDatabase } from "../infrastructure/cloudbase-wx-db.js";
import { handleGatewayRequest } from "../gateway/assemble.js";
import { makeRequestId } from "../api/v1/validation.js";
import { classifyCloudError, missingCloudEnvironmentKeys } from "../infrastructure/cloud-diagnostics.js";
import { CLOUDBASE_RUNTIME_COLLECTIONS, cloudBaseCollectionName } from "../infrastructure/cloudbase-db.js";
import { createCountingDb } from "../infrastructure/db-op-counter.js";
import { ProviderBudget } from "../provider/budget.js";
import { ProviderRegistry } from "../provider/registry.js";
import { loadProviderSources, type ProviderSourceId } from "../provider/sources.js";
import { runSettlementTimer } from "../application/settlement-timer.js";
import { activeWindow } from "../application/provider-active-window.js";
import type { Match } from "../domain/types.js";
import { SUPPORTED_LEAGUES } from "../domain/config.js";
import { SyncJobType } from "../domain/enums.js";
import { createCloudFunctionHandler, type CloudFunctionContextLike, type CloudFunctionEvent } from "./index.js";
import { buildTimerSummary } from "./timer-summary.js";
import { createApplicationRuntime } from "../runtime/application-runtime.js";
import {
  isProviderSyncJobType,
  logProviderFixtureFailures,
  providerScheduleSummary,
  runScheduledJobs,
  runDueProviderJobs,
  TIMER_TASK_TYPES,
  UNWIRED_PERIODIC_TASKS,
  WIRED_PERIODIC_TASKS,
} from "../runtime/scheduled-jobs.js";

export { runDueProviderJobs };

export interface CloudFunctionRuntimeOptions {
  env: Record<string, string | undefined>;
  db: CloudBaseSdkDatabase;
  sdkVersion: string;
  nodeVersion: string;
  buildTime?: string;
  log?: (entry: Record<string, unknown>) => void;
  now?: () => Date;
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
  const counted = createCountingDb(createCloudBaseWxDb(db, namespace));
  const cloudDb = counted.db;
  const repo = createGatewayRepository(config, cloudDb);
  if (repo instanceof InMemoryRepository) throw new Error("CloudBase runtime cannot use the memory repository");
  let runtime;
  try {
    runtime = createApplicationRuntime({
      env,
      db: cloudDb,
      namespace,
      repo,
      matchCursorSecret: config.match_cursor_secret,
      log: logger,
    });
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
    provider_sources: runtime.providerSources.sources.map((source) => ({
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
    services: runtime.services,
    repo,
    rate_limiter: rateLimiter,
    log: (entry) => logger({ event: "request", ...entry }),
    classifyError: classifyCloudError,
  });

  return async (event: CloudFunctionEvent, context: CloudFunctionContextLike & { ENV?: string }) => {
    if (event.action === "diag") {
      if (config.environment === "prod") return { result: { status: 404, body: { code: "NOT_FOUND", request_id: makeRequestId() } } };
      return { result: await runDiagnostics({
        options,
        namespace,
        context,
        providerSources: runtime.providerSources,
        providerBudget: runtime.providerBudget,
        providerRegistry: runtime.providerRegistry,
        repo,
      }) };
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
        ? (await runtime.providerRegistry.orderLeagues([...runtime.providerSources.sync_leagues], event.job, serverNow))[0]
        : event.league;
      if (leagueScopedJob && scheduledLeague === undefined) {
        return { result: { status: 200, body: { data: { kind: "skipped", reason: "no_configured_leagues" }, request_id: makeRequestId() } } };
      }
      const sync = await runtime.providerDispatcher.run(event.job, serverNow, scheduledLeague);
      logProviderFixtureFailures(logger, event.job, sync);
      const data = { sync, settlements: await runSettlementTimer(repo, serverNow, runtime.settlementTimerOptions) };
      return { result: { status: 200, body: { data, request_id: makeRequestId() } } };
    }
    if (event.Type === "Timer") {
      counted.counter.begin();
      const startedAt = Date.now();
      const errors: unknown[] = [];
      const serverNow = (options.now ?? (() => new Date()))();
      let providerData: Record<string, unknown> = { outcome: "failed" };
      let settlements: { match_id: string; outcome: unknown }[] = [];
      try {
        const scheduled = await runScheduledJobs({ runtime, serverNow });
        providerData = scheduled.providerData;
        settlements = scheduled.settlements;
        errors.push(...scheduled.errors);
        if (scheduled.errors.length > 0) throw scheduled.errors[0];
        return { result: { status: 200, body: { data: { ...providerData, settlements }, request_id: makeRequestId() } } };
      } catch (error) {
        if (!errors.includes(error)) errors.push(error);
        throw error;
      } finally {
        try {
          const dbOps = counted.counter.end();
          const summary = {
            ...buildTimerSummary({
              taskTypes: TIMER_TASK_TYPES,
              provider: providerScheduleSummary(providerData),
              settlements,
              dbOps,
              durationMs: Date.now() - startedAt,
              errors,
            }),
            wired_periodic_tasks: WIRED_PERIODIC_TASKS,
            unwired_periodic_tasks: UNWIRED_PERIODIC_TASKS,
            fifteen_items_complete: true,
          };
          logger({ event: "timer_summary", ...summary });
        } catch {}
      }
    }
    return handler(event, context);
  };
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
    ...CLOUDBASE_RUNTIME_COLLECTIONS.map((collection) => cloudBaseCollectionName(namespace, collection)),
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
  return Promise.all(sources.map(async (source) => {
    const lastRequest = registry.lastRequest(source.source_id);
    return {
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
      last_request: lastRequest,
      cloudflare_blocked: isSportApiCloudflareBlocked(source.source_id, lastRequest),
    };
  }));
}

export function isSportApiCloudflareBlocked(
  sourceId: ProviderSourceId,
  lastRequest: { status: number; provider_code?: string } | null,
): boolean {
  return sourceId === "sp" && (lastRequest?.status === 403 || lastRequest?.provider_code === "1010");
}
