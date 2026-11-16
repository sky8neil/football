import { activeLeagueSeason, SUPPORTED_LEAGUES, findSupportedLeagueById, type ProviderLeagueRefs } from "../domain/config.js";
import type { SyncJobType } from "../domain/enums.js";
import type { MatchProviderMapping } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import type { ApiFootballFixturesQuery } from "../provider/http.js";
import type { ApiFootballFixture } from "../provider/types.js";
import type { Provider } from "../domain/enums.js";
import { normalizeFixture } from "../provider/fixture-mapper.js";
import type { ProviderFixtureBatchItem } from "./provider-sync-job.js";
import { ensureCrossSourceMatchMapping } from "./provider-cross-source.js";
import type { ProviderSourceId } from "../provider/sources.js";

/**
 * 单轮候选上限。三种窗口任务每轮真正要处理的比赛是几十场量级；设上限是为了在
 * 异常数据（大量滞留待结算）时不会把整表拉进内存。超出的部分由后续轮次补齐。
 */
const WINDOW_CANDIDATE_LIMIT = 500;
const DAY_MS = 24 * 60 * 60_000;

type ProviderWindowJob = typeof import("../domain/enums.js").SyncJobType.NearMatch |
  typeof import("../domain/enums.js").SyncJobType.LiveMatch |
  typeof import("../domain/enums.js").SyncJobType.PostFinishVerify;

export interface ProviderWindowFixtureClient {
  getFixtures(query: ApiFootballFixturesQuery): Promise<readonly ApiFootballFixture[]>;
  orderLeagues?(leagueIds: readonly string[], jobType: SyncJobType, now: Date): Promise<string[]>;
  getFixturesFromSource?(sourceId: ProviderSourceId, query: ApiFootballFixturesQuery): Promise<readonly ApiFootballFixture[]>;
  getResultComparisonSources?(leagueId: string): readonly { sourceId: ProviderSourceId; role: "secondary" | "fallback" }[];
  recordComparisonSkipped?(sourceId: ProviderSourceId, leagueId: string, error: unknown): void;
}

async function loadMappingsByExternalId(
  mappings: NonNullable<AppRepository["matchProviderMappings"]>,
  fixtures: readonly ApiFootballFixture[],
): Promise<Map<string, MatchProviderMapping> | null> {
  const findBatch = (mappings as Partial<typeof mappings>).findByProviderAndExternalIds;
  if (findBatch === undefined) return null;
  const byProvider = new Map<Provider, string[]>();
  for (const fixture of fixtures) {
    const fixtureId = fixture.fixture?.id;
    if (fixtureId === undefined || String(fixtureId).length === 0) continue;
    const provider = (fixture.provider ?? "api_football") as Provider;
    const ids = byProvider.get(provider) ?? [];
    ids.push(String(fixtureId));
    byProvider.set(provider, ids);
  }
  const mappingByExternalId = new Map<string, MatchProviderMapping>();
  for (const [provider, externalIds] of byProvider) {
    const batch = await findBatch(provider, externalIds);
    for (const [id, mapping] of batch) mappingByExternalId.set(id, mapping);
  }
  return mappingByExternalId;
}

async function fixturesToItems(
  repo: AppRepository,
  fixtures: readonly ApiFootballFixture[],
  ids: Set<string>,
  serverNow: Date,
  providerLeagueRefs?: ProviderLeagueRefs,
): Promise<ProviderFixtureBatchItem[]> {
  const mappings = repo.matchProviderMappings;
  if (!mappings) return [];
  const result: ProviderFixtureBatchItem[] = [];
  const mappingByExternalId = await loadMappingsByExternalId(mappings, fixtures);
  for (const fixture of fixtures) {
    const fixtureId = fixture.fixture?.id;
    if (fixtureId === undefined || String(fixtureId).length === 0) {
      result.push({ fixture, payload: { fixture } });
      continue;
    }
    const provider = (fixture.provider ?? "api_football") as Provider;
    const mapping = mappingByExternalId === null
      ? await mappings.findByProviderAndExternalId(provider, String(fixtureId))
      : mappingByExternalId.get(String(fixtureId)) ?? null;
    if (mapping && ids.has(mapping.match_id)) {
      result.push({ fixture, payload: { fixture } });
      continue;
    }
    if (provider !== "5dollar" && provider !== "openfoot" && provider !== "sportapi") continue;
    const normalized = normalizeFixture(fixture, providerLeagueRefs, serverNow);
    if (normalized.entityFailed) continue;
    const crossMatch = await ensureCrossSourceMatchMapping(repo, normalized.fixture, serverNow, ids, providerLeagueRefs);
    if (crossMatch.match_id !== null && ids.has(crossMatch.match_id)) result.push({ fixture, payload: { fixture } });
  }
  return result;
}

