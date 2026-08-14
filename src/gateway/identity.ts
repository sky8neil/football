import type { GatewayRuntimeConfig } from "./config.js";

/** 只从进程配置解析可信 openid；永不读 header/query/body。 */
export function resolveTrustedOpenid(config: GatewayRuntimeConfig): string | null {
  if (config.environment === "prod") {
    return null;
  }
  const value = config.mock_trusted_openid;
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
