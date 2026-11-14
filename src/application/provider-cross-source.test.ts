import { describe, expect, it, vi } from "vitest";
import { SUPPORTED_LEAGUES } from "../domain/config.js";
import { Provider, SyncJobType } from "../domain/enums.js";
import type { Match, MatchProviderMapping } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import type { ApiFootballFixture } from "../provider/types.js";
import { loadProviderSources } from "../provider/sources.js";
import { ensureCrossSourceMatchMapping } from "./provider-cross-source.js";
import { loadActiveWindowFixtures } from "./provider-window-loader.js";

const NOW = new Date("2026-10-12T12:00:00.000Z");
const MATCH_ID = "00000000-0000-4000-8000-000000000001";
const HOME_ID = "00000000-0000-4000-8000-000000000002";
const AWAY_ID = "00000000-0000-4000-8000-000000000003";

function fixture(overrides: Record<string, unknown> = {}) {
  return {
    provider: "5dollar" as const,
    providerMatchId: "provider-match-1",
    leagueProviderId: "4160026622",
    season: "2026",
    round: "1",
    homeTeamProviderId: "provider-home",
    homeTeamName: "Home",
    awayTeamProviderId: "provider-away",
    awayTeamName: "Away",
    kickoffAt: new Date(NOW),
    kickoffConfirmed: true,
    kickoffDeltaMs: 0,
    status: { kind: "scheduled", kickoffConfirmed: true } as const,
    fulltime: null,
    rawStatus: "NS",
    ...overrides,
  };
}

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    schema_version: 1,
    match_id: MATCH_ID,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: HOME_ID,
    away_team_id: AWAY_ID,
    kickoff_at: new Date(NOW),
    kickoff_confirmed: true,
    prediction_deadline_at: null,
    prediction_closed_at: null,
    period_anchor_at: null,
    match_status: "SCHEDULED" as Match["match_status"],
    settlement_status: "WAITING" as Match["settlement_status"],
    regular_home_score: null,
    regular_away_score: null,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 0,
    settled_result_version: 0,
    result_source: null,
    result_provider: null,
    scoring_rule_version: "scoring_v1",
    finish_detected_at: null,
    settled_at: null,
    created_at: new Date(NOW),
    updated_at: new Date(NOW),
    ...overrides,
  };
}

function makeRepo(options: {
  matches?: Match[];
  existingMapping?: { match_id: string } | null;
  missingTeam?: boolean;
  missingMatch?: boolean;
} = {}) {
  const snapshots = { insert: vi.fn(async () => undefined) };
  const matchMappings = {
    findByProviderAndExternalId: vi.fn(async () => options.existingMapping ?? null),
    insert: vi.fn(async () => undefined),
  };
  const teamMappings = {
    findByProviderAndExternalId: vi.fn(async (_provider: Provider, id: string) => {
      if (options.missingTeam) return null;
      if (id === "provider-home") return { team_id: HOME_ID };
      if (id === "provider-away") return { team_id: AWAY_ID };
      return null;
    }),
  };
  const matches = options.matches ?? [makeMatch()];
  const repo = {
    matches: {
      findBySeason: vi.fn(async () => matches),
      findById: vi.fn(async (id: string) => {
        if (options.missingMatch) return null;
        return matches.find((match) => match.match_id === id) ?? null;
      }),
    },
    matchProviderMappings: matchMappings,
    teamProviderMappings: teamMappings,
    providerSnapshots: snapshots,
  } as unknown as AppRepository;
  return { repo, snapshots, matchMappings, teamMappings };
}

