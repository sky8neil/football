import { describe, expect, it, vi } from "vitest";
import { MVP_SEASON } from "../domain/config.js";
import { makeApiFixture } from "../provider/fixture-factory.js";
import type { ApiFootballFixture } from "../provider/types.js";
import {
  createFullScheduleVerifyLoader,
  createFutureScheduleLoader,
  createLiveMatchLoader,
  createNearMatchLoader,
  createPostFinishVerifyLoader,
} from "./provider-fixture-loader.js";

const NOW = new Date("2026-08-10T12:34:56.000Z");

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
    const getFixtures = vi.fn(async () => [past, future, invalidTime]);

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
    }): Promise<ApiFootballFixture[]> => {
      expect(query).toEqual({
        dateFrom: "2026-08-10",
        dateTo: "2026-09-09",
        leagueId: MVP_SEASON.api_football_league_id,
        season: MVP_SEASON.api_football_season,
      });
      return [fixture];
    });

    const loader = createFutureScheduleLoader({ getFixtures });

    await expect(loader(NOW)).resolves.toEqual([
      {
        fixture,
        payload: { fixture },
      },
    ]);
    expect(getFixtures).toHaveBeenCalledTimes(1);
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
    }): Promise<readonly ApiFootballFixture[]> => {
      expect(query).toEqual({
        leagueId: MVP_SEASON.api_football_league_id,
        season: MVP_SEASON.api_football_season,
      });
      return [fixture];
    });

    const loader = createFullScheduleVerifyLoader({ getSeasonFixtures });

    await expect(loader(NOW)).resolves.toEqual([
      {
        fixture,
        payload: { fixture },
      },
    ]);
    expect(getSeasonFixtures).toHaveBeenCalledTimes(1);
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
    }): Promise<readonly ApiFootballFixture[]> => {
      expect(query).toEqual({
        dateFrom: "2026-08-10",
        dateTo: "2026-08-11",
        leagueId: MVP_SEASON.api_football_league_id,
        season: MVP_SEASON.api_football_season,
      });
      return [at(1100010, 2), at(1100011, 24), at(1100012, 1), at(1100013, 25)];
    });

    const loader = createNearMatchLoader({ getFixtures });

    await expect(loader(NOW)).resolves.toEqual([
      { fixture: at(1100010, 2), payload: { fixture: at(1100010, 2) } },
      { fixture: at(1100011, 24), payload: { fixture: at(1100011, 24) } },
    ]);
    expect(getFixtures).toHaveBeenCalledTimes(1);
  });

  it("保留 kickoff 无法解析的 fixture 交给下游 fail closed", async () => {
    const invalid = makeApiFixture({
      fixtureId: 1100014,
      date: "not-a-date",
      timestamp: NOW.getTime() / 1000 + 3 * 60 * 60,
    });
    const getFixtures = vi.fn(async () => [invalid] as readonly ApiFootballFixture[]);
    const loader = createNearMatchLoader({ getFixtures });

    await expect(loader(NOW)).resolves.toEqual([
      { fixture: invalid, payload: { fixture: invalid } },
    ]);
  });
});

