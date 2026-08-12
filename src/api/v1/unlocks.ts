import { conflictError } from "../../domain/errors.js";
import type { UnlocksData, UnlocksQueryService } from "../../application/unlocks.js";
import {
  defaultApiRateLimiter,
  type RateLimiter,
} from "./rate-limit.js";

export interface GetMyUnlocksInput {
  authenticated_user_id?: string | null;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface GetMyUnlocksSuccessResponse {
  status: 200;
  body: {
    data: UnlocksData;
    request_id: string;
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
  (input.rate_limiter ?? defaultApiRateLimiter).check(
    "authenticated_reads",
    userId,
    input.server_now,
  );
  return service.getUnlocks(userId).then((data) => ({
    status: 200 as const,
    body: {
      data,
      request_id: input.request_id,
    },
  }));
}
