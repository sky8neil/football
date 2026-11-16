import { describe, expect, it, vi } from "vitest";
import { getPersonalLeagueSummary } from "./personal-league-summary.js";

describe("personal league summary handler", () => {
  const now = new Date("2026-08-09T00:00:00Z");
  const input = { authenticated_user_id: "user", query: { league_id: "chinese_super_league", season_id: "2026" }, server_now: now, request_id: "req" };

  it("passes the authenticated user and query to the service", async () => {
    const data = { availability: "not_available" as const, league_id: "chinese_super_league", season_id: "2026", completion_confirmed_at: null, ended_at: null, summary: null, reason: "not_available" };
    const get = vi.fn().mockResolvedValue(data);
    const check = vi.fn().mockResolvedValue(undefined);
    await expect(getPersonalLeagueSummary({ get }, { ...input, rate_limiter: { check } })).resolves.toEqual({ status: 200, body: { data, request_id: "req" } });
    expect(check).toHaveBeenCalledWith("authenticated_reads", "user", now);
    expect(get).toHaveBeenCalledWith("user", "chinese_super_league", "2026", now);
  });

  it("rejects missing identity and invalid query fields", async () => {
    const get = vi.fn();
    const check = vi.fn().mockResolvedValue(undefined);
    await expect(getPersonalLeagueSummary({ get }, { ...input, authenticated_user_id: null, rate_limiter: { check } })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    for (const query of [{}, { league_id: 1 }, { league_id: "x", season_id: 1 }, { league_id: "x", user_id: "other" }]) {
      await expect(getPersonalLeagueSummary({ get }, { ...input, query, rate_limiter: { check } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(get).not.toHaveBeenCalled();
  });
});
