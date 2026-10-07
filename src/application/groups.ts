import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { GroupMemberStatus, GroupStatus, SCHEMA_VERSION, UserStatus } from "../domain/enums.js";
import {
  conflictError,
  groupError,
  internalError,
  validationError,
} from "../domain/errors.js";
import { isValidUuid, newUuid } from "../domain/ids.js";
import type { Group, GroupMember, User } from "../domain/types.js";
import { UniqueConstraintError, type AppRepository, type UnitOfWork } from "../infrastructure/repositories.js";

export interface GroupMutationResult {
  group_id: string;
  invite_code: string;
  owner_user_id: string;
  status: GroupStatus;
  member_count: number;
  created_at: string;
}

export interface GroupJoinResult {
  group_id: string;
  member_count: number;
  joined_at: string;
}

export interface GroupListItem {
  group_id: string;
  display_name: string;
  owner_user_id: string;
  role: "owner" | "member";
  member_count: number;
  status: GroupStatus;
  joined_at: string;
}

export interface GroupDetail extends GroupListItem {
  invite_code: string;
}

export interface MyGroupsQuery {
  limit: number;
  cursor: string | null;
}

export interface MyGroupsResult {
  items: GroupListItem[];
  has_more: boolean;
  next_cursor: string | null;
}

interface MyGroupsCursorPayload {
  version: 1;
  joined_at: string;
  group_id: string;
}

const MY_GROUPS_CURSOR_VERSION = 1 as const;

interface GroupRepositories {
  users: UnitOfWork["users"];
  groups: NonNullable<UnitOfWork["groups"]>;
  groupMembers: NonNullable<UnitOfWork["groupMembers"]>;
}

export interface GroupsServiceOptions {
  inviteCodeFactory?: () => string;
  cursorSecret: string;
}

function isOpaqueCursorShape(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const parts = value.split(".");
  return (
    parts.length === 2 &&
    parts[0]!.length > 0 &&
    parts[1]!.length > 0 &&
    /^[A-Za-z0-9_-]+$/.test(parts[0]!) &&
    /^[A-Za-z0-9_-]+$/.test(parts[1]!)
  );
}

function parseMyGroupsCursor(value: unknown): Omit<MyGroupsCursorPayload, "version"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError("cursor 内容无效", { field: "cursor" });
  }
  const payload = value as Record<string, unknown>;
  if (
    payload.version !== MY_GROUPS_CURSOR_VERSION ||
    typeof payload.joined_at !== "string" ||
    !Number.isFinite(Date.parse(payload.joined_at)) ||
    typeof payload.group_id !== "string" ||
    !isValidUuid(payload.group_id)
  ) {
    throw validationError("cursor 内容无效", { field: "cursor" });
  }
  return {
    joined_at: new Date(payload.joined_at).toISOString(),
    group_id: payload.group_id,
  };
}

export class MyGroupsCursorCodec {
  constructor(private readonly secret: string) {
    if (secret.length === 0) {
      throw new Error("my groups cursor secret must not be empty");
    }
  }

