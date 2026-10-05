import { describe, expect, it, vi } from "vitest";
import { GroupStatus } from "../../domain/enums.js";
import { conflictError, groupError, validationError } from "../../domain/errors.js";
import type { GroupListItem, GroupMutationResult, MyGroupsResult } from "../../application/groups.js";
import {
  createGroup,
  dissolveGroup,
  getGroup,
  getMyGroups,
  joinGroup,
  leaveGroup,
  validateMyGroupsQuery,
  validateCreateGroupBody,
  validateJoinGroupBody,
} from "./groups.js";
import { InMemoryRateLimiter, RATE_LIMIT_DEFAULTS } from "./rate-limit.js";
import { mapErrorToHttp } from "./validation.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const GROUP_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";

describe("/v1/groups API", () => {
  it("accepts only an empty create object and validates invite-code body", () => {
    expect(validateCreateGroupBody({})).toEqual({});
    expect(() => validateCreateGroupBody({ display_name: "free text" })).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(validateJoinGroupBody({ invite_code: "ABCDEFGH" })).toEqual({ invite_code: "ABCDEFGH" });
    expect(() => validateJoinGroupBody({ invite_code: "bad" })).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });

  it("validates the documented pagination query fields", () => {
    expect(validateMyGroupsQuery({})).toEqual({ limit: 20, cursor: null });
    expect(validateMyGroupsQuery({ limit: "20", cursor: "opaque.signature" })).toEqual({
      limit: 20,
      cursor: "opaque.signature",
    });
    for (const query of [{ extra: "x" }, { limit: "0" }, { limit: "101" }, { cursor: "" }]) {
      expect(() => validateMyGroupsQuery(query)).toThrowError(
        expect.objectContaining({ code: "VALIDATION_ERROR" }),
      );
    }
  });

  it("creates and joins with request envelope and groups rate-limit scope", async () => {
    const service = {
      createGroup: vi.fn(async (_userId: string, _now: Date): Promise<GroupMutationResult> => ({ group_id: GROUP_ID, invite_code: "ABCDEFGH", owner_user_id: USER_ID, status: GroupStatus.Active, member_count: 1, created_at: NOW.toISOString() })),
      joinGroup: vi.fn(async (_userId: string, _inviteCode: unknown, _now: Date) => ({ group_id: GROUP_ID, member_count: 2, joined_at: NOW.toISOString() })),
    };
    const limiter = { check: vi.fn() };
    const created = await createGroup(service, {
      authenticated_user_id: USER_ID, body: {}, server_now: NOW, request_id: "create", rate_limiter: limiter,
    });
    expect(created).toEqual({ status: 201, body: { data: {
      group_id: GROUP_ID, invite_code: "ABCDEFGH", owner_user_id: USER_ID, status: GroupStatus.Active,
      member_count: 1, created_at: NOW.toISOString(),
    }, request_id: "create" } });
    await expect(joinGroup(service, {
      authenticated_user_id: USER_ID, body: { invite_code: "ABCDEFGH" }, server_now: NOW, request_id: "join", rate_limiter: limiter,
    })).resolves.toMatchObject({ status: 200, body: { data: { group_id: GROUP_ID }, request_id: "join" } });
    expect(limiter.check).toHaveBeenCalledWith("groups", USER_ID, NOW);
    expect(RATE_LIMIT_DEFAULTS.groups).toEqual({ max_requests: 10, window_ms: 60_000 });
  });

  it("serves the other four endpoints with their specified success statuses", async () => {
    const service = {
      leaveGroup: vi.fn(async () => undefined),
      dissolveGroup: vi.fn(async () => undefined),
      listMyGroups: vi.fn(async (): Promise<MyGroupsResult> => ({ items: [], has_more: false, next_cursor: null })),
      getGroup: vi.fn(async (): Promise<GroupListItem> => ({
        group_id: GROUP_ID, display_name: "Sky的预言群", owner_user_id: USER_ID, role: "owner",
        member_count: 1, status: GroupStatus.Active, joined_at: NOW.toISOString(),
      })),
    };
    const common = { authenticated_user_id: USER_ID, server_now: NOW, request_id: "r", rate_limiter: new InMemoryRateLimiter() };
    await expect(leaveGroup(service, { ...common, group_id: GROUP_ID })).resolves.toEqual({ status: 204 });
    await expect(dissolveGroup(service, { ...common, group_id: GROUP_ID })).resolves.toEqual({ status: 204 });
    await expect(getMyGroups(service, common)).resolves.toMatchObject({ status: 200, body: { data: { items: [], page: { next_cursor: null, has_more: false } } } });
    await expect(getGroup(service, { ...common, group_id: GROUP_ID })).resolves.toMatchObject({ status: 200, body: { data: { group_id: GROUP_ID } } });
  });

  it("passes limit and cursor through and returns the real page envelope", async () => {
    const item: GroupListItem = {
      group_id: GROUP_ID, display_name: "Sky的预言群", owner_user_id: USER_ID, role: "owner",
      member_count: 1, status: GroupStatus.Active, joined_at: NOW.toISOString(),
    };
    const service = {
      listMyGroups: vi.fn(async (): Promise<MyGroupsResult> => ({
        items: [item], has_more: true, next_cursor: "opaque.signature",
      })),
    };
    const limiter = { check: vi.fn() };
    const response = await getMyGroups(service, {
      authenticated_user_id: USER_ID,
      query: { limit: "1", cursor: "opaque.signature" },
      server_now: NOW,
      request_id: "paged",
      rate_limiter: limiter,
    });
    expect(service.listMyGroups).toHaveBeenCalledWith(USER_ID, {
      limit: 1,
      cursor: "opaque.signature",
    });
    expect(response).toMatchObject({
      status: 200,
      body: {
        data: { items: [item], page: { next_cursor: "opaque.signature", has_more: true } },
      },
    });
  });

  it("requires authentication and applies authenticated-read limit", async () => {
    const service = {
      listMyGroups: vi.fn(async (): Promise<MyGroupsResult> => ({ items: [], has_more: false, next_cursor: null })),
    };
    const limiter = new InMemoryRateLimiter();
    const input = { server_now: NOW, request_id: "auth", rate_limiter: limiter };
    await expect(getMyGroups(service, input)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    const authorized = { ...input, authenticated_user_id: USER_ID };
    for (let n = 0; n < 120; n += 1) await getMyGroups(service, authorized);
    await expect(getMyGroups(service, authorized)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(RATE_LIMIT_DEFAULTS.authenticated_reads).toEqual({ max_requests: 120, window_ms: 60_000 });
  });

  it("routes group detail reads through the authenticated-read bucket", async () => {
    const service = {
      getGroup: vi.fn(async (): Promise<GroupListItem> => ({
        group_id: GROUP_ID, display_name: "Sky的预言群", owner_user_id: USER_ID, role: "owner",
        member_count: 1, status: GroupStatus.Active, joined_at: NOW.toISOString(),
      })),
    };
    const limiter = { check: vi.fn() };
    await getGroup(service, {
      authenticated_user_id: USER_ID, group_id: GROUP_ID, server_now: NOW,
      request_id: "r", rate_limiter: limiter,
    });
    expect(limiter.check).toHaveBeenCalledWith("authenticated_reads", USER_ID, NOW);
  });

  it("maps group, validation, forbidden, and rate-limit errors to their HTTP statuses", () => {
    expect(mapErrorToHttp(validationError("bad"), "request").status).toBe(422);
    expect(mapErrorToHttp(conflictError("FORBIDDEN", "no"), "request").status).toBe(403);
    expect(mapErrorToHttp(groupError("GROUP_NOT_FOUND", "missing"), "request").status).toBe(404);
    expect(mapErrorToHttp(groupError("GROUP_MEMBER_LIMIT_REACHED", "full"), "request").status).toBe(409);
    expect(mapErrorToHttp(conflictError("RATE_LIMITED", "slow"), "request").status).toBe(429);
  });
});
