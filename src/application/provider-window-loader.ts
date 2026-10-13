import { SUPPORTED_LEAGUES, findSupportedLeagueById } from "../domain/config.js";
import type { SyncJobType } from "../domain/enums.js";
import type { Match } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import type { ApiFootballFixturesQuery } from "../provider/http.js";
import type { ApiFootballFixture } from "../provider/types.js";
import type { Provider } from "../domain/enums.js";
import { normalizeFixture } from "../provider/fixture-mapper.js";
import { activeWindow } from "./provider-active-window.js";
import type { ProviderFixtureBatchItem } from "./provider-sync-job.js";
import { ensureCrossSourceMatchMapping } from "./provider-cross-source.js";

type ProviderWindowJob = typeof import("../domain/enums.js").SyncJobType.NearMatch |
  typeof import("../domain/enums.js").SyncJobType.LiveMatch |
  typeof import("../domain/enums.js").SyncJobType.PostFinishVerify;

export interface ProviderWindowFixtureClient {
  getFixtures(query: ApiFootballFixturesQuery): Promise<readonly ApiFootballFixture[]>;
  orderLeagues?(leagueIds: readonly string[], jobType: SyncJobType, now: Date): Promise<string[]>;
}

export async function loadActiveWindowFixtures(
  repo: AppRepository,
  client: ProviderWindowFixtureClient,
  jobType: ProviderWindowJob,
  serverNow: Date,
): Promise<ProviderFixtureBatchItem[]> {
  const seasonIds = new Set(SUPPORTED_LEAGUES.map((league) => league.season_id));
  const allMatches: Match[] = [];
  for (const seasonId of seasonIds) allMatches.push(...await repo.matches.findBySeason(seasonId));
  const matches = activeWindow(allMatches, serverNow, jobType);
  const mappings = repo.matchProviderMappings;
  if (mappings === undefined) return [];

  const candidateMatchIds = new Map<string, Set<string>>();
  for (const match of matches) {
    const league = findSupportedLeagueById(match.league_id);
    if (league === undefined) continue;
    const ids = candidateMatchIds.get(league.league_id) ?? new Set<string>();
    ids.add(match.match_id);
    candidateMatchIds.set(league.league_id, ids);
  }

  const from = new Date(Math.min(serverNow.getTime() - 24 * 60 * 60_000, ...matches.map(match => match.kickoff_at.getTime()))).toISOString().slice(0, 10);
  const to = new Date(serverNow.getTime() + 24 * 60 * 60_000).toISOString().slice(0, 10);
  const result: ProviderFixtureBatchItem[] = [];
  const orderedIds = client.orderLeagues
    ? await client.orderLeagues(SUPPORTED_LEAGUES.map((league) => league.league_id), jobType, serverNow)
    : SUPPORTED_LEAGUES.map((league) => league.league_id);
  for (const leagueId of orderedIds) {
    const league = SUPPORTED_LEAGUES.find((row) => row.league_id === leagueId);
    if (!league) continue;
    const ids = candidateMatchIds.get(league.league_id);
    if (ids === undefined || ids.size === 0) continue;
    const fixtures = await client.getFixtures({
      dateFrom: from,
      dateTo: to,
      leagueId: league.api_football_league_id,
      season: league.api_football_season,
      jobType,
      serverNow,
    });
    for (const fixture of fixtures) {
      const fixtureId = fixture.fixture?.id;
      if (fixtureId === undefined || String(fixtureId).length === 0) {
        result.push({ fixture, payload: { fixture } });
        continue;
      }
      const provider = (fixture.provider ?? "api_football") as Provider;
      const mapping = await mappings.findByProviderAndExternalId(provider, String(fixtureId));
      if (mapping && ids.has(mapping.match_id)) {
        result.push({ fixture, payload: { fixture } });
        continue;
      }
      if (provider !== "5dollar" && provider !== "openfoot" && provider !== "sportapi") continue;
      const normalized = normalizeFixture(fixture);
      if (normalized.entityFailed) continue;
      const crossMatch = await ensureCrossSourceMatchMapping(repo, normalized.fixture, serverNow, ids);
      if (crossMatch.match_id !== null && ids.has(crossMatch.match_id)) result.push({ fixture, payload: { fixture } });
    }
  }
  return result;
}
