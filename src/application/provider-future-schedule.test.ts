import { describe, expect, it, vi } from "vitest";
import { MVP_SEASON, SUPPORTED_LEAGUES } from "../domain/config.js";
import { MatchStatus, Provider, SCHEMA_VERSION, SyncJobType } from "../domain/enums.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { makeApiFixture } from "../provider/fixture-factory.js";
import type { ApiFootballFixture } from "../provider/types.js";
import { ProviderFutureScheduleService } from "./provider-sync-service.js";

const NOW = new Date("2026-08-10T12:34:56.000Z");

describe("ProviderFutureScheduleService", () => {
  it("串联球队 mapping、future_schedule loader 与 fixture 同步，创建内部 scheduled match", async () => {
    const repo = new InMemoryRepository();
    const fixture = makeApiFixture({
      fixtureId: 1200001,
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
    const getFixtures = vi.fn(async (query: {
      dateFrom: string;
      dateTo: string;
      leagueId: string;
      season: string;
    }): Promise<readonly ApiFootballFixture[]> => {
      expect(query.dateFrom).toBe("2026-08-10");
      expect(query.dateTo).toBe("2026-09-09");
      expect(query.season).toBe(MVP_SEASON.api_football_season);
      return query.leagueId === MVP_SEASON.api_football_league_id ? [fixture] : [];
    });

    const outcome = await new ProviderFutureScheduleService(repo, {
      getTeams,
      getFixtures,
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
        job_type: SyncJobType.FutureSchedule,
        items_read: 1,
        items_changed: 1,
        items_failed: 0,
      },
    });
    const mapping = await repo.matchProviderMappings.findByProviderAndExternalId(
      Provider.ApiFootball,
      "1200001",
    );
    expect(mapping).not.toBeNull();
    await expect(repo.matches.findById(mapping!.match_id)).resolves.toMatchObject({
      match_status: MatchStatus.Scheduled,
      season_id: MVP_SEASON.season_id,
      round_id: "01",
    });
    expect(getTeams).toHaveBeenCalledTimes(SUPPORTED_LEAGUES.length);
    expect(getFixtures).toHaveBeenCalledTimes(SUPPORTED_LEAGUES.length);
  });

  it("future_schedule 锁被占用时跳过整个任务，不调用球队或 fixture client", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const repo = new InMemoryRepository();
      await repo.jobLocks.acquire(
        "sync:future_schedule",
        "other-owner",
        new Date(NOW.getTime() + 60_000),
      );
      const getTeams = vi.fn(async () => []);
      const getFixtures = vi.fn(async () => [] as readonly ApiFootballFixture[]);

      const outcome = await new ProviderFutureScheduleService(repo, {
        getTeams,
        getFixtures,
      }).run(NOW);

      expect(outcome).toEqual({
        kind: "skipped",
        fixtures: {
          kind: "skipped",
          job_type: SyncJobType.FutureSchedule,
          reason: "lock_held",
        },
      });
      expect(getTeams).not.toHaveBeenCalled();
      expect(getFixtures).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("[A-S7-01] probes nextSeason in June/Dec and open previousSeason in July/Jan while separating date-range fixtures by league.season", async () => {
    const juneNow = new Date("2026-06-25T12:00:00.000Z");
    const repo = new InMemoryRepository();
    const prevFixture = makeApiFixture({
      fixtureId: 1200501,
      leagueId: 39,
      season: "2025",
      date: "2026-06-28T14:00:00.000Z",
      timestamp: Date.parse("2026-06-28T14:00:00.000Z") / 1000,
    });
    const nextFixture = makeApiFixture({
      fixtureId: 1200502,
      leagueId: 39,
      season: "2026",
      date: "2026-07-20T14:00:00.000Z",
      timestamp: Date.parse("2026-07-20T14:00:00.000Z") / 1000,
    });
    const calls: Array<{ leagueId: string; seasonId?: string }> = [];

    const outcome = await new ProviderFutureScheduleService(repo, {
      getTeams: async (q) => q.leagueId === "39"
        ? [{ team: { id: 40, name: "Home FC" } }, { team: { id: 41, name: "Away FC" } }]
        : [],
      getFixtures: async (q) => {
        calls.push({ leagueId: q.leagueId, ...(q.seasonId ? { seasonId: q.seasonId } : {}) });
        // Date-range adapter (like FD) returns both seasons in overlapping June-July window
        return q.leagueId === "39" ? [prevFixture, nextFixture] : [];
      },
    }).run(juneNow);

    expect(outcome.kind).toBe("completed");
    expect(calls.filter((c) => c.leagueId === "39").map((c) => c.seasonId)).toEqual(["2025_2026", "2026_2027"]);
    const prevMap = await repo.matchProviderMappings.findByProviderAndExternalId(Provider.ApiFootball, "1200501");
    const nextMap = await repo.matchProviderMappings.findByProviderAndExternalId(Provider.ApiFootball, "1200502");
    expect((await repo.matches.findById(prevMap!.match_id))?.season_id).toBe("2025_2026");
    expect((await repo.matches.findById(nextMap!.match_id))?.season_id).toBe("2026_2027");

    // July with uncompleted 2025_2026 probes 2025_2026 alongside 2026_2027
    const julyNow = new Date("2026-07-10T12:00:00.000Z");
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
    const julyCalls: string[] = [];
    await new ProviderFutureScheduleService(repo, {
      getTeams: async () => [],
      getFixtures: async (q) => {
        if (q.leagueId === "39" && q.seasonId) julyCalls.push(q.seasonId);
        return [];
      },
    }).run(julyNow, "premier_league");
    expect(julyCalls).toEqual(["2026_2027", "2025_2026"]);
  });
});
