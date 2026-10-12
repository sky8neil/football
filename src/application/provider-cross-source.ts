import { SCHEMA_VERSION } from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { Provider } from "../domain/enums.js";
import type { MatchProviderMapping } from "../domain/types.js";
import { SUPPORTED_LEAGUES } from "../domain/config.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import type { NormalizedFixture } from "../provider/fixture-mapper.js";

const CROSS_SOURCE_PROVIDERS = new Set<Provider>(["5dollar", "openfoot", "sportapi"]);

export async function ensureCrossSourceMatchMapping(
  repo: AppRepository,
  fixture: NormalizedFixture,
  now: Date,
  candidateMatchIds?: ReadonlySet<string>,
): Promise<{ match_id: string | null; reason: "mapped" | "unlinked" | "ambiguous" | "not_secondary" }> {
  const provider = fixture.provider as Provider | undefined;
  if (!provider || !CROSS_SOURCE_PROVIDERS.has(provider)) return { match_id: null, reason: "not_secondary" };
  const mappings = repo.matchProviderMappings;
  const teams = repo.teamProviderMappings;
  if (!mappings || !teams || fixture.kickoffAt === null) return { match_id: null, reason: "unlinked" };
  const external = await mappings.findByProviderAndExternalId(provider, fixture.providerMatchId);
  if (external) return { match_id: external.match_id, reason: "mapped" };
  const supportedLeague = findSupportedLeagueByProviderIdForSource(provider, fixture.leagueProviderId);
  if (!supportedLeague) return { match_id: null, reason: "unlinked" };
  const [home, away] = await Promise.all([
    teams.findByProviderAndExternalId(provider, fixture.homeTeamProviderId),
    teams.findByProviderAndExternalId(provider, fixture.awayTeamProviderId),
  ]);
  if (!home || !away) {
    await recordUnlinked(repo, provider, fixture, now, "team_mapping_missing");
    return { match_id: null, reason: "unlinked" };
  }
  const candidates = (await repo.matches.findBySeason(supportedLeague.season_id)).filter((match) => {
    if (match.league_id !== supportedLeague.league_id || match.home_team_id !== home.team_id || match.away_team_id !== away.team_id) return false;
    if (candidateMatchIds && !candidateMatchIds.has(match.match_id)) return false;
    const tolerance = match.league_id === "chinese_super_league" ? 5 * 60_000 : 30 * 60_000;
    return Math.abs(match.kickoff_at.getTime() - fixture.kickoffAt!.getTime()) <= tolerance;
  });
  if (candidates.length !== 1) {
    if (candidates.length > 1 || candidateMatchIds === undefined) {
      await recordUnlinked(repo, provider, fixture, now, candidates.length > 1 ? "ambiguous" : "no_match");
    }
    return { match_id: null, reason: candidates.length > 1 ? "ambiguous" : "unlinked" };
  }
  const match = candidates[0]!;
  const mapping: MatchProviderMapping = {
    schema_version: SCHEMA_VERSION,
    match_id: match.match_id,
    provider,
    provider_match_id: fixture.providerMatchId,
    created_at: now,
    updated_at: now,
  };
  await mappings.insert(mapping);
  return { match_id: match.match_id, reason: "mapped" };
}

async function recordUnlinked(repo: AppRepository, provider: Provider, fixture: NormalizedFixture, now: Date, reason: string): Promise<void> {
  const snapshots = repo.providerSnapshots;
  if (!snapshots) return;
  await snapshots.insert({
    schema_version: SCHEMA_VERSION,
    snapshot_id: newUuid(),
    provider,
    entity_type: "match",
    entity_id: null,
    provider_entity_id: fixture.providerMatchId,
    event_type: "provider_error",
    payload: { diag_code: "DIAG_PROVIDER_MATCH_UNLINKED", league_id: fixture.leagueProviderId, reason },
    created_at: now,
  });
}

function findSupportedLeagueByProviderIdForSource(provider: Provider, providerId: string) {
  if (provider === "5dollar") return findLeague("5d", providerId);
  if (provider === "openfoot") return findLeague("of", providerId);
  if (provider === "sportapi") return findLeague("sp", providerId);
  return undefined;
}

function findLeague(source: "5d" | "of" | "sp", providerId: string) {
  return SUPPORTED_LEAGUES.find((league) => league.provider_refs[source] === providerId);
}
