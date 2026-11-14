import { describe, expect, it, vi } from "vitest";
import { SUPPORTED_LEAGUES } from "../domain/config.js";
import { MatchStatus, Provider, SettlementStatus, SyncJobType } from "../domain/enums.js";
import type { Match, MatchProviderMapping } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import type { ApiFootballFixture } from "../provider/types.js";
import { loadActiveWindowFixtures } from "./provider-window-loader.js";

const NOW = new Date("2026-10-11T12:00:00.000Z");
const LEAGUE = SUPPORTED_LEAGUES[0]!;

function mappedMatch(matchId: string, leagueId = LEAGUE.league_id): Match {
  return {
    league_id: leagueId,
    match_id: matchId,
    kickoff_at: new Date(NOW.getTime() - 60 * 60_000),
    match_status: MatchStatus.Scheduled,
    settlement_status: SettlementStatus.Pending,
    finish_detected_at: null,
  } as Match;
}

function fixture(id: string | number, provider?: ApiFootballFixture["provider"]): ApiFootballFixture {
  return { fixture: { id }, provider } as ApiFootballFixture;
}

function mapping(
  matchId: string,
  providerMatchId: string,
  provider: MatchProviderMapping["provider"] = Provider.ApiFootball,
): MatchProviderMapping {
  return {
    schema_version: 1,
    match_id: matchId,
    provider,
    provider_match_id: providerMatchId,
    created_at: NOW,
    updated_at: NOW,
  };
}

function createMappings(rows: MatchProviderMapping[], mode: "batch" | "sequential") {
  const findByProviderAndExternalId = vi.fn(async (
    provider: MatchProviderMapping["provider"],
    providerMatchId: string,
  ) => rows.find((row) => row.provider === provider && row.provider_match_id === providerMatchId) ?? null);
  const findByProviderAndExternalIds = vi.fn(async (
    provider: MatchProviderMapping["provider"],
    providerMatchIds: readonly string[],
  ) => {
    const found = new Map<string, MatchProviderMapping>();
    for (const id of providerMatchIds) {
      const row = rows.find((item) => item.provider === provider && item.provider_match_id === id);
      if (row) found.set(id, row);
    }
    return found;
  });
  const matchProviderMappings = mode === "batch"
    ? { findByProviderAndExternalId, findByProviderAndExternalIds }
    : { findByProviderAndExternalId };
  return { matchProviderMappings, findByProviderAndExternalId, findByProviderAndExternalIds };
}

function repoWith(
  matches: Match[],
  mappings: ReturnType<typeof createMappings>["matchProviderMappings"],
): AppRepository {
  return {
    matches: { findActiveWindow: async () => matches },
    matchProviderMappings: mappings,
  } as unknown as AppRepository;
}

