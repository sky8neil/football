import { readFile } from "node:fs/promises";
import Ajv from "ajv";
import YAML from "yaml";
import { describe, expect, it, vi } from "vitest";
import {
  AdminAuditAction,
  AdminAuditEntityType,
  AdminRole,
  AdminStatus,
  AnomalyStatus,
  AnomalyType,
  LeagueId,
  MatchStatus,
  Provider,
  ResultSource,
  SCHEMA_VERSION,
  ScoringRuleVersion,
  SettlementStatus,
  TeamStatus,
} from "../../domain/enums.js";
import type { Admin, AdminAuditLog, Anomaly, Match, Team } from "../../domain/types.js";
import { AdminAuditLogsService } from "../../application/admin-audit-logs.js";
import { AdminMatchDetailService } from "../../application/admin-match-detail.js";
import { AdminResolveAnomalyService } from "../../application/admin-resolve-anomaly.js";
import { AdminTeamsService } from "../../application/admin-teams.js";
import { InMemoryRepository } from "../../infrastructure/repositories.js";
import { getAdminMatchDetail, postAdminResolveAnomaly } from "./admin.js";
import { getAdminAuditLogs } from "./admin-audit-logs.js";
import { getAdminTeams, patchAdminTeam, postAdminTeamMapping } from "./admin-teams.js";
import { InMemoryRateLimiter, RATE_LIMIT_DEFAULTS } from "./rate-limit.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const ADMIN_OPENID = "admin-api-openid";
const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const ANOMALY_ID = "00000000-0000-4000-8000-000000000101";
const MATCH_ID = "00000000-0000-4000-8000-000000000201";
const TEAM_ID = "00000000-0000-4000-8000-000000000301";
const SECRET = "admin-slice9-cursor-secret";

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

function makeAnomaly(): Anomaly {
  return {
    schema_version: 1,
    anomaly_id: ANOMALY_ID,
    anomaly_key: `${MATCH_ID}:${AnomalyType.ProviderStateConflict}`,
    match_id: MATCH_ID,
    type: AnomalyType.ProviderStateConflict,
    blocking: true,
    status: AnomalyStatus.Open,
    first_seen_at: NOW,
    last_seen_at: NOW,
    occurrence_count: 1,
    details: {},
    resolved_at: null,
    resolution: null,
  };
}

function makeTeam(): Team {
  return {
    schema_version: 1,
    team_id: TEAM_ID,
    league_id: LeagueId.PremierLeague,
    name: "Southampton",
    name_zh: null,
    logo_url: null,
    short_name: "SOU",
    primary_color: null,
    secondary_color: null,
    status: TeamStatus.Active,
    created_at: NOW,
    updated_at: NOW,
  };
}

async function compileValidator(schemaName: string) {
  const raw = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
  const spec = YAML.parse(raw) as { components: { schemas: Record<string, unknown> } };
  const ajv = new Ajv({ nullable: true, allErrors: true });
  ajv.addSchema({ $id: "https://football.local/openapi.json", components: spec.components });
  return ajv.compile({ $ref: `https://football.local/openapi.json#/components/schemas/${schemaName}` });
}

