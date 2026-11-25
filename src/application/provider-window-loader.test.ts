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
    season_id: leagueId === "chinese_super_league" ? "2026" : "2026_2027",
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

describe("loadActiveWindowFixtures", () => {
  it("同一联赛的不同赛季分别请求各自的目标季", async () => {
    const matches = [
      mappedMatch("premier_league", NOW, { match_id: "old", season_id: "2025_2026" }),
      mappedMatch("premier_league", NOW, { match_id: "new", season_id: "2026_2027" }),
    ];
    const repo = { matches: { findActiveWindow: async () => matches }, matchProviderMappings: {} } as unknown as AppRepository;
    const client = { getFixtures: vi.fn(async (_query: ApiFootballFixturesQuery) => []) };
    await loadActiveWindowFixtures(repo, client, SyncJobType.LiveMatch, NOW);
    expect(client.getFixtures.mock.calls.map(([query]) => query)).toEqual([
      expect.objectContaining({ season: "2025", seasonId: "2025_2026" }),
      expect.objectContaining({ season: "2026", seasonId: "2026_2027" }),
    ]);
  });
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
      { fixture, payload: { fixture }, seasonId: leagueId === "chinese_super_league" ? "2026" : "2026_2027" },
    ]);
    expect(client.getFixtures).toHaveBeenCalledTimes(1);
    expect(client.getFixtures).toHaveBeenCalledWith(expect.objectContaining({
      leagueId: requestLeagueId,
      dateFrom: "2026-10-11",
      dateTo: "2026-10-11",
      jobType: SyncJobType.LiveMatch,
      serverNow: NOW,
    }));
  });

  it("computes fixture date ranges independently for each league", async () => {
    const historicalKickoff = new Date(NOW.getTime() - 90 * 24 * 60 * 60_000);
    const leagueAMatch = mappedMatch("premier_league", historicalKickoff, { match_id: "league-a" });
    const leagueBMatch = mappedMatch("la_liga", new Date(NOW.getTime() - 60 * 60_000), { match_id: "league-b-first" });
    const leagueBNextMatch = mappedMatch("la_liga", new Date(NOW.getTime() + 30 * 60 * 60_000), { match_id: "league-b-last" });
    const repo = {
      matches: { findActiveWindow: async () => [leagueAMatch, leagueBNextMatch, leagueBMatch] },
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
    expect(requestA?.dateTo).toBe(historicalKickoff.toISOString().slice(0, 10));
    expect(requestB?.dateFrom).toBe(leagueBMatch.kickoff_at.toISOString().slice(0, 10));
    expect(requestB?.dateTo).toBe(leagueBNextMatch.kickoff_at.toISOString().slice(0, 10));
  });

  it("requests fixture ranges for post-finish days and their next days", async () => {
    const requests: ApiFootballFixturesQuery[] = [];
    const repo = {
      matches: { findActiveWindow: async () => [mappedMatch("premier_league", new Date("2026-10-10T23:30:00.000Z"))] },
      matchProviderMappings: { findByProviderAndExternalId: async () => null },
    } as unknown as AppRepository;
    await loadActiveWindowFixtures(repo, {
      getFixtures: async (query) => { requests.push(query); return []; },
    }, SyncJobType.PostFinishVerify, NOW);

    expect(requests[0]?.dateFrom).toBe("2026-10-10");
    expect(requests[0]?.dateTo).toBe("2026-10-10");
    expect(requests[0]).not.toHaveProperty("secondaryDates");
  });

  it("单联赛异常时按联赛隔离，保留健康联赛数据并仅在全败时上抛 (A-S3-05)", async () => {
    const matches = [
      mappedMatch("premier_league", new Date(NOW.getTime() - 60_000), { match_id: "m-pl" }),
      mappedMatch("la_liga", new Date(NOW.getTime() - 60_000), { match_id: "m-pd" }),
    ];
    const mappings: Record<string, string> = { "ext-pl": "m-pl", "ext-pd": "m-pd" };
    const repo = {
      matches: { findActiveWindow: async () => matches },
      matchProviderMappings: {
        findByProviderAndExternalId: async (_provider: Provider, extId: string) =>
          mappings[extId] ? { match_id: mappings[extId]! } : null,
      },
    } as unknown as AppRepository;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const items = await loadActiveWindowFixtures(repo, {
        getFixtures: async (query) => {
          if (query.leagueId === "140") throw new Error("la liga timeout");
          return [{ fixture: { id: "ext-pl" } } as any];
        },
      }, SyncJobType.LiveMatch, NOW);
      expect(items.map((item) => item.fixture.fixture.id)).toEqual(["ext-pl"]);

      await expect(loadActiveWindowFixtures(repo, {
        getFixtures: async () => { throw new Error("all down"); },
      }, SyncJobType.LiveMatch, NOW)).rejects.toThrow("all down");
    } finally {
      warn.mockRestore();
    }
  });

  it("fixturesToItems 对命中 M_old 的已有映射经 resolveEffectiveMatchesByIds 解析到有效 M_new (A-S3-04)", async () => {
    const oldMatch = mappedMatch("premier_league", NOW, { match_id: "m-old", superseded_by: "m-new" } as Partial<Match>);
    const newMatch = mappedMatch("premier_league", NOW, { match_id: "m-new", superseded_by: null } as Partial<Match>);
    const byId = new Map([["m-old", oldMatch], ["m-new", newMatch]]);
    const repo = {
      matches: {
        findActiveWindow: async () => [newMatch],
        findById: async (id: string) => byId.get(id) ?? null,
      },
      matchProviderMappings: {
        findByProviderAndExternalId: async (_provider: Provider, extId: string) =>
          extId === "of-old" ? { match_id: "m-old" } : null,
      },
    } as unknown as AppRepository;
    const ofFixture = { fixture: { id: "of-old" }, provider: Provider.OpenFoot } as any;
    const items = await loadActiveWindowFixtures(repo, {
      getFixtures: async () => [ofFixture],
    }, SyncJobType.PostFinishVerify, NOW);
    expect(items).toHaveLength(1);
    expect(items[0]?.fixture.fixture.id).toBe("of-old");
  });
});
