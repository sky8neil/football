import { describe, expect, it } from "vitest";
import { decideProviderResultAdoption, type ProviderResultObservation } from "./provider-result-adoption.js";

const KICKOFF = new Date("2026-10-12T12:00:00.000Z");
const NOW = new Date("2026-10-12T15:00:00.000Z");

function observation(
  provider: ProviderResultObservation["provider"],
  status: ProviderResultObservation["status"],
  score: ProviderResultObservation["score"] = { home: 2, away: 1 },
  raw_status: string | null = status === "finished" ? "FT" : status.toUpperCase(),
): ProviderResultObservation {
  return { provider, status, score, raw_status, observed_at: NOW };
}

describe("decideProviderResultAdoption", () => {
  it.each([
    ["premier_league", "football_data"],
    ["chinese_super_league", "bsd"],
  ] as const)("adopts the authoritative source for %s", (leagueId, provider) => {
    expect(decideProviderResultAdoption(leagueId, [observation(provider, "finished")], KICKOFF, NOW))
      .toMatchObject({ kind: "adopt", provider, score: { home: 2, away: 1 } });
  });

  it("adopts agreeing finished 5d and OpenFoot observations when authority is absent", () => {
    expect(decideProviderResultAdoption("premier_league", [
      observation("5dollar", "finished"), observation("openfoot", "finished"),
    ], KICKOFF, NOW)).toMatchObject({ kind: "adopt", provider: "5dollar", compared_providers: ["5dollar", "openfoot"] });
  });

  it("waits for a second or authoritative source when only one non-authoritative result exists", () => {
    expect(decideProviderResultAdoption("premier_league", [observation("5dollar", "finished")], KICKOFF, NOW))
      .toEqual({ kind: "wait", reason: "non_authoritative_single_source" });
  });

  it("waits when no observation has a final score", () => {
    expect(decideProviderResultAdoption("premier_league", [observation("football_data", "finished", null)], KICKOFF, NOW))
      .toEqual({ kind: "wait", reason: "no_final_score" });
  });

  it("flags conflicting finished scores", () => {
    expect(decideProviderResultAdoption("premier_league", [
      observation("football_data", "finished", { home: 2, away: 1 }),
      observation("5dollar", "finished", { home: 1, away: 1 }),
    ], KICKOFF, NOW)).toEqual({ kind: "anomaly", reason: "score_conflict" });
  });

  it("flags unknown and awarded statuses instead of adopting them", () => {
    for (const item of [observation("football_data", "unknown"), observation("5dollar", "finished", null, "AWARDED")]) {
      expect(decideProviderResultAdoption("premier_league", [item], KICKOFF, NOW))
        .toEqual({ kind: "anomaly", reason: "unknown_status" });
    }
  });

  it("flags a finished/live conflict after the finish grace period", () => {
    const afterGrace = new Date(KICKOFF.getTime() + 150 * 60_000);
    expect(decideProviderResultAdoption("premier_league", [
      observation("football_data", "finished"), observation("5dollar", "live", null),
    ], KICKOFF, afterGrace)).toEqual({ kind: "anomaly", reason: "finished_live_conflict" });
  });
});
