import { describe, expect, it, vi } from "vitest";
import { MVP_SEASON } from "../domain/config.js";
import {
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
import { ProviderPostFinishVerifyService } from "./provider-post-finish.js";

const NOW = new Date("2026-08-10T12:34:56.000Z");

async function seedMappedMatch(
  repo: InMemoryRepository,
  providerMatchId: string,
): Promise<void> {
  const homeTeamId = newUuid();
  const awayTeamId = newUuid();
  const makeTeam = (teamId: string, name: string): Team => ({
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
  const makeMapping = (
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
  await repo.teams.insert(makeTeam(homeTeamId, "Home FC"));
  await repo.teams.insert(makeTeam(awayTeamId, "Away FC"));
  await repo.teamProviderMappings.insert(makeMapping(homeTeamId, "40"));
  await repo.teamProviderMappings.insert(makeMapping(awayTeamId, "41"));

  const kickoffAt = new Date("2026-08-10T12:00:00.000Z");
  const match: Match = {
    schema_version: 1,
    match_id: newUuid(),
    league_id: MVP_SEASON.league_id,
    season_id: MVP_SEASON.season_id,
    round_id: "01",
    home_team_id: homeTeamId,
    away_team_id: awayTeamId,
    kickoff_at: kickoffAt,
    kickoff_confirmed: true,
    prediction_deadline_at: new Date(kickoffAt.getTime() - 10 * 60 * 1000),
    prediction_closed_at: kickoffAt,
    period_anchor_at: kickoffAt,
    match_status: MatchStatus.Finished,
    finish_detected_at: NOW,
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

describe("ProviderPostFinishVerifyService", () => {
  it("串联固定赛季球队 mapping、post_finish_verify loader 与 fixture 同步", async () => {
    const repo = new InMemoryRepository();
    await seedMappedMatch(repo, "1200041");
    const fixture = makeApiFixture({
      fixtureId: 1200041,
      statusShort: "FT",
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

    const outcome = await new ProviderPostFinishVerifyService(repo, {
      getTeams,
      getFixtures,
    }).run(NOW);

    expect(outcome).toMatchObject({
      kind: "completed",
      teams: {
        kind: "completed",
        teams_read: 2,
        teams_created: 0,
        teams_unchanged: 2,
      },
      fixtures: {
        kind: "completed",
        job_type: SyncJobType.PostFinishVerify,
        items_read: 1,
        items_changed: 1,
        items_failed: 0,
      },
    });
    const mapping = await repo.matchProviderMappings.findByProviderAndExternalId(
      Provider.ApiFootball,
      "1200041",
    );
    expect(mapping).not.toBeNull();
    await expect(repo.matches.findById(mapping!.match_id)).resolves.toMatchObject({
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Waiting,
      result_version: 1,
    });
    expect(getTeams).toHaveBeenCalledTimes(1);
    expect(getFixtures).toHaveBeenCalledTimes(1);
  });

  it("highFrequencyUntilFirstSettlement 下 finished+settled 场次被过滤出批次", async () => {
    const repo = new InMemoryRepository();
    await seedMappedMatch(repo, "1200042");
    const mapping = await repo.matchProviderMappings.findByProviderAndExternalId(
      Provider.ApiFootball,
      "1200042",
    );
    const match = await repo.matches.findById(mapping!.match_id);
    await repo.matches.update({
      ...match!,
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Settled,
      regular_home_score: 2,
      regular_away_score: 1,
      result_version: 1,
      settled_result_version: 1,
      result_source: "provider",
      settled_at: NOW,
    });
    await repo.matchResults.insert({
      schema_version: 1,
      match_id: mapping!.match_id,
      result_version: 1,
      regular_home_score: 2,
      regular_away_score: 1,
      source: "provider",
      provider_status: "FT",
      admin_id: null,
      reason: null,
      created_at: NOW,
    });
    const fixture = makeApiFixture({
      fixtureId: 1200042,
      statusShort: "FT",
      fulltimeHome: 2,
      fulltimeAway: 1,
      date: "2026-08-10T12:00:00.000Z",
      timestamp: Date.parse("2026-08-10T12:00:00.000Z") / 1000,
      round: "Regular Season - 1",
    });
    const getTeams = vi.fn(async () => []);
    const getFixtures = vi.fn(async () => [fixture] as readonly ApiFootballFixture[]);

    const outcome = await new ProviderPostFinishVerifyService(repo, {
      getTeams,
      getFixtures,
    }).run(NOW);

    expect(outcome).toMatchObject({
      kind: "completed",
      fixtures: {
        kind: "completed",
        job_type: SyncJobType.PostFinishVerify,
        items_read: 0,
        items_changed: 0,
        items_failed: 0,
      },
    });
    expect(getFixtures).toHaveBeenCalledTimes(1);
    await expect(repo.matches.findById(mapping!.match_id)).resolves.toMatchObject({
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Settled,
      result_version: 1,
    });
    await expect(repo.matchResults.findLatestByMatch(mapping!.match_id)).resolves.toMatchObject({
      result_version: 1,
    });
  });

  it("highFrequencyUntilFirstSettlement 下 finished+waiting 场次仍进入批次", async () => {
    const repo = new InMemoryRepository();
    await seedMappedMatch(repo, "1200043");
    const mapping = await repo.matchProviderMappings.findByProviderAndExternalId(
      Provider.ApiFootball,
      "1200043",
    );
    const match = await repo.matches.findById(mapping!.match_id);
    await repo.matches.update({
      ...match!,
      settlement_status: SettlementStatus.Waiting,
    });
    const fixture = makeApiFixture({
      fixtureId: 1200043,
      statusShort: "FT",
      fulltimeHome: 2,
      fulltimeAway: 1,
      date: "2026-08-10T12:00:00.000Z",
      timestamp: Date.parse("2026-08-10T12:00:00.000Z") / 1000,
      round: "Regular Season - 1",
    });
    const getTeams = vi.fn(async () => []);
    const getFixtures = vi.fn(async () => [fixture] as readonly ApiFootballFixture[]);

    const outcome = await new ProviderPostFinishVerifyService(repo, {
      getTeams,
      getFixtures,
    }).run(NOW);

    expect(outcome).toMatchObject({
      kind: "completed",
      fixtures: {
        kind: "completed",
        job_type: SyncJobType.PostFinishVerify,
        items_read: 1,
        items_changed: 1,
        items_failed: 0,
      },
    });
    await expect(repo.matches.findById(mapping!.match_id)).resolves.toMatchObject({
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Waiting,
      result_version: 1,
      regular_home_score: 2,
      regular_away_score: 1,
    });
  });

  it("post_finish_verify 锁被占用时跳过整个任务，不调用 Provider client", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const repo = new InMemoryRepository();
      await repo.jobLocks.acquire(
        "sync:post_finish_verify",
        "other-owner",
        new Date(NOW.getTime() + 60_000),
      );
      const getTeams = vi.fn(async () => []);
      const getFixtures = vi.fn(async () => [] as readonly ApiFootballFixture[]);

      const outcome = await new ProviderPostFinishVerifyService(repo, {
        getTeams,
        getFixtures,
      }).run(NOW);

      expect(outcome).toEqual({
        kind: "skipped",
        fixtures: {
          kind: "skipped",
          job_type: SyncJobType.PostFinishVerify,
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
