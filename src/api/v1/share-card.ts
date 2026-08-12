import { assertUnknownFields } from "./validation.js";
import { conflictError } from "../../domain/errors.js";
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

const SHARE_CARD_QUERY_FIELDS = new Set(["season_id", "round_id"]);

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

export function validateShareCardQuery(query: Record<string, unknown>): ShareCardQuery {
  assertUnknownFields(query, SHARE_CARD_QUERY_FIELDS);
  return validateShareCardQueryValues(query);
}

export async function getShareCardMe(
  service: ShareCardQueryService,
  input: GetShareCardMeInput,
): Promise<ShareCardSuccessResponse> {
  if (typeof input.authenticated_user_id !== "string" || input.authenticated_user_id.length === 0) {
    throw conflictError("UNAUTHORIZED", "需要登录后访问分享卡");
  }

  (input.rate_limiter ?? defaultApiRateLimiter).check(
    "authenticated_reads",
    input.authenticated_user_id,
    input.server_now,
  );
  const query = validateShareCardQuery(input.query);
  const data = await service.getShareCard(input.authenticated_user_id, query);
  return {
    status: 200,
    body: {
      data,
      request_id: input.request_id,
    },
  };
}
