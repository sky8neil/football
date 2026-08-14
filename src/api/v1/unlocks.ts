import { conflictError } from "../../domain/errors.js";
import type { UnlocksData, UnlocksQueryService } from "../../application/unlocks.js";
import { assertUnknownFields } from "./validation.js";
import {
  defaultApiRateLimiter,
  type RateLimiter,
} from "./rate-limit.js";

export interface GetMyUnlocksInput {
  authenticated_user_id?: string | null;
  query?: unknown;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

const UNLOCKS_QUERY_FIELDS = new Set<string>();

export interface GetMyUnlocksSuccessResponse {
  status: 200;
  body: {
    data: UnlocksData;
    request_id: string;
  };
}

function toPublicUnlocksData(data: UnlocksData): UnlocksData {
  return {
    default_resources: [...data.default_resources],
    unlocked: data.unlocked.map((unlock) => ({
      unlock_id: unlock.unlock_id,
      unlock_code: unlock.unlock_code,
      threshold_points: unlock.threshold_points,
      source_version: unlock.source_version,
      unlocked_at: unlock.unlocked_at,
    })),
  };
}

function requireAuthenticatedUserId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw conflictError("UNAUTHORIZED", "需要登录后访问解锁资源");
  }
  return value;
}

export async function getMyUnlocks(
  service: Pick<UnlocksQueryService, "getUnlocks">,
  input: GetMyUnlocksInput,
): Promise<GetMyUnlocksSuccessResponse> {
  const userId = requireAuthenticatedUserId(input.authenticated_user_id);
  assertUnknownFields(
    (input.query === undefined ? {} : input.query) as Record<string, unknown>,
    UNLOCKS_QUERY_FIELDS,
  );
  await (input.rate_limiter ?? defaultApiRateLimiter).check(
    "authenticated_reads",
    userId,
    input.server_now,
  );
  const data = await service.getUnlocks(userId);
  return {
    status: 200,
    body: {
      data: toPublicUnlocksData(data),
      request_id: input.request_id,
    },
  };
}