describe("ensureCrossSourceMatchMapping", () => {
  it("loads the mapped match and verifies league, season and home/away identity", async () => {
    const { repo } = makeRepo({ existingMapping: { match_id: MATCH_ID } });
    await expect(ensureCrossSourceMatchMapping(repo, fixture(), NOW)).resolves.toEqual({
      match_id: MATCH_ID,
      reason: "mapped",
      season_id: "2026_2027",
      league_id: "premier_league",
      basis: "existing_mapping",
    });
  });

  it("rejects an existing mapping that points to a missing match", async () => {
    const { repo, matchMappings } = makeRepo({
      existingMapping: { match_id: MATCH_ID },
      missingMatch: true,
    });
    await expect(ensureCrossSourceMatchMapping(repo, fixture(), NOW)).resolves.toEqual({
      match_id: null,
      reason: "conflict",
      conflict_reason: "mapping_match_missing",
    });
    expect(matchMappings.insert).not.toHaveBeenCalled();
  });

  it("rejects an existing mapping that points to another league", async () => {
    const { repo, matchMappings } = makeRepo({
      existingMapping: { match_id: MATCH_ID },
      matches: [makeMatch({ league_id: "la_liga" })],
    });
    await expect(ensureCrossSourceMatchMapping(repo, fixture(), NOW)).resolves.toEqual({
      match_id: null,
      reason: "conflict",
      conflict_reason: "mapping_league_mismatch",
    });
    expect(matchMappings.insert).not.toHaveBeenCalled();
  });

  it("rejects an existing mapping that points to another season", async () => {
    const { repo, matchMappings } = makeRepo({
      existingMapping: { match_id: MATCH_ID },
      matches: [makeMatch({ season_id: "2025_2026" })],
    });
    await expect(ensureCrossSourceMatchMapping(repo, fixture(), NOW)).resolves.toEqual({
      match_id: null,
      reason: "conflict",
      conflict_reason: "mapping_season_mismatch",
    });
    expect(matchMappings.insert).not.toHaveBeenCalled();
  });

  it("treats an existing mapping outside the window candidates as out of window", async () => {
    const { repo, matchMappings } = makeRepo({ existingMapping: { match_id: MATCH_ID } });
    await expect(
      ensureCrossSourceMatchMapping(repo, fixture(), NOW, new Set(["00000000-0000-4000-8000-000000000099"])),
    ).resolves.toEqual({ match_id: null, reason: "out_of_window" });
    expect(matchMappings.insert).not.toHaveBeenCalled();
  });

  it("does not create a mapping for a unique identity outside the window candidates", async () => {
    const { repo, matchMappings } = makeRepo();
    await expect(
      ensureCrossSourceMatchMapping(repo, fixture(), NOW, new Set()),
    ).resolves.toEqual({ match_id: null, reason: "out_of_window" });
    expect(matchMappings.insert).not.toHaveBeenCalled();
  });

  it("inserts the unique local match mapping after team and kickoff matching", async () => {
    const { repo, matchMappings } = makeRepo();
    await expect(ensureCrossSourceMatchMapping(repo, fixture(), NOW)).resolves.toEqual({
      match_id: MATCH_ID,
      reason: "mapped",
      season_id: "2026_2027",
      league_id: "premier_league",
      basis: "unique_candidate",
    });
    expect(matchMappings.insert).toHaveBeenCalledTimes(1);
    expect(matchMappings.insert).toHaveBeenCalledWith(expect.objectContaining({
      match_id: MATCH_ID, provider: "5dollar", provider_match_id: "provider-match-1", created_at: NOW,
    }));
  });

  it("returns the unique candidate without writing mapping or snapshot when persist is false", async () => {
    const { repo, matchMappings, snapshots } = makeRepo();
    await expect(
      ensureCrossSourceMatchMapping(
        repo,
        fixture(),
        NOW,
        new Set([MATCH_ID]),
        undefined,
        { persist: false },
      ),
    ).resolves.toEqual({
      match_id: MATCH_ID,
      reason: "mapped",
      season_id: "2026_2027",
      league_id: "premier_league",
      basis: "unique_candidate",
    });
    expect(matchMappings.insert).not.toHaveBeenCalled();
    expect(snapshots.insert).not.toHaveBeenCalled();
  });

  it("does not resolve true identity ambiguity by window membership", async () => {
    const outOfWindowId = "00000000-0000-4000-8000-000000000010";
    const { repo, matchMappings } = makeRepo({
      matches: [makeMatch(), makeMatch({ match_id: outOfWindowId })],
    });
    await expect(
      ensureCrossSourceMatchMapping(repo, fixture(), NOW, new Set([MATCH_ID])),
    ).resolves.toEqual({ match_id: null, reason: "ambiguous" });
    expect(matchMappings.insert).not.toHaveBeenCalled();
  });

  it("keeps a clear existing external id mapping even when identity candidates are ambiguous", async () => {
    const { repo, matchMappings } = makeRepo({
      existingMapping: { match_id: MATCH_ID },
      matches: [makeMatch(), makeMatch({ match_id: "00000000-0000-4000-8000-000000000010" })],
    });
    await expect(
      ensureCrossSourceMatchMapping(repo, fixture(), NOW, new Set([MATCH_ID])),
    ).resolves.toEqual({
      match_id: MATCH_ID,
      reason: "mapped",
      season_id: "2026_2027",
      league_id: "premier_league",
      basis: "existing_mapping",
    });
    expect(matchMappings.insert).not.toHaveBeenCalled();
  });

  it("records a diagnostic snapshot when a provider team has no local mapping", async () => {
    const { repo, snapshots, matchMappings } = makeRepo({ missingTeam: true });
    await expect(ensureCrossSourceMatchMapping(repo, fixture(), NOW)).resolves.toEqual({ match_id: null, reason: "unlinked" });
    expect(matchMappings.insert).not.toHaveBeenCalled();
    expect(snapshots.insert).toHaveBeenCalledWith(expect.objectContaining({
      provider: "5dollar", event_type: "provider_error", provider_entity_id: "provider-match-1",
      payload: expect.objectContaining({ diag_code: "DIAG_PROVIDER_MATCH_UNLINKED", reason: "team_mapping_missing" }),
    }));
  });

  it("marks multiple local candidates ambiguous", async () => {
    const { repo, snapshots } = makeRepo({ matches: [
      makeMatch(), makeMatch({ match_id: "00000000-0000-4000-8000-000000000009" }),
    ] });
    await expect(ensureCrossSourceMatchMapping(repo, fixture(), NOW)).resolves.toEqual({ match_id: null, reason: "ambiguous" });
    expect(snapshots.insert).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ reason: "ambiguous" }),
    }));
  });

  it("records no_match for zero identity candidates even when window candidates are provided", async () => {
    const { repo, snapshots, matchMappings } = makeRepo({ matches: [] });
    await expect(
      ensureCrossSourceMatchMapping(repo, fixture(), NOW, new Set([MATCH_ID])),
    ).resolves.toEqual({ match_id: null, reason: "unlinked" });
    expect(matchMappings.insert).not.toHaveBeenCalled();
    expect(snapshots.insert).toHaveBeenCalledWith(expect.objectContaining({
      provider: "5dollar",
      provider_entity_id: "provider-match-1",
      payload: expect.objectContaining({
        diag_code: "DIAG_PROVIDER_MATCH_UNLINKED",
        reason: "no_match",
      }),
    }));
  });

  it.each([
    { label: "Premier League 30-minute boundary", provider: "5dollar" as const, league_id: "premier_league" as const, league_ref: "4160026622", tolerance: 30 * 60_000 },
    { label: "Chinese Super League 5-minute boundary", provider: "sportapi" as const, league_id: "chinese_super_league" as const, league_ref: "85", tolerance: 5 * 60_000 },
  ])("accepts the inclusive $label and rejects one millisecond beyond it", async ({ provider, league_id, league_ref, tolerance }) => {
    const localMatch = makeMatch({
      league_id,
      season_id: league_id === "premier_league" ? "2026_2027" : "2026",
      kickoff_at: new Date(NOW.getTime() + tolerance),
    });
    const atBoundary = makeRepo({ matches: [localMatch] });
    const input = fixture({ provider, leagueProviderId: league_ref, kickoffAt: NOW });
    await expect(ensureCrossSourceMatchMapping(atBoundary.repo, input, NOW)).resolves.toMatchObject({
      match_id: MATCH_ID,
      reason: "mapped",
      basis: "unique_candidate",
    });

    const outside = makeRepo({ matches: [makeMatch({ ...localMatch, kickoff_at: new Date(NOW.getTime() + tolerance + 1) })] });
    await expect(ensureCrossSourceMatchMapping(outside.repo, input, NOW)).resolves.toMatchObject({ match_id: null, reason: "unlinked" });
  });

  it("uses the configured source league override for cross-source matching", async () => {
    const config = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "5d",
      FOOTBALL_PROVIDER_KEY_5D: "5d-secret",
      FOOTBALL_PROVIDER_LEAGUE_REF_5D: JSON.stringify({ premier_league: "999" }),
      FOOTBALL_SYNC_LEAGUES: "premier_league",
    });
    const { repo, matchMappings } = makeRepo();
    const input = fixture({ leagueProviderId: "999" });
    await expect(ensureCrossSourceMatchMapping(repo, input, NOW, undefined, config.league_refs)).resolves.toEqual({
      match_id: MATCH_ID,
      reason: "mapped",
      season_id: "2026_2027",
      league_id: "premier_league",
      basis: "unique_candidate",
    });
    expect(matchMappings.insert).toHaveBeenCalledWith(expect.objectContaining({
      match_id: MATCH_ID,
      provider: "5dollar",
      provider_match_id: "provider-match-1",
    }));
  });

  it("does not fall back to a replaced static league ref when runtime mapping is provided", async () => {
    const config = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "5d",
      FOOTBALL_PROVIDER_KEY_5D: "5d-secret",
      FOOTBALL_PROVIDER_LEAGUE_REF_5D: JSON.stringify({ premier_league: "999" }),
      FOOTBALL_SYNC_LEAGUES: "premier_league",
    });
    const { repo, matchMappings } = makeRepo();
    await expect(ensureCrossSourceMatchMapping(
      repo,
      fixture({ leagueProviderId: "4160026622" }),
      NOW,
      undefined,
      config.league_refs,
    )).resolves.toEqual({ match_id: null, reason: "unlinked" });
    expect(matchMappings.insert).not.toHaveBeenCalled();
  });

  it("keeps using the original runtime mapping after another configuration loads", async () => {
    const first = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "5d",
      FOOTBALL_PROVIDER_KEY_5D: "5d-secret",
      FOOTBALL_PROVIDER_LEAGUE_REF_5D: JSON.stringify({ premier_league: "999" }),
      FOOTBALL_SYNC_LEAGUES: "premier_league",
    });
    loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "5d",
      FOOTBALL_PROVIDER_KEY_5D: "5d-secret",
      FOOTBALL_PROVIDER_LEAGUE_REF_5D: JSON.stringify({ premier_league: "888" }),
      FOOTBALL_SYNC_LEAGUES: "premier_league",
    });
    const { repo } = makeRepo();
    await expect(ensureCrossSourceMatchMapping(
      repo,
      fixture({ leagueProviderId: "999" }),
      NOW,
      undefined,
      first.league_refs,
    )).resolves.toEqual({
      match_id: MATCH_ID,
      reason: "mapped",
      season_id: "2026_2027",
      league_id: "premier_league",
      basis: "unique_candidate",
    });
  });
});

