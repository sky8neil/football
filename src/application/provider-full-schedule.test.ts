import { describe, expect, it, vi } from "vitest";
import { MVP_SEASON, SUPPORTED_LEAGUES } from "../domain/config.js";
import { MatchStatus, Provider, SCHEMA_VERSION, SyncJobType } from "../domain/enums.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { makeApiFixture } from "../provider/fixture-factory.js";
import type { ApiFootballFixture } from "../provider/types.js";
import { ProviderFullScheduleVerifyService } from "./provider-full-schedule.js";

const NOW = new Date("2026-08-10T12:34:56.000Z");

describe("ProviderFullScheduleVerifyService", () => {
  it("串联球队 mapping、完整赛季 loader 与 fixture 同步", async () => {
    const repo = new InMemoryRepository();
    const fixture = makeApiFixture({
      fixtureId: 1200011,
      statusShort: "NS",
      date: "2026-08-11T12:34:56.000Z",
      timestamp: Date.parse("2026-08-11T12:34:56.000Z") / 1000,
      round: "Regular Season - 1",
    });
    const getTeams = vi.fn(async (query: {
      leagueId: string;
      season: string;
    }) => {
      if (query.leagueId !== MVP_SEASON.api_football_league_id) {
        return [];
      }
      expect(query.season).toBe(MVP_SEASON.api_football_season);
      return [
        { team: { id: 40, name: "Home FC" } },
        { team: { id: 41, name: "Away FC" } },
      ];
    });
    const getSeasonFixtures = vi.fn(async (query: {
      leagueId: string;
      season: string;
    }): Promise<readonly ApiFootballFixture[]> => {
      expect(query.season).toBe(MVP_SEASON.api_football_season);
      return query.leagueId === MVP_SEASON.api_football_league_id ? [fixture] : [];
    });

    const outcome = await new ProviderFullScheduleVerifyService(repo, {
      getTeams,
      getSeasonFixtures,
    }).run(NOW);

    expect(outcome).toMatchObject({
      teams: {
        kind: "completed",
        teams_read: 2,
        teams_created: 2,
        teams_unchanged: 0,
      },
      fixtures: {
        kind: "completed",
        job_type: SyncJobType.FullScheduleVerify,
        items_read: 1,
        items_changed: 1,
        items_failed: 0,
      },
    });
    const mapping = await repo.matchProviderMappings.findByProviderAndExternalId(
      Provider.ApiFootball,
      "1200011",
    );
    expect(mapping).not.toBeNull();
    await expect(repo.matches.findById(mapping!.match_id)).resolves.toMatchObject({
      match_status: MatchStatus.Scheduled,
      season_id: MVP_SEASON.season_id,
      round_id: "01",
    });
    expect(getTeams).toHaveBeenCalledTimes(SUPPORTED_LEAGUES.length);
    expect(getSeasonFixtures).toHaveBeenCalledTimes(SUPPORTED_LEAGUES.length);
  });

  it("full_schedule_verify 锁被占用时跳过整个任务，不调用 Provider client", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const repo = new InMemoryRepository();
      await repo.jobLocks.acquire(
        "sync:full_schedule_verify",
        "other-owner",
        new Date(NOW.getTime() + 60_000),
      );
      const getTeams = vi.fn(async () => []);
      const getSeasonFixtures = vi.fn(async () => [] as readonly ApiFootballFixture[]);

      const outcome = await new ProviderFullScheduleVerifyService(repo, {
        getTeams,
        getSeasonFixtures,
      }).run(NOW);

      expect(outcome).toEqual({
        kind: "skipped",
        fixtures: {
          kind: "skipped",
          job_type: SyncJobType.FullScheduleVerify,
          reason: "lock_held",
        },
      });
      expect(getTeams).not.toHaveBeenCalled();
      expect(getSeasonFixtures).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("[A-S7-01] probes nextSeason in June for cross-year leagues (and December for CSL) without failing if nextSeason probe errors", async () => {
    const juneNow = new Date("2026-06-15T12:00:00.000Z");
    const repo = new InMemoryRepository();
    const fixture2526 = makeApiFixture({
      fixtureId: 1200101,
      leagueId: 39,
      season: "2025",
      date: "2026-05-24T15:00:00.000Z",
      timestamp: Date.parse("2026-05-24T15:00:00.000Z") / 1000,
    });
    const fixture2627 = makeApiFixture({
      fixtureId: 1200102,
      leagueId: 39,
      season: "2026",
      homeTeamId: 40,
      awayTeamId: 42,
      date: "2026-08-15T14:00:00.000Z",
      timestamp: Date.parse("2026-08-15T14:00:00.000Z") / 1000,
    });
    const getTeams = vi.fn(async (query: { leagueId: string; season: string; seasonId?: string }) => {
      if (query.leagueId !== "39") return [];
      if (query.seasonId === "2026_2027") {
        return [{ team: { id: 40, name: "Home FC" } }, { team: { id: 42, name: "Promoted FC" } }];
      }
      return [{ team: { id: 40, name: "Home FC" } }, { team: { id: 41, name: "Away FC" } }];
    });
    const getSeasonFixtures = vi.fn(async (query: { leagueId: string; seasonId?: string }) => {
      if (query.leagueId === "39" && query.seasonId === "2025_2026") return [fixture2526];
      if (query.leagueId === "39" && query.seasonId === "2026_2027") return [fixture2627];
      // Simulate next-season unpublished 404 on La Liga ("140"): must NOT fail active season
      if (query.leagueId === "140" && query.seasonId === "2026_2027") {
        throw new Error("next season not published yet");
      }
      return [];
    });

    const outcome = await new ProviderFullScheduleVerifyService(repo, { getTeams, getSeasonFixtures }).run(juneNow);
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("expected completed");
    expect(outcome.teams.teams_created).toBe(3);

    const eplSeasonCalls = getSeasonFixtures.mock.calls
      .map(([q]) => q)
      .filter((q) => q.leagueId === "39")
      .map((q) => q.seasonId);
    expect(eplSeasonCalls).toEqual(["2025_2026", "2026_2027"]);
    // June does NOT probe 2027 for calendar-year CSL ("169")
    const cslJuneCalls = getSeasonFixtures.mock.calls
      .map(([q]) => q)
      .filter((q) => q.leagueId === "169")
      .map((q) => q.seasonId);
    expect(cslJuneCalls).toEqual(["2026"]);

    const mNew = await repo.matchProviderMappings.findByProviderAndExternalId(Provider.ApiFootball, "1200102");
    expect(mNew).not.toBeNull();
    expect((await repo.matches.findById(mNew!.match_id))?.season_id).toBe("2026_2027");
    expect(await repo.seasonTeams.findByLeagueSeason("premier_league", "2026_2027")).toHaveLength(2);

    // December probes nextSeason "2027" for natural-year CSL ("169")
    const decNow = new Date("2026-12-15T12:00:00.000Z");
    const cslDecCalls: string[] = [];
    await new ProviderFullScheduleVerifyService(repo, {
      getTeams: async () => [],
      getSeasonFixtures: async (q) => {
        if (q.leagueId === "169" && q.seasonId) cslDecCalls.push(q.seasonId);
        return [];
      },
    }).run(decNow, "chinese_super_league");
    expect(cslDecCalls).toEqual(["2026", "2027"]);
  });

  it("[A-S7-01] probes uncompleted previousSeason in July/January and skips completed previousSeason", async () => {
    const julyNow = new Date("2026-07-15T12:00:00.000Z");
    const repo = new InMemoryRepository();
    await repo.leagueSeasons.insert({
      schema_version: SCHEMA_VERSION,
      league_id: "premier_league",
      season_id: "2025_2026",
      format: { kind: "double_round_robin", team_count: 20, round_count: 38 },
      schedule_status: "locked",
      completion_status: "open",
      completion_confirmed_at: null,
      reopened_at: null,
      reopen_count: 0,
      ended_at: null,
      manual_override: null,
      created_at: julyNow,
      updated_at: julyNow,
    });
    await repo.leagueSeasons.insert({
      schema_version: SCHEMA_VERSION,
      league_id: "la_liga",
      season_id: "2025_2026",
      format: { kind: "double_round_robin", team_count: 20, round_count: 38 },
      schedule_status: "locked",
      completion_status: "completed",
      completion_confirmed_at: julyNow,
      reopened_at: null,
      reopen_count: 0,
      ended_at: julyNow,
      manual_override: null,
      created_at: julyNow,
      updated_at: julyNow,
    });

    const fixturePrevCatchup = makeApiFixture({
      fixtureId: 1200201,
      leagueId: 39,
      season: "2025",
      date: "2026-07-10T15:00:00.000Z",
      timestamp: Date.parse("2026-07-10T15:00:00.000Z") / 1000,
    });
    const seasonCalls: Array<{ leagueId: string; seasonId?: string }> = [];
    await new ProviderFullScheduleVerifyService(repo, {
      getTeams: async (q) => q.leagueId === "39"
        ? [{ team: { id: 40, name: "Home FC" } }, { team: { id: 41, name: "Away FC" } }]
        : [],
      getSeasonFixtures: async (q) => {
        seasonCalls.push({ leagueId: q.leagueId, ...(q.seasonId ? { seasonId: q.seasonId } : {}) });
        return q.leagueId === "39" && q.seasonId === "2025_2026" ? [fixturePrevCatchup] : [];
      },
    }).run(julyNow);

    expect(seasonCalls.filter((c) => c.leagueId === "39").map((c) => c.seasonId)).toEqual(["2026_2027", "2025_2026"]);
    expect(seasonCalls.filter((c) => c.leagueId === "140").map((c) => c.seasonId)).toEqual(["2026_2027"]);
    const prevMapping = await repo.matchProviderMappings.findByProviderAndExternalId(Provider.ApiFootball, "1200201");
    expect(prevMapping).not.toBeNull();
    expect((await repo.matches.findById(prevMapping!.match_id))?.season_id).toBe("2025_2026");

    // January probes open previousSeason "2026" for natural-year CSL ("169")
    const janNow = new Date("2027-01-15T12:00:00.000Z");
    await repo.leagueSeasons.insert({
      schema_version: SCHEMA_VERSION,
      league_id: "chinese_super_league",
      season_id: "2026",
      format: { kind: "double_round_robin", team_count: 16, round_count: 30 },
      schedule_status: "locked",
      completion_status: "open",
      completion_confirmed_at: null,
      reopened_at: null,
      reopen_count: 0,
      ended_at: null,
      manual_override: null,
      created_at: janNow,
      updated_at: janNow,
    });
    const cslJanCalls: string[] = [];
    await new ProviderFullScheduleVerifyService(repo, {
      getTeams: async () => [],
      getSeasonFixtures: async (q) => {
        if (q.leagueId === "169" && q.seasonId) cslJanCalls.push(q.seasonId);
        return [];
      },
    }).run(janNow, "chinese_super_league");
    expect(cslJanCalls).toEqual(["2027", "2026"]);
  });
});
