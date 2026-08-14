import { FIXED_CONFIG_V1 } from "../../domain/config.js";
import { PeriodType } from "../../domain/enums.js";
import { validationError } from "../../domain/errors.js";
import { isValidPeriodKey } from "../../domain/time.js";
import type {
  RankingQuery,
  RankingQueryResult,
  RankingQueryService,
} from "../../application/ranking-query.js";
import { assertUnknownFields } from "./validation.js";
import {
  defaultApiRateLimiter,
  type RateLimiter,
} from "./rate-limit.js";

const RANKINGS_QUERY_FIELDS = new Set([
  "period_type",
  "period_key",
  "limit",
  "cursor",
]);

export type RankingsQuery = Omit<RankingQuery, "server_now">;

export interface GetRankingsInput {
  authenticated_user_id?: string | null;
  public_source: string;
  query: Record<string, unknown>;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface GetRankingsSuccessResponse {
  status: 200;
  body: {
    data: {
      items: RankingQueryResult["items"];
      page: {
        next_cursor: string | null;
        has_more: boolean;
      };
    };
    request_id: string;
  };
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

export function validateRankingsQuery(query: Record<string, unknown>): RankingsQuery {
  assertUnknownFields(query, RANKINGS_QUERY_FIELDS);
  if (query.period_type !== PeriodType.Week && query.period_type !== PeriodType.Month) {
    throw validationError("period_type 必须是 week 或 month", { field: "period_type" });
  }
  const periodKey = query.period_key === undefined ? null : query.period_key;
  if (
    periodKey !== null &&
    (typeof periodKey !== "string" || !isValidPeriodKey(query.period_type, periodKey))
  ) {
    throw validationError("period_key 格式与 period_type 不匹配", { field: "period_key" });
  }
  const cursor = query.cursor === undefined ? null : query.cursor;
  if (cursor !== null && typeof cursor !== "string") {
    throw validationError("cursor 必须是字符串", { field: "cursor" });
  }
  return {
    period_type: query.period_type,
    period_key: periodKey,
    limit: parseLimit(query.limit),
    cursor,
  };
}

function requirePublicSource(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("公开读取需要可信来源标识", { field: "public_source" });
  }
  return value;
}

export async function getRankings(
  service: Pick<RankingQueryService, "list">,
  input: GetRankingsInput,
): Promise<GetRankingsSuccessResponse> {
  const query = validateRankingsQuery(input.query);
  const publicSource = requirePublicSource(input.public_source);
  await (input.rate_limiter ?? defaultApiRateLimiter).check(
    "public_reads",
    publicSource,
    input.server_now,
  );
  const result = await service.list({ ...query, server_now: input.server_now });
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
