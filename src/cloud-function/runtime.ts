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
      return { result: await runDiagnostics({ options, namespace, context }) };
    }
    return handler(event, context);
  };
}

async function runDiagnostics(input: {
  options: CloudFunctionRuntimeOptions;
  namespace: string;
  context: CloudFunctionContextLike & { ENV?: string };
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
        indexes,
      },
      request_id: makeRequestId(),
    },
  };
}
