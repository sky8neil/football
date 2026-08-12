import { describe, expect, it } from "vitest";
import {
  ApiFootballClient,
  ProviderDataError,
  ProviderHttpError,
  ProviderQuotaExceededError,
  assertReadOnlyEndpoint,
  type ProviderHttpClient,
} from "./http.js";
import type { ApiFootballFixture, ApiFootballTeam } from "./types.js";

function envelope<T>(response: T[], errors: unknown = []) {
  return { get: "fixtures", errors, results: response.length, response };
}

function makeHttp(handler: (path: string, query: Record<string, string>) => unknown) {
  const calls: { path: string; query: Record<string, string> }[] = [];
  const http: ProviderHttpClient = {
    getJson: (path, query) => {
      calls.push({ path, query });
      return Promise.resolve(handler(path, query));
    },
  };
  return { http, calls };
}

describe("assertReadOnlyEndpoint（31.1 只允许读取）", () => {
  it("允许只读端点", () => {
    expect(() => assertReadOnlyEndpoint("fixtures")).not.toThrow();
    expect(() => assertReadOnlyEndpoint("teams")).not.toThrow();
    expect(() => assertReadOnlyEndpoint("fixtures/rounds")).not.toThrow();
    expect(() => assertReadOnlyEndpoint("status")).not.toThrow();
  });

  it("禁止 odds / bookmaker / bet 及任何博彩市场接口", () => {
    for (const path of [
      "odds",
      "odds/probabilities",
      "bookmakers",
      "bookmaker/premiums",
      "bets/probabilities",
      "fixtures/bets",
    ]) {
      expect(() => assertReadOnlyEndpoint(path), path).toThrow(ProviderDataError);
    }
  });

  it("禁止未知端点（fail-closed）", () => {
    expect(() => assertReadOnlyEndpoint("bet365")).toThrow(ProviderDataError);
  });
});