export async function loadActiveWindowFixtures(
  repo: AppRepository,
  client: ProviderWindowFixtureClient,
  jobType: ProviderWindowJob,
  serverNow: Date,
  providerLeagueRefs?: ProviderLeagueRefs,
): Promise<ProviderFixtureBatchItem[]> {
  const matches = (await repo.matches.findActiveWindow({
    jobType,
    now: serverNow,
    limit: WINDOW_CANDIDATE_LIMIT,
  })).filter((match) => match.superseded_by == null);
  const mappings = repo.matchProviderMappings;
  if (mappings === undefined) return [];

  const candidateMatchIds = new Map<string, Set<string>>();
  const candidateMatchesByLeague = new Map<string, typeof matches>();
  for (const match of matches) {
    const league = findSupportedLeagueById(match.league_id);
    if (league === undefined) continue;
    const ids = candidateMatchIds.get(league.league_id) ?? new Set<string>();
    ids.add(match.match_id);
    candidateMatchIds.set(league.league_id, ids);
    const leagueMatches = candidateMatchesByLeague.get(league.league_id) ?? [];
    leagueMatches.push(match);
    candidateMatchesByLeague.set(league.league_id, leagueMatches);
  }

  const result: ProviderFixtureBatchItem[] = [];
  const orderedIds = client.orderLeagues
    ? await client.orderLeagues(SUPPORTED_LEAGUES.map((league) => league.league_id), jobType, serverNow)
    : SUPPORTED_LEAGUES.map((league) => league.league_id);
  for (const leagueId of orderedIds) {
    const league = SUPPORTED_LEAGUES.find((row) => row.league_id === leagueId);
    if (!league) continue;
    const ids = candidateMatchIds.get(league.league_id);
    if (ids === undefined || ids.size === 0) continue;
    const leagueMatches = candidateMatchesByLeague.get(league.league_id) ?? [];
    const earliestKickoffMs = leagueMatches.reduce(
      (acc, match) => Math.min(acc, match.kickoff_at.getTime()),
      leagueMatches[0]!.kickoff_at.getTime(),
    );
    const latestKickoffMs = leagueMatches.reduce(
      (acc, match) => Math.max(acc, match.kickoff_at.getTime()),
      leagueMatches[0]!.kickoff_at.getTime(),
    );
    const secondaryDates = jobType === "post_finish_verify"
      ? [...new Set(leagueMatches
        .filter((match) => !(match.result_version > 0 && (match.compared_providers?.length ?? 0) >= 2))
        .flatMap((match) => {
          const kickoffDate = match.kickoff_at.toISOString().slice(0, 10);
          const nextDate = new Date(new Date(`${kickoffDate}T00:00:00.000Z`).getTime() + DAY_MS)
            .toISOString().slice(0, 10);
          return [kickoffDate, nextDate];
        }))].sort()
      : undefined;
    const fixtures = await client.getFixtures({
      dateFrom: new Date(earliestKickoffMs).toISOString().slice(0, 10),
      dateTo: new Date(latestKickoffMs).toISOString().slice(0, 10),
      leagueId: league.api_football_league_id,
      season: activeLeagueSeason(league, serverNow).api_football_season,
      jobType,
      serverNow,
      ...(secondaryDates === undefined ? {} : { secondaryDates }),
    });
    result.push(...await fixturesToItems(repo, fixtures, ids, serverNow, providerLeagueRefs));
  }
  return result;
}

export async function* loadPostFinishBatches(
  repo: AppRepository,
  client: ProviderWindowFixtureClient,
  serverNow: Date,
  providerLeagueRefs?: ProviderLeagueRefs,
): AsyncGenerator<readonly ProviderFixtureBatchItem[]> {
  yield await loadActiveWindowFixtures(repo, client, "post_finish_verify", serverNow, providerLeagueRefs);
  if (!client.getFixturesFromSource || !client.getResultComparisonSources) return;

  const orderedIds = client.orderLeagues
    ? await client.orderLeagues(SUPPORTED_LEAGUES.map((league) => league.league_id), "post_finish_verify", serverNow)
    : SUPPORTED_LEAGUES.map((league) => league.league_id);
  for (const leagueId of orderedIds) {
    const league = findSupportedLeagueById(leagueId);
    if (!league) continue;
    const sources = client.getResultComparisonSources(leagueId);
    let secondarySucceeded = false;
    for (const source of [...sources.filter((entry) => entry.role === "secondary"), ...sources.filter((entry) => entry.role === "fallback")]) {
      if (source.role === "fallback" && secondarySucceeded) break;
      const matches = (await repo.matches.findActiveWindow({ jobType: "post_finish_verify", now: serverNow, limit: WINDOW_CANDIDATE_LIMIT }))
        .filter((match) => match.league_id === leagueId && match.superseded_by == null &&
          !(match.result_version > 0 && new Set(match.compared_providers ?? []).size >= 2));
      if (matches.length === 0) break;
      const dates = [...new Set(matches.flatMap((match) => {
        const date = match.kickoff_at.toISOString().slice(0, 10);
        return [date, new Date(new Date(`${date}T00:00:00.000Z`).getTime() + DAY_MS).toISOString().slice(0, 10)];
      }))].sort();
      const fixtures: ApiFootballFixture[] = [];
      for (const date of dates) {
        try {
          const rows = await client.getFixturesFromSource(source.sourceId, {
            dateFrom: date, dateTo: date, leagueId: league.api_football_league_id,
            season: activeLeagueSeason(league, serverNow).api_football_season,
            jobType: "post_finish_verify", serverNow,
          });
          if (source.role === "secondary") secondarySucceeded = true;
          fixtures.push(...rows.filter((fixture) => fixture.fixture?.status?.short !== "NS"));
        } catch (error) {
          client.recordComparisonSkipped?.(source.sourceId, leagueId, error);
        }
      }
      yield await fixturesToItems(repo, fixtures, new Set(matches.map((match) => match.match_id)), serverNow, providerLeagueRefs);
    }
  }
}
