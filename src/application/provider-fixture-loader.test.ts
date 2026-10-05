import { describe, expect, it, vi } from "vitest";
import { SUPPORTED_LEAGUES } from "../domain/config.js";
import { makeApiFixture } from "../provider/fixture-factory.js";
import type { ApiFootballFixturesQuery } from "../provider/http.js";
import type { ApiFootballFixture } from "../provider/types.js";
import {
  createFullScheduleVerifyLoader,
  createFutureScheduleLoader,
  createLiveMatchLoader,
  createNearMatchLoader,
} from "./provider-fixture-loader.js";

const NOW = new Date("2026-08-10T12:34:56.000Z");
const EPL = SUPPORTED_LEAGUES[0];
const LA_LIGA = SUPPORTED_LEAGUES[1];

function eplOnly<T>(
  query: { leagueId: string },
  fixtures: readonly T[],
): T[] {
  return query.leagueId === EPL.api_football_league_id ? [...fixtures] : [];
}

function expectSixLeagueCalls(
  calls: unknown[],
  extra: Record<string, string> = {},
): void {
  expect(calls).toHaveLength(SUPPORTED_LEAGUES.length);
  expect(calls).toEqual(
    SUPPORTED_LEAGUES.map((row) => ({
      ...extra,
      leagueId: row.api_football_league_id,
      season: row.api_football_season,
    })),
  );
}

