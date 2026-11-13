import {
  ENVIRONMENT_NAMES,
  type EnvironmentName,
} from "../infrastructure/environment-config.js";
import {
  loadCloudBaseRepositoryConfig,
  type CloudBaseRepositoryConfig,
} from "../infrastructure/cloudbase-db.js";

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

function loadPostgresRepositoryConfig(
  env: Record<string, string | undefined>,
): PostgresRepositoryConfig {
  return {
    database_url: requiredTrimmed(env, "FOOTBALL_DATABASE_URL", "FOOTBALL_DATABASE_URL is required"),
    database_schema: requiredTrimmed(
      env,
      "FOOTBALL_DATABASE_SCHEMA",
      "FOOTBALL_DATABASE_SCHEMA is required",
    ),
    resource_namespace: requiredTrimmed(
      env,
      "FOOTBALL_RESOURCE_NAMESPACE",
      "FOOTBALL_RESOURCE_NAMESPACE is required",
    ),
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

  const cloudbaseRepository = repositoryBackend === "cloudbase"
    ? loadCloudBaseRepositoryConfig(env)
    : null;
  const postgresRepository = repositoryBackend === "postgres"
    ? loadPostgresRepositoryConfig(env)
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

  return {
    environment: rawEnvironment,
    mock_trusted_openid: mockTrustedOpenid,
    match_cursor_secret: rawSecret,
    public_source: LOCAL_PUBLIC_SOURCE,
    repository_backend: repositoryBackend,
    cloudbase_repository: cloudbaseRepository,
    postgres_repository: postgresRepository,
    vps_auth: vpsAuth,
  };
}
