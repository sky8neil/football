import { conflictError } from "../../domain/errors.js";
import type { LevelsData, LevelsQueryService } from "../../application/levels.js";
import {
  defaultApiRateLimiter,
  type RateLimiter,
} from "./rate-limit.js";

export interface GetMyLevelsInput {
  authenticated_user_id?: string | null;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface GetMyLevelsSuccessResponse {
  status: 200;
  body: {
    data: LevelsData;
    request_id: string;
  };
}

function requireAuthenticatedUserId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw conflictError("UNAUTHORIZED", "需要登录后访问等级");
  }
  return value;
}

export function getMyLevels(
  service: Pick<LevelsQueryService, "getLevels">,
  input: GetMyLevelsInput,
): Promise<GetMyLevelsSuccessResponse> {
  const userId = requireAuthenticatedUserId(input.authenticated_user_id);
  (input.rate_limiter ?? defaultApiRateLimiter).check(
    "authenticated_reads",
    userId,
    input.server_now,
  );
  return service.getLevels(userId).then((data) => ({
    status: 200 as const,
    body: {
      data,
      request_id: input.request_id,
    },
  }));
}
