import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AdminAuthorizationService } from "../application/admin.js";
import { conflictError, internalError, validationError } from "../domain/errors.js";
import { isValidUuid, newUuid } from "../domain/ids.js";
import type { AdminRole, AdminStatus } from "../domain/enums.js";
import type { AdminConsumedJtiStore, AuthSessionStore } from "../infrastructure/postgres-auth-sessions.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { assertUnknownFields } from "../api/v1/validation.js";
import { parseBearerToken, SESSION_TOKEN_TYPE } from "./auth.js";
import type { GatewayRuntimeConfig } from "./config.js";

export const ADMIN_WEB_SESSION_TTL_SECONDS = 8 * 60 * 60;
export const ADMIN_LOGIN_TOKEN_DEFAULT_TTL_SECONDS = 300;
export const ADMIN_LOGIN_TOKEN_MAX_TTL_SECONDS = 900;
export const ADMIN_LOGIN_TOKEN_MIN_TTL_SECONDS = 30;
const ADMIN_LOGIN_TOKEN_PREFIX = "adm1";
const MAX_CONSUMED_JTIS = 4096;

const ADMIN_LOGIN_FIELDS = new Set(["login_token", "openid", "passcode"]);

export interface AdminLoginResult {
  access_token: string;
  token_type: typeof SESSION_TOKEN_TYPE;
  expires_at: string;
  admin: {
    admin_id: string;
    role: AdminRole;
    status: AdminStatus;
  };
}

export interface AdminAuthMeResult {
  admin_id: string;
  role: AdminRole;
  status: AdminStatus;
}

interface AdminLoginTokenPayload {
  v: 1;
  typ: "admin_login";
  openid: string;
  iat: number;
  exp: number;
  jti: string;
}

