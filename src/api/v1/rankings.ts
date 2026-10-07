import { FIXED_CONFIG_V1 } from "../../domain/config.js";
import { RankingBoard, RankingScope } from "../../domain/enums.js";
import { conflictError, validationError } from "../../domain/errors.js";
import { isValidUuid } from "../../domain/ids.js";
import { isValidPeriodKey } from "../../domain/time.js";
import type {
  RankingQuery,
  RankingQueryResult,
  RankingQueryService,
} from "../../application/ranking-query.js";
import { assertUnknownFields } from "./validation.js";
import { defaultApiRateLimiter, type RateLimiter } from "./rate-limit.js";

const RANKINGS_QUERY_FIELDS = new Set([
  "board",
  "period_key",
  "scope",
  "group_id",
  "level_season_id",
  "limit",
  "cursor",
]);

export type RankingsQuery = Omit<RankingQuery, "server_now" | "authenticated_user_id">;

export interface GetRankingsInput {
  authenticated_user_id: string | null;
  query: Record<string, unknown>;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface GetRankingsSuccessResponse {
  status: 200;
  body: {
    data: {
      board: RankingQueryResult["board"];
      scope: RankingQueryResult["scope"];
      period_key: string | null;
      updated_at: string | null;
      server_now: string;
      current_period_key?: string;
      available_boards: RankingQueryResult["available_boards"];
      seasons_participated: number;
      entry_count: number;
      level_season_id?: string;
      available_level_seasons?: string[];
      is_provisional?: boolean;
      items: RankingQueryResult["items"];
      page: {
        next_cursor: string | null;
        has_more: boolean;
      };
      me?: RankingQueryResult["me"];
    };
    request_id: string;
  };
}

function parseLimit(value: unknown): number {
  if (value === undefined) return FIXED_CONFIG_V1.API_DEFAULT_LIMIT;
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
  if (!Object.values(RankingBoard).includes(query.board as RankingQuery["board"])) {
    throw validationError("board 必须是 week、career、strength 或 season", { field: "board" });
  }
  const board = query.board as RankingQuery["board"];
  const scope = query.scope === undefined ? RankingScope.Global : query.scope;
  if (!Object.values(RankingScope).includes(scope as RankingQuery["scope"])) {
    throw validationError("scope 必须是 global 或 group", { field: "scope" });
  }
  const periodKey = query.period_key === undefined ? null : query.period_key;
  if (board === RankingBoard.Week) {
    if (query.period_key !== undefined &&
      (typeof periodKey !== "string" || !isValidPeriodKey("week", periodKey))) {
      throw validationError("period_key 必须是有效 ISO 周", { field: "period_key" });
    }
  } else if (query.period_key !== undefined) {
    throw validationError("period_key 仅适用于 week 榜", { field: "period_key" });
  }
  const levelSeasonId = query.level_season_id === undefined ? null : query.level_season_id;
  if (board === RankingBoard.Season) {
    if (levelSeasonId !== null &&
      (typeof levelSeasonId !== "string" || !/^\d{4}_\d{4}$/.test(levelSeasonId))) {
      throw validationError("level_season_id 格式无效", { field: "level_season_id" });
    }
  } else if (query.level_season_id !== undefined) {
    throw validationError("level_season_id 仅适用于 season 榜", { field: "level_season_id" });
  }
  const groupId = query.group_id === undefined ? null : query.group_id;
  if (scope === RankingScope.Group) {
    if (typeof groupId !== "string" || !isValidUuid(groupId)) {
      throw validationError("scope=group 时 group_id 必须为 UUID v4", { field: "group_id" });
    }
  } else if (query.group_id !== undefined) {
    throw validationError("scope=global 时禁止携带 group_id", { field: "group_id" });
  }
  const cursor = query.cursor === undefined ? null : query.cursor;
  if (cursor !== null && typeof cursor !== "string") {
    throw validationError("cursor 必须是字符串", { field: "cursor" });
  }
  return {
    board,
    period_key: periodKey as string | null,
    scope: scope as RankingQuery["scope"],
    group_id: groupId as string | null,
    level_season_id: levelSeasonId as string | null,
    limit: parseLimit(query.limit),
    cursor,
  };
}

function requireAuthenticatedUserId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw conflictError("UNAUTHORIZED", "需要登录后查看排行榜");
  }
  return value;
}

export async function getRankings(
  service: Pick<RankingQueryService, "list">,
  input: GetRankingsInput,
): Promise<GetRankingsSuccessResponse> {
  const query = validateRankingsQuery(input.query);
  const userId = requireAuthenticatedUserId(input.authenticated_user_id);
  const limiter = input.rate_limiter ?? defaultApiRateLimiter;
  await limiter.check("authenticated_reads", userId, input.server_now);
  const result = await service.list({
    ...query,
    server_now: input.server_now,
    authenticated_user_id: userId,
  });
  return {
    status: 200,
    body: {
      data: {
        board: result.board,
        scope: result.scope,
        period_key: result.period_key,
        updated_at: result.updated_at,
        server_now: input.server_now.toISOString(),
        ...(result.current_period_key === undefined
          ? {}
          : { current_period_key: result.current_period_key }),
        available_boards: result.available_boards,
        seasons_participated: result.seasons_participated,
        entry_count: result.entry_count,
        ...(result.level_season_id === undefined ? {} : { level_season_id: result.level_season_id }),
        ...(result.available_level_seasons === undefined
          ? {}
          : { available_level_seasons: result.available_level_seasons }),
        ...(result.is_provisional === undefined ? {} : { is_provisional: result.is_provisional }),
        items: result.items,
        page: { next_cursor: result.next_cursor, has_more: result.has_more },
        ...(result.me === undefined ? {} : { me: result.me }),
      },
      request_id: input.request_id,
    },
  };
}
