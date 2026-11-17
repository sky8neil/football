import { afterEach, describe, expect, it, vi } from "vitest";
import { Provider } from "../domain/enums.js";
import type { Match } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { loadProviderSources } from "../provider/sources.js";
import { ensureCrossSourceMatchMapping } from "./provider-cross-source.js";
import { decideProviderResultAdoption } from "./provider-result-adoption.js";

const NOW = new Date("2026-10-12T12:00:00.000Z");
const MATCH_ID = "00000000-0000-4000-8000-000000000001";
const HOME_ID = "00000000-0000-4000-8000-000000000002";
const AWAY_ID = "00000000-0000-4000-8000-000000000003";

afterEach(() => vi.restoreAllMocks());

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
  const canonicalMatchIdentity = overrides.match_id ?? (MATCH_ID);
  return {
    schema_version: 1,
    match_id: canonicalMatchIdentity,
    canonical_match_id: overrides.canonical_match_id ?? canonicalMatchIdentity,
    superseded_by: overrides.superseded_by ?? null,
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
  missingTeamIds?: string[];
} = {}) {
  const snapshots = { insert: vi.fn(async () => undefined) };
  const matchMappings = {
    findByProviderAndExternalId: vi.fn(async () => options.existingMapping ?? null),
    insert: vi.fn(async () => undefined),
  };
  const teamMappings = {
    findByProviderAndExternalId: vi.fn(async (_provider: Provider, id: string) => {
      if (options.missingTeam || options.missingTeamIds?.includes(id)) return null;
      if (id === "provider-home") return { team_id: HOME_ID };
      if (id === "provider-away") return { team_id: AWAY_ID };
      return null;
    }),
  };
  const repo = {
    matches: { findBySeason: vi.fn(async () => options.matches ?? [makeMatch()]) },
    matchProviderMappings: matchMappings,
    teamProviderMappings: teamMappings,
    providerSnapshots: snapshots,
  } as unknown as AppRepository;
  return { repo, snapshots, matchMappings, teamMappings };
}

async function loadFreshEnsureCrossSourceMatchMapping() {
  vi.resetModules();
  return (await import("./provider-cross-source.js")).ensureCrossSourceMatchMapping;
}

