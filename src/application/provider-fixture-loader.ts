import {
  activeLeagueSeason,
  FIXED_CONFIG_V1,
  nextLeagueSeasonId,
  previousLeagueSeasonId,
  seasonBounds,
  SUPPORTED_LEAGUES,
  type SupportedLeagueId,
} from "../domain/config.js";
import { SyncJobType } from "../domain/enums.js";
import { internalError, validationError } from "../domain/errors.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { ProviderBudgetDeferredError } from "../provider/budget.js";
import { parseKickoff } from "../provider/kickoff.js";
import type {
  ApiFootballFixturesQuery,
  ApiFootballSeasonFixturesQuery,
} from "../provider/http.js";
import type {
  ApiFootballFixture,
} from "../provider/types.js";
import { SYNC_TASKS_V1 } from "../sync/config.js";
import type { ProviderFixtureBatchItem } from "./provider-sync-job.js";

type ProviderFixtureBatchLoader = (serverNow: Date) => Promise<readonly ProviderFixtureBatchItem[]>;

export interface FutureScheduleFixtureClient {
  getFixtures(query: ApiFootballFixturesQuery): Promise<readonly ApiFootballFixture[]>;
  orderLeagues?(leagueIds: readonly string[], jobType: SyncJobType, now: Date): Promise<string[]>;
}

export interface NearMatchFixtureClient {
  getFixtures(query: ApiFootballFixturesQuery): Promise<readonly ApiFootballFixture[]>;
  orderLeagues?(leagueIds: readonly string[], jobType: SyncJobType, now: Date): Promise<string[]>;
}

export interface LiveMatchFixtureClient {
  getFixtures(query: ApiFootballFixturesQuery): Promise<readonly ApiFootballFixture[]>;
  orderLeagues?(leagueIds: readonly string[], jobType: SyncJobType, now: Date): Promise<string[]>;
}

export interface PostFinishVerifyFixtureClient {
  getFixtures(query: ApiFootballFixturesQuery): Promise<readonly ApiFootballFixture[]>;
  orderLeagues?(leagueIds: readonly string[], jobType: SyncJobType, now: Date): Promise<string[]>;
}

export interface FullScheduleFixtureClient {
  getSeasonFixtures(
    query: ApiFootballSeasonFixturesQuery,
  ): Promise<readonly ApiFootballFixture[]>;
  orderLeagues?(leagueIds: readonly string[], jobType: SyncJobType, now: Date): Promise<string[]>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function assertValidDate(value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw validationError("server_now 必须是有效时间", { field: "server_now" });
  }
}

function formatUtcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * 安全读取原始 fixture 的 kickoff（31.5 逐条容错）：结构非法项返回 null，
 * 交由窗口保留为「无法解析」项，最终由 mapper 以实体级 PROVIDER_DATA_INVALID 失败。
 */
function parseFixtureKickoff(fixture: ApiFootballFixture): Date | null {
  const raw = (fixture as { fixture?: unknown } | null | undefined)?.fixture;
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const fields = raw as { timestamp?: unknown; date?: unknown };
  return parseKickoff(fields.timestamp, fields.date).kickoffAt;
}

/**
 * 换季过渡期相邻赛季探测集合：
 * - 跨年联赛（7/1 换季）：6 月（UTC month===5）探测 nextSeason；7 月（UTC month===6）若上赛季未 completed 探测 previousSeason；
 * - 自然年联赛（1/1 换季）：12 月（UTC month===11）探测 nextSeason；1 月（UTC month===0）若上赛季未 completed 探测 previousSeason。
 */
export async function resolveRolloverTargetSeasons(
  repo: Pick<AppRepository, "leagueSeasons" | "matches">,
  serverNow: Date,
  leagueIds?: readonly string[],
): Promise<Partial<Record<SupportedLeagueId, string[]>>> {
  assertValidDate(serverNow);
  const utcMonth = serverNow.getUTCMonth();
  const result: Partial<Record<SupportedLeagueId, string[]>> = {};
  const leagues = leagueIds
    ? SUPPORTED_LEAGUES.filter((league) => leagueIds.includes(league.league_id))
    : SUPPORTED_LEAGUES;

  for (const league of leagues) {
    const activeSeasonId = activeLeagueSeason(league, serverNow).season_id;
    const targets = [activeSeasonId];
    const crossYear = /^\d{4}_\d{4}$/.test(league.season_id);
    const naturalYear = /^\d{4}$/.test(league.season_id);

    if ((crossYear && utcMonth === 5) || (naturalYear && utcMonth === 11)) {
      const next = nextLeagueSeasonId(league, serverNow);
      if (next !== null && !targets.includes(next)) {
        targets.push(next);
      }
    }

    if ((crossYear && utcMonth === 6) || (naturalYear && utcMonth === 0)) {
      const prev = previousLeagueSeasonId(league, serverNow);
      if (prev !== null && !targets.includes(prev)) {
        const prevRecord = repo.leagueSeasons
          ? await repo.leagueSeasons.findByKey(league.league_id, prev)
          : null;
        if (prevRecord !== null) {
          if (prevRecord.completion_status !== "completed") {
            targets.push(prev);
          }
        } else {
          const prevMatches = typeof repo.matches.findByLeagueSeason === "function"
            ? await repo.matches.findByLeagueSeason(league.league_id, prev)
            : (await repo.matches.findBySeason(prev)).filter((m) => m.league_id === league.league_id);
          if (prevMatches.some((match) => match.superseded_by == null)) {
            targets.push(prev);
          }
        }
      }
    }

    result[league.league_id] = targets;
  }
  return result;
}

