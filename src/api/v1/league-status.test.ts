import { describe, expect, it, vi } from "vitest";
import { getLeagueStatus } from "./league-status.js";

describe("league status handler", () => {
  it("uses the public rate limit and returns service items", async () => {
    const now = new Date("2026-08-09T00:00:00Z");
    const list = vi.fn().mockResolvedValue([]);
    const check = vi.fn().mockResolvedValue(undefined);
    await expect(getLeagueStatus({ list }, { public_source: "source", query: {}, server_now: now, request_id: "req", rate_limiter: { check } }))
      .resolves.toEqual({ status: 200, body: { data: { items: [] }, request_id: "req" } });
    expect(check).toHaveBeenCalledWith("public_reads", "source", now);
    expect(list).toHaveBeenCalledWith(now);
  });

  it("rejects unknown parameters and missing public sources", async () => {
    const list = vi.fn();
    const input = { public_source: "source", query: { foo: "1" }, server_now: new Date(), request_id: "req" };
    await expect(getLeagueStatus({ list }, input)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(getLeagueStatus({ list }, { ...input, query: {}, public_source: "" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(list).not.toHaveBeenCalled();
  });
});
