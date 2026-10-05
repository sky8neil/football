import { MatchStatus, Provider, SyncJobType } from "../domain/enums.js";
import { findSupportedLeagueById, SUPPORTED_LEAGUES } from "../domain/config.js";
import { internalError } from "../domain/errors.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import {
  createLiveMatchLoader,
  type LiveMatchFixtureClient,
} from "./provider-fixture-loader.js";
import {
  ProviderFixtureSyncJobService,
  type ProviderFixtureBatchItem,
  type ProviderFixtureBatchLoader,
  type ProviderFixtureSyncJobOutcome,
  type ProviderFixtureSyncRetryOptions,
} from "./provider-sync-job.js";
import { ProviderFixtureSyncService } from "./provider-fixture-sync.js";
import {
  ProviderTeamSyncService,
  type ProviderTeamClient,
  type ProviderTeamSyncOutcome,
} from "./provider-team-sync.js";
import { SYNC_TASKS_V1 } from "../sync/config.js";

export interface ProviderLiveMatchClient
  extends LiveMatchFixtureClient,
    ProviderTeamClient {}

/**
 * 批次去重键（31.5 逐条容错）：优先用 provider fixture id；结构非法项无 id 时
 * 以稳定序号兜底，保证非法项不被静默丢弃，也不与合法项错误合并。
 */
function fixtureIdentityKey(item: ProviderFixtureBatchItem, index: number): string {
  const raw = (item.fixture as { fixture?: { id?: unknown } } | null | undefined)?.fixture;
  const id = raw?.id;
  return typeof id === "number" ? String(id) : `invalid:${index}`;
}

export type ProviderLiveMatchOutcome =
  | {
      kind: "completed";
      teams: ProviderTeamSyncOutcome;
      fixtures: Extract<ProviderFixtureSyncJobOutcome, { kind: "completed" }>;
    }
  | {
      kind: "skipped";
      fixtures: Extract<ProviderFixtureSyncJobOutcome, { kind: "skipped" }>;
    };

/** 贯通 32.4 的 T-2h 到 finished 任务入口；Provider client 由调用方注入。 */
export class ProviderLiveMatchService {
  private readonly teamSync: ProviderTeamSyncService;
  private readonly fixtureSync: ProviderFixtureSyncService;
  private readonly fixtureJob: ProviderFixtureSyncJobService;
  private readonly liveMatchLoader: ProviderFixtureBatchLoader;

  constructor(
    private readonly repo: AppRepository,
    private readonly client: ProviderLiveMatchClient,
    retryOptions: ProviderFixtureSyncRetryOptions = {},
  ) {
    this.teamSync = new ProviderTeamSyncService(repo, client);
    this.fixtureSync = new ProviderFixtureSyncService(repo);
    this.liveMatchLoader = createLiveMatchLoader(client);
    this.fixtureJob = new ProviderFixtureSyncJobService(
      repo,
      this.fixtureSync,
      retryOptions,
    );
  }

  async run(serverNow: Date): Promise<ProviderLiveMatchOutcome> {
    let teams: ProviderTeamSyncOutcome | null = null;
    const load: ProviderFixtureBatchLoader = async (loadNow) => {
      teams ??= await this.teamSync.sync(loadNow);
      const [providerLiveFixtures, knownUnfinishedFixtures] = await Promise.all([
        this.liveMatchLoader(loadNow),
        this.loadKnownUnfinishedFixtures(loadNow),
      ]);
      const fixturesById = new Map<string, ProviderFixtureBatchItem>();
      const merged = [...providerLiveFixtures, ...knownUnfinishedFixtures];
      for (let index = 0; index < merged.length; index += 1) {
        const item = merged[index]!;
        fixturesById.set(fixtureIdentityKey(item, index), item);
      }
      return [...fixturesById.values()];
    };
    const fixtures = await this.fixtureJob.run(
      SyncJobType.LiveMatch,
      load,
      serverNow,
    );
    if (fixtures.kind === "skipped") {
      return { kind: "skipped", fixtures };
    }
    if (teams === null) {
      throw internalError("live_match 已完成但未记录球队同步结果");
    }
    // P0-1（33.1）：批次完成后巡检库内仍为 live 的 match，覆盖本批未触达的 stale。
    await this.fixtureSync.patrolLiveMatches(serverNow);
    return { kind: "completed", teams, fixtures };
  }

  private async loadKnownUnfinishedFixtures(
    serverNow: Date,
  ): Promise<ProviderFixtureBatchItem[]> {
    const mappings = this.repo.matchProviderMappings;
    if (mappings === undefined) {
      throw internalError("live_match 缺少 match provider mappings repository");
    }
    const latestKickoff = new Date(
      serverNow.getTime() +
        SYNC_TASKS_V1.live_match.windowStartHoursBeforeKickoff! * 60 * 60 * 1000,
    );
    const seasonIds = new Set(SUPPORTED_LEAGUES.map((league) => league.season_id));
    const candidates: Array<{
      leagueId: string;
      season: string;
      fixtureId: string;
    }> = [];
    for (const seasonId of seasonIds) {
      const matches = await this.repo.matches.findBySeason(seasonId);
      for (const match of matches) {
        if (
          match.match_status !== MatchStatus.Live &&
          (match.match_status !== MatchStatus.Scheduled ||
            match.kickoff_at.getTime() > latestKickoff.getTime())
        ) {
          continue;
        }
        const league = findSupportedLeagueById(match.league_id);
        if (league === undefined) {
          continue;
        }
        const matchMappings = await mappings.findByMatchId(match.match_id);
        const providerMapping = matchMappings.find(
          (mapping) => mapping.provider === Provider.ApiFootball,
        );
        if (providerMapping !== undefined) {
          candidates.push({
            leagueId: league.api_football_league_id,
            season: league.api_football_season,
            fixtureId: providerMapping.provider_match_id,
          });
        }
      }
    }
    const fixturesByMatch = await Promise.all(
      candidates.map((candidate) =>
        this.client.getFixtures({
          fixtureId: candidate.fixtureId,
          leagueId: candidate.leagueId,
          season: candidate.season,
        }),
      ),
    );
    return fixturesByMatch.flatMap((fixtures) =>
      fixtures.map((fixture) => ({ fixture, payload: { fixture } })),
    );
  }
}
