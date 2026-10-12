import { describe, expect, it, vi } from "vitest";
import { SUPPORTED_LEAGUES } from "../domain/config.js";
import { MatchStatus, Provider, SettlementStatus, SyncJobType } from "../domain/enums.js";
import type { Match } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { loadActiveWindowFixtures } from "./provider-window-loader.js";

const NOW = new Date("2026-10-11T12:00:00.000Z");

function mappedMatch(leagueId: string, kickoffAt: Date): Match {
  return {
    league_id: leagueId,
    kickoff_at: kickoffAt,
    match_status: MatchStatus.Scheduled,
    settlement_status: SettlementStatus.Pending,
    finish_detected_at: null,
  } as Match;
}

function repository(match: Match | null, provider: Provider, providerMatchId: string): AppRepository {
  const matchId = "match-id";
  return {
    matches: { findBySeason: async () => match ? [match] : [] },
    matchProviderMappings: {
      findByMatchId: async () => match ? [{ match_id: matchId, provider, provider_match_id: providerMatchId }] : [],
    },
  } as unknown as AppRepository;
}

describe("loadActiveWindowFixtures", () => {
  it("makes zero provider calls when the local league has no active match", async () => {
    const client = { getFixtures: vi.fn(async () => []) };
    const repo = repository(null, Provider.FootballData, "fd-1");
    await expect(loadActiveWindowFixtures(repo, client, SyncJobType.LiveMatch, NOW)).resolves.toEqual([]);
    expect(client.getFixtures).not.toHaveBeenCalled();
  });

  it.each([
    ["premier_league", Provider.FootballData, SUPPORTED_LEAGUES[0]!.api_football_league_id],
    ["chinese_super_league", Provider.Bsd, SUPPORTED_LEAGUES[5]!.api_football_league_id],
  ] as const)("batches one date range request for %s", async (leagueId, provider, requestLeagueId) => {
    const localMatch = mappedMatch(leagueId, new Date(NOW.getTime() - 60 * 60_000));
    const repo = repository(localMatch, provider, "external-1");
    const fixture = { fixture: { id: "external-1" } } as any;
    const client = { getFixtures: vi.fn(async () => [fixture]) };

    await expect(loadActiveWindowFixtures(repo, client, SyncJobType.LiveMatch, NOW)).resolves.toEqual([
      { fixture, payload: { fixture } },
    ]);
    expect(client.getFixtures).toHaveBeenCalledTimes(1);
    expect(client.getFixtures).toHaveBeenCalledWith(expect.objectContaining({
      leagueId: requestLeagueId,
      dateFrom: "2026-10-10",
      dateTo: "2026-10-12",
      jobType: SyncJobType.LiveMatch,
      serverNow: NOW,
    }));
  });
});
