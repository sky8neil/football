import { SCHEMA_VERSION } from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { Provider } from "../domain/enums.js";
import type { MatchProviderMapping } from "../domain/types.js";
import {
  findSupportedLeagueByProviderId,
  providerSeasonRef,
  providerSourceId,
  type ProviderLeagueRefs,
} from "../domain/config.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import type { NormalizedFixture } from "../provider/fixture-mapper.js";

const CROSS_SOURCE_PROVIDERS = new Set<Provider>(["5dollar", "openfoot", "sportapi"]);

export type CrossSourceConflictReason =
  | "season_mismatch"
  | "mapping_match_missing"
  | "mapping_league_mismatch"
  | "mapping_season_mismatch"
  | "mapping_team_mismatch";

export type CrossSourceMatchMapping =
  | {
      match_id: string;
      reason: "mapped";
      season_id: string;
      league_id: string;
      basis: "existing_mapping" | "unique_candidate";
    }
  | {
      match_id: null;
      reason: "conflict";
      conflict_reason: CrossSourceConflictReason;
    }
  | {
      match_id: null;
      reason: "unlinked" | "ambiguous" | "out_of_window" | "not_secondary";
    };

export interface EnsureCrossSourceMatchMappingOptions {
  /** 窗口加载器只做只读预判时传 false，避免重复写未关联快照；默认写入。 */
  persist?: boolean;
}

export async function ensureCrossSourceMatchMapping(
  repo: AppRepository,
  fixture: NormalizedFixture,
  now: Date,
  candidateMatchIds?: ReadonlySet<string>,
  providerLeagueRefs?: ProviderLeagueRefs,
  options: EnsureCrossSourceMatchMappingOptions = {},
): Promise<CrossSourceMatchMapping> {
  const persist = options.persist !== false;
  const provider = fixture.provider as Provider | undefined;
  if (!provider || !CROSS_SOURCE_PROVIDERS.has(provider)) return { match_id: null, reason: "not_secondary" };
  const mappings = repo.matchProviderMappings;
  const teams = repo.teamProviderMappings;
  if (!mappings || !teams || fixture.kickoffAt === null) return { match_id: null, reason: "unlinked" };
  const supportedLeague = findSupportedLeagueByProviderId(fixture.leagueProviderId, provider, providerLeagueRefs);
  if (!supportedLeague) return { match_id: null, reason: "unlinked" };
  if (fixture.season !== null) {
    const sourceId = providerSourceId(provider);
    const sourceSeason = sourceId === null ? null : providerSeasonRef(supportedLeague, sourceId);
    const accepted =
      fixture.season === supportedLeague.source_season_ref ||
      (sourceSeason !== null && fixture.season === sourceSeason);
    if (!accepted) return { match_id: null, reason: "conflict", conflict_reason: "season_mismatch" };
  }
  const external = await mappings.findByProviderAndExternalId(provider, fixture.providerMatchId);
  if (external) {
    const match = await repo.matches.findById(external.match_id);
    if (match === null) {
      return { match_id: null, reason: "conflict", conflict_reason: "mapping_match_missing" };
    }
    if (match.league_id !== supportedLeague.league_id) {
      return { match_id: null, reason: "conflict", conflict_reason: "mapping_league_mismatch" };
    }
    if (match.season_id !== supportedLeague.season_id) {
      return { match_id: null, reason: "conflict", conflict_reason: "mapping_season_mismatch" };
    }
    const [home, away] = await Promise.all([
      teams.findByProviderAndExternalId(provider, fixture.homeTeamProviderId),
      teams.findByProviderAndExternalId(provider, fixture.awayTeamProviderId),
    ]);
    if (
      (home !== null && home.team_id !== match.home_team_id) ||
      (away !== null && away.team_id !== match.away_team_id)
    ) {
      return { match_id: null, reason: "conflict", conflict_reason: "mapping_team_mismatch" };
    }
    if (candidateMatchIds !== undefined && !candidateMatchIds.has(match.match_id)) {
      return { match_id: null, reason: "out_of_window" };
    }
    return {
      match_id: match.match_id,
      reason: "mapped",
      season_id: match.season_id,
      league_id: match.league_id,
      basis: "existing_mapping",
    };
  }
  const [home, away] = await Promise.all([
    teams.findByProviderAndExternalId(provider, fixture.homeTeamProviderId),
    teams.findByProviderAndExternalId(provider, fixture.awayTeamProviderId),
  ]);
  if (!home || !away) {
    if (persist) await recordUnlinked(repo, provider, fixture, now, "team_mapping_missing");
    return { match_id: null, reason: "unlinked" };
  }
  const identityMatches = (await repo.matches.findBySeason(supportedLeague.season_id)).filter((match) => {
    if (match.league_id !== supportedLeague.league_id || match.home_team_id !== home.team_id || match.away_team_id !== away.team_id) return false;
    const tolerance = match.league_id === "chinese_super_league" ? 5 * 60_000 : 30 * 60_000;
    return Math.abs(match.kickoff_at.getTime() - fixture.kickoffAt!.getTime()) <= tolerance;
  });
  if (identityMatches.length > 1) {
    if (persist) await recordUnlinked(repo, provider, fixture, now, "ambiguous");
    return { match_id: null, reason: "ambiguous" };
  }
  if (identityMatches.length === 0) {
    // 真正零候选与「唯一候选在窗口外」不同：即使带窗口候选集合，也应留下 no_match，
    // 以便与缺球队映射、歧义区分；窗口外唯一分支在下方单独处理。
    if (persist) await recordUnlinked(repo, provider, fixture, now, "no_match");
    return { match_id: null, reason: "unlinked" };
  }
  const match = identityMatches[0]!;
  if (candidateMatchIds !== undefined && !candidateMatchIds.has(match.match_id)) {
    return { match_id: null, reason: "out_of_window" };
  }
  if (persist) {
    const mapping: MatchProviderMapping = {
      schema_version: SCHEMA_VERSION,
      match_id: match.match_id,
      provider,
      provider_match_id: fixture.providerMatchId,
      created_at: now,
      updated_at: now,
    };
    await mappings.insert(mapping);
  }
  return {
    match_id: match.match_id,
    reason: "mapped",
    season_id: match.season_id,
    league_id: match.league_id,
    basis: "unique_candidate",
  };
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