describe("loadActiveWindowFixtures batch mapping (RP11)", () => {
  it("一个 league 返回 5 个 fixture 时只批量查 1 次，不走逐场查询", async () => {
    const rows = [1, 2, 3, 4, 5].map((i) => mapping(`match-${i}`, `ext-${i}`));
    const matches = rows.map((row) => mappedMatch(row.match_id));
    const fixtures = rows.map((row) => fixture(row.provider_match_id));
    const { matchProviderMappings, findByProviderAndExternalId, findByProviderAndExternalIds } =
      createMappings(rows, "batch");
    const client = { getFixtures: vi.fn(async () => fixtures) };

    const result = await loadActiveWindowFixtures(
      repoWith(matches, matchProviderMappings),
      client,
      SyncJobType.LiveMatch,
      NOW,
    );

    expect(findByProviderAndExternalIds).toHaveBeenCalledTimes(1);
    expect(findByProviderAndExternalIds.mock.calls[0]?.[0]).toBe(Provider.ApiFootball);
    expect(findByProviderAndExternalIds.mock.calls[0]?.[1]).toEqual(["ext-1", "ext-2", "ext-3", "ext-4", "ext-5"]);
    expect(findByProviderAndExternalId).toHaveBeenCalledTimes(0);
    expect(result).toEqual(
      fixtures.map((item) => ({
        candidateMatchIds: ["match-1", "match-2", "match-3", "match-4", "match-5"],
        fixture: item,
        payload: { fixture: item },
      })),
    );
  });

  it("批量查询与逐条查询产出的 payload 数组相等", async () => {
    const rows = [
      mapping("match-1", "ext-1"),
      mapping("match-2", "ext-2"),
      mapping("match-3", "ext-3"),
    ];
    const matches = rows.map((row) => mappedMatch(row.match_id));
    const fixtures = [fixture("ext-1"), fixture("ext-2"), fixture("ext-missing"), fixture("ext-3"), fixture("ext-other")];
    const batch = createMappings(rows, "batch");
    const sequential = createMappings(rows, "sequential");
    const client = { getFixtures: vi.fn(async () => fixtures) };

    const batched = await loadActiveWindowFixtures(
      repoWith(matches, batch.matchProviderMappings),
      client,
      SyncJobType.LiveMatch,
      NOW,
    );
    const oneByOne = await loadActiveWindowFixtures(
      repoWith(matches, sequential.matchProviderMappings),
      client,
      SyncJobType.LiveMatch,
      NOW,
    );

    expect(batched).toEqual(oneByOne);
    expect(batched).toHaveLength(3);
  });

  it("批量方法缺失时退化为逐条查询且结果不变", async () => {
    const rows = [1, 2, 3, 4, 5].map((i) => mapping(`match-${i}`, `ext-${i}`));
    const matches = rows.map((row) => mappedMatch(row.match_id));
    const fixtures = rows.map((row) => fixture(row.provider_match_id));
    const sequential = createMappings(rows, "sequential");
    const batch = createMappings(rows, "batch");
    const client = { getFixtures: vi.fn(async () => fixtures) };

    const fallback = await loadActiveWindowFixtures(
      repoWith(matches, sequential.matchProviderMappings),
      client,
      SyncJobType.LiveMatch,
      NOW,
    );
    const batched = await loadActiveWindowFixtures(
      repoWith(matches, batch.matchProviderMappings),
      client,
      SyncJobType.LiveMatch,
      NOW,
    );

    expect(sequential.findByProviderAndExternalId).toHaveBeenCalledTimes(5);
    expect(sequential.findByProviderAndExternalIds).toHaveBeenCalledTimes(0);
    expect(fallback).toEqual(batched);
    expect(fallback).toHaveLength(5);
  });

  it("一个 league 混有 5dollar 与 api_football 时按 provider 分组各查一次", async () => {
    const rows = [
      mapping("match-1", "ext-1", Provider.ApiFootball),
      mapping("match-2", "ext-2", Provider.FiveDollar),
      mapping("match-3", "ext-3", Provider.ApiFootball),
      mapping("match-4", "ext-4", Provider.FiveDollar),
      mapping("match-5", "ext-5", Provider.ApiFootball),
    ];
    const matches = rows.map((row) => mappedMatch(row.match_id));
    const fixtures = [
      fixture("ext-1"),
      fixture("ext-2", "5dollar"),
      fixture("ext-3"),
      fixture("ext-4", "5dollar"),
      fixture("ext-5"),
    ];
    const { matchProviderMappings, findByProviderAndExternalId, findByProviderAndExternalIds } =
      createMappings(rows, "batch");
    const client = { getFixtures: vi.fn(async () => fixtures) };

    const result = await loadActiveWindowFixtures(
      repoWith(matches, matchProviderMappings),
      client,
      SyncJobType.LiveMatch,
      NOW,
    );

    expect(findByProviderAndExternalIds).toHaveBeenCalledTimes(2);
    expect(findByProviderAndExternalIds.mock.calls.map((call) => call[0]).sort()).toEqual(
      [Provider.ApiFootball, Provider.FiveDollar].sort(),
    );
    expect(findByProviderAndExternalId).toHaveBeenCalledTimes(0);
    expect(result).toHaveLength(5);
  });
});
