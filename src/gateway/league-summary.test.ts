import { describe, expect, it, vi } from "vitest";
import { InMemoryRateLimiter } from "../api/v1/rate-limit.js";
import { MatchQueryService } from "../application/match-query.js";
import { SessionService } from "../application/session.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { handleGatewayRequest } from "./assemble.js";
import { LOCAL_PUBLIC_SOURCE, type GatewayRuntimeConfig } from "./config.js";

const now = new Date("2026-08-09T12:00:00Z");

function harness() {
  const repo = new InMemoryRepository();
  const config: GatewayRuntimeConfig = { environment: "test", mock_trusted_openid: null, match_cursor_secret: "test-secret", public_source: LOCAL_PUBLIC_SOURCE, repository_backend: "memory", cloudbase_repository: null, postgres_repository: null, vps_auth: null, deploy_target: "vps" };
  const getMyPrediction = vi.fn();
  const services = { session: new SessionService(repo), matches: new MatchQueryService(repo, config.match_cursor_secret), predictions: { submit: vi.fn(), getMyPrediction } };
  const rate_limiter = new InMemoryRateLimiter();
  const request = (path: string, query: Record<string, string> = {}, openid: string | null = null, method = "GET", body?: unknown) => handleGatewayRequest({ method, path, query, body, server_now: now, config, services, repo, rate_limiter, trusted_openid: openid });
  return { request, getMyPrediction };
}

describe("league summary gateway routes", () => {
  it("requires login, validates query fields, and routes authenticated summaries", async () => {
    const { request, getMyPrediction } = harness();
    expect(await request("/v1/predictions/summary", { league_id: "x" })).toMatchObject({ status: 401, body: { code: "UNAUTHORIZED" } });
    expect((await request("/v1/session/init", {}, "openid", "POST", { nickname: "Player" })).status).toBe(201);
    const response = await request("/v1/predictions/summary", { league_id: "chinese_super_league" }, "openid");
    expect(response).toEqual({ status: 200, body: { request_id: expect.any(String), data: { availability: "not_available", league_id: "chinese_super_league", season_id: null, completion_confirmed_at: null, ended_at: null, summary: null, reason: "not_available" } } });
    for (const query of [{ league_id: "x", user_id: "other_user" }, {}]) {
      const invalid = await request("/v1/predictions/summary", query, "openid");
      expect(invalid).toMatchObject({ status: 422, body: { code: "VALIDATION_ERROR" } });
      expect(invalid.body).not.toHaveProperty("data");
    }
    expect(getMyPrediction).not.toHaveBeenCalled();
  });

  it("allows guests to list six leagues and rejects unknown query fields", async () => {
    const { request } = harness();
    const response = await request("/v1/leagues/status");
    expect(response.status).toBe(200);
    expect((response.body as { data: { items: unknown[] } }).data.items).toHaveLength(6);
    expect(await request("/v1/leagues/status", { foo: "1" })).toMatchObject({ status: 422, body: { code: "VALIDATION_ERROR" } });
  });
});