function fixtureMatchesTargetSeason(fixture: ApiFootballFixture, seasonId: string, isSecondaryProbe: boolean): boolean {
  const rawSeason = fixture?.league?.season;
  if (typeof rawSeason === "string" || typeof rawSeason === "number") {
    const seasonYear = String(rawSeason).slice(0, 4);
    if (/^\d{4}$/.test(seasonYear)) {
      return seasonYear === seasonId.split("_")[0];
    }
  }
  if (!isSecondaryProbe) {
    return true;
  }
  const bounds = seasonBounds(seasonId);
  const kickoff = parseFixtureKickoff(fixture);
  if (bounds === null || kickoff === null) return false;
  return kickoff.getTime() >= bounds.start.getTime() && kickoff.getTime() < bounds.end.getTime();
}

async function loadFixturesForSupportedLeagues(
  client: { orderLeagues?: (leagueIds: readonly string[], jobType: SyncJobType, now: Date) => Promise<string[]> },
  load: (leagueId: string, season: string, jobType: SyncJobType, serverNow: Date, seasonId?: string) => Promise<readonly ApiFootballFixture[]>,
  jobType: SyncJobType,
  serverNow: Date,
  leagueIds?: readonly string[],
  targetSeasons?: Partial<Record<SupportedLeagueId, string | readonly string[]>>,
): Promise<ProviderFixtureBatchItem[]> {
  const fixtures: ProviderFixtureBatchItem[] = [];
  const eligibleLeagues = leagueIds
    ? SUPPORTED_LEAGUES.filter((league) => leagueIds.includes(league.league_id))
    : SUPPORTED_LEAGUES;
  const orderedIds = client.orderLeagues
    ? await client.orderLeagues(eligibleLeagues.map((league) => league.league_id), jobType, serverNow)
    : eligibleLeagues.map((league) => league.league_id);
  let attemptedPrimary = 0;
  let succeededPrimary = 0;
  let firstError: unknown;
  let deferredError: ProviderBudgetDeferredError | undefined;
  for (const leagueId of orderedIds) {
    const league = SUPPORTED_LEAGUES.find((row) => row.league_id === leagueId);
    if (!league) continue;
    const configured = targetSeasons?.[league.league_id];
    const seasonEntries: Array<{ seasonId: string | undefined; isSecondaryProbe: boolean }> = configured === undefined
      ? [{ seasonId: undefined, isSecondaryProbe: false }]
      : (typeof configured === "string" ? [configured] : [...new Set(configured)])
          .map((seasonId, index) => ({ seasonId, isSecondaryProbe: index > 0 }));

    for (const entry of seasonEntries) {
      if (!entry.isSecondaryProbe) attemptedPrimary += 1;
      try {
        const effectiveSeasonId = entry.seasonId ?? activeLeagueSeason(league, serverNow).season_id;
        const rows = await load(
          league.api_football_league_id,
          entry.seasonId?.split("_")[0] ?? activeLeagueSeason(league, serverNow).api_football_season,
          jobType,
          serverNow,
          entry.seasonId,
        );
        const filteredRows = seasonEntries.length > 1
          ? rows.filter((fixture) => fixtureMatchesTargetSeason(fixture, effectiveSeasonId, entry.isSecondaryProbe))
          : rows;
        fixtures.push(...filteredRows.map((fixture) => ({ fixture, payload: { fixture }, ...(entry.seasonId === undefined ? {} : { seasonId: entry.seasonId }) })));
        if (!entry.isSecondaryProbe) succeededPrimary += 1;
      } catch (error) {
        if (!entry.isSecondaryProbe) {
          if (firstError === undefined) firstError = error;
          if (deferredError === undefined && error instanceof ProviderBudgetDeferredError) deferredError = error;
        }
        console.warn(
          entry.isSecondaryProbe ? "[provider_fixture_loader_season_probe_failed]" : "[provider_fixture_loader_league_failed]",
          {
            job_type: jobType,
            league_id: league.league_id,
            ...(entry.seasonId === undefined ? {} : { season_id: entry.seasonId }),
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
  }
  if (attemptedPrimary > 0 && succeededPrimary === 0) {
    throw deferredError ?? firstError;
  }
  return fixtures;
}

function nearMatchWindowHours(): { earliest: number; latest: number } {
  const config = SYNC_TASKS_V1.near_match;
  if (
    config.windowEndHoursBeforeKickoff === undefined ||
    config.windowStartHoursBeforeKickoff === undefined
  ) {
    throw internalError("near_match 缺少窗口配置");
  }
  return {
    earliest: config.windowEndHoursBeforeKickoff,
    latest: config.windowStartHoursBeforeKickoff,
  };
}

/** 生成 32.1 的未来赛程 loader；HTTP client 由外部注入，本模块不连接 Provider。 */
export function createFutureScheduleLoader(
  client: FutureScheduleFixtureClient,
  leagueIds?: readonly string[],
  targetSeasons?: Partial<Record<SupportedLeagueId, string | readonly string[]>>,
): ProviderFixtureBatchLoader {
  return async (serverNow) => {
    assertValidDate(serverNow);
    const dateTo = new Date(
      serverNow.getTime() + FIXED_CONFIG_V1.SYNC_FUTURE_DAYS * DAY_MS,
    );
    const fixtures = await loadFixturesForSupportedLeagues(
      client,
      (leagueId, season, jobType, now, seasonId) => client.getFixtures({
        dateFrom: formatUtcDate(serverNow),
        dateTo: formatUtcDate(dateTo),
        leagueId,
        season,
        ...(seasonId === undefined ? {} : { seasonId }),
        jobType,
        serverNow: now,
      }),
      SyncJobType.FutureSchedule,
      serverNow,
      leagueIds,
      targetSeasons,
    );
    return fixtures.flatMap((item) => {
      const { fixture } = item;
      const kickoff = parseFixtureKickoff(fixture);
      if (
        kickoff === null ||
        kickoff.getTime() >= serverNow.getTime() &&
          kickoff.getTime() <= dateTo.getTime()
      ) {
        return [item];
      }
      return [];
    });
  };
}

/** 生成 32.3 的临近比赛 loader；HTTP client 由外部注入，本模块不连接 Provider。 */
export function createNearMatchLoader(
  client: NearMatchFixtureClient,
): ProviderFixtureBatchLoader {
  return async (serverNow) => {
    assertValidDate(serverNow);
    const window = nearMatchWindowHours();
    const earliestKickoff = new Date(serverNow.getTime() + window.earliest * HOUR_MS);
    const latestKickoff = new Date(serverNow.getTime() + window.latest * HOUR_MS);
    const fixtures = await loadFixturesForSupportedLeagues(
      client,
      (leagueId, season, jobType, now) => client.getFixtures({
        dateFrom: formatUtcDate(earliestKickoff),
        dateTo: formatUtcDate(latestKickoff),
        leagueId,
        season,
        jobType,
        serverNow: now,
      }),
      SyncJobType.NearMatch,
      serverNow,
    );

    return fixtures.flatMap((item) => {
      const { fixture } = item;
      const kickoff = parseFixtureKickoff(fixture);
      if (
        kickoff === null ||
        kickoff.getTime() >= earliestKickoff.getTime() &&
          kickoff.getTime() <= latestKickoff.getTime()
      ) {
        return [item];
      }
      return [];
    });
  };
}

/** 生成 32.4 的 live_match loader；HTTP client 由外部注入，本模块不连接 Provider。 */
export function createLiveMatchLoader(
  client: LiveMatchFixtureClient,
): ProviderFixtureBatchLoader {
  return async (serverNow) => {
    assertValidDate(serverNow);
    const config = SYNC_TASKS_V1.live_match;
    if (config.windowStartHoursBeforeKickoff === undefined) {
      throw internalError("live_match 缺少 kickoff 窗口配置");
    }

    const latestKickoff = new Date(
      serverNow.getTime() + config.windowStartHoursBeforeKickoff * HOUR_MS,
    );
    const fixtures = await loadFixturesForSupportedLeagues(
      client,
      (leagueId, season, jobType, now) => client.getFixtures({
        dateFrom: formatUtcDate(serverNow),
        dateTo: formatUtcDate(latestKickoff),
        leagueId,
        season,
        jobType,
        serverNow: now,
      }),
      SyncJobType.LiveMatch,
      serverNow,
    );

    return fixtures.flatMap((item) => {
      const { fixture } = item;
      const kickoff = parseFixtureKickoff(fixture);
      // 32.4：窗口为「T-2h ～ finished」，不设下界——已开赛（kickoff < server_now）
      // 且未 finished 的场次必须继续进入高频批次，直到收到 finished 为止。
      if (kickoff === null || kickoff.getTime() <= latestKickoff.getTime()) {
        return [item];
      }
      return [];
    });
  };
}

/** 生成 32.2 的完整赛季校验 loader；HTTP client 由外部注入，本模块不连接 Provider。 */
export function createFullScheduleVerifyLoader(
  client: FullScheduleFixtureClient,
  leagueIds?: readonly string[],
  targetSeasons?: Partial<Record<SupportedLeagueId, string | readonly string[]>>,
): ProviderFixtureBatchLoader {
  return async (serverNow) => {
    assertValidDate(serverNow);
    const fixtures = await loadFixturesForSupportedLeagues(
      client,
      (leagueId, season, jobType, now, seasonId) => client.getSeasonFixtures({ leagueId, season, jobType, serverNow: now, ...(seasonId === undefined ? {} : { seasonId }) }),
      SyncJobType.FullScheduleVerify,
      serverNow,
      leagueIds,
      targetSeasons,
    );
    return fixtures;
  };
}
