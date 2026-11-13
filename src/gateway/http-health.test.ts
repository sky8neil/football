import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startGatewayServer } from "./http.js";

let server: Server;
let origin: string;

beforeAll(async () => {
  server = await startGatewayServer({
    port: 0,
    env: {
      FOOTBALL_ENVIRONMENT: "dev",
      FOOTBALL_MATCH_CURSOR_SECRET: "http-health-test-secret",
      FOOTBALL_REPOSITORY_BACKEND: "memory",
      FOOTBALL_MOCK_TRUSTED_OPENID: "http-health-test-user",
    },
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe("gateway health check", () => {
  it("returns 200 ok for the memory backend", async () => {
    const response = await fetch(`${origin}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
