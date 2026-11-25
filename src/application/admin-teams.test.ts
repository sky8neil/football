import { describe, expect, it } from "vitest";
import {
  AdminAuditAction,
  AdminAuditEntityType,
  AdminRole,
  AdminStatus,
  AnomalyStatus,
  AnomalyType,
  LeagueId,
  Provider,
  TeamStatus,
} from "../domain/enums.js";
import type { Admin, Anomaly, Team } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { missingTeamMappingAnomalyKey, missingTeamMappingAnomalyMatchId } from "./provider-cross-source.js";
import { AdminTeamsService } from "./admin-teams.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const ADMIN_OPENID = "admin-teams-openid";
const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const TEAM_A_ID = "00000000-0000-4000-8000-000000000301";
const TEAM_B_ID = "00000000-0000-4000-8000-000000000302";

function makeAdmin(): Admin {
  return {
    schema_version: 1,
    admin_id: ADMIN_ID,
    openid: ADMIN_OPENID,
    status: AdminStatus.Active,
    role: AdminRole.Admin,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    schema_version: 1,
    team_id: TEAM_A_ID,
    league_id: LeagueId.PremierLeague,
    name: "Ipswich Town",
    name_zh: null,
    logo_url: null,
    short_name: "IPS",
    primary_color: null,
    secondary_color: null,
    status: TeamStatus.Active,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe("AdminTeamsService", () => {
  it("支持按联赛、关键词与缺失状态筛选球队列表", async () => {
    const repo = new InMemoryRepository();
    await repo.admins.insert(makeAdmin());
    await repo.teams.insert(makeTeam());
    await repo.teams.insert(
      makeTeam({
        team_id: TEAM_B_ID,
        league_id: LeagueId.LaLiga,
        name: "Leganes",
        name_zh: "莱加内斯",
        logo_url: "https://cdn.example.com/leganes.png",
      }),
    );
    await repo.teamProviderMappings.insert({
      schema_version: 1,
      team_id: TEAM_B_ID,
      provider: Provider.FootballData,
      provider_team_id: "745",
      created_at: NOW,
      updated_at: NOW,
    });

    const service = new AdminTeamsService(repo);
    const missing = await service.listTeams(ADMIN_OPENID, {
      league_id: null,
      q: null,
      missing_only: true,
    });
    expect(missing.map((item) => item.team.team_id)).toEqual([TEAM_A_ID]);

    const byProviderId = await service.listTeams(ADMIN_OPENID, {
      league_id: LeagueId.LaLiga,
      q: "745",
      missing_only: false,
    });
    expect(byProviderId).toHaveLength(1);
    expect(byProviderId[0]?.mappings[0]?.provider_team_id).toBe("745");
  });

  it("更新升班马 name_zh/logo_url 时写审计日志并自动解除缺中文名异常", async () => {
    const repo = new InMemoryRepository();
    await repo.admins.insert(makeAdmin());
    await repo.teams.insert(makeTeam());
    const missingZhAnomaly: Anomaly = {
      schema_version: 1,
      anomaly_id: "00000000-0000-4000-8000-000000000401",
      anomaly_key: `${TEAM_A_ID}:${AnomalyType.ProviderDataInvalid}`,
      match_id: TEAM_A_ID,
      type: AnomalyType.ProviderDataInvalid,
      blocking: false,
      status: AnomalyStatus.Open,
      first_seen_at: NOW,
      last_seen_at: NOW,
      occurrence_count: 1,
      details: { entity_type: "team", reason: "team_name_zh_missing" },
      resolved_at: null,
      resolution: null,
    };
    await repo.anomalies.insert(missingZhAnomaly);

    const service = new AdminTeamsService(repo);
    const outcome = await service.updateTeam(
      ADMIN_OPENID,
      TEAM_A_ID,
      {
        name_zh: " 伊普斯维奇 ",
        logo_url: "https://cdn.example.com/ipswich.png",
        reason: "补齐升班马中文名与队徽",
      },
      NOW,
    );

    expect(outcome.team).toMatchObject({
      team_id: TEAM_A_ID,
      name_zh: "伊普斯维奇",
      logo_url: "https://cdn.example.com/ipswich.png",
    });
    expect(outcome.resolved_anomaly_ids).toEqual([missingZhAnomaly.anomaly_id]);
    expect(await repo.anomalies.findById!(missingZhAnomaly.anomaly_id)).toMatchObject({
      status: AnomalyStatus.Resolved,
      resolution: `admin_team_update:${outcome.audit_log.audit_id}`,
    });
    expect(await repo.adminAuditLogs.findByEntity(AdminAuditEntityType.Team, TEAM_A_ID)).toMatchObject([
      {
        action: AdminAuditAction.UpdateTeam,
        reason: "补齐升班马中文名与队徽",
      },
    ]);
  });

  it("新增/覆盖外部数据源队名或队 ID 映射并自动解除缺映射异常", async () => {
    const repo = new InMemoryRepository();
    await repo.admins.insert(makeAdmin());
    await repo.teams.insert(makeTeam());
    await repo.teams.insert(makeTeam({ team_id: TEAM_B_ID, name: "Leicester City" }));

    const syntheticMatchId = missingTeamMappingAnomalyMatchId(Provider.OpenFoot, "Ipswich Town FC");
    const missingMapAnomaly: Anomaly = {
      schema_version: 1,
      anomaly_id: "00000000-0000-4000-8000-000000000402",
      anomaly_key: missingTeamMappingAnomalyKey(Provider.OpenFoot, "Ipswich Town FC"),
      match_id: syntheticMatchId,
      type: AnomalyType.ProviderDataInvalid,
      blocking: false,
      status: AnomalyStatus.Open,
      first_seen_at: NOW,
      last_seen_at: NOW,
      occurrence_count: 1,
      details: { entity_type: "team", reason: "team_mapping_missing" },
      resolved_at: null,
      resolution: null,
    };
    await repo.anomalies.insert(missingMapAnomaly);

    const service = new AdminTeamsService(repo);
    const created = await service.upsertTeamMapping(
      ADMIN_OPENID,
      TEAM_A_ID,
      {
        provider: Provider.OpenFoot,
        provider_team_id: "Ipswich Town FC",
        reason: "补齐 openfoot 队名映射",
      },
      NOW,
    );

    expect(created.status).toBe("created");
    expect(created.resolved_anomaly_ids).toEqual([missingMapAnomaly.anomaly_id]);
    expect(await repo.anomalies.findById!(missingMapAnomaly.anomaly_id)).toMatchObject({
      status: AnomalyStatus.Resolved,
      resolution: `admin_team_mapping:${created.audit_log.audit_id}`,
    });

    await expect(
      service.upsertTeamMapping(
        ADMIN_OPENID,
        TEAM_B_ID,
        {
          provider: Provider.OpenFoot,
          provider_team_id: "Ipswich Town FC",
          reason: "误绑测试",
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: "TEAM_MAPPING_CONFLICT" });

    const overwritten = await service.upsertTeamMapping(
      ADMIN_OPENID,
      TEAM_B_ID,
      {
        provider: Provider.OpenFoot,
        provider_team_id: "Ipswich Town FC",
        overwrite: true,
        reason: "更正绑定目标球队",
      },
      NOW,
    );
    expect(overwritten.status).toBe("updated");
    expect(
      await repo.teamProviderMappings.findByProviderAndExternalId(
        Provider.OpenFoot,
        "Ipswich Town FC",
      ),
    ).toMatchObject({ team_id: TEAM_B_ID });
  });
});