describe("loadActiveWindowFixtures provider-scoped external ids", () => {
  const league = SUPPORTED_LEAGUES[0]!;
  const inWindowId = "00000000-0000-4000-8000-000000000101";
  const outOfWindowId = "00000000-0000-4000-8000-000000000102";
  const sharedExternalId = "7001";

  function mappingFor(
    matchId: string,
    provider: Provider,
    providerMatchId: string,
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

  function fixtureFor(provider: Provider): ApiFootballFixture {
    return { fixture: { id: sharedExternalId }, provider } as ApiFootballFixture;
  }

  function repoFor(
    rows: MatchProviderMapping[],
    matches: Match[],
  ): { repo: AppRepository; findByProviderAndExternalIds: ReturnType<typeof vi.fn> } {
    const findByProviderAndExternalIds = vi.fn(async (
      provider: Provider,
      externalIds: readonly string[],
    ) => {
      const found = new Map<string, MatchProviderMapping>();
      for (const externalId of externalIds) {
        const row = rows.find(
          (item) => item.provider === provider && item.provider_match_id === externalId,
        );
        if (row !== undefined) found.set(externalId, row);
      }
      return found;
    });
    const repo = {
      matches: { findActiveWindow: vi.fn(async () => matches) },
      matchProviderMappings: {
        findByProviderAndExternalId: vi.fn(async () => null),
        findByProviderAndExternalIds,
      },
    } as unknown as AppRepository;
    return { repo, findByProviderAndExternalIds };
  }

  it.each([
    { label: "5dollar fixture first", fixtureOrder: [Provider.FiveDollar, Provider.SportApi] },
    { label: "sportapi fixture first", fixtureOrder: [Provider.SportApi, Provider.FiveDollar] },
  ])("judges each shared external id by provider, regardless of return order ($label)", async ({ fixtureOrder }) => {
    const rows = [
      mappingFor(inWindowId, Provider.FiveDollar, sharedExternalId),
      mappingFor(outOfWindowId, Provider.SportApi, sharedExternalId),
    ];
    const matches = [
      makeMatch({ match_id: inWindowId, league_id: league.league_id, season_id: league.season_id }),
    ];
    const { repo, findByProviderAndExternalIds } = repoFor(rows, matches);
    const fixtures = fixtureOrder.map(fixtureFor);

    const result = await loadActiveWindowFixtures(
      repo,
      { getFixtures: vi.fn(async () => fixtures) },
      SyncJobType.LiveMatch,
      NOW,
    );

    expect(findByProviderAndExternalIds).toHaveBeenCalledTimes(2);
    expect(result.map((item) => item.fixture.provider)).toEqual([Provider.FiveDollar]);
  });
});
