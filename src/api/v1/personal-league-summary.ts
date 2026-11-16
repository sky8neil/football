import type { PersonalLeagueSummaryResponse, PersonalLeagueSummaryService } from "../../application/personal-league-summary-service.js";
import { conflictError, validationError } from "../../domain/errors.js";
import { defaultApiRateLimiter, type RateLimiter } from "./rate-limit.js";
import { assertUnknownFields } from "./validation.js";

export interface GetPersonalLeagueSummaryInput {
  authenticated_user_id?: string | null;
  query: Record<string, unknown>;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

function requireAuthenticatedUserId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw conflictError("UNAUTHORIZED", "需要登录后访问联赛小结");
  }
  return value;
}

export async function getPersonalLeagueSummary(
  service: Pick<PersonalLeagueSummaryService, "get">,
  input: GetPersonalLeagueSummaryInput,
): Promise<{ status: 200; body: { data: PersonalLeagueSummaryResponse; request_id: string } }> {
  const userId = requireAuthenticatedUserId(input.authenticated_user_id);
  await (input.rate_limiter ?? defaultApiRateLimiter).check("authenticated_reads", userId, input.server_now);
  assertUnknownFields(input.query, new Set(["league_id", "season_id"]));
  const { league_id: leagueId, season_id: seasonId } = input.query;
  if (typeof leagueId !== "string") throw validationError("league_id");
  if (seasonId !== undefined && typeof seasonId !== "string") throw validationError("season_id");
  const data = await service.get(userId, leagueId, seasonId, input.server_now);
  return { status: 200, body: { data, request_id: input.request_id } };
}
