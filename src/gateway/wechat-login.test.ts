import { describe, expect, it, vi } from "vitest";
import { DomainError } from "../domain/errors.js";
import { mapErrorToHttp } from "../api/v1/validation.js";
import {
  WECHAT_JSCODE2SESSION_GRANT_TYPE,
  WECHAT_JSCODE2SESSION_URL,
  exchangeWechatLoginCode,
  type WechatCode2SessionHttp,
} from "./wechat-login.js";

const APP_ID = "wx-test-appid";
const APP_SECRET = "wx-test-secret-must-not-leak";
const LOGIN_CODE = "wx-one-time-code-must-not-leak";
const OPENID = "wx-openid-alice";
const UNIONID = "wx-unionid-alice";
const SESSION_KEY = "wx-session-key-must-not-leave";

const AUTH = {
  wechat_app_id: APP_ID,
  wechat_app_secret: APP_SECRET,
};

function makeHttp(
  handler: (url: string, query: Record<string, string>) => unknown | Promise<unknown>,
): { http: WechatCode2SessionHttp; calls: { url: string; query: Record<string, string> }[] } {
  const calls: { url: string; query: Record<string, string> }[] = [];
  return {
    calls,
    http: {
      getJson: vi.fn(async (url, query) => {
        calls.push({ url, query });
        return handler(url, query);
      }),
    },
  };
}

async function exchange(
  http: WechatCode2SessionHttp,
  code: string = LOGIN_CODE,
) {
  return exchangeWechatLoginCode({ code, auth: AUTH, http });
}

async function rejected(http: WechatCode2SessionHttp, code: string = LOGIN_CODE) {
  try {
    await exchange(http, code);
    throw new Error("expected UNAUTHORIZED");
  } catch (err) {
    return err;
  }
}

function expectUnauthorized(err: unknown): asserts err is DomainError {
  expect(err).toBeInstanceOf(DomainError);
  expect(err).toMatchObject({ code: "UNAUTHORIZED", message: "需要重新登录", details: null });
  const mapped = mapErrorToHttp(err, "req-wechat-login");
  expect(mapped.status).toBe(401);
  expect(mapped.body.code).toBe("UNAUTHORIZED");
  expect(mapped.body.message).toBe("需要重新登录");
  const serialized = JSON.stringify(err);
  expect(serialized).not.toContain(APP_SECRET);
  expect(serialized).not.toContain(LOGIN_CODE);
  expect(serialized).not.toContain(SESSION_KEY);
  expect(String(err)).not.toContain(APP_SECRET);
  expect(String(err)).not.toContain(LOGIN_CODE);
  expect(mapped.body.message).not.toContain(APP_SECRET);
  expect(mapped.body.message).not.toContain(LOGIN_CODE);
}

describe("exchangeWechatLoginCode", () => {
  it("exchanges a code for openid and optional unionid without exposing session_key", async () => {
    const { http, calls } = makeHttp(() => ({
      openid: OPENID,
      unionid: UNIONID,
      session_key: SESSION_KEY,
    }));

    const identity = await exchange(http);

    expect(identity).toEqual({ openid: OPENID, unionid: UNIONID });
    expect(identity).not.toHaveProperty("session_key");
    expect(JSON.stringify(identity)).not.toContain(SESSION_KEY);
    expect(JSON.stringify(identity)).not.toContain(APP_SECRET);
    expect(calls).toEqual([
      {
        url: WECHAT_JSCODE2SESSION_URL,
        query: {
          appid: APP_ID,
          secret: APP_SECRET,
          js_code: LOGIN_CODE,
          grant_type: WECHAT_JSCODE2SESSION_GRANT_TYPE,
        },
      },
    ]);
    expect(WECHAT_JSCODE2SESSION_URL).toBe("https://api.weixin.qq.com/sns/jscode2session");
    expect(WECHAT_JSCODE2SESSION_GRANT_TYPE).toBe("authorization_code");
  });

  it("returns null unionid when WeChat omits it", async () => {
    const { http } = makeHttp(() => ({ openid: ` ${OPENID} `, session_key: SESSION_KEY }));
    await expect(exchange(http)).resolves.toEqual({ openid: OPENID, unionid: null });
  });

  it("treats errcode 0 with openid as success", async () => {
    const { http } = makeHttp(() => ({ errcode: 0, openid: OPENID }));
    await expect(exchange(http)).resolves.toEqual({ openid: OPENID, unionid: null });
  });

  it("rejects a blank code without calling WeChat", async () => {
    const { http } = makeHttp(() => {
      throw new Error("must not call WeChat");
    });
    expectUnauthorized(await rejected(http, "   "));
    expect(http.getJson).not.toHaveBeenCalled();
  });

  it("maps WeChat errcode to UNAUTHORIZED and does not return identity", async () => {
    for (const payload of [
      { errcode: 40029, errmsg: "invalid code", openid: OPENID, session_key: SESSION_KEY },
      { errcode: -1, errmsg: "system error" },
      { errcode: 45011, errmsg: "api minute-quota reach limit" },
      { errcode: "40163", errmsg: "code been used" },
    ]) {
      const { http } = makeHttp(() => payload);
      expectUnauthorized(await rejected(http));
    }
  });

  it("maps timeout and network failures to UNAUTHORIZED", async () => {
    const timeout = makeHttp(() => {
      throw new Error(`timeout ${APP_SECRET} ${LOGIN_CODE}`);
    });
    const network = makeHttp(() => {
      throw new Error(`network ${APP_SECRET} ${WECHAT_JSCODE2SESSION_URL}?secret=${APP_SECRET}`);
    });
    expectUnauthorized(await rejected(timeout.http));
    expectUnauthorized(await rejected(network.http));
  });

  it("maps missing openid and non-object payloads to UNAUTHORIZED", async () => {
    for (const payload of [
      { session_key: SESSION_KEY },
      { openid: "  ", session_key: SESSION_KEY },
      { errcode: 0, errmsg: "ok" },
      null,
      [],
      "openid",
    ]) {
      const { http } = makeHttp(() => payload);
      expectUnauthorized(await rejected(http));
    }
  });
});