describe("createFutureScheduleLoader", () => {
  it("只返回 server_now 起未来 30 天内的 kickoff，非法时间交给下游 fail closed", async () => {
    const past = makeApiFixture({
      fixtureId: 1100009,
      date: "2026-08-10T12:34:55.000Z",
      timestamp: Date.parse("2026-08-10T12:34:55.000Z") / 1000,
    });
    const future = makeApiFixture({
      fixtureId: 1100010,
      date: "2026-08-11T12:34:56.000Z",
      timestamp: Date.parse("2026-08-11T12:34:56.000Z") / 1000,
    });
    const invalidTime = makeApiFixture({
      fixtureId: 1100011,
      date: "invalid",
    });
    const getFixtures = vi.fn(async (query: { leagueId: string }) =>
      eplOnly(query, [past, future, invalidTime]),
    );

    const loader = createFutureScheduleLoader({ getFixtures });

    await expect(loader(NOW)).resolves.toEqual([
      { fixture: future, payload: { fixture: future } },
      { fixture: invalidTime, payload: { fixture: invalidTime } },
    ]);
  });

  it("按 server_now 到未来 30 天读取固定英超赛季并保留 fixture payload", async () => {
    const fixture = makeApiFixture({
      fixtureId: 1100007,
      date: "2026-08-11T12:34:56.000Z",
      timestamp: Date.parse("2026-08-11T12:34:56.000Z") / 1000,
    });
    const getFixtures = vi.fn(async (query: {
      dateFrom: string;
      dateTo: string;
      leagueId: string;
      season: string;
    }): Promise<ApiFootballFixture[]> => eplOnly(query, [fixture]));

    const loader = createFutureScheduleLoader({ getFixtures });

    await expect(loader(NOW)).resolves.toEqual([
      {
        fixture,
        payload: { fixture },
      },
    ]);
    expectSixLeagueCalls(getFixtures.mock.calls.map((call) => call[0]), {
      dateFrom: "2026-08-10",
      dateTo: "2026-09-09",
    });
  });

  it("顺序遍历六联赛并合并返回", async () => {
    const epl = makeApiFixture({
      fixtureId: 1100040,
      leagueId: 39,
      date: "2026-08-11T12:34:56.000Z",
      timestamp: Date.parse("2026-08-11T12:34:56.000Z") / 1000,
    });
    const laLiga = makeApiFixture({
      fixtureId: 1100041,
      leagueId: 140,
      date: "2026-08-12T12:34:56.000Z",
      timestamp: Date.parse("2026-08-12T12:34:56.000Z") / 1000,
    });
    const getFixtures = vi.fn(async (query: { leagueId: string }) => {
      if (query.leagueId === EPL.api_football_league_id) {
        return [epl];
      }
      if (query.leagueId === LA_LIGA.api_football_league_id) {
        return [laLiga];
      }
      return [];
    });

    const loader = createFutureScheduleLoader({ getFixtures });
    await expect(loader(NOW)).resolves.toEqual([
      { fixture: epl, payload: { fixture: epl } },
      { fixture: laLiga, payload: { fixture: laLiga } },
    ]);
    expect(getFixtures).toHaveBeenCalledTimes(SUPPORTED_LEAGUES.length);
  });

  it("无效 server_now 时 fail closed 且不调用 Provider client", async () => {
    const getFixtures = vi.fn(async () => [] as ApiFootballFixture[]);
    const loader = createFutureScheduleLoader({ getFixtures });

    await expect(loader(new Date("invalid"))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(getFixtures).not.toHaveBeenCalled();
  });
});

describe("createFullScheduleVerifyLoader", () => {
  it("按固定英超赛季读取完整赛程并保留 fixture payload", async () => {
    const fixture = makeApiFixture({ fixtureId: 1100008 });
    const getSeasonFixtures = vi.fn(async (query: {
      leagueId: string;
      season: string;
    }): Promise<readonly ApiFootballFixture[]> => eplOnly(query, [fixture]));

    const loader = createFullScheduleVerifyLoader({ getSeasonFixtures });

    await expect(loader(NOW)).resolves.toEqual([
      {
        fixture,
        payload: { fixture },
      },
    ]);
    expectSixLeagueCalls(getSeasonFixtures.mock.calls.map((call) => call[0]));
  });

  it("无效 server_now 时 fail closed 且不调用 Provider client", async () => {
    const getSeasonFixtures = vi.fn(async () => [] as readonly ApiFootballFixture[]);
    const loader = createFullScheduleVerifyLoader({ getSeasonFixtures });

    await expect(loader(new Date("invalid"))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(getSeasonFixtures).not.toHaveBeenCalled();
  });
});

describe("createNearMatchLoader", () => {
  it("请求覆盖 T-24h 到 T-2h 的日期并只保留窗口内 kickoff", async () => {
    const at = (fixtureId: number, offsetHours: number): ApiFootballFixture => {
      const kickoff = new Date(NOW.getTime() + offsetHours * 60 * 60 * 1000);
      return makeApiFixture({
        fixtureId,
        date: kickoff.toISOString(),
        timestamp: kickoff.getTime() / 1000,
      });
    };
    const getFixtures = vi.fn(async (query: {
      dateFrom: string;
      dateTo: string;
      leagueId: string;
      season: string;
    }): Promise<readonly ApiFootballFixture[]> =>
      eplOnly(query, [at(1100010, 2), at(1100011, 24), at(1100012, 1), at(1100013, 25)]),
    );

    const loader = createNearMatchLoader({ getFixtures });

    await expect(loader(NOW)).resolves.toEqual([
      { fixture: at(1100010, 2), payload: { fixture: at(1100010, 2) } },
      { fixture: at(1100011, 24), payload: { fixture: at(1100011, 24) } },
    ]);
    expectSixLeagueCalls(getFixtures.mock.calls.map((call) => call[0]), {
      dateFrom: "2026-08-10",
      dateTo: "2026-08-11",
    });
  });

  it("保留 kickoff 无法解析的 fixture 交给下游 fail closed", async () => {
    const invalid = makeApiFixture({
      fixtureId: 1100014,
      date: "not-a-date",
      timestamp: NOW.getTime() / 1000 + 3 * 60 * 60,
    });
    const getFixtures = vi.fn(async (query: { leagueId: string }) =>
      eplOnly(query, [invalid]),
    );
    const loader = createNearMatchLoader({ getFixtures });

    await expect(loader(NOW)).resolves.toEqual([
      { fixture: invalid, payload: { fixture: invalid } },
    ]);
  });
});

describe("createLiveMatchLoader", () => {
  it("从注入时钟计算 T-2h 上界，已开赛场次（含旧 kickoff）保留、非法时间交给下游", async () => {
    const at = (
      fixtureId: number,
      offsetHours: number,
      statusShort = "NS",
    ): ApiFootballFixture => {
      const kickoff = new Date(NOW.getTime() + offsetHours * 60 * 60 * 1000);
      return makeApiFixture({
        fixtureId,
        statusShort,
        date: kickoff.toISOString(),
        timestamp: kickoff.getTime() / 1000,
      });
    };
    const invalidKickoff = makeApiFixture({
      fixtureId: 1100024,
      date: "not-a-date",
      timestamp: Number.NaN,
    });
    const getFixtures = vi.fn(async (query: ApiFootballFixturesQuery) =>
      eplOnly(query, [
        at(1100020, -3, "1H"),
        at(1100021, 2),
        at(1100022, 2.01),
        invalidKickoff,
      ]),
    );

    const loader = createLiveMatchLoader({ getFixtures });

    await expect(loader(NOW)).resolves.toEqual([
      { fixture: at(1100020, -3, "1H"), payload: { fixture: at(1100020, -3, "1H") } },
      { fixture: at(1100021, 2), payload: { fixture: at(1100021, 2) } },
      { fixture: invalidKickoff, payload: { fixture: invalidKickoff } },
    ]);
    const calls = getFixtures.mock.calls.map((call) => call[0]);
    expectSixLeagueCalls(calls, {
      dateFrom: "2026-08-10",
      dateTo: "2026-08-10",
    });
  });

  it("32.4 窗口无下界：已开赛未 finished 的场次纳入，超过 now+2h 的排除", async () => {
    const at = (fixtureId: number, offsetHours: number): ApiFootballFixture => {
      const kickoff = new Date(NOW.getTime() + offsetHours * 60 * 60 * 1000);
      return makeApiFixture({
        fixtureId,
        date: kickoff.toISOString(),
        timestamp: kickoff.getTime() / 1000,
      });
    };
    const getFixtures = vi.fn(async (query: { leagueId: string }) =>
      eplOnly(query, [at(1100025, -25), at(1100026, 25), at(1100028, 1)]),
    );

    const loader = createLiveMatchLoader({ getFixtures });

    await expect(loader(NOW)).resolves.toEqual([
      { fixture: at(1100025, -25), payload: { fixture: at(1100025, -25) } },
      { fixture: at(1100028, 1), payload: { fixture: at(1100028, 1) } },
    ]);
  });

  it("逐条容错：批量中结构非法 fixture 不弃整包，合法项照常返回", async () => {
    const kickoff = new Date(NOW.getTime() + 1 * 60 * 60 * 1000);
    const valid = makeApiFixture({
      fixtureId: 1100030,
      date: kickoff.toISOString(),
      timestamp: kickoff.getTime() / 1000,
    });
    const invalid = {} as ApiFootballFixture;
    const getFixtures = vi.fn(async (query: ApiFootballFixturesQuery) =>
      eplOnly(query, [valid, invalid]),
    );

    const loader = createLiveMatchLoader({ getFixtures });

    await expect(loader(NOW)).resolves.toEqual([
      { fixture: valid, payload: { fixture: valid } },
      { fixture: invalid, payload: { fixture: invalid } },
    ]);
  });

  it("无效 server_now 时 fail closed 且不调用 Provider client", async () => {
    const getFixtures = vi.fn(async () => [] as readonly ApiFootballFixture[]);
    const loader = createLiveMatchLoader({ getFixtures });

    await expect(loader(new Date("invalid"))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(getFixtures).not.toHaveBeenCalled();
  });
});
