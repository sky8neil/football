import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startGatewayServer } from "./http.js";

const MAX_JSON_BODY_BYTES = 256 * 1024;

let server: Server;
let port: number;

beforeAll(async () => {
  server = await startGatewayServer({
    port: 0,
    env: {
      FOOTBALL_ENVIRONMENT: "dev",
      FOOTBALL_MATCH_CURSOR_SECRET: "http-transport-test-secret",
      FOOTBALL_REPOSITORY_BACKEND: "memory",
      FOOTBALL_MOCK_TRUSTED_OPENID: "http-transport-test-user",
      FOOTBALL_SEED_SCENARIO: "normal",
    },
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server?.closeAllConnections();
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

function request(options: {
  method?: string;
  path: string;
  headers?: http.OutgoingHttpHeaders;
  body?: Buffer | string;
  chunked?: boolean;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: options.method ?? "GET",
      path: options.path,
      headers: options.headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.on("error", reject);
    if (options.chunked) {
      req.removeHeader("content-length");
      req.write(options.body ?? Buffer.alloc(0));
      req.end();
      return;
    }
    req.end(options.body);
  });
}

describe("gateway HTTP transport", () => {
  it("returns 400 for a malformed URL and keeps serving", async () => {
    for (const path of ["//:80", "http://[invalid]"]) {
      const response = await request({ path });
      expect(response.status).toBe(400);
      expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(JSON.parse(response.body.toString("utf8"))).toEqual({
        code: "VALIDATION_ERROR",
        message: "请求 URL 非法",
        request_id: expect.any(String),
        details: null,
      });
    }
    const health = await request({ path: "/health" });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body.toString("utf8"))).toEqual({ ok: true });
  });

  it("accepts a JSON body of 256KB and rejects 256KB+1 with 413", async () => {
    const exact = await request({
      method: "POST",
      path: "/v1/session/init",
      headers: { "content-type": "application/json" },
      body: Buffer.alloc(MAX_JSON_BODY_BYTES, 0x61),
    });
    expect(exact.status).toBe(422);
    expect(JSON.parse(exact.body.toString("utf8"))).toMatchObject({
      code: "VALIDATION_ERROR",
    });

    const over = await request({
      method: "POST",
      path: "/v1/session/init",
      headers: { "content-type": "application/json" },
      body: Buffer.alloc(MAX_JSON_BODY_BYTES + 1, 0x61),
    });
    expect(over.status).toBe(413);
    expect(over.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(JSON.parse(over.body.toString("utf8"))).toEqual({
      code: "PAYLOAD_TOO_LARGE",
      message: "请求体超过 256KB 上限",
      request_id: expect.any(String),
      details: null,
    });
  });

  it("returns 413 for a chunked body and a declared Content-Length above 256KB", async () => {
    const chunked = await request({
      method: "POST",
      path: "/v1/session/init",
      headers: {
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      },
      body: Buffer.alloc(MAX_JSON_BODY_BYTES + 1, 0x62),
      chunked: true,
    });
    expect(chunked.status).toBe(413);
    expect(JSON.parse(chunked.body.toString("utf8")).code).toBe("PAYLOAD_TOO_LARGE");

    const declared = await request({
      method: "POST",
      path: "/v1/session/init",
      headers: {
        "content-type": "application/json",
        "content-length": MAX_JSON_BODY_BYTES + 1,
      },
      body: Buffer.from("{}"),
    });
    expect(declared.status).toBe(413);
    expect(JSON.parse(declared.body.toString("utf8")).code).toBe("PAYLOAD_TOO_LARGE");

    const health = await request({ path: "/health" });
    expect(health.status).toBe(200);
  });

  it("omits the body and content-type on 204", async () => {
    const created = await request({
      method: "POST",
      path: "/v1/session/init",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nickname: "传输层" }),
    });
    expect([200, 201]).toContain(created.status);
    expect(created.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(created.body.length).toBeGreaterThan(0);

    const deleted = await request({ method: "DELETE", path: "/v1/profile/me" });
    expect(deleted.status).toBe(204);
    expect(deleted.headers["content-type"]).toBeUndefined();
    expect(deleted.body).toEqual(Buffer.alloc(0));
  });
});
