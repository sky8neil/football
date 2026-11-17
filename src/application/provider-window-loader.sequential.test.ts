import { describe, expect, it, vi } from "vitest";
import { MatchStatus, Provider, SettlementStatus } from "../domain/enums.js";
import type { Match } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { loadPostFinishBatches } from "./provider-window-loader.js";

const now = new Date("2026-10-12T12:00:00.000Z");

function setup(leagueId = "premier_league") {
  const matches = ["2026-10-10", "2026-10-12"].map((date, index) => ({
    match_id: `match-${index}`, league_id: leagueId, season_id: leagueId === "chinese_super_league" ? "2026" : "2026_2027", kickoff_at: new Date(`${date}T10:00:00Z`),
    match_status: MatchStatus.Finished, settlement_status: SettlementStatus.Pending,
    result_version: 1, compared_providers: ["primary"], superseded_by: null,
  } as unknown as Match));
  const repo = {
    matches: { findActiveWindow: vi.fn(async () => matches) },
    matchProviderMappings: { findByProviderAndExternalId: vi.fn(async (_provider, id) => ({ match_id: id })) },
  } as unknown as AppRepository;
  const client = {
    getFixtures: vi.fn(async () => []),
    getResultComparisonSources: vi.fn(() => [
      { sourceId: "5d" as const, role: "secondary" as const },
      { sourceId: "of" as const, role: "secondary" as const },
      { sourceId: "sp" as const, role: "fallback" as const },
    ]),
    getFixturesFromSource: vi.fn(async (_source, _query) => []),
    recordComparisonSkipped: vi.fn(),
  };
  return { matches, repo, client };
}

describe("post-finish sequential batches", () => {
  it("recalculates unresolved dates after each applied source and excludes superseded records", async () => {
    const { matches, repo, client } = setup();
    matches.push({ ...matches[0]!, match_id: "old", kickoff_at: new Date("2026-09-01T10:00:00Z"), superseded_by: "match-0" });
    const batches = loadPostFinishBatches(repo, client, now);
    await batches.next();
    await batches.next();
    matches[0]!.compared_providers = [Provider.FootballData, Provider.OpenFoot];
    await batches.next();
    const calls = client.getFixturesFromSource.mock.calls;
    expect(calls.filter(([source]) => source === "5d").map(([, query]) => query.dateFrom)).toEqual(["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"]);
    expect(calls.filter(([source]) => source === "of").map(([, query]) => query.dateFrom)).toEqual(["2026-10-12", "2026-10-13"]);
    expect(calls.some(([source]) => source === "sp")).toBe(false);
  });

  it("continues after secondary failures, records diagnostics, and only then permits fallback", async () => {
    const { repo, client } = setup("chinese_super_league");
    client.getResultComparisonSources.mockReturnValue([
      { sourceId: "of", role: "secondary" }, { sourceId: "sp", role: "fallback" },
    ] as ReturnType<typeof client.getResultComparisonSources>);
    client.getFixturesFromSource.mockImplementation(async (source) => {
      if (source === "of") throw new Error("unavailable");
      return [];
    });
    for await (const _batch of loadPostFinishBatches(repo, client, now)) {}
    expect(client.recordComparisonSkipped).toHaveBeenCalled();
    expect(client.getFixturesFromSource.mock.calls.some(([source]) => source === "sp")).toBe(true);
  });

  it("tries the next secondary after an error and suppresses fallback after success", async () => {
    const { repo, client } = setup();
    client.getFixturesFromSource.mockImplementation(async (source) => {
      if (source === "5d") throw new Error("unavailable");
      return [];
    });
    for await (const _batch of loadPostFinishBatches(repo, client, now)) {}
    expect(client.recordComparisonSkipped).toHaveBeenCalled();
    expect(client.getFixturesFromSource.mock.calls.some(([source]) => source === "of")).toBe(true);
    expect(client.getFixturesFromSource.mock.calls.some(([source]) => source === "sp")).toBe(false);
  });

  it("does not treat repeated observations from one provider as agreement", async () => {
    const { matches, repo, client } = setup();
    matches[0]!.compared_providers = [Provider.FootballData, Provider.FootballData];
    matches[1]!.compared_providers = [Provider.FootballData, Provider.OpenFoot];
    for await (const _batch of loadPostFinishBatches(repo, client, now)) {}
    expect(client.getFixturesFromSource.mock.calls.map(([, query]) => query.dateFrom)).toEqual([
      "2026-10-10", "2026-10-11", "2026-10-10", "2026-10-11",
    ]);
  });
});
