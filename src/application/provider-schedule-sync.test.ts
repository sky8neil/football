import { describe, expect, it } from "vitest";
import { MatchStatus, Provider, SettlementStatus } from "../domain/enums.js";
import { MVP_SEASON } from "../domain/config.js";
import { newUuid } from "../domain/ids.js";
import type { Team, TeamProviderMapping } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { makeApiFixture } from "../provider/fixture-factory.js";
import type { ApiFootballFixture } from "../provider/types.js";
import { ProviderFixtureSyncService } from "./provider-fixture-sync.js";

const NOW = new Date("2026-08-10T12:00:00.000Z");

function makeTeam(teamId: string): Team {
  return {
    schema_version: 1,
    team_id: teamId,
    name: `Team ${teamId}`,
    short_name: null,
    primary_color: null,
    secondary_color: null,
    status: "active",
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeTeamMapping(teamId: string, providerTeamId: string): TeamProviderMapping {
  return {
    schema_version: 1,
    team_id: teamId,
    provider: Provider.ApiFootball,
    provider_team_id: providerTeamId,
    created_at: NOW,
    updated_at: NOW,
  };
}

async function seedTeams(repo: InMemoryRepository): Promise<{
  homeTeamId: string;
  awayTeamId: string;
}> {
  const homeTeamId = newUuid();
  const awayTeamId = newUuid();
  await repo.teams.insert(makeTeam(homeTeamId));
  await repo.teams.insert(makeTeam(awayTeamId));
  await repo.teamProviderMappings.insert(makeTeamMapping(homeTeamId, "40"));
  await repo.teamProviderMappings.insert(makeTeamMapping(awayTeamId, "41"));
  return { homeTeamId, awayTeamId };
}

describe("Provider schedule discovery", () => {
  it("首次发现合法 scheduled fixture 时创建 match、mapping 和 discovered snapshot", async () => {
    const repo = new InMemoryRepository();
    const teams = await seedTeams(repo);
    const fixture = makeApiFixture({
      fixtureId: 1100100,
      statusShort: "NS",
      date: "2026-08-11T12:00:00.000Z",
      timestamp: Date.parse("2026-08-11T12:00:00.000Z") / 1000,
      round: "Regular Season - 1",
    });

    const outcome = await new ProviderFixtureSyncService(repo).applyFixture(
      fixture,
      { fixture },
      NOW,
    );

    expect(outcome).toMatchObject({
      kind: "applied",
      match_status: MatchStatus.Scheduled,
    });
    const mapping = await repo.matchProviderMappings.findByProviderAndExternalId(
      Provider.ApiFootball,
      "1100100",
    );
    expect(mapping).not.toBeNull();

    const match = await repo.matches.findById(mapping!.match_id);
    expect(match).toMatchObject({
      league_id: MVP_SEASON.league_id,
      season_id: MVP_SEASON.season_id,
      round_id: "01",
      home_team_id: teams.homeTeamId,
      away_team_id: teams.awayTeamId,
      kickoff_at: new Date("2026-08-11T12:00:00.000Z"),
      kickoff_confirmed: true,
      prediction_deadline_at: new Date("2026-08-11T11:50:00.000Z"),
      prediction_closed_at: null,
      match_status: MatchStatus.Scheduled,
      settlement_status: SettlementStatus.Pending,
      result_version: 0,
      settled_result_version: 0,
      regular_home_score: null,
      regular_away_score: null,
      result_source: null,
    });
    await expect(repo.providerSnapshots.findByEntity("match", mapping!.match_id)).resolves.toEqual([
      expect.objectContaining({
        provider_entity_id: "1100100",
        event_type: "discovered",
        payload: { fixture },
      }),
      expect.objectContaining({
        provider_entity_id: "1100100",
        event_type: "status_changed",
        payload: { sync: "success" },
      }),
    ]);
  });

  it("round 无法严格解析为 01..38 时 fail closed 且不创建比赛事实", async () => {
    const repo = new InMemoryRepository();
    await seedTeams(repo);
    const fixture: ApiFootballFixture = makeApiFixture({
      fixtureId: 1100101,
      statusShort: "NS",
      round: "Playoff",
    });

    await expect(
      new ProviderFixtureSyncService(repo).applyFixture(fixture, { fixture }, NOW),
    ).rejects.toMatchObject({ code: "PROVIDER_DATA_ERROR" });
    await expect(
      repo.matchProviderMappings.findByProviderAndExternalId(
        Provider.ApiFootball,
        "1100101",
      ),
    ).resolves.toBeNull();
    await expect(repo.matches.findBySeason(MVP_SEASON.season_id)).resolves.toEqual([]);
  });

  it("缺少 Provider 球队 mapping 时 fail closed 且不创建比赛事实", async () => {
    const repo = new InMemoryRepository();
    const homeTeamId = newUuid();
    await repo.teams.insert(makeTeam(homeTeamId));
    await repo.teamProviderMappings.insert(makeTeamMapping(homeTeamId, "40"));
    const fixture = makeApiFixture({ fixtureId: 1100102, statusShort: "NS" });

    await expect(
      new ProviderFixtureSyncService(repo).applyFixture(fixture, { fixture }, NOW),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(repo.matches.findBySeason(MVP_SEASON.season_id)).resolves.toEqual([]);
    await expect(
      repo.matchProviderMappings.findByProviderAndExternalId(
        Provider.ApiFootball,
        "1100102",
      ),
    ).resolves.toBeNull();
  });
});
