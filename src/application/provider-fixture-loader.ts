import { FIXED_CONFIG_V1, SUPPORTED_LEAGUES } from "../domain/config.js";
import { SyncJobType } from "../domain/enums.js";
import { internalError, validationError } from "../domain/errors.js";
import { parseKickoff } from "../provider/kickoff.js";
import type {
  ApiFootballFixturesQuery,
  ApiFootballSeasonFixturesQuery,
} from "../provider/http.js";
import type {
  ApiFootballFixture,
} from "../provider/types.js";
import { SYNC_TASKS_V1 } from "../sync/config.js";
import type { ProviderFixtureBatchLoader } from "./provider-sync-job.js";

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

async function loadFixturesForSupportedLeagues(
  client: { orderLeagues?: (leagueIds: readonly string[], jobType: SyncJobType, now: Date) => Promise<string[]> },
  load: (leagueId: string, season: string, jobType: SyncJobType, serverNow: Date) => Promise<readonly ApiFootballFixture[]>,
  jobType: SyncJobType,
  serverNow: Date,
  leagueIds?: readonly string[],
): Promise<ApiFootballFixture[]> {
  const fixtures: ApiFootballFixture[] = [];
  const eligibleLeagues = leagueIds
    ? SUPPORTED_LEAGUES.filter((league) => leagueIds.includes(league.league_id))
    : SUPPORTED_LEAGUES;
  const orderedIds = client.orderLeagues
    ? await client.orderLeagues(eligibleLeagues.map((league) => league.league_id), jobType, serverNow)
    : eligibleLeagues.map((league) => league.league_id);
  for (const leagueId of orderedIds) {
    const league = SUPPORTED_LEAGUES.find((row) => row.league_id === leagueId);
    if (!league) continue;
    fixtures.push(...await load(league.api_football_league_id, league.api_football_season, jobType, serverNow));
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
): ProviderFixtureBatchLoader {
  return async (serverNow) => {
    assertValidDate(serverNow);
    const dateTo = new Date(
      serverNow.getTime() + FIXED_CONFIG_V1.SYNC_FUTURE_DAYS * DAY_MS,
    );
    const fixtures = await loadFixturesForSupportedLeagues(
      client,
      (leagueId, season, jobType, now) => client.getFixtures({
        dateFrom: formatUtcDate(serverNow),
        dateTo: formatUtcDate(dateTo),
        leagueId,
        season,
        jobType,
        serverNow: now,
      }),
      SyncJobType.FutureSchedule,
      serverNow,
      leagueIds,
    );
    return fixtures.flatMap((fixture) => {
      const kickoff = parseFixtureKickoff(fixture);
      if (
        kickoff === null ||
        kickoff.getTime() >= serverNow.getTime() &&
          kickoff.getTime() <= dateTo.getTime()
      ) {
        return [{ fixture, payload: { fixture } }];
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

    return fixtures.flatMap((fixture) => {
      const kickoff = parseFixtureKickoff(fixture);
      if (
        kickoff === null ||
        kickoff.getTime() >= earliestKickoff.getTime() &&
          kickoff.getTime() <= latestKickoff.getTime()
      ) {
        return [{ fixture, payload: { fixture } }];
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

    return fixtures.flatMap((fixture) => {
      const kickoff = parseFixtureKickoff(fixture);
      // 32.4：窗口为「T-2h ～ finished」，不设下界——已开赛（kickoff < server_now）
      // 且未 finished 的场次必须继续进入高频批次，直到收到 finished 为止。
      if (kickoff === null || kickoff.getTime() <= latestKickoff.getTime()) {
        return [{ fixture, payload: { fixture } }];
      }
      return [];
    });
  };
}

/** 生成 32.2 的完整赛季校验 loader；HTTP client 由外部注入，本模块不连接 Provider。 */
export function createFullScheduleVerifyLoader(
  client: FullScheduleFixtureClient,
  leagueIds?: readonly string[],
): ProviderFixtureBatchLoader {
  return async (serverNow) => {
    assertValidDate(serverNow);
    const fixtures = await loadFixturesForSupportedLeagues(
      client,
      (leagueId, season, jobType, now) => client.getSeasonFixtures({ leagueId, season, jobType, serverNow: now }),
      SyncJobType.FullScheduleVerify,
      serverNow,
      leagueIds,
    );
    return fixtures.map((fixture) => ({
      fixture,
      payload: { fixture },
    }));
  };
}
