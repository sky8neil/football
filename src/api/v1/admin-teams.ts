import { LeagueId, Provider, type TeamStatus } from "../../domain/enums.js";
import { conflictError, validationError } from "../../domain/errors.js";
import { isValidUuid } from "../../domain/ids.js";
import type {
  AdminTeamsListQuery,
  AdminTeamsService,
  AdminTeamWithMappings,
  AdminUpdateTeamInput,
  AdminUpsertTeamMappingInput,
} from "../../application/admin-teams.js";
import { assertUnknownFields } from "./validation.js";
import { defaultApiRateLimiter, type RateLimiter } from "./rate-limit.js";

const ADMIN_TEAMS_QUERY_FIELDS = new Set(["league_id", "q", "missing_only"]);
const ADMIN_UPDATE_TEAM_FIELDS = new Set(["name_zh", "logo_url", "reason"]);
const ADMIN_UPSERT_MAPPING_FIELDS = new Set(["provider", "provider_team_id", "overwrite", "reason"]);
const VALID_LEAGUES = new Set<string>(Object.values(LeagueId));
const VALID_PROVIDERS = new Set<string>(Object.values(Provider));

export interface AdminTeamMappingItem {
  provider: Provider;
  provider_team_id: string;
  updated_at: string;
}

export interface AdminTeamItem {
  team_id: string;
  league_id: LeagueId;
  name: string;
  name_zh: string | null;
  logo_url: string | null;
  short_name: string | null;
  status: TeamStatus;
  mappings: AdminTeamMappingItem[];
  updated_at: string;
}