  encode(position: Omit<MyGroupsCursorPayload, "version">): string {
    const payload: MyGroupsCursorPayload = {
      version: MY_GROUPS_CURSOR_VERSION,
      ...position,
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.secret).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  decode(cursor: string): Omit<MyGroupsCursorPayload, "version"> {
    if (!isOpaqueCursorShape(cursor)) {
      throw validationError("cursor 格式无效", { field: "cursor" });
    }
    const [encoded, signature] = cursor.split(".") as [string, string];
    const expected = createHmac("sha256", this.secret).update(encoded).digest("base64url");
    const providedBytes = Buffer.from(signature, "utf8");
    const expectedBytes = Buffer.from(expected, "utf8");
    if (
      providedBytes.length !== expectedBytes.length ||
      !timingSafeEqual(providedBytes, expectedBytes)
    ) {
      throw validationError("cursor 签名无效", { field: "cursor" });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw validationError("cursor 内容无效", { field: "cursor" });
    }
    return parseMyGroupsCursor(parsed);
  }
}

function requireUserId(userId: string): void {
  if (!isValidUuid(userId)) {
    throw validationError("user_id 必须为 UUID v4", { field: "user_id" });
  }
}

function requireGroupId(groupId: string): void {
  if (!isValidUuid(groupId)) {
    throw validationError("group_id 必须为 UUID v4", { field: "group_id" });
  }
}

function requireValidServerNow(serverNow: Date): void {
  if (!(serverNow instanceof Date) || !Number.isFinite(serverNow.getTime())) {
    throw validationError("server_now 必须是有效时间", { field: "server_now" });
  }
}

function requireRepositories(
  repo: Pick<UnitOfWork, "users" | "groups" | "groupMembers">,
): GroupRepositories {
  if (repo.groups === undefined || repo.groupMembers === undefined) {
    throw internalError("groups/group_members repository port 未配置");
  }
  return {
    users: repo.users,
    groups: repo.groups,
    groupMembers: repo.groupMembers,
  };
}

function inviteCode(): string {
  const alphabet = FIXED_CONFIG_V1.GROUP_INVITE_CODE_ALPHABET;
  return Array.from({ length: FIXED_CONFIG_V1.GROUP_INVITE_CODE_LENGTH }, () =>
    alphabet[randomInt(alphabet.length)],
  ).join("");
}

function validateInviteCode(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== FIXED_CONFIG_V1.GROUP_INVITE_CODE_LENGTH ||
    [...value].some((character) => !FIXED_CONFIG_V1.GROUP_INVITE_CODE_ALPHABET.includes(character))
  ) {
    throw validationError("invite_code 格式非法", { field: "invite_code" });
  }
  return value;
}

function requireOwnerUser(user: User | null): User {
  if (user === null) {
    throw internalError("群主用户记录不存在");
  }
  if (user.status === UserStatus.Active && user.nickname === null) {
    throw internalError("active 群主缺少 nickname");
  }
  return user;
}

function displayName(owner: User): string {
  return owner.status === UserStatus.Deleted
    ? "已注销用户的预言群"
    : `${owner.nickname}的预言群`;
}

async function toListItem(
  repos: GroupRepositories,
  group: Group,
  member: GroupMember,
): Promise<GroupListItem> {
  const owner = requireOwnerUser(await repos.users.findById(group.owner_user_id));
  return {
    group_id: group.group_id,
    display_name: displayName(owner),
    owner_user_id: group.owner_user_id,
    role: member.user_id === group.owner_user_id ? "owner" : "member",
    member_count: group.member_count,
    status: group.status,
    joined_at: member.joined_at.toISOString(),
  };
}

function createOwnerMember(group: Group, userId: string, now: Date): GroupMember {
  return {
    group_id: group.group_id,
    user_id: userId,
    status: GroupMemberStatus.Active,
    joined_at: now,
    left_at: null,
    created_at: now,
    updated_at: now,
    schema_version: SCHEMA_VERSION,
  };
}

async function assertJoinLimitNotReached(
  repos: GroupRepositories,
  userId: string,
): Promise<void> {
  const activeMemberships = (await repos.groupMembers.findByUser(userId))
    .filter((member) => member.status === GroupMemberStatus.Active);
  let joinedActiveGroups = 0;
  for (const member of activeMemberships) {
    const group = await repos.groups.findById(member.group_id);
    if (group === null) {
      throw internalError(`active group_member 缺少 group（group_id=${member.group_id}）`);
    }
    if (group.status === GroupStatus.Active) {
      joinedActiveGroups += 1;
    }
  }
  if (joinedActiveGroups >= FIXED_CONFIG_V1.USER_MAX_GROUPS_JOINED) {
    throw groupError("GROUP_JOIN_LIMIT_REACHED", "已达到加入群数量上限");
  }
}

export class GroupsService {
  private readonly inviteCodeFactory: () => string;
  private readonly cursorCodec: MyGroupsCursorCodec;

  constructor(
    private readonly repo: Pick<AppRepository, "users" | "groups" | "groupMembers" | "withTransaction">,
    options: GroupsServiceOptions,
  ) {
    this.inviteCodeFactory = options.inviteCodeFactory ?? inviteCode;
    this.cursorCodec = new MyGroupsCursorCodec(options.cursorSecret);
  }

