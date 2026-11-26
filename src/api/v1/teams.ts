import { findSupportedLeagueById, isSupportedLeagueId } from "../../domain/config.js";
import { TeamStatus, type LeagueId } from "../../domain/enums.js";
import { internalError, notFoundError, validationError } from "../../domain/errors.js";
import { isValidUuid } from "../../domain/ids.js";
import type { AppRepository } from "../../infrastructure/repositories.js";
import { requirePublicSource } from "./matches.js";
import { defaultApiRateLimiter, type RateLimiter } from "./rate-limit.js";
import { assertUnknownFields } from "./validation.js";

const TEAMS_QUERY_FIELDS = new Set(["league_id"]);

export interface PublicTeamItem {
  team_id: string;
  league_id: LeagueId;
  name: string;
  name_zh: string | null;
  logo_url: string | null;
}

export interface GetTeamsInput {
  public_source: string;
  query: Record<string, unknown>;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface GetTeamsSuccessResponse {
  status: 200;
  body: {
    data: {
      items: PublicTeamItem[];
    };
    request_id: string;
  };
}

export interface GetTeamByIdInput {
  team_id: unknown;
  public_source: string;
  query: Record<string, unknown>;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface GetTeamByIdSuccessResponse {
  status: 200;
  body: {
    data: PublicTeamItem;
    request_id: string;
  };
}

export function validateTeamId(value: unknown): string {
  if (typeof value !== "string" || !isValidUuid(value)) {
    throw validationError("team_id 必须为 UUID v4", { field: "team_id" });
  }
  return value;
}

export function validateTeamsQuery(query: Record<string, unknown>): LeagueId | null {
  assertUnknownFields(query, TEAMS_QUERY_FIELDS);
  const rawLeagueId = query.league_id;
  if (rawLeagueId === undefined) {
    return null;
  }
  if (
    typeof rawLeagueId !== "string" ||
    !isSupportedLeagueId(rawLeagueId) ||
    findSupportedLeagueById(rawLeagueId) === undefined
  ) {
    throw validationError("league_id 不是有效联赛", { field: "league_id" });
  }
  return rawLeagueId;
}

export async function getTeams(
  repo: Pick<AppRepository, "teams">,
  input: GetTeamsInput,
): Promise<GetTeamsSuccessResponse> {
  const leagueId = validateTeamsQuery(input.query);
  const publicSource = requirePublicSource(input.public_source);
  await (input.rate_limiter ?? defaultApiRateLimiter).check(
    "public_reads",
    publicSource,
    input.server_now,
  );
  if (repo.teams?.findAll === undefined) {
    throw internalError("teams findAll port 未配置");
  }
  const allTeams = await repo.teams.findAll();
  const items: PublicTeamItem[] = allTeams
    .filter((team) => team.status === TeamStatus.Active)
    .filter((team) => leagueId === null || team.league_id === leagueId)
    .sort(
      (a, b) =>
        a.league_id.localeCompare(b.league_id) ||
        a.name.localeCompare(b.name) ||
        a.team_id.localeCompare(b.team_id),
    )
    .map((team) => ({
      team_id: team.team_id,
      league_id: team.league_id,
      name: team.name,
      name_zh: team.name_zh ?? null,
      logo_url: team.logo_url ?? null,
    }));

  return {
    status: 200,
    body: {
      data: { items },
      request_id: input.request_id,
    },
  };
}

export async function getTeamById(
  repo: Pick<AppRepository, "teams">,
  input: GetTeamByIdInput,
): Promise<GetTeamByIdSuccessResponse> {
  assertUnknownFields(input.query, new Set());
  const teamId = validateTeamId(input.team_id);
  const publicSource = requirePublicSource(input.public_source);
  await (input.rate_limiter ?? defaultApiRateLimiter).check(
    "public_reads",
    publicSource,
    input.server_now,
  );
  if (repo.teams?.findById === undefined) {
    throw internalError("teams findById port 未配置");
  }
  const team = await repo.teams.findById(teamId);
  if (team === null) {
    throw notFoundError("TEAM");
  }
  return {
    status: 200,
    body: {
      data: {
        team_id: team.team_id,
        league_id: team.league_id,
        name: team.name,
        name_zh: team.name_zh ?? null,
        logo_url: team.logo_url ?? null,
      },
      request_id: input.request_id,
    },
  };
}
