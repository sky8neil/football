import { RANKING_FIRST_PERIOD_KEY } from "../domain/config.js";
import { PeriodType } from "../domain/enums.js";
import { isExistingUtcCalendarDate, isMondayLevelEvalAt, isValidPeriodKey } from "../domain/time.js";
import {
  ENVIRONMENT_NAMES,
  type EnvironmentName,
} from "../infrastructure/environment-config.js";
import {
  loadCloudBaseRepositoryConfig,
  type CloudBaseRepositoryConfig,
} from "../infrastructure/cloudbase-db.js";
import { resolveDeployTarget, type DeployTarget } from "../sync/deploy-target.js";

export const LOCAL_PUBLIC_SOURCE = "local_v0" as const;

export interface PostgresRepositoryConfig {
  database_url: string;
  database_schema: string;
  resource_namespace: string;
}

export interface VpsAuthConfig {
  wechat_app_id: string;
  wechat_app_secret: string;
  session_ttl_seconds: number;
}

export interface GatewayRuntimeConfig {
  environment: EnvironmentName;
  mock_trusted_openid: string | null;
  match_cursor_secret: string;
  public_source: typeof LOCAL_PUBLIC_SOURCE;
  repository_backend: "memory" | "cloudbase" | "postgres";
  cloudbase_repository: CloudBaseRepositoryConfig | null;
  postgres_repository: PostgresRepositoryConfig | null;
  vps_auth: VpsAuthConfig | null;
  /** 部署目标：决定调度器 tick 粒度（vps 3 分钟 / cloudbase 15 分钟）。 */
  deploy_target: DeployTarget;
  /** 等级首评时间轴（周一 10:00 Asia/Shanghai / 02:00:00.000Z）；prod 必填，非 prod 可为空。 */
  level_first_eval_as_of?: Date | null;
  /** 周榜可选周的最早一周（ISO 周编号）；prod 必填，非 prod 可回落 RANKING_FIRST_PERIOD_KEY。 */
  ranking_first_period_key: string;
  /** 可选：Web 管理端签发登录令牌的独立密钥；未配置时回落 match_cursor_secret。 */
  admin_login_secret?: string | null;
  /** 可选：Web 管理端独立口令；未配置时仅允许签名登录令牌登录。 */
  admin_web_passcode?: string | null;
}

const ISO_TIMESTAMP_WITH_TZ_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseLevelFirstEvalAsOf(
  env: Record<string, string | undefined>,
  environment: EnvironmentName | string | undefined = env.FOOTBALL_ENVIRONMENT,
): Date | null {
  const raw = env.FOOTBALL_LEVEL_FIRST_EVAL_AS_OF;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length === 0) {
    if (environment === "prod") {
      throw new Error(
        "FOOTBALL_LEVEL_FIRST_EVAL_AS_OF is required when FOOTBALL_ENVIRONMENT=prod (must be Monday 10:00:00.000 Asia/Shanghai, e.g. 2026-08-03T02:00:00.000Z)",
      );
    }
    return null;
  }
  if (!ISO_TIMESTAMP_WITH_TZ_PATTERN.test(trimmed)) {
    throw new Error(
      "FOOTBALL_LEVEL_FIRST_EVAL_AS_OF must be a valid ISO 8601 timestamp at Monday 10:00:00.000 Asia/Shanghai (02:00:00.000Z)",
    );
  }
  if (!isExistingUtcCalendarDate(trimmed)) {
    throw new Error(
      "FOOTBALL_LEVEL_FIRST_EVAL_AS_OF must be a valid calendar date at Monday 10:00:00.000 Asia/Shanghai (02:00:00.000Z)",
    );
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime()) || !isMondayLevelEvalAt(parsed)) {
    throw new Error(
      "FOOTBALL_LEVEL_FIRST_EVAL_AS_OF must be Monday 10:00:00.000 Asia/Shanghai (02:00:00.000Z)",
    );
  }
  return parsed;
}

