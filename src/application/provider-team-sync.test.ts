import { describe, expect, it, vi } from "vitest";
import { AdminAuthorizationService } from "./admin.js";
import { AdminAnomaliesService } from "./admin-anomalies.js";
import { SUPPORTED_LEAGUES } from "../domain/config.js";
import { AdminRole, AdminStatus, AnomalyStatus, AnomalyType, Provider, SCHEMA_VERSION, SyncJobType, TeamStatus } from "../domain/enums.js";
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
  it("球队同步按指定旧赛季请求并维护参赛名单", async () => {
    const repo = new InMemoryRepository();
    const getTeams = vi.fn(async () => [providerTeam(40, "Home FC")]);
    await new ProviderTeamSyncService(repo, { getTeams }).sync(new Date("2027-01-02T00:00:00Z"), SyncJobType.FutureSchedule, ["premier_league"], { premier_league: "2025_2026" });
    expect(getTeams).toHaveBeenCalledWith(expect.objectContaining({ season: "2025", seasonId: "2025_2026" }));
    expect(await repo.seasonTeams.findByLeagueSeason("premier_league", "2025_2026")).toHaveLength(1);
  });
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
        jobType: SyncJobType.FutureSchedule,
        serverNow: NOW,
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

  it("单联赛 getTeams 失败时隔离并入库健康联赛，仅在全部联赛失败时抛错 (A-S3-05)", async () => {
    const repo = new InMemoryRepository();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const service = new ProviderTeamSyncService(repo, {
        getTeams: async (query) => {
          if (query.leagueId === "169") throw new Error("csl teams down");
          if (query.leagueId === "39") return [providerTeam(40, "Home FC")];
          return [];
        },
      });
      await expect(service.sync(NOW)).resolves.toEqual({
        kind: "completed",
        teams_read: 1,
        teams_created: 1,
        teams_unchanged: 0,
      });
      expect(await repo.teamProviderMappings.findByProviderAndExternalId(Provider.ApiFootball, "40")).not.toBeNull();

      const failAll = new ProviderTeamSyncService(repo, {
        getTeams: async () => { throw new Error("all teams down"); },
      });
      await expect(failAll.sync(NOW)).rejects.toThrow("all teams down");
    } finally {
      warn.mockRestore();
    }
  });

  it("[Q-PLAN-2] records non-blocking missing-name_zh anomaly for new teams (compatible with AdminAnomaliesService), never overwrites existing name_zh/logo_url, and supports multi-season arrays", async () => {
    const repo = new InMemoryRepository();
    await repo.admins.insert({
      schema_version: SCHEMA_VERSION,
      admin_id: newUuid(),
      openid: "admin-openid",
      role: AdminRole.Admin,
      status: AdminStatus.Active,
      created_at: NOW,
      updated_at: NOW,
    });
    const service = new ProviderTeamSyncService(repo, {
      getTeams: async (query) => query.leagueId === "39"
        ? [{ provider: Provider.FootballData, team: { id: 901, name: "Promoted Town FC" } }]
        : [],
    });

    await expect(service.sync(NOW, SyncJobType.FullScheduleVerify, ["premier_league"], {
      premier_league: ["2025_2026", "2026_2027"],
    })).resolves.toEqual({
      kind: "completed",
      teams_read: 2,
      teams_created: 1,
      teams_unchanged: 1,
    });

    const mapping = await repo.teamProviderMappings.findByProviderAndExternalId(Provider.FootballData, "901");
    expect(mapping).not.toBeNull();
    const createdTeam = await repo.teams.findById(mapping!.team_id);
    expect(createdTeam).toMatchObject({
      name: "Promoted Town FC",
      name_zh: null,
      logo_url: null,
    });
    expect(await repo.seasonTeams.findByLeagueSeason("premier_league", "2025_2026")).toHaveLength(1);
    expect(await repo.seasonTeams.findByLeagueSeason("premier_league", "2026_2027")).toHaveLength(1);

    const anomaly = await repo.anomalies.findByKey(`${mapping!.team_id}:${AnomalyType.ProviderDataInvalid}`);
    expect(anomaly).toMatchObject({
      blocking: false,
      status: AnomalyStatus.Open,
      details: expect.objectContaining({
        entity_type: "team",
        reason: "team_name_zh_missing",
        team_id: mapping!.team_id,
        league_id: "premier_league",
        team_name: "Promoted Town FC",
      }),
    });

    // Must pass AdminAnomaliesService invariant checks
    const adminPage = await new AdminAnomaliesService(repo, "cursor-secret").list("admin-openid", {
      status: AnomalyStatus.Open,
      blocking: false,
      limit: 20,
      cursor: null,
    });
    expect(adminPage.items).toHaveLength(1);

    // Manually curated name_zh & logo_url MUST NEVER be overwritten on subsequent team syncs
    await repo.teams.patchFields!(mapping!.team_id, {
      name_zh: "升班马镇",
      logo_url: "https://cdn.example.com/promoted-town.png",
      updated_at: NOW,
    });
    const resync = new ProviderTeamSyncService(repo, {
      getTeams: async () => [{
        provider: Provider.FootballData,
        team: { id: 901, name: "Promoted Town FC Renamed", name_zh: "错误覆盖名", logo_url: "https://evil.example/x.png" } as never,
      }],
    });
    await expect(resync.sync(NOW, SyncJobType.FutureSchedule, ["premier_league"])).resolves.toEqual({
      kind: "completed",
      teams_read: 1,
      teams_created: 0,
      teams_unchanged: 1,
    });
    expect(await repo.teams.findById(mapping!.team_id)).toMatchObject({
      name: "Promoted Town FC",
      name_zh: "升班马镇",
      logo_url: "https://cdn.example.com/promoted-town.png",
    });
  });
});