function sha256Buffer(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function constantTimeStringEqual(left: string, right: string): boolean {
  return timingSafeEqual(sha256Buffer(left), sha256Buffer(right));
}

export function issueAdminLoginToken(input: {
  openid: string;
  secret: string;
  now: Date;
  ttlSeconds?: number;
}): { login_token: string; expires_at: Date; ttl_seconds: number } {
  const openid = input.openid.trim();
  if (openid.length === 0) {
    throw validationError("openid 不能为空", { field: "openid" });
  }
  if (typeof input.secret !== "string" || input.secret.length === 0) {
    throw internalError("admin login secret 不能为空");
  }
  const ttlSeconds = input.ttlSeconds ?? ADMIN_LOGIN_TOKEN_DEFAULT_TTL_SECONDS;
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < ADMIN_LOGIN_TOKEN_MIN_TTL_SECONDS ||
    ttlSeconds > ADMIN_LOGIN_TOKEN_MAX_TTL_SECONDS
  ) {
    throw validationError(
      `ttl_seconds 必须为 ${ADMIN_LOGIN_TOKEN_MIN_TTL_SECONDS}..${ADMIN_LOGIN_TOKEN_MAX_TTL_SECONDS} 的整数`,
      { field: "ttl_seconds" },
    );
  }
  const iat = Math.floor(input.now.getTime() / 1000);
  const exp = iat + ttlSeconds;
  const payload: AdminLoginTokenPayload = {
    v: 1,
    typ: "admin_login",
    openid,
    iat,
    exp,
    jti: newUuid(),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signingInput = `${ADMIN_LOGIN_TOKEN_PREFIX}.${encodedPayload}`;
  const signature = createHmac("sha256", input.secret).update(signingInput).digest("base64url");
  return {
    login_token: `${signingInput}.${signature}`,
    expires_at: new Date(exp * 1000),
    ttl_seconds: ttlSeconds,
  };
}

function pruneConsumedJtis(consumedJtis: Map<string, number>, nowEpochSeconds: number): void {
  for (const [jti, exp] of consumedJtis.entries()) {
    if (exp <= nowEpochSeconds) {
      consumedJtis.delete(jti);
    }
  }
}

function consumeJtiInMap(
  consumedJtis: Map<string, number>,
  jti: string,
  expEpochSeconds: number,
  nowEpochSeconds: number,
): void {
  pruneConsumedJtis(consumedJtis, nowEpochSeconds);
  if (consumedJtis.has(jti)) {
    throw conflictError("UNAUTHORIZED", "管理员登录令牌已被使用");
  }
  if (consumedJtis.size >= MAX_CONSUMED_JTIS) {
    const oldestKey = consumedJtis.keys().next().value;
    if (oldestKey !== undefined) consumedJtis.delete(oldestKey);
  }
  consumedJtis.set(jti, expEpochSeconds);
}

export function verifyAdminLoginToken(input: {
  token: string;
  secret: string;
  now: Date;
  consumedJtis?: Map<string, number>;
}): { openid: string; jti: string; exp: number } {
  const parts = input.token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== ADMIN_LOGIN_TOKEN_PREFIX) {
    throw conflictError("UNAUTHORIZED", "管理员登录令牌无效");
  }
  const [, encodedPayload, encodedSignature] = parts as [string, string, string];
  if (
    !/^[A-Za-z0-9_-]+$/.test(encodedPayload) ||
    !/^[A-Za-z0-9_-]+$/.test(encodedSignature)
  ) {
    throw conflictError("UNAUTHORIZED", "管理员登录令牌格式无效");
  }
  const signingInput = `${ADMIN_LOGIN_TOKEN_PREFIX}.${encodedPayload}`;
  const expectedSig = createHmac("sha256", input.secret).update(signingInput).digest("base64url");
  const providedBuf = Buffer.from(encodedSignature, "utf8");
  const expectedBuf = Buffer.from(expectedSig, "utf8");
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    throw conflictError("UNAUTHORIZED", "管理员登录令牌签名无效");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw conflictError("UNAUTHORIZED", "管理员登录令牌内容无效");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw conflictError("UNAUTHORIZED", "管理员登录令牌内容无效");
  }
  const payload = parsed as Record<string, unknown>;
  if (
    payload.v !== 1 ||
    payload.typ !== "admin_login" ||
    typeof payload.openid !== "string" ||
    payload.openid.trim().length === 0 ||
    typeof payload.iat !== "number" ||
    !Number.isInteger(payload.iat) ||
    typeof payload.exp !== "number" ||
    !Number.isInteger(payload.exp) ||
    typeof payload.jti !== "string" ||
    !isValidUuid(payload.jti)
  ) {
    throw conflictError("UNAUTHORIZED", "管理员登录令牌载荷无效");
  }
  const nowSec = Math.floor(input.now.getTime() / 1000);
  if (payload.exp <= nowSec) {
    throw conflictError("UNAUTHORIZED", "管理员登录令牌已过期");
  }

  if (input.consumedJtis !== undefined) {
    consumeJtiInMap(input.consumedJtis, payload.jti, payload.exp, nowSec);
  }

  return { openid: payload.openid.trim(), jti: payload.jti, exp: payload.exp };
}

export function resolveAdminLoginSecret(config: Pick<GatewayRuntimeConfig, "match_cursor_secret" | "admin_login_secret">): string {
  return config.admin_login_secret ?? config.match_cursor_secret;
}

export function validateAdminLoginPayload(
  body: Record<string, unknown>,
):
  | { kind: "token"; login_token: string }
  | { kind: "passcode"; openid: string; passcode: string } {
  assertUnknownFields(body, ADMIN_LOGIN_FIELDS);
  const hasToken = Object.prototype.hasOwnProperty.call(body, "login_token");
  const hasOpenid = Object.prototype.hasOwnProperty.call(body, "openid");
  const hasPasscode = Object.prototype.hasOwnProperty.call(body, "passcode");

  if (hasToken) {
    if (hasOpenid || hasPasscode) {
      throw validationError("login_token 不能与 openid/passcode 同时传递");
    }
    if (
      typeof body.login_token !== "string" ||
      body.login_token.trim().length < 1 ||
      body.login_token.trim().length > 1024
    ) {
      throw validationError("login_token 格式无效", { field: "login_token" });
    }
    return { kind: "token", login_token: body.login_token.trim() };
  }

  if (hasOpenid || hasPasscode) {
    if (
      typeof body.openid !== "string" ||
      body.openid.trim().length < 1 ||
      body.openid.trim().length > 128
    ) {
      throw validationError("openid 格式无效", { field: "openid" });
    }
    if (
      typeof body.passcode !== "string" ||
      body.passcode.length < 1 ||
      body.passcode.length > 256
    ) {
      throw validationError("passcode 格式无效", { field: "passcode" });
    }
    return { kind: "passcode", openid: body.openid.trim(), passcode: body.passcode };
  }

  throw validationError("必须提供 login_token 或 openid 与 passcode");
}