export function parseRankingFirstPeriodKey(
  env: Record<string, string | undefined>,
  environment: EnvironmentName | string | undefined = env.FOOTBALL_ENVIRONMENT,
): string {
  const raw = env.FOOTBALL_RANKING_FIRST_PERIOD_KEY;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length === 0) {
    if (environment === "prod") {
      throw new Error(
        "FOOTBALL_RANKING_FIRST_PERIOD_KEY is required when FOOTBALL_ENVIRONMENT=prod (必须是 ISO 周编号，如 2026-W47)",
      );
    }
    return RANKING_FIRST_PERIOD_KEY;
  }
  if (!isValidPeriodKey(PeriodType.Week, trimmed)) {
    throw new Error(
      "FOOTBALL_RANKING_FIRST_PERIOD_KEY must be a valid ISO week number (必须是 ISO 周编号，如 2026-W47)",
    );
  }
  return trimmed;
}

function isEnvironmentName(value: unknown): value is EnvironmentName {
  return typeof value === "string" &&
    (ENVIRONMENT_NAMES as readonly string[]).includes(value);
}

function requiredTrimmed(
  env: Record<string, string | undefined>,
  key: string,
  message: string,
): string {
  const value = env[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }
  return value.trim();
}

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function assertSqlIdentifier(value: string, key: string): void {
  if (!SQL_IDENTIFIER.test(value)) {
    throw new Error(`${key} must be a valid SQL identifier`);
  }
}

function assertPostgresDatabaseUrl(databaseUrl: string): void {
  let protocol = "";
  try {
    protocol = new URL(databaseUrl).protocol;
  } catch {
    throw new Error("FOOTBALL_DATABASE_URL must use the postgres or postgresql protocol");
  }
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error("FOOTBALL_DATABASE_URL must use the postgres or postgresql protocol");
  }
}

function assertNoEnvironmentMarker(
  value: string,
  key: string,
  marker: "dev" | "test" | "prod",
  environment: EnvironmentName,
): void {
  if (value.toLowerCase().includes(marker)) {
    throw new Error(
      `${key} must not contain ${marker} when FOOTBALL_ENVIRONMENT=${environment}`,
    );
  }
}

function assertPostgresEnvironmentIsolation(
  environment: EnvironmentName,
  databaseSchema: string,
  resourceNamespace: string,
): void {
  const fields: Array<[string, string]> = [
    ["FOOTBALL_DATABASE_SCHEMA", databaseSchema],
    ["FOOTBALL_RESOURCE_NAMESPACE", resourceNamespace],
  ];
  const forbiddenByEnv: Record<EnvironmentName, ReadonlyArray<"dev" | "test" | "prod">> = {
    prod: ["dev", "test"],
    dev: ["test", "prod"],
    test: ["dev", "prod"],
  };
  for (const [key, value] of fields) {
    for (const marker of forbiddenByEnv[environment]) {
      assertNoEnvironmentMarker(value, key, marker, environment);
    }
  }
}

function loadPostgresRepositoryConfig(
  env: Record<string, string | undefined>,
  environment: EnvironmentName,
): PostgresRepositoryConfig {
  const databaseUrl = requiredTrimmed(
    env,
    "FOOTBALL_DATABASE_URL",
    "FOOTBALL_DATABASE_URL is required",
  );
  const databaseSchema = requiredTrimmed(
    env,
    "FOOTBALL_DATABASE_SCHEMA",
    "FOOTBALL_DATABASE_SCHEMA is required",
  );
  const resourceNamespace = requiredTrimmed(
    env,
    "FOOTBALL_RESOURCE_NAMESPACE",
    "FOOTBALL_RESOURCE_NAMESPACE is required",
  );
  assertPostgresDatabaseUrl(databaseUrl);
  assertSqlIdentifier(databaseSchema, "FOOTBALL_DATABASE_SCHEMA");
  assertSqlIdentifier(resourceNamespace, "FOOTBALL_RESOURCE_NAMESPACE");
  assertPostgresEnvironmentIsolation(environment, databaseSchema, resourceNamespace);
  return {
    database_url: databaseUrl,
    database_schema: databaseSchema,
    resource_namespace: resourceNamespace,
  };
}

function loadVpsAuthConfig(env: Record<string, string | undefined>): VpsAuthConfig {
  const rawTtl = env.FOOTBALL_SESSION_TTL_SECONDS;
  const sessionTtlSeconds = Number(rawTtl);
  if (!Number.isInteger(sessionTtlSeconds) || sessionTtlSeconds <= 0) {
    throw new Error("FOOTBALL_SESSION_TTL_SECONDS must be a positive integer");
  }
  return {
    wechat_app_id: requiredTrimmed(env, "FOOTBALL_WECHAT_APP_ID", "FOOTBALL_WECHAT_APP_ID is required"),
    wechat_app_secret: requiredTrimmed(
      env,
      "FOOTBALL_WECHAT_APP_SECRET",
      "FOOTBALL_WECHAT_APP_SECRET is required",
    ),
    session_ttl_seconds: sessionTtlSeconds,
  };
}

