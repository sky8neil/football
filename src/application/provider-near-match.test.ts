import { describe, expect, it, vi } from "vitest";
import { MVP_SEASON } from "../domain/config.js";
import { MatchStatus, Provider, SyncJobType } from "../domain/enums.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { makeApiFixture } from "../provider/fixture-factory.js";
import type { ApiFootballFixture } from "../provider/types.js";
import { ProviderNearMatchService } from "./provider-near-match.js";

const NOW = new Date("2026-08-10T12:34:56.000Z");

describe("ProviderNearMatchService", () => {
  it("串联固定赛季球队 mapping、T-24h 到 T-2h loader 与 fixture 同步", async () => {
    const repo = new InMemoryRepository();
    const fixture = makeApiFixture({
      fixtureId: 1200021,
      statusShort: "NS",
      date: "2026-08-10T18:34:56.000Z",
      timestamp: Date.parse("2026-08-10T18:34:56.000Z") / 1000,
      round: "Regular Season - 1",
    });
    const getTeams = vi.fn(async (query: {
      leagueId: string;
      season: string;
    }) => {
      expect(query).toEqual({
        leagueId: MVP_SEASON.api_football_league_id,
        season: MVP_SEASON.api_football_season,
      });
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
      expect(query).toEqual({
        dateFrom: "2026-08-10",
        dateTo: "2026-08-11",
        leagueId: MVP_SEASON.api_football_league_id,
        season: MVP_SEASON.api_football_season,
      });
      return [fixture];
    });

    const outcome = await new ProviderNearMatchService(repo, {
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
        job_type: SyncJobType.NearMatch,
        items_read: 1,
        items_changed: 1,
        items_failed: 0,
      },
    });
    const mapping = await repo.matchProviderMappings.findByProviderAndExternalId(
      Provider.ApiFootball,
      "1200021",
    );
    expect(mapping).not.toBeNull();
    await expect(repo.matches.findById(mapping!.match_id)).resolves.toMatchObject({
      match_status: MatchStatus.Scheduled,
      season_id: MVP_SEASON.season_id,
      round_id: "01",
    });
    expect(getTeams).toHaveBeenCalledTimes(1);
    expect(getFixtures).toHaveBeenCalledTimes(1);
  });

  it("near_match 锁被占用时跳过整个任务，不调用 Provider client", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const repo = new InMemoryRepository();
      await repo.jobLocks.acquire(
        "sync:near_match",
        "other-owner",
        new Date(NOW.getTime() + 60_000),
      );
      const getTeams = vi.fn(async () => []);
      const getFixtures = vi.fn(async () => [] as readonly ApiFootballFixture[]);

      const outcome = await new ProviderNearMatchService(repo, {
        getTeams,
        getFixtures,
      }).run(NOW);

      expect(outcome).toEqual({
        kind: "skipped",
        fixtures: {
          kind: "skipped",
          job_type: SyncJobType.NearMatch,
          reason: "lock_held",
        },
      });
      expect(getTeams).not.toHaveBeenCalled();
      expect(getFixtures).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
