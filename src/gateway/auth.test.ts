import { describe, expect, it, vi } from "vitest";
import { DomainError } from "../domain/errors.js";
import { mapErrorToHttp } from "../api/v1/validation.js";
import type { AuthSessionRecord, AuthSessionStore } from "../infrastructure/postgres-auth-sessions.js";
import {
  issueWechatSession,
  parseBearerToken,
  resolveBearerOpenid,
  SESSION_TOKEN_TYPE,
} from "./auth.js";
import {
  WECHAT_JSCODE2SESSION_GRANT_TYPE,
  WECHAT_JSCODE2SESSION_URL,
  type WechatCode2SessionHttp,
} from "./wechat-login.js";

const APP_ID = "wx-test-appid";
const APP_SECRET = "wx-test-secret-must-not-leak";
const LOGIN_CODE = "wx-one-time-code-must-not-leak";
const OPENID = "wx-openid-alice";
const SESSION_KEY = "wx-session-key-must-not-leave";
const TOKEN = "opaque-session-token";
const NOW = new Date("2026-08-09T12:00:00.000Z");
const TTL_SECONDS = 120;
const AUTH = {
  wechat_app_id: APP_ID,
  wechat_app_secret: APP_SECRET,
  session_ttl_seconds: TTL_SECONDS,
};

function expectUnauthorized(err: unknown): asserts err is DomainError {
  expect(err).toBeInstanceOf(DomainError);
  expect(err).toMatchObject({ code: "UNAUTHORIZED", message: "需要重新登录", details: null });
  const mapped = mapErrorToHttp(err, "req-auth");
  expect(mapped.status).toBe(401);
  expect(mapped.body.code).toBe("UNAUTHORIZED");
  expect(JSON.stringify(err)).not.toContain(APP_SECRET);
  expect(JSON.stringify(err)).not.toContain(LOGIN_CODE);
  expect(JSON.stringify(err)).not.toContain(SESSION_KEY);
}

async function rejected(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
    throw new Error("expected UNAUTHORIZED");
  } catch (err) {
    return err;
  }
}

function memorySessions(seed: AuthSessionRecord[] = []): AuthSessionStore & { records: AuthSessionRecord[] } {
  const records = [...seed];
  return {
    records,
    async create(input) {
      const record = {
        token: `${TOKEN}-${records.length + 1}`,
        openid: input.openid,
        expires_at: new Date(input.now.getTime() + input.ttlSeconds * 1000),
      };
      records.push(record);
      return record;
    },
    async findActiveByToken(input) {
      return records.find((item) => item.token === input.token && item.expires_at.getTime() > input.now.getTime()) ??
        null;
    },
  };
}

function wechatHttp(payload: unknown = { openid: OPENID, session_key: SESSION_KEY }): WechatCode2SessionHttp {
  return {
    getJson: vi.fn(async () => payload),
  };
}

describe("issueWechatSession", () => {
  it("exchanges a wechat code then issues an opaque session from configured ttl", async () => {
    const http = wechatHttp();
    const sessions = memorySessions();

    const issued = await issueWechatSession({
      code: LOGIN_CODE,
      auth: AUTH,
      http,
      sessions,
      now: NOW,
    });

    expect(issued).toEqual({
      access_token: `${TOKEN}-1`,
      token_type: SESSION_TOKEN_TYPE,
      expires_at: new Date(NOW.getTime() + TTL_SECONDS * 1000).toISOString(),
    });
    expect(issued.token_type).toBe("Bearer");
    expect(JSON.stringify(issued)).not.toContain(SESSION_KEY);
    expect(JSON.stringify(issued)).not.toContain(APP_SECRET);
    expect(sessions.records).toEqual([
      {
        token: `${TOKEN}-1`,
        openid: OPENID,
        expires_at: new Date(NOW.getTime() + TTL_SECONDS * 1000),
      },
    ]);
    expect(http.getJson).toHaveBeenCalledWith(WECHAT_JSCODE2SESSION_URL, {
      appid: APP_ID,
      secret: APP_SECRET,
      js_code: LOGIN_CODE,
      grant_type: WECHAT_JSCODE2SESSION_GRANT_TYPE,
    });
  });

  it("does not create a session when wechat exchange fails", async () => {
    const http = wechatHttp({ errcode: 40029, errmsg: "invalid code", session_key: SESSION_KEY });
    const sessions = memorySessions();
    const create = vi.spyOn(sessions, "create");
    expectUnauthorized(await rejected(() => issueWechatSession({
      code: LOGIN_CODE,
      auth: AUTH,
      http,
      sessions,
      now: NOW,
    })));
    expect(create).not.toHaveBeenCalled();
    expect(sessions.records).toEqual([]);
  });
});

describe("resolveBearerOpenid", () => {
  const sessions = memorySessions([
    {
      token: TOKEN,
      openid: OPENID,
      expires_at: new Date(NOW.getTime() + TTL_SECONDS * 1000),
    },
  ]);

  it("returns openid for an unexpired bearer token", async () => {
    await expect(resolveBearerOpenid({
      authorization: `Bearer ${TOKEN}`,
      sessions,
      now: NOW,
    })).resolves.toBe(OPENID);
  });

  it("requires a new login after expiry", async () => {
    expectUnauthorized(await rejected(() => resolveBearerOpenid({
      authorization: `Bearer ${TOKEN}`,
      sessions,
      now: new Date(NOW.getTime() + TTL_SECONDS * 1000),
    })));
  });

  it("rejects missing, blank, and non-bearer credentials", async () => {
    for (const authorization of [undefined, null, "", "   ", TOKEN, `Basic ${TOKEN}`, "Bearer", "Bearer "]) {
      expectUnauthorized(await rejected(() => resolveBearerOpenid({
        authorization,
        sessions,
        now: NOW,
      })));
    }
  });
});

describe("parseBearerToken", () => {
  it("reads the opaque bearer token", () => {
    expect(parseBearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(parseBearerToken(`bearer ${TOKEN}`)).toBe(TOKEN);
  });
});