describe("createLiveMatchLoader", () => {
  it("读取 T-2h 之前仍可能进行中的比赛，并排除精确窗口之后的赛程", async () => {
    const at = (fixtureId: number, offsetHours: number): ApiFootballFixture => {
      const kickoff = new Date(NOW.getTime() + offsetHours * 60 * 60 * 1000);
      return makeApiFixture({
        fixtureId,
        date: kickoff.toISOString(),
        timestamp: kickoff.getTime() / 1000,
      });
    };
    const invalidKickoff = makeApiFixture({
      fixtureId: 1100024,
      date: "not-a-date",
      timestamp: NOW.getTime() / 1000 - 3 * 60 * 60,
    });
    const getFixtures = vi.fn(async (query: {
      dateFrom: string;
      dateTo: string;
      leagueId: string;
      season: string;
    }): Promise<readonly ApiFootballFixture[]> => {
      expect(query).toEqual({
        dateFrom: "2026-08-09",
        dateTo: "2026-08-10",
        leagueId: MVP_SEASON.api_football_league_id,
        season: MVP_SEASON.api_football_season,
      });
      return [at(1100020, -3), at(1100021, 2), at(1100022, 2.01), invalidKickoff];
    });

    const loader = createLiveMatchLoader({ getFixtures });

    await expect(loader(NOW)).resolves.toEqual([
      { fixture: at(1100020, -3), payload: { fixture: at(1100020, -3) } },
      { fixture: at(1100021, 2), payload: { fixture: at(1100021, 2) } },
      { fixture: invalidKickoff, payload: { fixture: invalidKickoff } },
    ]);
    expect(getFixtures).toHaveBeenCalledTimes(1);
  });

  it("P1-3 硬下界：kickoff 早于 server_now - 24h 的 fixture 不得进入 live 批", async () => {
    const at = (fixtureId: number, offsetHours: number): ApiFootballFixture => {
      const kickoff = new Date(NOW.getTime() + offsetHours * 60 * 60 * 1000);
      return makeApiFixture({
        fixtureId,
        date: kickoff.toISOString(),
        timestamp: kickoff.getTime() / 1000,
      });
    };
    const getFixtures = vi.fn(async () => [
      at(1100025, -25),
      at(1100026, -36),
      at(1100027, -23.5),
      at(1100028, 1),
    ] as readonly ApiFootballFixture[]);

    const loader = createLiveMatchLoader({ getFixtures });

    await expect(loader(NOW)).resolves.toEqual([
      { fixture: at(1100027, -23.5), payload: { fixture: at(1100027, -23.5) } },
      { fixture: at(1100028, 1), payload: { fixture: at(1100028, 1) } },
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

describe("createPostFinishVerifyLoader", () => {
  it("读取最近 24 小时已开始比赛，排除过旧和未来赛程并保留非法时间", async () => {
    const at = (fixtureId: number, offsetHours: number): ApiFootballFixture => {
      const kickoff = new Date(NOW.getTime() + offsetHours * 60 * 60 * 1000);
      return makeApiFixture({
        fixtureId,
        date: kickoff.toISOString(),
        timestamp: kickoff.getTime() / 1000,
      });
    };
    const invalidKickoff = makeApiFixture({
      fixtureId: 1100034,
      date: "not-a-date",
      timestamp: NOW.getTime() / 1000,
    });
    const fixtures = [
      at(1100030, -25),
      at(1100031, -24),
      at(1100032, -1),
      at(1100033, 1),
      invalidKickoff,
    ];
    const getFixtures = vi.fn(async (query: {
      dateFrom: string;
      dateTo: string;
      leagueId: string;
      season: string;
    }): Promise<readonly ApiFootballFixture[]> => {
      expect(query).toEqual({
        dateFrom: "2026-08-09",
        dateTo: "2026-08-10",
        leagueId: MVP_SEASON.api_football_league_id,
        season: MVP_SEASON.api_football_season,
      });
      return fixtures;
    });

    const loader = createPostFinishVerifyLoader({ getFixtures });

    await expect(loader(NOW)).resolves.toEqual([
      { fixture: fixtures[1], payload: { fixture: fixtures[1] } },
      { fixture: fixtures[2], payload: { fixture: fixtures[2] } },
      { fixture: invalidKickoff, payload: { fixture: invalidKickoff } },
    ]);
    expect(getFixtures).toHaveBeenCalledTimes(1);
  });

  it("无效 server_now 时 fail closed 且不调用 Provider client", async () => {
    const getFixtures = vi.fn(async () => [] as readonly ApiFootballFixture[]);
    const loader = createPostFinishVerifyLoader({ getFixtures });

    await expect(loader(new Date("invalid"))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(getFixtures).not.toHaveBeenCalled();
  });
});