describe("ensureCrossSourceMatchMapping", () => {
  it("显式目标季用于候选查找，未指定时使用当前赛季", async () => {
    const old = makeRepo({ matches: [makeMatch({ season_id: "2023_2024" })] });
    await expect(ensureCrossSourceMatchMapping(old.repo, fixture(), NOW, undefined, undefined, "2023_2024")).resolves.toMatchObject({ match_id: MATCH_ID });
    expect(old.repo.matches.findBySeason).toHaveBeenCalledWith("2023_2024");
    const current = makeRepo();
    await ensureCrossSourceMatchMapping(current.repo, fixture(), NOW);
    expect(current.repo.matches.findBySeason).toHaveBeenCalledWith("2026_2027");
  });
  it("returns an existing match mapping without looking up teams", async () => {
    const { repo, teamMappings } = makeRepo({ existingMapping: { match_id: "known-match" } });
    await expect(ensureCrossSourceMatchMapping(repo, fixture(), NOW)).resolves.toEqual({ match_id: "known-match", reason: "mapped" });
    expect(teamMappings.findByProviderAndExternalId).not.toHaveBeenCalled();
  });

  it("inserts the unique local match mapping after team and kickoff matching", async () => {
    const { repo, matchMappings } = makeRepo();
    await expect(ensureCrossSourceMatchMapping(repo, fixture(), NOW)).resolves.toEqual({ match_id: MATCH_ID, reason: "mapped" });
    expect(matchMappings.insert).toHaveBeenCalledWith(expect.objectContaining({
      match_id: MATCH_ID, provider: "5dollar", provider_match_id: "provider-match-1", created_at: NOW,
    }));
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

  it("warns once for the same unmapped provider team across fixtures and records each snapshot", async () => {
    const ensureWithFreshModule = await loadFreshEnsureCrossSourceMatchMapping();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { repo, snapshots } = makeRepo({ missingTeamIds: ["provider-home"] });

    await ensureWithFreshModule(repo, fixture({ homeTeamName: undefined }), NOW);
    await ensureWithFreshModule(repo, fixture({ providerMatchId: "provider-match-2" }), NOW);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[team_mapping_missing]", {
      league_id: "4160026622",
      provider: "5dollar",
      provider_team_id: "provider-home",
      team_name: null,
      side: "home",
      provider_match_id: "provider-match-1",
      season: "2026",
    });
    expect(snapshots.insert).toHaveBeenCalledTimes(2);
  });

  it("warns separately for missing home and away team mappings with structured details", async () => {
    const ensureWithFreshModule = await loadFreshEnsureCrossSourceMatchMapping();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { repo } = makeRepo({ missingTeam: true });

    await ensureWithFreshModule(repo, fixture(), NOW);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, "[team_mapping_missing]", {
      league_id: "4160026622",
      provider: "5dollar",
      provider_team_id: "provider-home",
      team_name: "Home",
      side: "home",
      provider_match_id: "provider-match-1",
      season: "2026",
    });
    expect(warn).toHaveBeenNthCalledWith(2, "[team_mapping_missing]", {
      league_id: "4160026622",
      provider: "5dollar",
      provider_team_id: "provider-away",
      team_name: "Away",
      side: "away",
      provider_match_id: "provider-match-1",
      season: "2026",
    });
  });

  it("does not warn when both provider team mappings exist", async () => {
    const ensureWithFreshModule = await loadFreshEnsureCrossSourceMatchMapping();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { repo } = makeRepo();

    await ensureWithFreshModule(repo, fixture(), NOW);

    expect(warn).not.toHaveBeenCalled();
  });

  it("deduplicates warnings independently for each provider", async () => {
    const ensureWithFreshModule = await loadFreshEnsureCrossSourceMatchMapping();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { repo } = makeRepo({ missingTeamIds: ["provider-home"] });

    await ensureWithFreshModule(repo, fixture(), NOW);
    await ensureWithFreshModule(repo, fixture({ provider: "sportapi", leagueProviderId: "85" }), NOW);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, "[team_mapping_missing]", expect.objectContaining({
      provider: "5dollar",
      provider_team_id: "provider-home",
    }));
    expect(warn).toHaveBeenNthCalledWith(2, "[team_mapping_missing]", expect.objectContaining({
      provider: "sportapi",
      provider_team_id: "provider-home",
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

  it.each([
    { label: "Premier League 30-minute boundary", provider: "5dollar" as const, league_id: "premier_league" as const, league_ref: "4160026622", tolerance: 30 * 60_000 },
    { label: "Chinese Super League 90-minute boundary", provider: "sportapi" as const, league_id: "chinese_super_league" as const, league_ref: "85", tolerance: 90 * 60_000 },
  ])("accepts the inclusive $label and rejects one millisecond beyond it", async ({ provider, league_id, league_ref, tolerance }) => {
    const localMatch = makeMatch({
      league_id,
      season_id: league_id === "premier_league" ? "2026_2027" : "2026",
      kickoff_at: new Date(NOW.getTime() + tolerance),
    });
    const atBoundary = makeRepo({ matches: [localMatch] });
    const input = fixture({ provider, leagueProviderId: league_ref, kickoffAt: NOW });
    await expect(ensureCrossSourceMatchMapping(atBoundary.repo, input, NOW)).resolves.toMatchObject({ match_id: MATCH_ID, reason: "mapped" });

    const outside = makeRepo({ matches: [makeMatch({ ...localMatch, kickoff_at: new Date(NOW.getTime() + tolerance + 1) })] });
    await expect(ensureCrossSourceMatchMapping(outside.repo, input, NOW)).resolves.toMatchObject({ match_id: null, reason: "unlinked" });
  });

  it("中超按 90 分钟容忍度对齐 openfoot 的夏令时偏移", async () => {
    // 回归保护：openfoot 对不实行夏令时的联赛错误套用欧洲夏令时，
    // 导致 DST 窗口内 kickoff 晚整 60 分钟。见 provider-cross-source.ts 常量注释。
    const localMatch = makeMatch({
      league_id: "chinese_super_league",
      season_id: "2026",
      kickoff_at: NOW,
    });
    const { repo, matchMappings } = makeRepo({ matches: [localMatch] });
    const input = fixture({
      provider: "openfoot" as const,
      leagueProviderId: "comp_chinese_super_league_chn",
      kickoffAt: new Date(NOW.getTime() + 60 * 60_000),
    });

    await expect(ensureCrossSourceMatchMapping(repo, input, NOW)).resolves.toEqual({
      match_id: MATCH_ID,
      reason: "mapped",
    });
    expect(matchMappings.insert).toHaveBeenCalledWith(expect.objectContaining({
      match_id: MATCH_ID,
      provider: "openfoot",
    }));
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
    await expect(ensureCrossSourceMatchMapping(repo, input, NOW, undefined, config.league_refs)).resolves.toEqual({ match_id: MATCH_ID, reason: "mapped" });
    expect(matchMappings.insert).toHaveBeenCalledWith(expect.objectContaining({
      match_id: MATCH_ID,
      provider: "5dollar",
      provider_match_id: "provider-match-1",
    }));
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
    )).resolves.toEqual({ match_id: MATCH_ID, reason: "mapped" });
  });

  it("links secondary observation to the primary match_id and applies result adoption and conflict rules", async () => {
    const { repo } = makeRepo();
    const linked = await ensureCrossSourceMatchMapping(repo, fixture(), NOW);
    expect(linked).toEqual({ match_id: MATCH_ID, reason: "mapped" });

    const agreed = decideProviderResultAdoption("premier_league", [
      { provider: "football_data", status: "finished", score: { home: 2, away: 1 }, raw_status: "FT", observed_at: NOW },
      { provider: "5dollar", status: "finished", score: { home: 2, away: 1 }, raw_status: "FT", observed_at: NOW },
    ], NOW, NOW);
    expect(agreed).toMatchObject({ kind: "adopt", provider: "football_data", score: { home: 2, away: 1 } });

    const conflicted = decideProviderResultAdoption("premier_league", [
      { provider: "football_data", status: "finished", score: { home: 2, away: 1 }, raw_status: "FT", observed_at: NOW },
      { provider: "5dollar", status: "finished", score: { home: 1, away: 1 }, raw_status: "FT", observed_at: NOW },
    ], NOW, NOW);
    expect(conflicted).toEqual({ kind: "anomaly", reason: "score_conflict" });
  });
});
