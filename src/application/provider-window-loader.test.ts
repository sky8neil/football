import { describe, expect, it, vi } from "vitest";
import { SUPPORTED_LEAGUES } from "../domain/config.js";
import { MatchStatus, Provider, SettlementStatus, SyncJobType } from "../domain/enums.js";
import type { Match } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import type { ApiFootballFixturesQuery } from "../provider/http.js";
import { loadActiveWindowFixtures } from "./provider-window-loader.js";

const NOW = new Date("2026-10-11T12:00:00.000Z");

function mappedMatch(leagueId: string, kickoffAt: Date, overrides: Partial<Match> = {}): Match {
  return {
    league_id: leagueId,
    match_id: "match-id",
    kickoff_at: kickoffAt,
    match_status: MatchStatus.Scheduled,
    settlement_status: SettlementStatus.Pending,
    finish_detected_at: null,
    ...overrides,
  } as Match;
}

function repository(match: Match | null, provider: Provider, providerMatchId: string): AppRepository {
  const matchId = "match-id";
  return {
    matches: { findActiveWindow: async () => (match ? [match] : []) },
    matchProviderMappings: {
      findByMatchId: async () => match ? [{ match_id: matchId, provider, provider_match_id: providerMatchId }] : [],
      findByProviderAndExternalId: async () => match ? { match_id: matchId } : null,
    },
  } as unknown as AppRepository;
}

function repositoryForMatches(matches: Match[]): AppRepository {
  return {
    matches: { findActiveWindow: async () => matches },
    matchProviderMappings: { findByProviderAndExternalId: async () => null },
  } as unknown as AppRepository;
}

async function queryForMatches(
  matches: Match[],
  jobType: typeof SyncJobType.LiveMatch | typeof SyncJobType.NearMatch | typeof SyncJobType.PostFinishVerify,
): Promise<ApiFootballFixturesQuery | undefined> {
  const client = { getFixtures: vi.fn(async (_query: ApiFootballFixturesQuery) => []) };
  await loadActiveWindowFixtures(repositoryForMatches(matches), client, jobType, NOW);
  return client.getFixtures.mock.calls[0]?.[0];
}

describe("loadActiveWindowFixtures", () => {
  it("makes zero provider calls when the local league has no active match", async () => {
    const client = { getFixtures: vi.fn(async () => []) };
    const repo = repository(null, Provider.FootballData, "fd-1");
    await expect(loadActiveWindowFixtures(repo, client, SyncJobType.LiveMatch, NOW)).resolves.toEqual([]);
    expect(client.getFixtures).not.toHaveBeenCalled();
  });

  it("不再整赛季读取，改为 findActiveWindow", async () => {
    const localMatch = mappedMatch("premier_league", new Date(NOW.getTime() - 60 * 60_000));
    const findBySeason = vi.fn(async () => [localMatch]);
    const findActiveWindow = vi.fn(async () => [localMatch]);
    const repo = {
      matches: { findBySeason, findActiveWindow },
      matchProviderMappings: {
        findByMatchId: async () => [{ match_id: "match-id", provider: Provider.FootballData, provider_match_id: "external-1" }],
        findByProviderAndExternalId: async () => ({ match_id: "match-id" }),
      },
    } as unknown as AppRepository;
    const client = { getFixtures: vi.fn(async () => [{ fixture: { id: "external-1" } } as any]) };

    await loadActiveWindowFixtures(repo, client, SyncJobType.LiveMatch, NOW);

    expect(findBySeason).toHaveBeenCalledTimes(0);
    expect(findActiveWindow).toHaveBeenCalledTimes(1);
    expect(findActiveWindow).toHaveBeenCalledWith({
      jobType: SyncJobType.LiveMatch,
      now: NOW,
      limit: 500,
    });
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

  it("computes fixture date ranges independently for each league", async () => {
    const historicalKickoff = new Date(NOW.getTime() - 90 * 24 * 60 * 60_000);
    const leagueAMatch = mappedMatch("premier_league", historicalKickoff);
    const leagueBMatch = mappedMatch("la_liga", new Date(NOW.getTime() - 60 * 60_000));
    const repo = {
      matches: { findActiveWindow: async () => [leagueAMatch, leagueBMatch] },
      matchProviderMappings: { findByProviderAndExternalId: async () => null },
    } as unknown as AppRepository;
    const requests: ApiFootballFixturesQuery[] = [];
    const client = {
      getFixtures: vi.fn(async (query: ApiFootballFixturesQuery) => {
        requests.push(query);
        return [];
      }),
    };

    await loadActiveWindowFixtures(repo, client, SyncJobType.LiveMatch, NOW);

    const requestA = requests.find((query) => query.leagueId === SUPPORTED_LEAGUES[0]!.api_football_league_id);
    const requestB = requests.find((query) => query.leagueId === SUPPORTED_LEAGUES[1]!.api_football_league_id);
    expect(requestA?.dateFrom).toBe(historicalKickoff.toISOString().slice(0, 10));
    expect(requestB?.dateFrom).toBe(new Date(NOW.getTime() - 24 * 60 * 60_000).toISOString().slice(0, 10));
  });

  it("requests post-finish secondary dates from unchecked kickoff days and their next days", async () => {
    const query = await queryForMatches([
      mappedMatch("premier_league", new Date("2026-10-10T23:30:00.000Z")),
      mappedMatch("premier_league", new Date("2026-10-12T02:00:00.000Z")),
    ], SyncJobType.PostFinishVerify);

    expect(query?.secondaryDates).toEqual(["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"]);
  });

  it("excludes already matching dual-source results from secondary dates", async () => {
    const query = await queryForMatches([
      mappedMatch("premier_league", new Date("2026-10-10T23:30:00.000Z"), {
        result_version: 1,
        compared_providers: [Provider.FootballData, Provider.OpenFoot],
      }),
      mappedMatch("premier_league", new Date("2026-10-12T02:00:00.000Z")),
    ], SyncJobType.PostFinishVerify);

    expect(query?.secondaryDates).toEqual(["2026-10-12", "2026-10-13"]);
  });

  it("passes an empty secondary date list when every candidate has matching dual-source results", async () => {
    const query = await queryForMatches([
      mappedMatch("premier_league", new Date("2026-10-10T23:30:00.000Z"), {
        result_version: 1,
        compared_providers: [Provider.FootballData, Provider.OpenFoot],
      }),
      mappedMatch("premier_league", new Date("2026-10-12T02:00:00.000Z"), {
        result_version: 2,
        compared_providers: [Provider.FootballData, Provider.OpenFoot],
      }),
    ], SyncJobType.PostFinishVerify);

    expect(query?.secondaryDates).toEqual([]);
  });

  it.each([SyncJobType.LiveMatch, SyncJobType.NearMatch] as const)("does not pass secondary dates for %s", async (jobType) => {
    const query = await queryForMatches([
      mappedMatch("premier_league", new Date("2026-10-10T23:30:00.000Z")),
    ], jobType);

    expect(query).not.toHaveProperty("secondaryDates");
  });
});
