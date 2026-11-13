import { conflictError } from "../domain/errors.js";
import type { AuthSessionStore } from "../infrastructure/postgres-auth-sessions.js";
import type { VpsAuthConfig } from "./config.js";
import { exchangeWechatLoginCode, type WechatCode2SessionHttp } from "./wechat-login.js";

export const SESSION_TOKEN_TYPE = "Bearer" as const;

export interface IssuedWechatSession {
  access_token: string;
  token_type: typeof SESSION_TOKEN_TYPE;
  expires_at: string;
}

export interface IssueWechatSessionInput {
  code: string;
  auth: VpsAuthConfig;
  http: WechatCode2SessionHttp;
  sessions: AuthSessionStore;
  now: Date;
}

export interface ResolveBearerOpenidInput {
  authorization: unknown;
  sessions: AuthSessionStore;
  now: Date;
}

function unauthorized(): never {
  throw conflictError("UNAUTHORIZED", "需要重新登录");
}

export function parseBearerToken(authorization: unknown): string {
  if (typeof authorization !== "string") unauthorized();
  const match = /^(Bearer)\s+(\S+)$/i.exec(authorization.trim());
  if (match === null) unauthorized();
  const token = match[2];
  if (token === undefined || token.length === 0) unauthorized();
  return token;
}

export async function issueWechatSession(
  input: IssueWechatSessionInput,
): Promise<IssuedWechatSession> {
  const identity = await exchangeWechatLoginCode({
    code: input.code,
    auth: input.auth,
    http: input.http,
  });
  const session = await input.sessions.create({
    openid: identity.openid,
    now: input.now,
    ttlSeconds: input.auth.session_ttl_seconds,
  });
  return {
    access_token: session.token,
    token_type: SESSION_TOKEN_TYPE,
    expires_at: session.expires_at.toISOString(),
  };
}

export async function resolveBearerOpenid(input: ResolveBearerOpenidInput): Promise<string> {
  const token = parseBearerToken(input.authorization);
  const session = await input.sessions.findActiveByToken({ token, now: input.now });
  if (session === null) unauthorized();
  return session.openid;
}
