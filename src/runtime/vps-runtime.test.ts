import { describe, expect, it } from "vitest";
import { createVpsRuntime } from "./vps-runtime.js";
import { createWechatCode2SessionHttp } from "../gateway/wechat-http.js";

describe("createVpsRuntime", () => {
  it("wires postgres sessions, health check, and a real wechat HTTP client", async () => {
    const runtime = createVpsRuntime({
      postgres: {
        database_url: "postgres://football:secret@127.0.0.1:1/football",
        database_schema: "football_vps05",
        resource_namespace: "ft",
      },
    });
    expect(runtime.wechatHttp).toEqual(expect.objectContaining({ getJson: expect.any(Function) }));
    expect(runtime.db).toEqual(expect.objectContaining({ query: expect.any(Function) }));
    expect(runtime.sessions).toEqual(expect.objectContaining({
      create: expect.any(Function),
      findActiveByToken: expect.any(Function),
    }));
    await expect(runtime.healthCheck()).resolves.toBe(false);
    await runtime.close();
    await runtime.close();
    await expect(runtime.healthCheck()).resolves.toBe(false);
  });

  it("accepts an injected wechat HTTP client", async () => {
    const wechatHttp = createWechatCode2SessionHttp({ origin: "http://127.0.0.1:9" });
    const runtime = createVpsRuntime({
      postgres: {
        database_url: "postgres://football:secret@127.0.0.1:1/football",
        database_schema: "football_vps05",
        resource_namespace: "ft",
      },
      wechatHttp,
    });
    expect(runtime.wechatHttp).toBe(wechatHttp);
    await runtime.close();
  });
});