  async createGroup(userId: string, serverNow: Date): Promise<GroupMutationResult> {
    requireUserId(userId);
    requireValidServerNow(serverNow);
    for (;;) {
      const code = this.inviteCodeFactory();
      try {
        return await this.repo.withTransaction(async (tx) => {
          const repos = requireRepositories(tx);
          if (await repos.users.findById(userId) === null) {
            throw internalError("已认证群主用户记录不存在");
          }
          const owned = (await repos.groups.findByOwner(userId))
            .filter((group) => group.status === GroupStatus.Active);
          if (owned.length >= FIXED_CONFIG_V1.USER_MAX_GROUPS_OWNED) {
            throw groupError("GROUP_OWNED_LIMIT_REACHED", "已达到创建群数量上限");
          }
          await assertJoinLimitNotReached(repos, userId);
          const group: Group = {
            group_id: newUuid(),
            owner_user_id: userId,
            invite_code: code,
            status: GroupStatus.Active,
            member_count: 1,
            created_at: serverNow,
            updated_at: serverNow,
            schema_version: SCHEMA_VERSION,
          };
          await repos.groups.insert(group);
          await repos.groupMembers.insert(createOwnerMember(group, userId, serverNow));
          return {
            group_id: group.group_id,
            invite_code: group.invite_code,
            owner_user_id: group.owner_user_id,
            status: group.status,
            member_count: group.member_count,
            created_at: group.created_at.toISOString(),
          };
        });
      } catch (error) {
        if (
          error instanceof UniqueConstraintError &&
          error.collection === "groups" &&
          error.indexName === "uk_invite_code"
        ) {
          continue;
        }
        throw error;
      }
    }
  }

  async joinGroup(userId: string, inviteCodeValue: unknown, serverNow: Date): Promise<GroupJoinResult> {
    requireUserId(userId);
    requireValidServerNow(serverNow);
    const code = validateInviteCode(inviteCodeValue);
    return this.repo.withTransaction(async (tx) => {
      const repos = requireRepositories(tx);
      const group = await repos.groups.findByInviteCode(code);
      if (group === null) {
        throw groupError("GROUP_NOT_FOUND", "群不存在");
      }
      if (group.status === GroupStatus.Dissolved) {
        throw groupError("GROUP_DISSOLVED", "群已解散");
      }
      const existing = await repos.groupMembers.findByGroupAndUser(group.group_id, userId);
      if (existing?.status === GroupMemberStatus.Active) {
        throw groupError("GROUP_ALREADY_MEMBER", "已经是群成员");
      }
      if (group.member_count >= FIXED_CONFIG_V1.GROUP_MAX_MEMBERS) {
        throw groupError("GROUP_MEMBER_LIMIT_REACHED", "群成员数量已达上限");
      }
      await assertJoinLimitNotReached(repos, userId);
      if (await repos.users.findById(userId) === null) {
        throw conflictError("AUTH_REQUIRED", "需要有效用户身份");
      }
      if (existing === null) {
        await repos.groupMembers.insert(createOwnerMember(group, userId, serverNow));
      } else {
        await repos.groupMembers.update({
          ...existing,
          status: GroupMemberStatus.Active,
          joined_at: serverNow,
          left_at: null,
          updated_at: serverNow,
        });
      }
      const updatedGroup: Group = {
        ...group,
        member_count: group.member_count + 1,
        updated_at: serverNow,
      };
      await repos.groups.update(updatedGroup);
      return {
        group_id: group.group_id,
        member_count: updatedGroup.member_count,
        joined_at: serverNow.toISOString(),
      };
    });
  }

  async leaveGroup(userId: string, groupId: string, serverNow: Date): Promise<void> {
    requireUserId(userId);
    requireGroupId(groupId);
    requireValidServerNow(serverNow);
    await this.repo.withTransaction(async (tx) => {
      const repos = requireRepositories(tx);
      const group = await repos.groups.findById(groupId);
      if (group === null) {
        throw groupError("GROUP_NOT_FOUND", "群不存在");
      }
      if (group.owner_user_id === userId) {
        throw groupError("GROUP_OWNER_CANNOT_LEAVE", "群主只能解散群");
      }
      const member = await repos.groupMembers.findByGroupAndUser(groupId, userId);
      if (member?.status !== GroupMemberStatus.Active) {
        throw groupError("GROUP_NOT_MEMBER", "不是该群 active 成员");
      }
      await repos.groupMembers.update({
        ...member,
        status: GroupMemberStatus.Left,
        left_at: serverNow,
        updated_at: serverNow,
      });
      await repos.groups.update({
        ...group,
        member_count: group.member_count - 1,
        updated_at: serverNow,
      });
    });
  }