describe("ApiFootballClient（注入式 HTTP client，不访问真实 API）", () => {
  it("getFixtures 构造正确 URL/query 并解析 envelope", async () => {
    const fixture: ApiFootballFixture = {
      fixture: { id: 1100001, date: "2026-08-08T14:00:00Z", timestamp: 1783586400, status: { short: "NS" } },
      league: { id: 39, season: "2026", round: "Round 1" },
      teams: { home: { id: 40 }, away: { id: 41 } },
    };
    const { http, calls } = makeHttp(() => envelope([fixture]));
    const client = new ApiFootballClient(http);
    const result = await client.getFixtures({
      dateFrom: "2026-08-08",
      dateTo: "2026-09-08",
      leagueId: "39",
      season: "2026",
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.fixture.id).toBe(1100001);
    expect(calls[0]?.path).toBe("https://v3.football.api-sports.io/fixtures");
    expect(calls[0]?.query).toEqual({
      from: "2026-08-08",
      to: "2026-09-08",
      league: "39",
      season: "2026",
      timezone: "UTC",
    });
  });

  it("getFixtures 使用 API-Football 的 UTC 日期窗口参数", async () => {
    const { http, calls } = makeHttp(() => envelope([]));
    const client = new ApiFootballClient(http);

    await client.getFixtures({
      dateFrom: "2026-08-08",
      dateTo: "2026-09-08",
      leagueId: "39",
      season: "2026",
    });

    expect(calls[0]?.query).toEqual({
      from: "2026-08-08",
      to: "2026-09-08",
      league: "39",
      season: "2026",
      timezone: "UTC",
    });
  });

  it("getFixtures 关键 fixture 结构缺失时按 ProviderDataError fail closed", async () => {
    const { http } = makeHttp(() => envelope([{} as ApiFootballFixture]));
    const client = new ApiFootballClient(http);

    await expect(
      client.getFixtures({
        dateFrom: "2026-08-08",
        dateTo: "2026-09-08",
        leagueId: "39",
        season: "2026",
      }),
    ).rejects.toBeInstanceOf(ProviderDataError);
  });

  it("getSeasonFixtures 查询完整赛季时不带日期窗口", async () => {
    const fixture: ApiFootballFixture = {
      fixture: { id: 1100002, date: "2026-08-08T14:00:00Z", timestamp: 1783586400, status: { short: "NS" } },
      league: { id: 39, season: "2026", round: "Round 1" },
      teams: { home: { id: 40 }, away: { id: 41 } },
    };
    const { http, calls } = makeHttp(() => envelope([fixture]));
    const client = new ApiFootballClient(http);

    await expect(client.getSeasonFixtures({ leagueId: "39", season: "2026" }))
      .resolves.toEqual([fixture]);
    expect(calls[0]?.query).toEqual({
      league: "39",
      season: "2026",
      timezone: "UTC",
    });
  });

  it("getTeams / getFixtureRounds / getStatus 只读方法", async () => {
    const team: ApiFootballTeam = { team: { id: 40, name: "Home FC" } };
    const { http } = makeHttp((path) => {
      if (path.endsWith("/teams")) return envelope([team]);
      if (path.endsWith("/fixtures/rounds")) return envelope(["Round 1", "Round 2"]);
      return envelope([{ account: { firstname: "t" } }]);
    });
    const client = new ApiFootballClient(http);
    const teams = await client.getTeams({ leagueId: "39", season: "2026" });
    const rounds = await client.getFixtureRounds({ leagueId: "39", season: "2026" });
    const status = await client.getStatus();
    expect(teams[0]?.team.id).toBe(40);
    expect(rounds[0]).toBe("Round 1");
    expect(status.account.firstname).toBe("t");
  });

  it("getTeams 关键字段缺失时按 ProviderDataError fail closed", async () => {
    const { http } = makeHttp(() => envelope([{} as ApiFootballTeam]));
    const client = new ApiFootballClient(http);

    await expect(client.getTeams({ leagueId: "39", season: "2026" }))
      .rejects.toBeInstanceOf(ProviderDataError);
  });

  it("getFixtureRounds 响应包含非字符串 round 时按 ProviderDataError fail closed", async () => {
    const { http } = makeHttp(() => envelope([{} as unknown as string]));
    const client = new ApiFootballClient(http);

    await expect(client.getFixtureRounds({ leagueId: "39", season: "2026" }))
      .rejects.toBeInstanceOf(ProviderDataError);
  });

  it("status response 为空时按关键字段缺失 fail closed", async () => {
    const { http } = makeHttp(() => envelope([]));
    const client = new ApiFootballClient(http);

    await expect(client.getStatus()).rejects.toBeInstanceOf(ProviderDataError);
  });

  it("envelope errors 数组非空 -> ProviderDataError", async () => {
    const { http } = makeHttp(() => envelope([], ["unknown endpoint"]));
    const client = new ApiFootballClient(http);
    await expect(
      client.getFixtures({ dateFrom: "a", dateTo: "b", leagueId: "39", season: "2026" }),
    ).rejects.toBeInstanceOf(ProviderDataError);
  });

  it("envelope errors 含 quota -> ProviderQuotaExceededError", async () => {
    const { http } = makeHttp(() => envelope([], { quota: "Quota exceeded" }));
    const client = new ApiFootballClient(http);
    await expect(
      client.getFixtures({ dateFrom: "a", dateTo: "b", leagueId: "39", season: "2026" }),
    ).rejects.toBeInstanceOf(ProviderQuotaExceededError);
  });

  it("HTTP 429 -> ProviderQuotaExceededError（quota 不密集重试）", async () => {
    const { http } = makeHttp(() => {
      throw new ProviderHttpError(429, "Too Many Requests");
    });
    const client = new ApiFootballClient(http);
    await expect(
      client.getFixtures({ dateFrom: "a", dateTo: "b", leagueId: "39", season: "2026" }),
    ).rejects.toBeInstanceOf(ProviderQuotaExceededError);
  });

  it("其他 HTTP 错误原样透传", async () => {
    const { http } = makeHttp(() => {
      throw new ProviderHttpError(500, "Server Error");
    });
    const client = new ApiFootballClient(http);
    await expect(
      client.getFixtures({ dateFrom: "a", dateTo: "b", leagueId: "39", season: "2026" }),
    ).rejects.toMatchObject({ status: 500 });
  });
});