describe("Slice 9 admin API handlers", () => {
  it("POST /v1/admin/anomalies/:id/resolve 先鉴权再限流，校验未知字段并通过 OpenAPI schema", async () => {
    const repo = new InMemoryRepository();
    await repo.admins.insert(makeAdmin());
    await repo.anomalies.insert(makeAnomaly());
    const service = new AdminResolveAnomalyService(repo);
    const limiter = new InMemoryRateLimiter();
    const checkSpy = vi.spyOn(limiter, "check");

    await expect(
      postAdminResolveAnomaly(service, {
        trusted_openid: "not-an-admin",
        anomaly_id: ANOMALY_ID,
        body: { reason: "ok" },
        server_now: NOW,
        request_id: "req-unauth",
        rate_limiter: limiter,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(checkSpy).not.toHaveBeenCalled();

    await expect(
      postAdminResolveAnomaly(service, {
        trusted_openid: ADMIN_OPENID,
        anomaly_id: ANOMALY_ID,
        body: { reason: "ok", extra: 1 },
        server_now: NOW,
        request_id: "req-extra",
        rate_limiter: limiter,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const res = await postAdminResolveAnomaly(service, {
      trusted_openid: ADMIN_OPENID,
      anomaly_id: ANOMALY_ID,
      body: { reason: "人工确认已完场" },
      server_now: NOW,
      request_id: "00000000-0000-4000-8000-000000000901",
      rate_limiter: limiter,
    });
    expect(res.status).toBe(200);
    expect(checkSpy).toHaveBeenCalledWith("admin_apis", ADMIN_OPENID, NOW);
    const validate = await compileValidator("AdminResolveAnomalyEnvelope");
    expect(validate(res.body), JSON.stringify(validate.errors)).toBe(true);
  });

  it("GET /v1/admin/audit-logs 先鉴权再限流，拒绝未知 query 并通过 OpenAPI schema", async () => {
    const repo = new InMemoryRepository();
    await repo.admins.insert(makeAdmin());
    const log: AdminAuditLog = {
      schema_version: 1,
      audit_id: "00000000-0000-4000-8000-000000000501",
      admin_id: ADMIN_ID,
      action: AdminAuditAction.ResolveAnomaly,
      entity_type: AdminAuditEntityType.Anomaly,
      entity_id: ANOMALY_ID,
      old_value: { status: "open" },
      new_value: { status: "resolved" },
      reason: "人工核验",
      created_at: NOW,
    };
    await repo.adminAuditLogs.insert(log);
    const service = new AdminAuditLogsService(repo, SECRET);
    const limiter = new InMemoryRateLimiter();
    const checkSpy = vi.spyOn(limiter, "check");

    await expect(
      getAdminAuditLogs(service, {
        trusted_openid: "unknown",
        query: {},
        server_now: NOW,
        request_id: "req-forbid",
        rate_limiter: limiter,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(checkSpy).not.toHaveBeenCalled();

    await expect(
      getAdminAuditLogs(service, {
        trusted_openid: ADMIN_OPENID,
        query: { unknown_field: "1" },
        server_now: NOW,
        request_id: "req-bad-query",
        rate_limiter: limiter,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const res = await getAdminAuditLogs(service, {
      trusted_openid: ADMIN_OPENID,
      query: { action: "resolve_anomaly", target_type: "anomaly", limit: "10" },
      server_now: NOW,
      request_id: "00000000-0000-4000-8000-000000000902",
      rate_limiter: limiter,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    const validate = await compileValidator("AdminAuditLogsEnvelope");
    expect(validate(res.body), JSON.stringify(validate.errors)).toBe(true);
  });

  it("GET/PATCH/POST /v1/admin/teams* 校验参数、限流且通过 OpenAPI schema", async () => {
    const repo = new InMemoryRepository();
    await repo.admins.insert(makeAdmin());
    await repo.teams.insert(makeTeam());
    const service = new AdminTeamsService(repo);
    const limiter = new InMemoryRateLimiter();

    const updated = await patchAdminTeam(service, {
      trusted_openid: ADMIN_OPENID,
      team_id: TEAM_ID,
      body: {
        name_zh: "南安普顿",
        logo_url: "https://cdn.example.com/saints.png",
        reason: "补充升班马资料",
      },
      server_now: NOW,
      request_id: "00000000-0000-4000-8000-000000000903",
      rate_limiter: limiter,
    });
    expect(updated.status).toBe(200);
    const validateUpdate = await compileValidator("AdminUpdateTeamEnvelope");
    expect(validateUpdate(updated.body), JSON.stringify(validateUpdate.errors)).toBe(true);

    const mapped = await postAdminTeamMapping(service, {
      trusted_openid: ADMIN_OPENID,
      team_id: TEAM_ID,
      body: {
        provider: Provider.FootballData,
        provider_team_id: "340",
        reason: "绑定 football_data 队 ID",
      },
      server_now: NOW,
      request_id: "00000000-0000-4000-8000-000000000904",
      rate_limiter: limiter,
    });
    expect(mapped.status).toBe(200);
    const validateMapping = await compileValidator("AdminUpsertTeamMappingEnvelope");
    expect(validateMapping(mapped.body), JSON.stringify(validateMapping.errors)).toBe(true);

    const listed = await getAdminTeams(service, {
      trusted_openid: ADMIN_OPENID,
      query: { league_id: "premier_league", q: "南安普顿" },
      server_now: NOW,
      request_id: "00000000-0000-4000-8000-000000000905",
      rate_limiter: limiter,
    });
    expect(listed.status).toBe(200);
    expect(listed.body.data.items).toHaveLength(1);
    const validateList = await compileValidator("AdminTeamsEnvelope");
    expect(validateList(listed.body), JSON.stringify(validateList.errors)).toBe(true);

    // 确认限流桶共享 admin_apis (60/min)
    for (let i = 3; i < RATE_LIMIT_DEFAULTS.admin_apis.max_requests; i += 1) {
      await getAdminTeams(service, {
        trusted_openid: ADMIN_OPENID,
        query: {},
        server_now: NOW,
        request_id: `req-${i}`,
        rate_limiter: limiter,
      });
    }
    await expect(
      getAdminTeams(service, {
        trusted_openid: ADMIN_OPENID,
        query: {},
        server_now: NOW,
        request_id: "req-over",
        rate_limiter: limiter,
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("[CR-11] GET /v1/admin/matches/:match_id 返回 result_version、球队与未解决异常并通过 OpenAPI 校验", async () => {
    const repo = new InMemoryRepository();
    await repo.admins.insert(makeAdmin());
    const homeTeam: Team = {
      ...makeTeam(),
      team_id: "00000000-0000-4000-8000-000000000311",
    };
    const awayTeam: Team = {
      ...makeTeam(),
      team_id: "00000000-0000-4000-8000-000000000312",
      name: "Burnley",
      name_zh: "伯恩利",
    };
    await repo.teams.insert(homeTeam);
    await repo.teams.insert(awayTeam);
    const match: Match = {
      schema_version: SCHEMA_VERSION,
      match_id: MATCH_ID,
      canonical_match_id: MATCH_ID,
      superseded_by: null,
      league_id: LeagueId.PremierLeague,
      season_id: "2026-2027",
      round_id: "R1",
      home_team_id: homeTeam.team_id,
      away_team_id: awayTeam.team_id,
      kickoff_at: NOW,
      kickoff_confirmed: true,
      prediction_deadline_at: new Date(NOW.getTime() - 5 * 60_000),
      prediction_closed_at: NOW,
      period_anchor_at: NOW,
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Failed,
      regular_home_score: 2,
      regular_away_score: 1,
      extra_home_score: null,
      extra_away_score: null,
      penalty_home_score: null,
      penalty_away_score: null,
      result_version: 3,
      settled_result_version: 2,
      result_source: ResultSource.Admin,
      scoring_rule_version: ScoringRuleVersion.ScoringV1,
      finish_detected_at: NOW,
      settled_at: null,
      created_at: NOW,
      updated_at: NOW,
    };
    await repo.matches.insert(match);
    await repo.anomalies.insert(makeAnomaly());

    const service = new AdminMatchDetailService(repo);
    const limiter = new InMemoryRateLimiter();
    await expect(
      getAdminMatchDetail(service, {
        trusted_openid: "unknown-user",
        match_id: MATCH_ID,
        query: {},
        server_now: NOW,
        request_id: "req-unauth",
        rate_limiter: limiter,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const res = await getAdminMatchDetail(service, {
      trusted_openid: ADMIN_OPENID,
      match_id: MATCH_ID,
      query: {},
      server_now: NOW,
      request_id: "00000000-0000-4000-8000-000000000906",
      rate_limiter: limiter,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      match_id: MATCH_ID,
      result_version: 3,
      settled_result_version: 2,
      result_source: ResultSource.Admin,
      regular_home_score: 2,
      regular_away_score: 1,
    });
    expect(res.body.data.open_anomalies).toHaveLength(1);
    const validate = await compileValidator("AdminMatchDetailEnvelope");
    expect(validate(res.body), JSON.stringify(validate.errors)).toBe(true);
  });
});