  async dissolveGroup(userId: string, groupId: string, serverNow: Date): Promise<void> {
    requireUserId(userId);
    requireGroupId(groupId);
    requireValidServerNow(serverNow);
    await this.repo.withTransaction(async (tx) => {
      const repos = requireRepositories(tx);
      const group = await repos.groups.findById(groupId);
      if (group === null) {
        throw groupError("GROUP_NOT_FOUND", "群不存在");
      }
      if (group.owner_user_id !== userId) {
        throw conflictError("FORBIDDEN", "仅群主可解散群");
      }
      for (const member of await repos.groupMembers.findByGroup(groupId)) {
        if (member.status === GroupMemberStatus.Active) {
          await repos.groupMembers.update({
            ...member,
            status: GroupMemberStatus.Left,
            left_at: serverNow,
            updated_at: serverNow,
          });
        }
      }
      if (group.status !== GroupStatus.Dissolved || group.member_count !== 0) {
        await repos.groups.update({
          ...group,
          status: GroupStatus.Dissolved,
          member_count: 0,
          updated_at: serverNow,
        });
      }
    });
  }

  async listMyGroups(userId: string, query: MyGroupsQuery): Promise<MyGroupsResult> {
    requireUserId(userId);
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > FIXED_CONFIG_V1.API_MAX_LIMIT
    ) {
      throw validationError("limit 必须为 1..100 的整数", { field: "limit" });
    }
    if (query.cursor !== null && !isOpaqueCursorShape(query.cursor)) {
      throw validationError("cursor 格式无效", { field: "cursor" });
    }
    const cursor = query.cursor === null ? null : this.cursorCodec.decode(query.cursor);
    const repos = requireRepositories(this.repo);
    const memberships = (await repos.groupMembers.findByUser(userId))
      .filter((member) => member.status === GroupMemberStatus.Active)
      .sort((a, b) => a.joined_at.getTime() - b.joined_at.getTime() || a.group_id.localeCompare(b.group_id));
    const joined: Array<{ membership: GroupMember; group: Group }> = [];
    for (const membership of memberships) {
      const group = await repos.groups.findById(membership.group_id);
      if (group === null) {
        throw internalError(`active group_member 缺少 group（group_id=${membership.group_id}）`);
      }
      if (group.status !== GroupStatus.Active) {
        continue;
      }
      joined.push({ membership, group });
    }
    const cursorJoinedAt = cursor === null ? null : Date.parse(cursor.joined_at);
    const remaining = cursor === null
      ? joined
      : joined.filter(({ membership }) =>
        membership.joined_at.getTime() > cursorJoinedAt! ||
        membership.joined_at.getTime() === cursorJoinedAt! &&
          membership.group_id > cursor.group_id,
      );
    const page = remaining.slice(0, query.limit);
    const items: GroupListItem[] = [];
    for (const { membership, group } of page) {
      items.push(await toListItem(repos, group, membership));
    }
    const hasMore = remaining.length > query.limit;
    const last = page.at(-1);
    return {
      items,
      has_more: hasMore,
      next_cursor: hasMore && last !== undefined
        ? this.cursorCodec.encode({
            joined_at: last.membership.joined_at.toISOString(),
            group_id: last.membership.group_id,
          })
        : null,
    };
  }

  async getGroup(userId: string, groupId: string): Promise<GroupDetail> {
    requireUserId(userId);
    requireGroupId(groupId);
    const repos = requireRepositories(this.repo);
    const group = await repos.groups.findById(groupId);
    if (group === null) {
      throw groupError("GROUP_NOT_FOUND", "群不存在");
    }
    if (group.status === GroupStatus.Dissolved) {
      throw groupError("GROUP_NOT_FOUND", "群不存在");
    }
    const member = await repos.groupMembers.findByGroupAndUser(groupId, userId);
    if (member?.status !== GroupMemberStatus.Active) {
      throw conflictError("FORBIDDEN", "仅群成员可查看群信息");
    }
    return { ...(await toListItem(repos, group, member)), invite_code: group.invite_code };
  }
}
