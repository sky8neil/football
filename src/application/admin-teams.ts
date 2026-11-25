import {
  AdminAuditAction,
  ADMIN_AUDIT_ENTITY_TYPE_BY_ACTION,
  AnomalyStatus,
  AnomalyType,
  LeagueId,
  Provider,
  SCHEMA_VERSION,
} from "../domain/enums.js";
import { conflictError, internalError, notFoundError, validationError } from "../domain/errors.js";
import { isValidUuid, newUuid } from "../domain/ids.js";
import type { AdminAuditLog, Team, TeamProviderMapping } from "../domain/types.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";
import { AdminAuthorizationService, type AdminWriteAuthorizer } from "./admin.js";
import { assertValidServerNow } from "./period-finalize.js";
import { missingTeamMappingAnomalyKey } from "./provider-cross-source.js";

export interface AdminTeamWithMappings {
  team: Team;
  mappings: TeamProviderMapping[];
}

export interface AdminTeamsListQuery {
  league_id: LeagueId | null;
  q: string | null;
  missing_only: boolean;
}

export interface AdminUpdateTeamInput {
  name_zh?: string | null;
  logo_url?: string | null;
  reason: string;
}

export interface AdminUpdateTeamOutcome {
  admin_id: string;
  team: Team;
  audit_log: AdminAuditLog;
  resolved_anomaly_ids: string[];
}

export interface AdminUpsertTeamMappingInput {
  provider: Provider;
  provider_team_id: string;
  overwrite?: boolean;
  reason: string;
}

export interface AdminUpsertTeamMappingOutcome {
  admin_id: string;
  team: Team;
  mapping: TeamProviderMapping;
  status: "created" | "updated" | "unchanged";
  audit_log: AdminAuditLog;
  resolved_anomaly_ids: string[];
}

const VALID_LEAGUE_IDS = new Set<string>(Object.values(LeagueId));
const VALID_PROVIDERS = new Set<string>(Object.values(Provider));

function assertReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.trim().length < 1 || reason.length > 500) {
    throw validationError("reason 长度必须为 1..500", { field: "reason" });
  }
  return reason.trim();
}

function normalizeOptionalNameZh(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw validationError("name_zh 必须为字符串或 null", { field: "name_zh" });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 80) {
    throw validationError("name_zh 长度不能超过 80", { field: "name_zh" });
  }
  return trimmed;
}

function normalizeOptionalLogoUrl(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw validationError("logo_url 必须为字符串或 null", { field: "logo_url" });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 500) {
    throw validationError("logo_url 长度不能超过 500", { field: "logo_url" });
  }
  if (/^https:\/\/[^/\s]+/.test(trimmed) || (trimmed.startsWith("/") && !trimmed.startsWith("//"))) {
    return trimmed;
  }
  throw validationError("logo_url 必须以 https:// 或 / 开头", { field: "logo_url" });
}

function teamAuditSnapshot(team: Team): Record<string, unknown> {
  return {
    team_id: team.team_id,
    league_id: team.league_id,
    name: team.name,
    name_zh: team.name_zh ?? null,
    logo_url: team.logo_url ?? null,
    status: team.status,
  };
}

async function resolveTeamAnomalyByKey(
  tx: UnitOfWork,
  anomalyKey: string,
  resolution: string,
  serverNow: Date,
): Promise<string | null> {
  if (tx.anomalies === undefined) return null;
  const existing = await tx.anomalies.findByKey(anomalyKey);
  if (existing === null || existing.status === AnomalyStatus.Resolved) return null;
  await tx.anomalies.update({
    ...existing,
    status: AnomalyStatus.Resolved,
    resolved_at: serverNow,
    resolution,
  });
  return existing.anomaly_id;
}

export class AdminTeamsService implements AdminWriteAuthorizer {
  private readonly authorization = new AdminAuthorizationService();

  constructor(private readonly repo: AppRepository) {}

  authorizeAdmin(trustedOpenid: string): Promise<void> {
    return this.authorization.authorizeAdmin(this.repo, trustedOpenid);
  }