/**
 * 从调用方传入的 env 映射读取规划级键。不读真实环境文件。
 * cloudbase 只解析 CloudBase 专属键；postgres 只解析自建库与 VPS 登录键。
 */
export function loadGatewayRuntimeConfig(
  env: Record<string, string | undefined>,
): GatewayRuntimeConfig {
  const rawEnvironment = env.FOOTBALL_ENVIRONMENT;
  if (!isEnvironmentName(rawEnvironment)) {
    throw new Error("FOOTBALL_ENVIRONMENT must be one of: dev, test, prod");
  }

  const rawSecret = env.FOOTBALL_MATCH_CURSOR_SECRET;
  if (typeof rawSecret !== "string" || rawSecret.trim().length === 0) {
    throw new Error("FOOTBALL_MATCH_CURSOR_SECRET is required");
  }

  const repositoryBackend = env.FOOTBALL_REPOSITORY_BACKEND;
  if (
    repositoryBackend !== "memory" &&
    repositoryBackend !== "cloudbase" &&
    repositoryBackend !== "postgres"
  ) {
    throw new Error("FOOTBALL_REPOSITORY_BACKEND must be memory, cloudbase, or postgres");
  }
  if (rawEnvironment === "prod" && repositoryBackend === "memory") {
    throw new Error(
      "FOOTBALL_REPOSITORY_BACKEND=memory is not allowed when FOOTBALL_ENVIRONMENT=prod",
    );
  }

  const cloudbaseRepository = repositoryBackend === "cloudbase"
    ? loadCloudBaseRepositoryConfig(env)
    : null;
  const postgresRepository = repositoryBackend === "postgres"
    ? loadPostgresRepositoryConfig(env, rawEnvironment)
    : null;
  const vpsAuth = repositoryBackend === "postgres" ? loadVpsAuthConfig(env) : null;

  let mockTrustedOpenid: string | null = null;
  if (rawEnvironment === "dev" || rawEnvironment === "test") {
    const rawMock = env.FOOTBALL_MOCK_TRUSTED_OPENID;
    if (typeof rawMock === "string") {
      const trimmed = rawMock.trim();
      mockTrustedOpenid = trimmed.length > 0 ? trimmed : null;
    }
  }

  const levelFirstEvalAsOf = parseLevelFirstEvalAsOf(env, rawEnvironment);
  const rankingFirstPeriodKey = parseRankingFirstPeriodKey(env, rawEnvironment);
  const rawAdminLoginSecret = env.FOOTBALL_ADMIN_LOGIN_SECRET?.trim();
  const adminLoginSecret = rawAdminLoginSecret && rawAdminLoginSecret.length > 0
    ? rawAdminLoginSecret
    : null;
  const rawAdminWebPasscode = env.FOOTBALL_ADMIN_WEB_PASSCODE?.trim();
  let adminWebPasscode: string | null = null;
  if (rawAdminWebPasscode && rawAdminWebPasscode.length > 0) {
    if (rawEnvironment === "prod" && rawAdminWebPasscode.length < 12) {
      throw new Error(
        "FOOTBALL_ADMIN_WEB_PASSCODE must be at least 12 characters when FOOTBALL_ENVIRONMENT=prod",
      );
    }
    adminWebPasscode = rawAdminWebPasscode;
  }

  return {
    environment: rawEnvironment,
    mock_trusted_openid: mockTrustedOpenid,
    match_cursor_secret: rawSecret,
    public_source: LOCAL_PUBLIC_SOURCE,
    repository_backend: repositoryBackend,
    cloudbase_repository: cloudbaseRepository,
    postgres_repository: postgresRepository,
    vps_auth: vpsAuth,
    deploy_target: resolveDeployTarget(env),
    level_first_eval_as_of: levelFirstEvalAsOf,
    ranking_first_period_key: rankingFirstPeriodKey,
    ...(adminLoginSecret !== null ? { admin_login_secret: adminLoginSecret } : {}),
    ...(adminWebPasscode !== null ? { admin_web_passcode: adminWebPasscode } : {}),
  };
}
