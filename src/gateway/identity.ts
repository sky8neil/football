import type { AuthSessionStore } from "../infrastructure/postgres-auth-sessions.js";
import { resolveBearerOpenid } from "./auth.js";
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

export interface ResolveRequestTrustedOpenidInput {
  config: GatewayRuntimeConfig;
  now: Date;
  trusted_openid?: string | null;
  authorization?: unknown;
  sessions?: AuthSessionStore;
}

/**
 * HTTP 信任边界解析可信 openid。
 * 显式 trusted_openid（含 null）保留 CloudBase / 调用方注入；
 * 自建会话存在时校验 Authorization Bearer；否则回退 mock。
 * 永不读 query/body 中的 openid。
 */
export async function resolveRequestTrustedOpenid(
  input: ResolveRequestTrustedOpenidInput,
): Promise<string | null> {
  if (input.trusted_openid !== undefined) {
    return input.trusted_openid;
  }
  if (input.sessions !== undefined) {
    if (typeof input.authorization !== "string" || input.authorization.trim().length === 0) {
      return null;
    }
    return resolveBearerOpenid({
      authorization: input.authorization,
      sessions: input.sessions,
      now: input.now,
    });
  }
  return resolveTrustedOpenid(input.config);
}