  async listTeams(
    trustedOpenid: string | null | undefined,
    query: AdminTeamsListQuery,
  ): Promise<AdminTeamWithMappings[]> {
    if (query.league_id !== null && !VALID_LEAGUE_IDS.has(query.league_id)) {
      throw validationError("league_id 无效", { field: "league_id" });
    }
    if (query.q !== null && (typeof query.q !== "string" || query.q.length > 100)) {
      throw validationError("q 长度不能超过 100", { field: "q" });
    }
    await this.authorization.requireActiveAdmin(this.repo, trustedOpenid);
    if (
      this.repo.teams?.findAll === undefined ||
      this.repo.teamProviderMappings?.findAll === undefined
    ) {
      throw internalError("teams/teamProviderMappings findAll port 未配置");
    }

    const [teams, mappings] = await Promise.all([
      this.repo.teams.findAll(),
      this.repo.teamProviderMappings.findAll(),
    ]);
    const mappingsByTeam = new Map<string, TeamProviderMapping[]>();
    for (const mapping of mappings) {
      const list = mappingsByTeam.get(mapping.team_id);
      if (list === undefined) mappingsByTeam.set(mapping.team_id, [mapping]);
      else list.push(mapping);
    }
    for (const list of mappingsByTeam.values()) {
      list.sort(
        (a, b) =>
          a.provider.localeCompare(b.provider) ||
          a.provider_team_id.localeCompare(b.provider_team_id),
      );
    }

    const keyword = query.q?.trim().toLowerCase() ?? "";
    return teams
      .map((team) => ({
        team,
        mappings: mappingsByTeam.get(team.team_id) ?? [],
      }))
      .filter(({ team }) => query.league_id === null || team.league_id === query.league_id)
      .filter(({ team, mappings: teamMappings }) => {
        if (!query.missing_only) return true;
        const missingNameZh = typeof team.name_zh !== "string" || team.name_zh.trim().length === 0;
        const missingLogo = typeof team.logo_url !== "string" || team.logo_url.trim().length === 0;
        return missingNameZh || missingLogo || teamMappings.length === 0;
      })
      .filter(({ team, mappings: teamMappings }) => {
        if (keyword.length === 0) return true;
        return (
          team.team_id.toLowerCase().includes(keyword) ||
          team.name.toLowerCase().includes(keyword) ||
          (team.name_zh ?? "").toLowerCase().includes(keyword) ||
          (team.short_name ?? "").toLowerCase().includes(keyword) ||
          teamMappings.some(
            (m) =>
              m.provider.toLowerCase().includes(keyword) ||
              m.provider_team_id.toLowerCase().includes(keyword),
          )
        );
      })
      .sort(
        (a, b) =>
          a.team.league_id.localeCompare(b.team.league_id) ||
          a.team.name.localeCompare(b.team.name) ||
          a.team.team_id.localeCompare(b.team.team_id),
      );
  }

