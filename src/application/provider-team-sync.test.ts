import { describe, expect, it, vi } from "vitest";
import { MVP_SEASON } from "../domain/config.js";
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
  it("使用固定英超赛季查询，并首次创建 active team 与 Provider mapping", async () => {
    const repo = new InMemoryRepository();
    const getTeams = vi.fn(async () => [
      providerTeam(40, "Home FC", "HFC"),
      providerTeam(41, "Away FC"),
    ] as const);
    const service = new ProviderTeamSyncService(repo, { getTeams });

    await expect(service.sync(NOW)).resolves.toEqual({
      kind: "completed",
      teams_read: 2,
      teams_created: 2,
      teams_unchanged: 0,
    });
    expect(getTeams).toHaveBeenCalledWith({
      leagueId: MVP_SEASON.api_football_league_id,
      season: MVP_SEASON.api_football_season,
    });

    const mapping = await repo.teamProviderMappings.findByProviderAndExternalId(
      Provider.ApiFootball,
      "40",
    );
    expect(mapping).not.toBeNull();
    await expect(repo.teams.findById(mapping!.team_id)).resolves.toMatchObject({
      name: "Home FC",
      short_name: null,
      primary_color: null,
      secondary_color: null,
      status: TeamStatus.Active,
      created_at: NOW,
      updated_at: NOW,
      schema_version: SCHEMA_VERSION,
    });
  });

  it("重复同步命中已有 mapping 时保持球队事实不变并幂等返回", async () => {
    const repo = new InMemoryRepository();
    const getTeams = vi.fn(async () => [providerTeam(40, "Renamed by Provider", "NEW")] as const);
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
      getTeams: async () => [providerTeam(40, "Home FC")],
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
      getTeams: async () => [providerTeam(40, "Home FC"), invalid],
    });

    await expect(service.sync(NOW)).rejects.toMatchObject({ code: "PROVIDER_DATA_ERROR" });
    await expect(
      repo.teamProviderMappings.findByProviderAndExternalId(Provider.ApiFootball, "40"),
    ).resolves.toBeNull();
  });
});
