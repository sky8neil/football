import { conflictError } from "../domain/errors.js";
import type { VpsAuthConfig } from "./config.js";

export const WECHAT_JSCODE2SESSION_URL =
  "https://api.weixin.qq.com/sns/jscode2session";

export const WECHAT_JSCODE2SESSION_GRANT_TYPE = "authorization_code";

export interface WechatCode2SessionHttp {
  getJson(url: string, query: Record<string, string>): Promise<unknown>;
}

export interface WechatLoginIdentity {
  openid: string;
  unionid: string | null;
}

export interface ExchangeWechatLoginCodeInput {
  code: string;
  auth: Pick<VpsAuthConfig, "wechat_app_id" | "wechat_app_secret">;
  http: WechatCode2SessionHttp;
}

function unauthorized(): never {
  throw conflictError("UNAUTHORIZED", "需要重新登录");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasWechatErrcode(errcode: unknown): boolean {
  return errcode !== undefined && errcode !== null && errcode !== 0 && errcode !== "0";
}

export async function exchangeWechatLoginCode(
  input: ExchangeWechatLoginCodeInput,
): Promise<WechatLoginIdentity> {
  const code = typeof input.code === "string" ? input.code.trim() : "";
  if (code.length === 0) {
    unauthorized();
  }

  let payload: unknown;
  try {
    payload = await input.http.getJson(WECHAT_JSCODE2SESSION_URL, {
      appid: input.auth.wechat_app_id,
      secret: input.auth.wechat_app_secret,
      js_code: code,
      grant_type: WECHAT_JSCODE2SESSION_GRANT_TYPE,
    });
  } catch {
    unauthorized();
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    unauthorized();
  }

  const record = payload as Record<string, unknown>;
  if (hasWechatErrcode(record.errcode) || !isNonEmptyString(record.openid)) {
    unauthorized();
  }

  return {
    openid: record.openid.trim(),
    unionid: isNonEmptyString(record.unionid) ? record.unionid.trim() : null,
  };
}
