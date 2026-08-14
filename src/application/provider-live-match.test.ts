import { describe, expect, it, vi } from "vitest";
import { MVP_SEASON } from "../domain/config.js";
import {
  AnomalyStatus,
  AnomalyType,
  MatchStatus,
  Provider,
  SettlementStatus,
  SyncJobType,
  TeamStatus,
} from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { Match, Team, TeamProviderMapping } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { makeApiFixture } from "../provider/fixture-factory.js";
import type { ApiFootballFixture } from "../provider/types.js";
import { ProviderLiveMatchService } from "./provider-live-match.js";

const NOW = new Date("2026-08-10T12:34:56.000Z");

async function seedMappedMatch(
  repo: InMemoryRepository,
  providerMatchId: string,
): Promise<void> {
  const homeTeamId = newUuid();
  const awayTeamId = newUuid();
  const team = (teamId: string, name: string): Team => ({
    schema_version: 1,
    team_id: teamId,
    name,
    short_name: null,
    primary_color: null,
    secondary_color: null,
    status: TeamStatus.Active,
    created_at: NOW,
    updated_at: NOW,
  });
  const mapping = (
    teamId: string,
    providerTeamId: string,
  ): TeamProviderMapping => ({
    schema_version: 1,
    team_id: teamId,
    provider: Provider.ApiFootball,
    provider_team_id: providerTeamId,
    created_at: NOW,
    updated_at: NOW,
  });
  await repo.teams.insert(team(homeTeamId, "Home FC"));
  await repo.teams.insert(team(awayTeamId, "Away FC"));
  await repo.teamProviderMappings.insert(mapping(homeTeamId, "40"));
  await repo.teamProviderMappings.insert(mapping(awayTeamId, "41"));

  const match: Match = {
    schema_version: 1,
    match_id: newUuid(),
    league_id: MVP_SEASON.league_id,
    season_id: MVP_SEASON.season_id,
    round_id: "01",
    home_team_id: homeTeamId,
    away_team_id: awayTeamId,
    kickoff_at: new Date("2026-08-10T12:00:00.000Z"),
    kickoff_confirmed: true,
    prediction_deadline_at: new Date("2026-08-10T11:50:00.000Z"),
    prediction_closed_at: new Date("2026-08-10T11:50:00.000Z"),
    period_anchor_at: new Date("2026-08-10T12:00:00.000Z"),
    match_status: MatchStatus.Scheduled,
    settlement_status: SettlementStatus.Pending,
    regular_home_score: null,
    regular_away_score: null,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 0,
    settled_result_version: 0,
    result_source: null,
    scoring_rule_version: "scoring_v1",
    finish_detected_at: null,
    settled_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
  await repo.matches.insert(match);
  await repo.matchProviderMappings.insert({
    schema_version: 1,
    match_id: match.match_id,
    provider: Provider.ApiFootball,
    provider_match_id: providerMatchId,
    created_at: NOW,
    updated_at: NOW,
  });
}

describe("ProviderLiveMatchService", () => {
  it("串联固定赛季球队 mapping、live_match loader 与 fixture 同步", async () => {
    const repo = new InMemoryRepository();
    await seedMappedMatch(repo, "1200031");
    const fixture = makeApiFixture({
      fixtureId: 1200031,
      statusShort: "1H",
      date: "2026-08-10T12:00:00.000Z",
      timestamp: Date.parse("2026-08-10T12:00:00.000Z") / 1000,
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
        dateFrom: "2026-08-09",
        dateTo: "2026-08-10",
        leagueId: MVP_SEASON.api_football_league_id,
        season: MVP_SEASON.api_football_season,
      });
      return [fixture];
    });

    const outcome = await new ProviderLiveMatchService(repo, {
      getTeams,
      getFixtures,
    }).run(NOW);

    expect(outcome).toMatchObject({
      teams: {
        kind: "completed",
        teams_read: 2,
        teams_created: 0,
        teams_unchanged: 2,
      },
      fixtures: {
        kind: "completed",
        job_type: SyncJobType.LiveMatch,
        items_read: 1,
        items_changed: 1,
        items_failed: 0,
      },
    });
    const mapping = await repo.matchProviderMappings.findByProviderAndExternalId(
      Provider.ApiFootball,
      "1200031",
    );
    expect(mapping).not.toBeNull();
    await expect(repo.matches.findById(mapping!.match_id)).resolves.toMatchObject({
      match_status: MatchStatus.Live,
      season_id: MVP_SEASON.season_id,
      round_id: "01",
    });
    expect(getTeams).toHaveBeenCalledTimes(1);
    expect(getFixtures).toHaveBeenCalledTimes(1);
  });

  it("批次未触达的库内 live match 在 job 后巡检评估 LIVE_SYNC_STALE", async () => {
    const repo = new InMemoryRepository();
    await seedMappedMatch(repo, "1200032");
    const mapping = await repo.matchProviderMappings.findByProviderAndExternalId(
      Provider.ApiFootball,
      "1200032",
    );
    const match = await repo.matches.findById(mapping!.match_id);
    const staleSince = new Date(NOW.getTime() - 11 * 60 * 1000);
    await repo.matches.update({
      ...match!,
      match_status: MatchStatus.Live,
      period_anchor_at: match!.kickoff_at,
    });
    await repo.providerSnapshots.insert({
      schema_version: 1,
      snapshot_id: newUuid(),
      provider: Provider.ApiFootball,
      entity_type: "match",
      entity_id: match!.match_id,
      provider_entity_id: "1200032",
      event_type: "status_changed",
      payload: { sync: "success" },
      created_at: staleSince,
    });

    const getTeams = vi.fn(async () => []);
    const getFixtures = vi.fn(async () => [] as readonly ApiFootballFixture[]);

    const outcome = await new ProviderLiveMatchService(repo, {
      getTeams,
      getFixtures,
    }).run(NOW);

    expect(outcome).toMatchObject({
      kind: "completed",
      fixtures: {
        kind: "completed",
        job_type: SyncJobType.LiveMatch,
        items_read: 0,
        items_changed: 0,
        items_failed: 0,
      },
    });
    await expect(
      repo.anomalies.findByKey(`${match!.match_id}:${AnomalyType.LiveSyncStale}`),
    ).resolves.toMatchObject({
      status: AnomalyStatus.Open,
      blocking: false,
      details: { last_successful_sync_at: staleSince.toISOString() },
    });
  });

  it("live_match 锁被占用时跳过整个任务，不调用 Provider client", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const repo = new InMemoryRepository();
      await repo.jobLocks.acquire(
        "sync:live_match",
        "other-owner",
        new Date(NOW.getTime() + 60_000),
      );
      const getTeams = vi.fn(async () => []);
      const getFixtures = vi.fn(async () => [] as readonly ApiFootballFixture[]);

      const outcome = await new ProviderLiveMatchService(repo, {
        getTeams,
        getFixtures,
      }).run(NOW);

      expect(outcome).toEqual({
        kind: "skipped",
        fixtures: {
          kind: "skipped",
          job_type: SyncJobType.LiveMatch,
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