export async function loginAdminSession(input: {
  credential: ReturnType<typeof validateAdminLoginPayload>;
  config: GatewayRuntimeConfig;
  repo: AppRepository;
  sessions: AuthSessionStore;
  now: Date;
  consumedJtis?: AdminConsumedJtiStore | Map<string, number>;
}): Promise<AdminLoginResult> {
  let openid: string;
  if (input.credential.kind === "token") {
    const verified = verifyAdminLoginToken({
      token: input.credential.login_token,
      secret: resolveAdminLoginSecret(input.config),
      now: input.now,
    });
    if (input.consumedJtis !== undefined) {
      if (input.consumedJtis instanceof Map) {
        consumeJtiInMap(
          input.consumedJtis,
          verified.jti,
          verified.exp,
          Math.floor(input.now.getTime() / 1000),
        );
      } else {
        const accepted = await input.consumedJtis.consume({
          jti: verified.jti,
          expiresAt: new Date(verified.exp * 1000),
          now: input.now,
        });
        if (!accepted) {
          throw conflictError("UNAUTHORIZED", "管理员登录令牌已被使用");
        }
      }
    }
    openid = verified.openid;
  } else {
    const configured = input.config.admin_web_passcode;
    if (typeof configured !== "string" || configured.length === 0) {
      throw conflictError("UNAUTHORIZED", "管理员口令登录未启用");
    }
    if (!constantTimeStringEqual(input.credential.passcode, configured)) {
      throw conflictError("UNAUTHORIZED", "管理员凭证无效");
    }
    openid = input.credential.openid;
  }

  const admin = await new AdminAuthorizationService().requireActiveAdmin(input.repo, openid);
  const configuredTtl = input.config.vps_auth?.session_ttl_seconds;
  const ttlSeconds = configuredTtl !== undefined
    ? Math.min(ADMIN_WEB_SESSION_TTL_SECONDS, configuredTtl)
    : ADMIN_WEB_SESSION_TTL_SECONDS;
  const session = await input.sessions.create({
    openid: admin.openid,
    now: input.now,
    ttlSeconds,
  });
  return {
    access_token: session.token,
    token_type: SESSION_TOKEN_TYPE,
    expires_at: session.expires_at.toISOString(),
    admin: {
      admin_id: admin.admin_id,
      role: admin.role,
      status: admin.status,
    },
  };
}

export async function getAdminAuthMe(input: {
  repo: AppRepository;
  trusted_openid: string | null | undefined;
}): Promise<AdminAuthMeResult> {
  if (typeof input.trusted_openid !== "string" || input.trusted_openid.trim().length === 0) {
    throw conflictError("UNAUTHORIZED", "需要可信管理员身份");
  }
  const admin = await new AdminAuthorizationService().requireActiveAdmin(
    input.repo,
    input.trusted_openid,
  );
  return {
    admin_id: admin.admin_id,
    role: admin.role,
    status: admin.status,
  };
}

export async function logoutAdminSession(input: {
  authorization: unknown;
  sessions: AuthSessionStore | undefined;
  now: Date;
}): Promise<void> {
  if (input.sessions === undefined) {
    throw conflictError("UNAUTHORIZED", "当前运行时未启用会话存储");
  }
  const token = parseBearerToken(input.authorization);
  const active = await input.sessions.findActiveByToken({ token, now: input.now });
  if (active === null) {
    throw conflictError("UNAUTHORIZED", "需要重新登录");
  }
  if (input.sessions.deleteByToken !== undefined) {
    await input.sessions.deleteByToken(token);
    return;
  }
  await input.sessions.deleteByOpenid(active.openid);
}
