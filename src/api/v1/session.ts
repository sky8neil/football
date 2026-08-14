import { internalError, conflictError } from "../../domain/errors.js";
import type { SessionInitResult, SessionService } from "../../application/session.js";
import { assertUnknownFields } from "./validation.js";
import {
  defaultApiRateLimiter,
  type RateLimiter,
} from "./rate-limit.js";

const SESSION_INIT_BODY_FIELDS = new Set(["nickname"]);

export interface SessionInitBody {
  nickname: unknown;
}

export interface PostSessionInitInput {
  trusted_openid?: string | null;
  body: unknown;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface PostSessionInitSuccessResponse {
  status: 200 | 201;
  body: {
    data: {
      user_id: string;
      nickname: string;
      favorite_team_id: string | null;
      status: "active";
      career_points: number;
      career_level: number;
    };
    request_id: string;
  };
}

export function validateSessionInitBody(payload: unknown): SessionInitBody {
  assertUnknownFields(payload as Record<string, unknown>, SESSION_INIT_BODY_FIELDS);
  return payload as SessionInitBody;
}

function requireTrustedOpenid(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw conflictError("UNAUTHORIZED", "需要可信微信身份");
  }
  return value;
}

function mapSessionResult(
  result: SessionInitResult,
  requestId: string,
): PostSessionInitSuccessResponse {
  const { user } = result;
  if (typeof user.nickname !== "string" || user.status !== "active") {
    throw internalError("session init 返回的用户状态不一致");
  }
  return {
    status: result.created ? 201 : 200,
    body: {
      data: {
        user_id: user.user_id,
        nickname: user.nickname,
        favorite_team_id: user.favorite_team_id,
        status: "active",
        career_points: user.career_points,
        career_level: user.career_level,
      },
      request_id: requestId,
    },
  };
}

export async function postSessionInit(
  service: Pick<SessionService, "init">,
  input: PostSessionInitInput,
): Promise<PostSessionInitSuccessResponse> {
  const openid = requireTrustedOpenid(input.trusted_openid);
  await (input.rate_limiter ?? defaultApiRateLimiter).check(
    "authenticated_reads",
    openid,
    input.server_now,
  );
  const body = validateSessionInitBody(input.body);
  const result = await service.init(
    { openid, nickname: body.nickname },
    input.server_now,
  );
  return mapSessionResult(result, input.request_id);
}
