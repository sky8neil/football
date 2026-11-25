import { conflictError, validationError } from "../../domain/errors.js";
import { isValidUuid } from "../../domain/ids.js";
import type { AnomalyStatus, AnomalyType, LeagueId, MatchStatus, ResultSource, SettlementStatus } from "../../domain/enums.js";
import type { AdminMatchDetailService } from "../../application/admin-match-detail.js";
import { assertUnknownFields } from "./validation.js";
import { defaultApiRateLimiter, type RateLimiter } from "./rate-limit.js";

export interface GetAdminMatchDetailInput {
  trusted_openid?: string | null;
  match_id: unknown;
  query?: unknown;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface AdminMatchDetailTeamResponse {
  team_id: string;
  name: string;
  name_zh: string | null;
  logo_url: string | null;
}

export interface AdminMatchDetailAnomalyResponse {
  anomaly_id: string;
  anomaly_key: string;
  type: AnomalyType;
  blocking: boolean;
  status: AnomalyStatus;
  last_seen_at: string;
  occurrence_count: number;
}

export interface AdminMatchDetailResponseData {
  match_id: string;
  league_id: LeagueId;
  season_id: string;
  round_id: string;
  kickoff_at: string;
  match_status: MatchStatus;
  settlement_status: SettlementStatus;
  result_version: number;
  settled_result_version: number;
  result_source: ResultSource | null;
  regular_home_score: number | null;
  regular_away_score: number | null;
  superseded_by: string | null;
  home_team: AdminMatchDetailTeamResponse;
  away_team: AdminMatchDetailTeamResponse;
  open_anomalies: AdminMatchDetailAnomalyResponse[];
}

export interface GetAdminMatchDetailSuccessResponse {
  status: 200;
  body: {
    data: AdminMatchDetailResponseData;
    request_id: string;
  };
}

async function preflightAdminMatchDetail(
  service: Pick<AdminMatchDetailService, "authorizeAdmin">,
  value: string | null | undefined,
): Promise<string> {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw conflictError("UNAUTHORIZED", "需要可信管理员身份");
  }
  await service.authorizeAdmin(value);
  return value;
}

export async function getAdminMatchDetail(
  service: AdminMatchDetailService,
  input: GetAdminMatchDetailInput,
): Promise<GetAdminMatchDetailSuccessResponse> {
  if (input.query !== undefined) {
    assertUnknownFields(input.query as Record<string, unknown>, new Set());
  }
  const trustedOpenid = await preflightAdminMatchDetail(service, input.trusted_openid);
  if (typeof input.match_id !== "string" || !isValidUuid(input.match_id)) {
    throw validationError("match_id 必须为 UUID v4", { field: "match_id" });
  }
  await (input.rate_limiter ?? defaultApiRateLimiter).check(
    "admin_apis",
    trustedOpenid,
    input.server_now,
  );
  const outcome = await service.getMatchDetail(trustedOpenid, input.match_id);
  const { match, home_team, away_team, open_anomalies } = outcome;
  return {
    status: 200,
    body: {
      data: {
        match_id: match.match_id,
        league_id: match.league_id,
        season_id: match.season_id,
        round_id: match.round_id,
        kickoff_at: match.kickoff_at.toISOString(),
        match_status: match.match_status,
        settlement_status: match.settlement_status,
        result_version: match.result_version,
        settled_result_version: match.settled_result_version,
        result_source: match.result_source,
        regular_home_score: match.regular_home_score,
        regular_away_score: match.regular_away_score,
        superseded_by: match.superseded_by,
        home_team: {
          team_id: match.home_team_id,
          name: home_team?.name ?? match.home_team_id,
          name_zh: home_team?.name_zh ?? null,
          logo_url: home_team?.logo_url ?? null,
        },
        away_team: {
          team_id: match.away_team_id,
          name: away_team?.name ?? match.away_team_id,
          name_zh: away_team?.name_zh ?? null,
          logo_url: away_team?.logo_url ?? null,
        },
        open_anomalies: open_anomalies.map((anomaly) => ({
          anomaly_id: anomaly.anomaly_id,
          anomaly_key: anomaly.anomaly_key,
          type: anomaly.type,
          blocking: anomaly.blocking,
          status: anomaly.status,
          last_seen_at: anomaly.last_seen_at.toISOString(),
          occurrence_count: anomaly.occurrence_count,
        })),
      },
      request_id: input.request_id,
    },
  };
}
