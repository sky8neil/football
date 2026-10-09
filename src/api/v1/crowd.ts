import { conflictError } from "../../domain/errors.js";
import type {
  CrowdQueryResult,
  CrowdQueryService,
} from "../../application/crowd-query.js";
import { validateMatchId } from "./matches.js";
import { assertUnknownFields } from "./validation.js";
import { defaultApiRateLimiter, type RateLimiter } from "./rate-limit.js";

const CROWD_QUERY_FIELDS = new Set<string>();

export interface GetMatchCrowdInput {
  authenticated_user_id?: string | null;
  match_id: unknown;
  query: Record<string, unknown>;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface GetMatchCrowdSuccessResponse {
  status: 200;
  body: {
    data: CrowdQueryResult;
    request_id: string;
  };
}

function requireAuthenticatedUserId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw conflictError("UNAUTHORIZED", "需要登录后查看大家怎么选");
  }
  return value;
}

export async function getMatchCrowd(
  service: Pick<CrowdQueryService, "get">,
  input: GetMatchCrowdInput,
): Promise<GetMatchCrowdSuccessResponse> {
  const userId = requireAuthenticatedUserId(input.authenticated_user_id);
  const matchId = validateMatchId(input.match_id);
  assertUnknownFields(input.query, CROWD_QUERY_FIELDS);
  await (input.rate_limiter ?? defaultApiRateLimiter).check(
    "authenticated_reads",
    userId,
    input.server_now,
  );
  const data = await service.get({
    authenticated_user_id: userId,
    match_id: matchId,
    server_now: input.server_now,
  });
  return {
    status: 200,
    body: { data, request_id: input.request_id },
  };
}
