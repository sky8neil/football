import { FIXED_CONFIG_V1, MVP_SEASON } from "../domain/config.js";
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
}

export interface NearMatchFixtureClient {
  getFixtures(query: ApiFootballFixturesQuery): Promise<readonly ApiFootballFixture[]>;
}

export interface LiveMatchFixtureClient {
  getFixtures(query: ApiFootballFixturesQuery): Promise<readonly ApiFootballFixture[]>;
}

export interface PostFinishVerifyFixtureClient {
  getFixtures(query: ApiFootballFixturesQuery): Promise<readonly ApiFootballFixture[]>;
}

export interface FullScheduleFixtureClient {
  getSeasonFixtures(
    query: ApiFootballSeasonFixturesQuery,
  ): Promise<readonly ApiFootballFixture[]>;
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
): ProviderFixtureBatchLoader {
  return async (serverNow) => {
    assertValidDate(serverNow);
    const dateTo = new Date(
      serverNow.getTime() + FIXED_CONFIG_V1.SYNC_FUTURE_DAYS * DAY_MS,
    );
    const query: ApiFootballFixturesQuery = {
      dateFrom: formatUtcDate(serverNow),
      dateTo: formatUtcDate(dateTo),
      leagueId: MVP_SEASON.api_football_league_id,
      season: MVP_SEASON.api_football_season,
    };
    const fixtures = await client.getFixtures(query);
    return fixtures.flatMap((fixture) => {
      const kickoff = parseKickoff(
        fixture.fixture.timestamp,
        fixture.fixture.date,
      ).kickoffAt;
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
    const fixtures = await client.getFixtures({
      dateFrom: formatUtcDate(earliestKickoff),
      dateTo: formatUtcDate(latestKickoff),
      leagueId: MVP_SEASON.api_football_league_id,
      season: MVP_SEASON.api_football_season,
    });

    return fixtures.flatMap((fixture) => {
      const kickoff = parseKickoff(
        fixture.fixture.timestamp,
        fixture.fixture.date,
      ).kickoffAt;
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
    const fixtures = await client.getFixtures({
      dateFrom: formatUtcDate(new Date(serverNow.getTime() - DAY_MS)),
      dateTo: formatUtcDate(latestKickoff),
      leagueId: MVP_SEASON.api_football_league_id,
      season: MVP_SEASON.api_football_season,
    });

    return fixtures.flatMap((fixture) => {
      const kickoff = parseKickoff(
        fixture.fixture.timestamp,
        fixture.fixture.date,
      ).kickoffAt;
      if (kickoff === null || kickoff.getTime() <= latestKickoff.getTime()) {
        return [{ fixture, payload: { fixture } }];
      }
      return [];
    });
  };
}

/** 生成 32.5 的 post_finish_verify loader；HTTP client 由外部注入，本模块不连接 Provider。 */
export function createPostFinishVerifyLoader(
  client: PostFinishVerifyFixtureClient,
): ProviderFixtureBatchLoader {
  return async (serverNow) => {
    assertValidDate(serverNow);
    const earliestKickoff = new Date(serverNow.getTime() - DAY_MS);
    const fixtures = await client.getFixtures({
      dateFrom: formatUtcDate(earliestKickoff),
      dateTo: formatUtcDate(serverNow),
      leagueId: MVP_SEASON.api_football_league_id,
      season: MVP_SEASON.api_football_season,
    });

    return fixtures.flatMap((fixture) => {
      const kickoff = parseKickoff(
        fixture.fixture.timestamp,
        fixture.fixture.date,
      ).kickoffAt;
      if (
        kickoff === null ||
        kickoff.getTime() >= earliestKickoff.getTime() &&
          kickoff.getTime() <= serverNow.getTime()
      ) {
        return [{ fixture, payload: { fixture } }];
      }
      return [];
    });
  };
}

/** 生成 32.2 的完整赛季校验 loader；HTTP client 由外部注入，本模块不连接 Provider。 */
export function createFullScheduleVerifyLoader(
  client: FullScheduleFixtureClient,
): ProviderFixtureBatchLoader {
  return async (serverNow) => {
    assertValidDate(serverNow);
    const query: ApiFootballSeasonFixturesQuery = {
      leagueId: MVP_SEASON.api_football_league_id,
      season: MVP_SEASON.api_football_season,
    };
    const fixtures = await client.getSeasonFixtures(query);
    return fixtures.map((fixture) => ({
      fixture,
      payload: { fixture },
    }));
  };
}
