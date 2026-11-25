import { assertUnknownFields } from "./validation.js";
import { conflictError, validationError } from "../../domain/errors.js";
import {
  validateShareCardQueryValues,
  type ShareCardData,
  type ShareCardQuery,
  ShareCardQueryService,
} from "../../application/share-card.js";
import {
  defaultApiRateLimiter,
  type RateLimiter,
} from "./rate-limit.js";

const SHARE_CARD_QUERY_FIELDS = new Set(["league_id", "season_id", "round_id"]);
const PUBLIC_SHARE_CARD_QUERY_FIELDS = new Set(["league_id", "season_id", "round_id", "share_token"]);

export interface ShareCardSuccessResponse {
  status: 200;
  body: {
    data: ShareCardData;
    request_id: string;
  };
}

export interface GetShareCardMeInput {
  authenticated_user_id?: string | null;
  query: Record<string, unknown>;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface GetShareCardForUserInput {
  user_id: string;
  authenticated_user_id?: string | null;
  query: Record<string, unknown>;
  server_now: Date;
  request_id: string;
}

export function validateShareCardQuery(query: Record<string, unknown>): ShareCardQuery {
  assertUnknownFields(query, SHARE_CARD_QUERY_FIELDS);
  return validateShareCardQueryValues(query);
}

export function validatePublicShareCardQuery(
  query: Record<string, unknown>,
): ShareCardQuery & { share_token: string | null } {
  assertUnknownFields(query, PUBLIC_SHARE_CARD_QUERY_FIELDS);
  let shareToken: string | null = null;
  if (Object.prototype.hasOwnProperty.call(query, "share_token") && query.share_token !== undefined) {
    if (typeof query.share_token !== "string") {
      throw validationError("share_token 必须为字符串", { field: "share_token" });
    }
    const trimmed = query.share_token.trim();
    shareToken = trimmed.length > 0 ? trimmed : null;
  }
  const { league_id, season_id, round_id } = validateShareCardQueryValues({
    league_id: query.league_id,
    season_id: query.season_id,
    round_id: query.round_id,
  });
  return { league_id, season_id, round_id, share_token: shareToken };
}

export async function getShareCardMe(
  service: ShareCardQueryService,
  input: GetShareCardMeInput,
): Promise<ShareCardSuccessResponse> {
  if (typeof input.authenticated_user_id !== "string" || input.authenticated_user_id.length === 0) {
    throw conflictError("UNAUTHORIZED", "需要登录后访问分享卡");
  }

  await (input.rate_limiter ?? defaultApiRateLimiter).check(
    "authenticated_reads",
    input.authenticated_user_id,
    input.server_now,
  );
  const query = validateShareCardQuery(input.query);
  const data = await service.getShareCard(input.authenticated_user_id, query, input.server_now);
  return {
    status: 200,
    body: {
      data,
      request_id: input.request_id,
    },
  };
}

export async function getShareCardForUser(
  service: ShareCardQueryService,
  input: GetShareCardForUserInput,
): Promise<ShareCardSuccessResponse> {
  const { share_token, ...query } = validatePublicShareCardQuery(input.query);
  const data = await service.getPublicShareCard(input.user_id, query, {
    shareToken: share_token,
    viewerUserId: input.authenticated_user_id ?? null,
    serverNow: input.server_now,
  });
  return {
    status: 200,
    body: {
      data,
      request_id: input.request_id,
    },
  };
}
