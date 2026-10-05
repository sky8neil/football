import { FIXED_CONFIG_V1 } from "../../domain/config.js";
import { conflictError, validationError } from "../../domain/errors.js";
import { isValidUuid } from "../../domain/ids.js";
import type { GroupsService, MyGroupsQuery } from "../../application/groups.js";
import { assertUnknownFields } from "./validation.js";
import { defaultApiRateLimiter, type RateLimiter } from "./rate-limit.js";

const JOIN_FIELDS = new Set(["invite_code"]);
const MY_GROUPS_QUERY_FIELDS = new Set(["limit", "cursor"]);

export interface GroupApiInput {
  authenticated_user_id?: string | null;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface CreateGroupInput extends GroupApiInput {
  body: unknown;
}

export interface JoinGroupInput extends GroupApiInput {
  body: unknown;
}

export interface GroupIdInput extends GroupApiInput {
  group_id: unknown;
}

export interface GetMyGroupsInput extends GroupApiInput {
  query?: Record<string, unknown>;
}

export function validateCreateGroupBody(body: unknown): Record<string, never> {
  assertUnknownFields(body as Record<string, unknown>, new Set());
  if (Object.keys(body as Record<string, unknown>).length !== 0) {
    throw validationError("创建群请求体必须为空对象");
  }
  return {};
}

export function validateJoinGroupBody(body: unknown): { invite_code: string } {
  assertUnknownFields(body as Record<string, unknown>, JOIN_FIELDS);
  const inviteCode = (body as Record<string, unknown>).invite_code;
  const alphabet = FIXED_CONFIG_V1.GROUP_INVITE_CODE_ALPHABET;
  if (
    typeof inviteCode !== "string" ||
    inviteCode.length !== FIXED_CONFIG_V1.GROUP_INVITE_CODE_LENGTH ||
    [...inviteCode].some((character) => !alphabet.includes(character))
  ) {
    throw validationError("invite_code 格式非法", { field: "invite_code" });
  }
  return { invite_code: inviteCode };
}

export function validateMyGroupsQuery(query: Record<string, unknown>): MyGroupsQuery {
  assertUnknownFields(query, MY_GROUPS_QUERY_FIELDS);
  const limit = query.limit === undefined
    ? FIXED_CONFIG_V1.API_DEFAULT_LIMIT
    : typeof query.limit === "string" && /^\d+$/.test(query.limit)
      ? Number(query.limit)
      : Number.NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > FIXED_CONFIG_V1.API_MAX_LIMIT) {
    throw validationError("limit 必须为 1..100 的整数", { field: "limit" });
  }
  const cursor = query.cursor;
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0)) {
    throw validationError("cursor 格式无效", { field: "cursor" });
  }
  return { limit, cursor: cursor === undefined ? null : cursor };
}

function requireAuthenticatedUserId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw conflictError("AUTH_REQUIRED", "需要登录后访问群功能");
  }
  return value;
}

function validateGroupId(value: unknown): string {
  if (typeof value !== "string" || !isValidUuid(value)) {
    throw validationError("group_id 必须为 UUID v4", { field: "group_id" });
  }
  return value;
}

async function checkGroupRateLimit(input: GroupApiInput, userId: string): Promise<void> {
  await (input.rate_limiter ?? defaultApiRateLimiter).check("groups", userId, input.server_now);
}

async function checkAuthenticatedReadRateLimit(input: GroupApiInput, userId: string): Promise<void> {
  await (input.rate_limiter ?? defaultApiRateLimiter).check(
    "authenticated_reads",
    userId,
    input.server_now,
  );
}

export async function createGroup(
  service: Pick<GroupsService, "createGroup">,
  input: CreateGroupInput,
) {
  const userId = requireAuthenticatedUserId(input.authenticated_user_id);
  await checkGroupRateLimit(input, userId);
  validateCreateGroupBody(input.body);
  const data = await service.createGroup(userId, input.server_now);
  return { status: 201 as const, body: { data, request_id: input.request_id } };
}

export async function joinGroup(
  service: Pick<GroupsService, "joinGroup">,
  input: JoinGroupInput,
) {
  const userId = requireAuthenticatedUserId(input.authenticated_user_id);
  await checkGroupRateLimit(input, userId);
  const body = validateJoinGroupBody(input.body);
  const data = await service.joinGroup(userId, body.invite_code, input.server_now);
  return { status: 200 as const, body: { data, request_id: input.request_id } };
}

export async function leaveGroup(
  service: Pick<GroupsService, "leaveGroup">,
  input: GroupIdInput,
): Promise<{ status: 204 }> {
  const userId = requireAuthenticatedUserId(input.authenticated_user_id);
  await checkGroupRateLimit(input, userId);
  await service.leaveGroup(userId, validateGroupId(input.group_id), input.server_now);
  return { status: 204 };
}

export async function dissolveGroup(
  service: Pick<GroupsService, "dissolveGroup">,
  input: GroupIdInput,
): Promise<{ status: 204 }> {
  const userId = requireAuthenticatedUserId(input.authenticated_user_id);
  await checkGroupRateLimit(input, userId);
  await service.dissolveGroup(userId, validateGroupId(input.group_id), input.server_now);
  return { status: 204 };
}

export async function getMyGroups(
  service: Pick<GroupsService, "listMyGroups">,
  input: GetMyGroupsInput,
) {
  const userId = requireAuthenticatedUserId(input.authenticated_user_id);
  const query = validateMyGroupsQuery(input.query ?? {});
  await checkAuthenticatedReadRateLimit(input, userId);
  const result = await service.listMyGroups(userId, query);
  return {
    status: 200 as const,
    body: {
      data: {
        items: result.items,
        page: { next_cursor: result.next_cursor, has_more: result.has_more },
      },
      request_id: input.request_id,
    },
  };
}

export async function getGroup(
  service: Pick<GroupsService, "getGroup">,
  input: GroupIdInput,
) {
  const userId = requireAuthenticatedUserId(input.authenticated_user_id);
  await checkAuthenticatedReadRateLimit(input, userId);
  const data = await service.getGroup(userId, validateGroupId(input.group_id));
  return { status: 200 as const, body: { data, request_id: input.request_id } };
}
