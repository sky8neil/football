import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createWechatCode2SessionHttp } from "./wechat-http.js";
import {
  WECHAT_JSCODE2SESSION_GRANT_TYPE,
  WECHAT_JSCODE2SESSION_URL,
  exchangeWechatLoginCode,
} from "./wechat-login.js";

const APP_ID = "wx-test-appid";
const APP_SECRET = "wx-test-secret-must-not-leak";
const LOGIN_CODE = "wx-one-time-code-must-not-leak";
const OPENID = "wx-openid-alice";
const SESSION_KEY = "wx-session-key-must-not-leave";

describe("createWechatCode2SessionHttp", () => {
  const captured: { url: string | undefined; secret: string | null } = { url: undefined, secret: null };
  const stub = http.createServer((req, res) => {
    captured.url = req.url;
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    captured.secret = requestUrl.searchParams.get("secret");
    const code = requestUrl.searchParams.get("js_code");
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    if (code === LOGIN_CODE) {
      res.end(JSON.stringify({ openid: OPENID, session_key: SESSION_KEY }));
      return;
    }
    res.end(JSON.stringify({ errcode: 40029, errmsg: "invalid code" }));
  });
  let origin = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      stub.listen(0, "127.0.0.1", () => resolve());
    });
    origin = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    stub.closeAllConnections();
    await new Promise<void>((resolve, reject) => stub.close((error) => error ? reject(error) : resolve()));
  });

  it("sends a real GET to the configured origin and does not leak code or secret", async () => {
    const httpClient = createWechatCode2SessionHttp({ origin });
    const identity = await exchangeWechatLoginCode({
      code: LOGIN_CODE,
      auth: { wechat_app_id: APP_ID, wechat_app_secret: APP_SECRET },
      http: httpClient,
    });
    expect(identity).toEqual({ openid: OPENID, unionid: null });
    expect(captured.secret).toBe(APP_SECRET);
    expect(captured.url).toContain("/sns/jscode2session");
    expect(captured.url).toContain(`grant_type=${WECHAT_JSCODE2SESSION_GRANT_TYPE}`);
    expect(WECHAT_JSCODE2SESSION_URL).toBe("https://api.weixin.qq.com/sns/jscode2session");
    expect(JSON.stringify(identity)).not.toContain(APP_SECRET);
    expect(JSON.stringify(identity)).not.toContain(LOGIN_CODE);
    expect(JSON.stringify(identity)).not.toContain(SESSION_KEY);
  });
});