  async updateTeam(
    trustedOpenid: string | null | undefined,
    teamId: string,
    input: AdminUpdateTeamInput,
    serverNow: Date,
  ): Promise<AdminUpdateTeamOutcome> {
    if (typeof teamId !== "string" || !isValidUuid(teamId)) {
      throw validationError("team_id 必须为 UUID v4", { field: "team_id" });
    }
    const hasNameZh = Object.prototype.hasOwnProperty.call(input, "name_zh");
    const hasLogoUrl = Object.prototype.hasOwnProperty.call(input, "logo_url");
    if (!hasNameZh && !hasLogoUrl) {
      throw validationError("至少需要提供 name_zh 或 logo_url");
    }
    const nextNameZh = normalizeOptionalNameZh(input.name_zh);
    const nextLogoUrl = normalizeOptionalLogoUrl(input.logo_url);
    const reason = assertReason(input.reason);
    assertValidServerNow(serverNow);

    return this.repo.withTransaction(async (tx) => {
      const admin = await this.authorization.requireActiveAdmin(tx, trustedOpenid);
      if (tx.teams === undefined || tx.adminAuditLogs === undefined) {
        throw internalError("teams 或 admin_audit_logs repository port 未配置");
      }
      const existing = await tx.teams.findById(teamId);
      if (existing === null) {
        throw notFoundError("TEAM");
      }

      const patch: Partial<Team> = {};
      let changed = false;
      if (hasNameZh && (existing.name_zh ?? null) !== nextNameZh) {
        patch.name_zh = nextNameZh ?? null;
        changed = true;
      }
      if (hasLogoUrl && (existing.logo_url ?? null) !== nextLogoUrl) {
        patch.logo_url = nextLogoUrl ?? null;
        changed = true;
      }
      if (!changed) {
        throw conflictError("TEAM_PROFILE_UNCHANGED", "球队资料未发生变化", { team_id: teamId });
      }
      patch.updated_at = serverNow;
      if (tx.teams.patchFields !== undefined) {
        await tx.teams.patchFields(teamId, patch);
      } else if (tx.teams.update !== undefined) {
        await tx.teams.update({ ...existing, ...patch });
      } else {
        throw internalError("teams 更新端口未配置");
      }

      const updated: Team = {
        ...existing,
        ...(hasNameZh ? { name_zh: nextNameZh ?? null } : {}),
        ...(hasLogoUrl ? { logo_url: nextLogoUrl ?? null } : {}),
        updated_at: serverNow,
      };
      const auditId = newUuid();
      const resolvedAnomalyIds: string[] = [];
      if (typeof updated.name_zh === "string" && updated.name_zh.length > 0) {
        const resolvedId = await resolveTeamAnomalyByKey(
          tx,
          `${teamId}:${AnomalyType.ProviderDataInvalid}`,
          `admin_team_update:${auditId}`,
          serverNow,
        );
        if (resolvedId !== null) resolvedAnomalyIds.push(resolvedId);
      }

      const auditLog: AdminAuditLog = {
        schema_version: SCHEMA_VERSION,
        audit_id: auditId,
        admin_id: admin.admin_id,
        action: AdminAuditAction.UpdateTeam,
        entity_type: ADMIN_AUDIT_ENTITY_TYPE_BY_ACTION[AdminAuditAction.UpdateTeam],
        entity_id: teamId,
        old_value: teamAuditSnapshot(existing),
        new_value: {
          ...teamAuditSnapshot(updated),
          ...(resolvedAnomalyIds.length > 0 ? { resolved_anomaly_ids: resolvedAnomalyIds } : {}),
        },
        reason,
        created_at: serverNow,
      };
      await tx.adminAuditLogs.insert(auditLog);

      return {
        admin_id: admin.admin_id,
        team: updated,
        audit_log: auditLog,
        resolved_anomaly_ids: resolvedAnomalyIds,
      };
    });
  }

