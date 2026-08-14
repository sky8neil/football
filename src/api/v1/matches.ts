import { FIXED_CONFIG_V1 } from "../../domain/config.js";
import { MatchStatus } from "../../domain/enums.js";
import { validationError } from "../../domain/errors.js";
import { isValidUuid } from "../../domain/ids.js";
import type {
  MatchDetailResult,
  MatchListQuery,
  MatchListResult,
  MatchQueryService,
} from "../../application/match-query.js";
import { assertUnknownFields, ISO_UTC_DATE_TIME } from "./validation.js";
import {
  defaultApiRateLimiter,
  type RateLimiter,
} from "./rate-limit.js";

const MATCHES_QUERY_FIELDS = new Set(["from", "to", "status", "limit", "cursor"]);

export type MatchesQuery = Omit<MatchListQuery, "server_now" | "authenticated_user_id">;

export interface GetMatchesInput {
  authenticated_user_id?: string | null;
  public_source: string;
  query: Record<string, unknown>;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface GetMatchesSuccessResponse {
  status: 200;
  body: {
    data: {
      items: MatchListResult["items"];
      page: {
        next_cursor: string | null;
        has_more: boolean;
      };
    };
    request_id: string;
  };
}

export interface GetMatchInput {
  authenticated_user_id?: string | null;
  public_source: string;
  match_id: unknown;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface GetMatchSuccessResponse {
  status: 200;
  body: {
    data: MatchDetailResult;
    request_id: string;
  };
}

export function validateMatchId(value: unknown): string {
  if (typeof value !== "string" || !isValidUuid(value)) {
    throw validationError("match_id 必须为 UUID v4", { field: "match_id" });
  }
  return value;
}

function requirePublicSource(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("公开读取需要可信来源标识", { field: "public_source" });
  }
  return value;
}

function parseDate(value: unknown, field: string): Date | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || !ISO_UTC_DATE_TIME.test(value)) {
    throw validationError(`${field} 必须是 ISO8601 UTC 时间`, { field });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw validationError(`${field} 必须是有效 ISO8601 UTC 时间`, { field });
  }
  return date;
}

function parseLimit(value: unknown): number {
  if (value === undefined) {
    return FIXED_CONFIG_V1.API_DEFAULT_LIMIT;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw validationError("limit 必须是整数", { field: "limit" });
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > FIXED_CONFIG_V1.API_MAX_LIMIT) {
    throw validationError("limit 必须为 1..100", { field: "limit" });
  }
  return limit;
}

export function validateMatchesQuery(query: Record<string, unknown>): MatchesQuery {
  assertUnknownFields(query, MATCHES_QUERY_FIELDS);
  const status = query.status === undefined ? null : query.status;
  if (
    status !== null &&
    (typeof status !== "string" || !Object.values(MatchStatus).includes(status as MatchStatus))
  ) {
    throw validationError("status 不是有效比赛状态", { field: "status" });
  }
  const cursor = query.cursor === undefined ? null : query.cursor;
  if (cursor !== null && typeof cursor !== "string") {
    throw validationError("cursor 必须是字符串", { field: "cursor" });
  }
  return {
    from: parseDate(query.from, "from"),
    to: parseDate(query.to, "to"),
    status: status as MatchListQuery["status"],
    limit: parseLimit(query.limit),
    cursor,
  };
}

export async function getMatches(
  service: Pick<MatchQueryService, "list">,
  input: GetMatchesInput,
): Promise<GetMatchesSuccessResponse> {
  const query = validateMatchesQuery(input.query);
  const publicSource = requirePublicSource(input.public_source);
  await (input.rate_limiter ?? defaultApiRateLimiter).check(
    "public_reads",
    publicSource,
    input.server_now,
  );
  const result = await service.list({
    ...query,
    server_now: input.server_now,
    authenticated_user_id: input.authenticated_user_id,
  });
  return {
    status: 200,
    body: {
      data: {
        items: result.items,
        page: {
          next_cursor: result.next_cursor,
          has_more: result.has_more,
        },
      },
      request_id: input.request_id,
    },
  };
}

export async function getMatch(
  service: Pick<MatchQueryService, "get">,
  input: GetMatchInput,
): Promise<GetMatchSuccessResponse> {
  const matchId = validateMatchId(input.match_id);
  const publicSource = requirePublicSource(input.public_source);
  await (input.rate_limiter ?? defaultApiRateLimiter).check(
    "public_reads",
    publicSource,
    input.server_now,
  );
  const data = await service.get(matchId, input.authenticated_user_id, input.server_now);
  return {
    status: 200,
    body: {
      data,
      request_id: input.request_id,
    },
  };
}
