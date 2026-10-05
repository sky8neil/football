import { describe, expect, it, vi } from "vitest";
import { SUPPORTED_LEAGUES } from "../domain/config.js";
import { Provider, SCHEMA_VERSION, TeamStatus } from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { TeamProviderMapping } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import type { ApiFootballTeam } from "../provider/types.js";
import { ProviderTeamSyncService } from "./provider-team-sync.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");

function providerTeam(id: number, name: string, shortCode: string | null = null): ApiFootballTeam {
  return { team: { id, name, short_code: shortCode } };
}

function orphanMapping(providerTeamId: string): TeamProviderMapping {
  return {
    schema_version: SCHEMA_VERSION,
    team_id: newUuid(),
    provider: Provider.ApiFootball,
    provider_team_id: providerTeamId,
    created_at: NOW,
    updated_at: NOW,
  };
}

describe("ProviderTeamSyncService", () => {
  it("遍历六联赛查询，并首次创建带 league_id 的 active team 与 Provider mapping", async () => {
    const repo = new InMemoryRepository();
    const getTeams = vi.fn(async (query: { leagueId: string; season: string }) => {
      if (query.leagueId === "39") {
        return [providerTeam(40, "Home FC", "HFC"), providerTeam(41, "Away FC")] as const;
      }
      if (query.leagueId === "169") {
        return [providerTeam(500, "CSL FC")] as const;
      }
      return [] as const;
    });
    const service = new ProviderTeamSyncService(repo, { getTeams });

    await expect(service.sync(NOW)).resolves.toEqual({
      kind: "completed",
      teams_read: 3,
      teams_created: 3,
      teams_unchanged: 0,
    });
    expect(getTeams).toHaveBeenCalledTimes(SUPPORTED_LEAGUES.length);
    expect(getTeams.mock.calls.map((call) => call[0])).toEqual(
      SUPPORTED_LEAGUES.map((row) => ({
        leagueId: row.api_football_league_id,
        season: row.api_football_season,
      })),
    );

    const eplMapping = await repo.teamProviderMappings.findByProviderAndExternalId(
      Provider.ApiFootball,
      "40",
    );
    expect(eplMapping).not.toBeNull();
    await expect(repo.teams.findById(eplMapping!.team_id)).resolves.toMatchObject({
      league_id: "premier_league",
      name: "Home FC",
      short_name: null,
      primary_color: null,
      secondary_color: null,
      status: TeamStatus.Active,
      created_at: NOW,
      updated_at: NOW,
      schema_version: SCHEMA_VERSION,
    });
    const cslMapping = await repo.teamProviderMappings.findByProviderAndExternalId(
      Provider.ApiFootball,
      "500",
    );
    await expect(repo.teams.findById(cslMapping!.team_id)).resolves.toMatchObject({
      league_id: "chinese_super_league",
      name: "CSL FC",
    });
  });

  it("重复同步命中已有 mapping 时保持球队事实不变并幂等返回", async () => {
    const repo = new InMemoryRepository();
    const getTeams = vi.fn(async (query: { leagueId: string }) => {
      if (query.leagueId === "39") {
        return [providerTeam(40, "Renamed by Provider", "NEW")] as const;
      }
      return [] as const;
    });
    const service = new ProviderTeamSyncService(repo, { getTeams });

    await service.sync(NOW);
    const first = await repo.teamProviderMappings.findByProviderAndExternalId(
      Provider.ApiFootball,
      "40",
    );
    const firstTeam = await repo.teams.findById(first!.team_id);

    await expect(service.sync(NOW)).resolves.toEqual({
      kind: "completed",
      teams_read: 1,
      teams_created: 0,
      teams_unchanged: 1,
    });
    await expect(
      repo.teamProviderMappings.findByProviderAndExternalId(Provider.ApiFootball, "40"),
    ).resolves.toEqual(first);
    await expect(repo.teams.findById(first!.team_id)).resolves.toEqual(firstTeam);
  });

  it("mapping 指向不存在的内部 team 时 Fail Closed 且不写入新事实", async () => {
    const repo = new InMemoryRepository();
    await repo.teamProviderMappings.insert(orphanMapping("40"));
    const service = new ProviderTeamSyncService(repo, {
      getTeams: async (query: { leagueId: string }) =>
        query.leagueId === "39" ? [providerTeam(40, "Home FC")] : [],
    });

    await expect(service.sync(NOW)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(
      repo.teamProviderMappings.findByProviderAndExternalId(Provider.ApiFootball, "40"),
    ).resolves.toBeTruthy();
    await expect(repo.teamProviderMappings.findByProviderAndExternalId(Provider.ApiFootball, "41"))
      .resolves.toBeNull();
  });

  it("批次包含非法 Provider 球队时回滚同一事务内已准备的创建", async () => {
    const repo = new InMemoryRepository();
    const invalid = providerTeam(41, "");
    const service = new ProviderTeamSyncService(repo, {
      getTeams: async (query: { leagueId: string }) =>
        query.leagueId === "39" ? [providerTeam(40, "Home FC"), invalid] : [],
    });

    await expect(service.sync(NOW)).rejects.toMatchObject({ code: "PROVIDER_DATA_ERROR" });
    await expect(
      repo.teamProviderMappings.findByProviderAndExternalId(Provider.ApiFootball, "40"),
    ).resolves.toBeNull();
  });
});
