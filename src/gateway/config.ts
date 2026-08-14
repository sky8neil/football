import {
  ENVIRONMENT_NAMES,
  type EnvironmentName,
} from "../infrastructure/environment-config.js";

export const LOCAL_PUBLIC_SOURCE = "local_v0" as const;

export interface GatewayRuntimeConfig {
  environment: EnvironmentName;
  mock_trusted_openid: string | null;
  match_cursor_secret: string;
  public_source: typeof LOCAL_PUBLIC_SOURCE;
}

function isEnvironmentName(value: unknown): value is EnvironmentName {
  return typeof value === "string" &&
    (ENVIRONMENT_NAMES as readonly string[]).includes(value);
}

/**
 * 从调用方传入的 env 映射读取规划级键。不读真实环境文件，
 * 也不解析 FOOTBALL_CLOUD_ENVIRONMENT_ID / FOOTBALL_RESOURCE_NAMESPACE。
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
  };
}