export interface GetAdminTeamsInput {
  trusted_openid?: string | null;
  query: Record<string, unknown>;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface GetAdminTeamsSuccessResponse {
  status: 200;
  body: {
    data: {
      items: AdminTeamItem[];
    };
    request_id: string;
  };
}

export interface PatchAdminTeamInput {
  trusted_openid?: string | null;
  team_id: unknown;
  query?: unknown;
  body: unknown;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface PatchAdminTeamSuccessResponse {
  status: 200;
  body: {
    data: {
      team_id: string;
      league_id: LeagueId;
      name: string;
      name_zh: string | null;
      logo_url: string | null;
      updated_at: string;
      resolved_anomaly_ids: string[];
      audit_id: string;
    };
    request_id: string;
  };
}

export interface PostAdminTeamMappingInput {
  trusted_openid?: string | null;
  team_id: unknown;
  query?: unknown;
  body: unknown;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface PostAdminTeamMappingSuccessResponse {
  status: 200;
  body: {
    data: {
      team_id: string;
      provider: Provider;
      provider_team_id: string;
      status: "created" | "updated" | "unchanged";
      resolved_anomaly_ids: string[];
      audit_id: string;
    };
    request_id: string;
  };
}

async function preflightAdmin(
  service: Pick<AdminTeamsService, "authorizeAdmin">,
  value: string | null | undefined,
): Promise<string> {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw conflictError("UNAUTHORIZED", "需要可信管理员身份");
  }
  await service.authorizeAdmin(value);
  return value;
}

export function validateAdminTeamId(value: unknown): string {
  if (typeof value !== "string" || !isValidUuid(value)) {
    throw validationError("team_id 必须为 UUID v4", { field: "team_id" });
  }
  return value;
}

export function validateAdminTeamsQuery(query: Record<string, unknown>): AdminTeamsListQuery {
  assertUnknownFields(query, ADMIN_TEAMS_QUERY_FIELDS);
  let leagueId: LeagueId | null = null;
  if (query.league_id !== undefined) {
    if (typeof query.league_id !== "string" || !VALID_LEAGUES.has(query.league_id)) {
      throw validationError("league_id 无效", { field: "league_id" });
    }
    leagueId = query.league_id as LeagueId;
  }
  let q: string | null = null;
  if (query.q !== undefined) {
    if (typeof query.q !== "string" || query.q.length > 100) {
      throw validationError("q 长度不能超过 100", { field: "q" });
    }
    q = query.q.trim().length > 0 ? query.q.trim() : null;
  }
  let missingOnly = false;
  if (query.missing_only !== undefined) {
    if (query.missing_only === "true") missingOnly = true;
    else if (query.missing_only === "false") missingOnly = false;
    else throw validationError("missing_only 必须是 true 或 false", { field: "missing_only" });
  }
  return { league_id: leagueId, q, missing_only: missingOnly };
}

export function validatePatchAdminTeamPayload(payload: unknown): AdminUpdateTeamInput {
  const body = payload as Record<string, unknown>;
  assertUnknownFields(body, ADMIN_UPDATE_TEAM_FIELDS);
  const hasNameZh = Object.prototype.hasOwnProperty.call(body, "name_zh");
  const hasLogoUrl = Object.prototype.hasOwnProperty.call(body, "logo_url");
  if (!hasNameZh && !hasLogoUrl) {
    throw validationError("至少需要提供 name_zh 或 logo_url");
  }
  if (typeof body.reason !== "string" || body.reason.trim().length < 1 || body.reason.length > 500) {
    throw validationError("reason 长度必须为 1..500", { field: "reason" });
  }
  return {
    ...(hasNameZh ? { name_zh: body.name_zh as string | null } : {}),
    ...(hasLogoUrl ? { logo_url: body.logo_url as string | null } : {}),
    reason: body.reason.trim(),
  };
}

export function validatePostAdminTeamMappingPayload(payload: unknown): AdminUpsertTeamMappingInput {
  const body = payload as Record<string, unknown>;
  assertUnknownFields(body, ADMIN_UPSERT_MAPPING_FIELDS);
  if (typeof body.provider !== "string" || !VALID_PROVIDERS.has(body.provider)) {
    throw validationError("provider 枚举值无效", { field: "provider" });
  }
  if (
    typeof body.provider_team_id !== "string" ||
    body.provider_team_id.trim().length < 1 ||
    body.provider_team_id.trim().length > 128
  ) {
    throw validationError("provider_team_id 长度必须为 1..128", { field: "provider_team_id" });
  }
  if (body.overwrite !== undefined && typeof body.overwrite !== "boolean") {
    throw validationError("overwrite 必须为布尔值", { field: "overwrite" });
  }
  if (typeof body.reason !== "string" || body.reason.trim().length < 1 || body.reason.length > 500) {
    throw validationError("reason 长度必须为 1..500", { field: "reason" });
  }
  return {
    provider: body.provider as Provider,
    provider_team_id: body.provider_team_id.trim(),
    ...(body.overwrite !== undefined ? { overwrite: body.overwrite } : {}),
    reason: body.reason.trim(),
  };
}

function mapTeamWithMappings(entry: AdminTeamWithMappings): AdminTeamItem {
  return {
    team_id: entry.team.team_id,
    league_id: entry.team.league_id,
    name: entry.team.name,
    name_zh: entry.team.name_zh ?? null,
    logo_url: entry.team.logo_url ?? null,
    short_name: entry.team.short_name,
    status: entry.team.status,
    mappings: entry.mappings.map((mapping) => ({
      provider: mapping.provider,
      provider_team_id: mapping.provider_team_id,
      updated_at: mapping.updated_at.toISOString(),
    })),
    updated_at: entry.team.updated_at.toISOString(),
  };
}

export async function getAdminTeams(
  service: Pick<AdminTeamsService, "authorizeAdmin" | "listTeams">,
  input: GetAdminTeamsInput,
): Promise<GetAdminTeamsSuccessResponse> {
  const query = validateAdminTeamsQuery(input.query);
  const trustedOpenid = await preflightAdmin(service, input.trusted_openid);
  await (input.rate_limiter ?? defaultApiRateLimiter).check(
    "admin_apis",
    trustedOpenid,
    input.server_now,
  );
  const items = await service.listTeams(trustedOpenid, query);
  return {
    status: 200,
    body: {
      data: {
        items: items.map(mapTeamWithMappings),
      },
      request_id: input.request_id,
    },
  };
}

export async function patchAdminTeam(
  service: Pick<AdminTeamsService, "authorizeAdmin" | "updateTeam">,
  input: PatchAdminTeamInput,
): Promise<PatchAdminTeamSuccessResponse> {
  if (input.query !== undefined) {
    assertUnknownFields(input.query as Record<string, unknown>, new Set());
  }
  const trustedOpenid = await preflightAdmin(service, input.trusted_openid);
  const teamId = validateAdminTeamId(input.team_id);
  const payload = validatePatchAdminTeamPayload(input.body);
  await (input.rate_limiter ?? defaultApiRateLimiter).check(
    "admin_apis",
    trustedOpenid,
    input.server_now,
  );
  const outcome = await service.updateTeam(trustedOpenid, teamId, payload, input.server_now);
  return {
    status: 200,
    body: {
      data: {
        team_id: outcome.team.team_id,
        league_id: outcome.team.league_id,
        name: outcome.team.name,
        name_zh: outcome.team.name_zh ?? null,
        logo_url: outcome.team.logo_url ?? null,
        updated_at: outcome.team.updated_at.toISOString(),
        resolved_anomaly_ids: outcome.resolved_anomaly_ids,
        audit_id: outcome.audit_log.audit_id,
      },
      request_id: input.request_id,
    },
  };
}

export async function postAdminTeamMapping(
  service: Pick<AdminTeamsService, "authorizeAdmin" | "upsertTeamMapping">,
  input: PostAdminTeamMappingInput,
): Promise<PostAdminTeamMappingSuccessResponse> {
  if (input.query !== undefined) {
    assertUnknownFields(input.query as Record<string, unknown>, new Set());
  }
  const trustedOpenid = await preflightAdmin(service, input.trusted_openid);
  const teamId = validateAdminTeamId(input.team_id);
  const payload = validatePostAdminTeamMappingPayload(input.body);
  await (input.rate_limiter ?? defaultApiRateLimiter).check(
    "admin_apis",
    trustedOpenid,
    input.server_now,
  );
  const outcome = await service.upsertTeamMapping(trustedOpenid, teamId, payload, input.server_now);
  return {
    status: 200,
    body: {
      data: {
        team_id: outcome.team.team_id,
        provider: outcome.mapping.provider,
        provider_team_id: outcome.mapping.provider_team_id,
        status: outcome.status,
        resolved_anomaly_ids: outcome.resolved_anomaly_ids,
        audit_id: outcome.audit_log.audit_id,
      },
      request_id: input.request_id,
    },
  };
}
