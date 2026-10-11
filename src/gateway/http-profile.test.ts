import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { startGatewayServer } from "./http.js";

let server: Server;
let origin: string;
async function readProfile() {
  const response = await fetch(origin + "/v1/profile/me");
  expect(response.status).toBe(200);
  return (await response.json() as { data: { nickname: string; favorite_team_id: string | null } }).data;
}

beforeAll(async () => {
  server = await startGatewayServer({ port: 0, env: {
    FOOTBALL_ENVIRONMENT: "dev",
    FOOTBALL_MATCH_CURSOR_SECRET: "http-profile-test-secret",
    FOOTBALL_REPOSITORY_BACKEND: "memory",
    FOOTBALL_MOCK_TRUSTED_OPENID: "http-profile-test-user",
    FOOTBALL_SEED_SCENARIO: "normal",
  } });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const response = await fetch(origin + "/v1/session/init", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nickname: "测试球友" }),
  });
  expect([200, 201]).toContain(response.status);
});
afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

function miniProgramProfileService() {
  const apiModule = { exports: {} as { request: (input: unknown) => Promise<unknown> } };
  runInNewContext(readFileSync(new URL("../../miniprogram/services/api.js", import.meta.url), "utf8"), {
    module: apiModule, require: () => ({ gatewayOrigin: origin }),
    wx: { request(options: { url: string; method: string; header: Record<string, string>; data: unknown; success: (res: unknown) => void; fail: () => void }) {
      if (!["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT"].includes(options.method)) {
        throw new Error("wx.request does not support " + options.method);
      }
      void fetch(options.url, { method: options.method, headers: options.header, ...(options.data ? { body: JSON.stringify(options.data) } : {}) })
        .then(async response => options.success({ statusCode: response.status, data: await response.json() }))
        .catch(() => options.fail());
    } },
  });
  const profileModule = { exports: {} as { updateMyProfile: (patch: unknown) => Promise<{ statusCode: number }> } };
  runInNewContext(readFileSync(new URL("../../miniprogram/services/profile.js", import.meta.url), "utf8"), {
    module: profileModule, require: () => apiModule.exports,
  });
  return profileModule.exports;
}

describe("profile updates over real HTTP", () => {
  it("saves nickname and favorite team through the WeChat-compatible client", async () => {
    const service = miniProgramProfileService();
    expect((await readProfile()).favorite_team_id).toBeNull();
    expect((await service.updateMyProfile({ nickname: "更新后的球友" })).statusCode).toBe(200);
    expect((await readProfile()).nickname).toBe("更新后的球友");
    const matches = await (await fetch(origin + "/v1/matches?limit=100")).json() as { data: { items: { home_team: { team_id: string } }[] } };
    const teamId = matches.data.items[0]!.home_team.team_id;
    expect((await service.updateMyProfile({ favorite_team_id: teamId })).statusCode).toBe(200);
    expect((await readProfile()).favorite_team_id).toBe(teamId);
    expect((await service.updateMyProfile({ favorite_team_id: null })).statusCode).toBe(200);
    expect((await readProfile()).favorite_team_id).toBeNull();
  });
  it("continues to parse PATCH JSON bodies for other clients", async () => {
    const response = await fetch(origin + "/v1/profile/me", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ nickname: "PATCH球友" }),
    });
    expect(response.status).toBe(200);
    expect((await readProfile()).nickname).toBe("PATCH球友");
  });
  it("applies the same field validation to POST updates", async () => {
    const response = await fetch(origin + "/v1/profile/me", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ favorite_team_id: "invalid" }),
    });
    expect(response.status).toBe(422);
  });
});
