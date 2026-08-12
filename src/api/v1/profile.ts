import { conflictError, validationError } from "../../domain/errors.js";
import { isValidUuid } from "../../domain/ids.js";
import type {
  MyProfileData,
  ProfileQueryService,
  PublicProfileData,
} from "../../application/profile.js";
import type {
  ProfileMutationService,
  ProfilePatch,
} from "../../application/profile-mutation.js";
import { assertUnknownFields } from "./validation.js";
import {
  defaultApiRateLimiter,
  type RateLimiter,
} from "./rate-limit.js";

export interface GetMyProfileInput {
  authenticated_user_id?: string | null;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface GetMyProfileSuccessResponse {
  status: 200;
  body: {
    data: MyProfileData;
    request_id: string;
  };
}

export interface GetPublicProfileInput {
  user_id: unknown;
  request_id: string;
  public_source: string;
  server_now: Date;
  rate_limiter?: RateLimiter;
}

export interface GetPublicProfileSuccessResponse {
  status: 200;
  body: {
    data: PublicProfileData;
    request_id: string;
  };
}

export interface DeleteMyProfileInput {
  authenticated_user_id?: string | null;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface DeleteMyProfileSuccessResponse {
  status: 204;
}

export interface PatchMyProfileInput {
  authenticated_user_id?: string | null;
  body: unknown;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface PatchMyProfileSuccessResponse {
  status: 200;
  body: {
    data: MyProfileData;
    request_id: string;
  };
}

const PROFILE_PATCH_FIELDS = new Set(["nickname", "favorite_team_id"]);

function requireAuthenticatedUserId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw conflictError("UNAUTHORIZED", "需要登录后访问个人资料");
  }
  return value;
}

export function validatePublicProfileUserId(value: unknown): string {
  if (typeof value !== "string" || !isValidUuid(value)) {
    throw validationError("user_id 必须为 UUID v4", { field: "user_id" });
  }
  return value;
}

function requirePublicSource(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("公开读取需要可信来源标识", { field: "public_source" });
  }
  return value;
}

export function validateProfilePatch(input: unknown): ProfilePatch {
  assertUnknownFields(input as Record<string, unknown>, PROFILE_PATCH_FIELDS);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw validationError("资料更新请求体必须为 JSON 对象");
  }
  const payload = input as Record<string, unknown>;
  if (Object.keys(payload).length === 0) {
    throw validationError("至少需要更新一个资料字段");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "nickname") &&
    typeof payload.nickname !== "string") {
    throw validationError("nickname 必须为字符串", { field: "nickname" });
  }
  if (Object.prototype.hasOwnProperty.call(payload, "favorite_team_id") &&
    payload.favorite_team_id !== null &&
    (typeof payload.favorite_team_id !== "string" || !isValidUuid(payload.favorite_team_id))) {
    throw validationError("favorite_team_id 必须为 UUID v4 或 null", {
      field: "favorite_team_id",
    });
  }
  return payload as ProfilePatch;
}

export async function getPublicProfile(
  service: Pick<ProfileQueryService, "getPublicProfile">,
  input: GetPublicProfileInput,
): Promise<GetPublicProfileSuccessResponse> {
  const userId = validatePublicProfileUserId(input.user_id);
  const publicSource = requirePublicSource(input.public_source);
  (input.rate_limiter ?? defaultApiRateLimiter).check(
    "public_reads",
    publicSource,
    input.server_now,
  );
  const data = await service.getPublicProfile(userId);
  return {
    status: 200,
    body: {
      data,
      request_id: input.request_id,
    },
  };
}

export async function getMyProfile(
  service: Pick<ProfileQueryService, "getMyProfile">,
  input: GetMyProfileInput,
): Promise<GetMyProfileSuccessResponse> {
  const userId = requireAuthenticatedUserId(input.authenticated_user_id);
  (input.rate_limiter ?? defaultApiRateLimiter).check(
    "authenticated_reads",
    userId,
    input.server_now,
  );
  const data = await service.getMyProfile(userId);
  return {
    status: 200,
    body: {
      data,
      request_id: input.request_id,
    },
  };
}

export async function patchMyProfile(
  service: Pick<ProfileMutationService, "updateMyProfile">,
  input: PatchMyProfileInput,
): Promise<PatchMyProfileSuccessResponse> {
  const userId = requireAuthenticatedUserId(input.authenticated_user_id);
  (input.rate_limiter ?? defaultApiRateLimiter).check(
    "profile_patch",
    userId,
    input.server_now,
  );
  const patch = validateProfilePatch(input.body);
  const data = await service.updateMyProfile(userId, patch, input.server_now);
  return {
    status: 200,
    body: {
      data,
      request_id: input.request_id,
    },
  };
}

export async function deleteMyProfile(
  service: Pick<ProfileMutationService, "deleteMyProfile">,
  input: DeleteMyProfileInput,
): Promise<DeleteMyProfileSuccessResponse> {
  const userId = requireAuthenticatedUserId(input.authenticated_user_id);
  (input.rate_limiter ?? defaultApiRateLimiter).check(
    "profile_patch",
    userId,
    input.server_now,
  );
  await service.deleteMyProfile(userId, input.server_now);
  return { status: 204 };
}
