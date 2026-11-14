import {
  SUPPORTED_LEAGUES,
  findSupportedLeagueById,
  findSupportedLeagueByProviderId,
  type ProviderLeagueRefs,
} from "../domain/config.js";
import type { SyncJobType } from "../domain/enums.js";
import type { MatchProviderMapping } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import type { ApiFootballFixturesQuery } from "../provider/http.js";
import type { ApiFootballFixture } from "../provider/types.js";
import type { Provider } from "../domain/enums.js";
import { normalizeFixture } from "../provider/fixture-mapper.js";
import type { ProviderFixtureBatchItem } from "./provider-sync-job.js";
import { ensureCrossSourceMatchMapping } from "./provider-cross-source.js";

/**
 * 单轮候选上限。三种窗口任务每轮真正要处理的比赛是几十场量级；设上限是为了在
 * 异常数据（大量滞留待结算）时不会把整表拉进内存。超出的部分由后续轮次补齐。
 */
const WINDOW_CANDIDATE_LIMIT = 500;

type ProviderWindowJob = typeof import("../domain/enums.js").SyncJobType.NearMatch |
  typeof import("../domain/enums.js").SyncJobType.LiveMatch |
  typeof import("../domain/enums.js").SyncJobType.PostFinishVerify;

export interface ProviderWindowFixtureClient {
  getFixtures(query: ApiFootballFixturesQuery): Promise<readonly ApiFootballFixture[]>;
  orderLeagues?(leagueIds: readonly string[], jobType: SyncJobType, now: Date): Promise<string[]>;
}

function mappingLookupKey(provider: Provider, externalId: string): string {
  return `${provider}\u0000${externalId}`;
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
    for (const [id, mapping] of batch) {
      mappingByExternalId.set(mappingLookupKey(provider, id), mapping);
    }
  }
  return mappingByExternalId;
}

export interface ProviderWindowFixtureLoadResult {
  items: ProviderFixtureBatchItem[];
  /**
   * 进入窗口过滤阶段的条数：按联赛逐次查询后、按目标联赛筛选后、窗口过滤前。
   * 它既不是 5d 全联赛共享原始响应总数，也不是 HTTP 请求次数；共享响应由 Registry
   * 一次取得并按联赛分发，这里只累计各联赛实际交给窗口加载器的行。
   */
  items_window_input: number;
  /** 因已有映射、唯一候选不在活动窗口或主源缺少映射而被正常过滤的条数。 */
  items_window_filtered: number;
}

export async function loadActiveWindowFixturesWithStats(
  repo: AppRepository,
  client: ProviderWindowFixtureClient,
  jobType: ProviderWindowJob,
  serverNow: Date,
  providerLeagueRefs?: ProviderLeagueRefs,
): Promise<ProviderWindowFixtureLoadResult> {
  const matches = await repo.matches.findActiveWindow({
    jobType,
    now: serverNow,
    limit: WINDOW_CANDIDATE_LIMIT,
  });
  const mappings = repo.matchProviderMappings;
  if (mappings === undefined) {
    return { items: [], items_window_input: 0, items_window_filtered: 0 };
  }

  const candidateMatchIds = new Map<string, Set<string>>();
  for (const match of matches) {
    const league = findSupportedLeagueById(match.league_id);
    if (league === undefined) continue;
    const ids = candidateMatchIds.get(league.league_id) ?? new Set<string>();
    ids.add(match.match_id);
    candidateMatchIds.set(league.league_id, ids);
  }

  const earliestKickoffMs = matches.reduce(
    (acc, match) => Math.min(acc, match.kickoff_at.getTime()),
    serverNow.getTime() - 24 * 60 * 60_000,
  );
  const from = new Date(earliestKickoffMs).toISOString().slice(0, 10);
  const to = new Date(serverNow.getTime() + 24 * 60 * 60_000).toISOString().slice(0, 10);
  const result: ProviderFixtureBatchItem[] = [];
  let itemsWindowInput = 0;
  let itemsWindowFiltered = 0;
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
    const windowCandidateMatchIds = [...ids];
    const pushCandidate = (fixture: ApiFootballFixture) => {
      result.push({ fixture, payload: { fixture }, candidateMatchIds: windowCandidateMatchIds });
    };
    // RP11：一次批量取回本联赛所有外部 ID 的映射，避免逐场查询
    const mappingByExternalId = await loadMappingsByExternalId(mappings, fixtures);
    for (const fixture of fixtures) {
      const fixtureId = fixture.fixture?.id;
      if (fixtureId === undefined || String(fixtureId).length === 0) {
        itemsWindowInput += 1;
        pushCandidate(fixture);
        continue;
      }
      const provider = (fixture.provider ?? "api_football") as Provider;
      const mapping = mappingByExternalId === null
        ? await mappings.findByProviderAndExternalId(provider, String(fixtureId))
        : mappingByExternalId.get(mappingLookupKey(provider, String(fixtureId))) ?? null;
      if (mapping !== null) {
        itemsWindowInput += 1;
        // 已有来源映射：只处理落在本窗口候选集合内的比赛，窗口外记录正常过滤。
        if (ids.has(mapping.match_id)) pushCandidate(fixture);
        else itemsWindowFiltered += 1;
        continue;
      }
      if (provider !== "5dollar" && provider !== "openfoot" && provider !== "sportapi") {
        // 主源无映射记录已进入按联赛查询结果，但不能据此采纳；显式计入输入与过滤，
        // 避免与真正零输入混淆，也不改变 items_read 只统计实际交给 applyFixture 的口径。
        itemsWindowInput += 1;
        itemsWindowFiltered += 1;
        continue;
      }
      const rawLeagueId = fixture.league?.id;
      if (rawLeagueId !== undefined && String(rawLeagueId).length > 0) {
        const fixtureLeague = findSupportedLeagueByProviderId(
          String(rawLeagueId),
          provider,
          providerLeagueRefs,
        );
        if (fixtureLeague === undefined || fixtureLeague.league_id !== league.league_id) continue;
      }
      itemsWindowInput += 1;
      // 无映射的次要源只读预判：窗口外唯一候选正常过滤，缺映射/歧义/冲突仍交给
      // applyFixture 产生可观察结果，避免窗口加载阶段静默吞掉目标记录错误。
      const normalized = normalizeFixture(fixture, providerLeagueRefs, { identityOnly: true });
      if (normalized.entityFailed) {
        pushCandidate(fixture);
        continue;
      }
      const crossMatch = await ensureCrossSourceMatchMapping(
        repo,
        normalized.fixture,
        serverNow,
        ids,
        providerLeagueRefs,
        { persist: false },
      );
      if (crossMatch.reason === "out_of_window") {
        itemsWindowFiltered += 1;
        continue;
      }
      pushCandidate(fixture);
    }
  }
  return {
    items: result,
    items_window_input: itemsWindowInput,
    items_window_filtered: itemsWindowFiltered,
  };
}

export async function loadActiveWindowFixtures(
  repo: AppRepository,
  client: ProviderWindowFixtureClient,
  jobType: ProviderWindowJob,
  serverNow: Date,
  providerLeagueRefs?: ProviderLeagueRefs,
): Promise<ProviderFixtureBatchItem[]> {
  const loaded = await loadActiveWindowFixturesWithStats(
    repo,
    client,
    jobType,
    serverNow,
    providerLeagueRefs,
  );
  return loaded.items;
}