  async upsertTeamMapping(
    trustedOpenid: string | null | undefined,
    teamId: string,
    input: AdminUpsertTeamMappingInput,
    serverNow: Date,
  ): Promise<AdminUpsertTeamMappingOutcome> {
    if (typeof teamId !== "string" || !isValidUuid(teamId)) {
      throw validationError("team_id 必须为 UUID v4", { field: "team_id" });
    }
    if (typeof input.provider !== "string" || !VALID_PROVIDERS.has(input.provider)) {
      throw validationError("provider 枚举值无效", { field: "provider" });
    }
    if (
      typeof input.provider_team_id !== "string" ||
      input.provider_team_id.trim().length < 1 ||
      input.provider_team_id.trim().length > 128
    ) {
      throw validationError("provider_team_id 长度必须为 1..128", { field: "provider_team_id" });
    }
    if (input.overwrite !== undefined && typeof input.overwrite !== "boolean") {
      throw validationError("overwrite 必须为布尔值", { field: "overwrite" });
    }
    const providerTeamId = input.provider_team_id.trim();
    const overwrite = input.overwrite === true;
    const reason = assertReason(input.reason);
    assertValidServerNow(serverNow);

    return this.repo.withTransaction(async (tx) => {
      const admin = await this.authorization.requireActiveAdmin(tx, trustedOpenid);
      if (
        tx.teams === undefined ||
        tx.teamProviderMappings === undefined ||
        tx.adminAuditLogs === undefined
      ) {
        throw internalError("teams/teamProviderMappings/adminAuditLogs port 未配置");
      }
      const team = await tx.teams.findById(teamId);
      if (team === null) {
        throw notFoundError("TEAM");
      }

      const existing = await tx.teamProviderMappings.findByProviderAndExternalId(
        input.provider,
        providerTeamId,
      );
      const auditId = newUuid();
      const missingKey = missingTeamMappingAnomalyKey(input.provider, providerTeamId);
      let mapping: TeamProviderMapping;
      let status: "created" | "updated" | "unchanged";

      if (existing === null) {
        mapping = {
          schema_version: SCHEMA_VERSION,
          team_id: teamId,
          provider: input.provider,
          provider_team_id: providerTeamId,
          created_at: serverNow,
          updated_at: serverNow,
        };
        await tx.teamProviderMappings.insert(mapping);
        status = "created";
      } else if (existing.team_id === teamId) {
        const resolvedId = await resolveTeamAnomalyByKey(
          tx,
          missingKey,
          `admin_team_mapping:${auditId}`,
          serverNow,
        );
        if (resolvedId === null) {
          throw conflictError("TEAM_MAPPING_UNCHANGED", "该外部源队名/队 ID 映射已指向当前球队", {
            team_id: teamId,
            provider: input.provider,
            provider_team_id: providerTeamId,
          });
        }
        const auditLog: AdminAuditLog = {
          schema_version: SCHEMA_VERSION,
          audit_id: auditId,
          admin_id: admin.admin_id,
          action: AdminAuditAction.UpsertTeamMapping,
          entity_type: ADMIN_AUDIT_ENTITY_TYPE_BY_ACTION[AdminAuditAction.UpsertTeamMapping],
          entity_id: `${input.provider}:${providerTeamId}`,
          old_value: {
            team_id: existing.team_id,
            provider: existing.provider,
            provider_team_id: existing.provider_team_id,
          },
          new_value: {
            team_id: existing.team_id,
            provider: existing.provider,
            provider_team_id: existing.provider_team_id,
            resolved_anomaly_ids: [resolvedId],
          },
          reason,
          created_at: serverNow,
        };
        await tx.adminAuditLogs.insert(auditLog);
        return {
          admin_id: admin.admin_id,
          team,
          mapping: existing,
          status: "unchanged",
          audit_log: auditLog,
          resolved_anomaly_ids: [resolvedId],
        };
      } else if (!overwrite) {
        throw conflictError("TEAM_MAPPING_CONFLICT", "外部源队名/队 ID 已映射到其他球队", {
          provider: input.provider,
          provider_team_id: providerTeamId,
          existing_team_id: existing.team_id,
          target_team_id: teamId,
        });
      } else {
        if (tx.teamProviderMappings.update === undefined) {
          throw internalError("teamProviderMappings.update port 未配置");
        }
        mapping = {
          ...existing,
          team_id: teamId,
          updated_at: serverNow,
        };
        await tx.teamProviderMappings.update(mapping);
        status = "updated";
      }

      const resolvedAnomalyIds: string[] = [];
      const resolvedId = await resolveTeamAnomalyByKey(
        tx,
        missingKey,
        `admin_team_mapping:${auditId}`,
        serverNow,
      );
      if (resolvedId !== null) resolvedAnomalyIds.push(resolvedId);

      const auditLog: AdminAuditLog = {
        schema_version: SCHEMA_VERSION,
        audit_id: auditId,
        admin_id: admin.admin_id,
        action: AdminAuditAction.UpsertTeamMapping,
        entity_type: ADMIN_AUDIT_ENTITY_TYPE_BY_ACTION[AdminAuditAction.UpsertTeamMapping],
        entity_id: `${input.provider}:${providerTeamId}`,
        old_value: existing === null
          ? null
          : {
              team_id: existing.team_id,
              provider: existing.provider,
              provider_team_id: existing.provider_team_id,
            },
        new_value: {
          team_id: mapping.team_id,
          provider: mapping.provider,
          provider_team_id: mapping.provider_team_id,
          ...(resolvedAnomalyIds.length > 0 ? { resolved_anomaly_ids: resolvedAnomalyIds } : {}),
        },
        reason,
        created_at: serverNow,
      };
      await tx.adminAuditLogs.insert(auditLog);

      return {
        admin_id: admin.admin_id,
        team,
        mapping,
        status,
        audit_log: auditLog,
        resolved_anomaly_ids: resolvedAnomalyIds,
      };
    });
  }
}
