import { describe, expect, it } from "vitest";
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { GroupMemberStatus, GroupStatus, UserStatus } from "../domain/enums.js";
import type { Group, GroupMember, User } from "../domain/types.js";
import { defaultLevelState } from "../domain/types.js";
import { InMemoryRepository, UniqueConstraintError } from "../infrastructure/repositories.js";
import { GroupsService, MyGroupsCursorCodec } from "./groups.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const CURSOR_SECRET = "test-groups-cursor-secret";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function codeAt(n: number): string {
  let value = n;
  let code = "";
  for (let i = 0; i < FIXED_CONFIG_V1.GROUP_INVITE_CODE_LENGTH; i += 1) {
    code = FIXED_CONFIG_V1.GROUP_INVITE_CODE_ALPHABET[value % FIXED_CONFIG_V1.GROUP_INVITE_CODE_ALPHABET.length]! + code;
    value = Math.floor(value / FIXED_CONFIG_V1.GROUP_INVITE_CODE_ALPHABET.length);
  }
  return code;
}

function makeUser(userId: string, nickname = "Sky", status: User["status"] = UserStatus.Active): User {
  return {
    schema_version: 1, user_id: userId, openid: `openid-${userId}`, unionid: null,
    nickname: status === UserStatus.Deleted ? null : nickname, favorite_team_id: null, status,
    career_points: 0, career_valid_predictions: 0, career_wdl_hits: 0, career_exact_hits: 0,
    career_last_scoring_match_at: null,
    career_level: 1, career_best_level: 1, career_level_state: defaultLevelState(),
    deleted_at: status === UserStatus.Deleted ? NOW : null, created_at: NOW, updated_at: NOW,
  };
}

function makeGroup(ownerUserId: string, groupNo: number, inviteCode = `ABCDEF${String(groupNo).padStart(2, "0")}`): Group {
  return {
    schema_version: 1, group_id: id(100 + groupNo), owner_user_id: ownerUserId,
    invite_code: inviteCode, status: GroupStatus.Active, member_count: 1,
    created_at: NOW, updated_at: NOW,
  };
}

function makeMember(groupId: string, userId: string, status: GroupMember["status"] = GroupMemberStatus.Active, joinedAt: Date = NOW): GroupMember {
  return {
    schema_version: 1, group_id: groupId, user_id: userId, status,
    joined_at: joinedAt, left_at: status === GroupMemberStatus.Left ? NOW : null,
    created_at: NOW, updated_at: NOW,
  };
}

async function seedUser(repo: InMemoryRepository, userId: string, nickname?: string): Promise<void> {
  await repo.users.insert(makeUser(userId, nickname));
}

async function seedOwnedGroup(repo: InMemoryRepository, ownerId: string, n: number, invite?: string): Promise<Group> {
  const group = makeGroup(ownerId, n, invite);
  await repo.groups.insert(group);
  await repo.groupMembers.insert(makeMember(group.group_id, ownerId));
  return group;
}

describe("GroupsService", () => {
  it("creates a group with an atomic unique invite code and active owner membership", async () => {
    const repo = new InMemoryRepository();
    await seedUser(repo, id(1), "Sky");
    await seedOwnedGroup(repo, id(2), 1, "ABCDEFGH");
    const inviteCodes = ["ABCDEFGH", "JKLMNPQR"];
    const service = new GroupsService(repo, { inviteCodeFactory: () => inviteCodes.shift()!, cursorSecret: CURSOR_SECRET });

    const result = await service.createGroup(id(1), NOW);

    expect(result.invite_code).toBe("JKLMNPQR");
    expect(result.member_count).toBe(1);
    expect(await repo.groups.findByInviteCode("JKLMNPQR")).toMatchObject({ owner_user_id: id(1) });
    expect((await repo.groupMembers.findByUser(id(1))).map((member) => member.status)).toEqual(["active"]);
  });

  it("returns the dissolved owner's display-name fallback and enforces the owned-group limit", async () => {
    const repo = new InMemoryRepository();
    await seedUser(repo, id(1), "Sky");
    for (let n = 1; n <= 5; n += 1) await seedOwnedGroup(repo, id(1), n);
    await expect(new GroupsService(repo, { cursorSecret: CURSOR_SECRET }).createGroup(id(1), NOW)).rejects.toMatchObject({ code: "GROUP_OWNED_LIMIT_REACHED" });

    const deletedOwner = makeUser(id(2), "", UserStatus.Deleted);
    await repo.users.insert(deletedOwner);
    const group = await seedOwnedGroup(repo, id(2), 6);
    const item = await new GroupsService(repo, { cursorSecret: CURSOR_SECRET }).getGroup(id(2), group.group_id);
    expect(item.display_name).toBe("已注销用户的预言群");
  });

  it("only active owned groups consume the owned limit", async () => {
    const repo = new InMemoryRepository();
    await seedUser(repo, id(1));
    for (let n = 1; n <= 5; n += 1) {
      const group = await seedOwnedGroup(repo, id(1), n);
      await repo.groups.update({ ...group, status: GroupStatus.Dissolved });
    }

    await expect(new GroupsService(repo, { cursorSecret: CURSOR_SECRET }).createGroup(id(1), NOW)).resolves.toMatchObject({
      owner_user_id: id(1),
      status: GroupStatus.Active,
    });
  });

  it("counts the owner against the active joined-group limit when creating", async () => {
    const repo = new InMemoryRepository();
    await seedUser(repo, id(1));
    for (let n = 1; n <= 20; n += 1) {
      const group = makeGroup(id(n + 100), n, `H${String(n).padStart(7, "0")}`);
      await repo.groups.insert(group);
      await repo.groupMembers.insert(makeMember(group.group_id, id(1)));
    }

    await expect(new GroupsService(repo, { cursorSecret: CURSOR_SECRET }).createGroup(id(1), NOW)).rejects.toMatchObject({
      code: "GROUP_JOIN_LIMIT_REACHED",
    });
  });

  it("join follows all six validation decisions in documented order", async () => {
    const repo = new InMemoryRepository();
    const service = new GroupsService(repo, { cursorSecret: CURSOR_SECRET });
    await seedUser(repo, id(1));
    await seedUser(repo, id(5));

    await expect(service.joinGroup(id(1), "bad", NOW)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.joinGroup(id(1), "ABCDEFGH", NOW)).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });

    const dissolved = makeGroup(id(2), 1, "BCDEFGHJ");
    await seedUser(repo, id(2));
    await repo.groups.insert({ ...dissolved, status: GroupStatus.Dissolved, member_count: 500 });
    await repo.groupMembers.insert(makeMember(dissolved.group_id, id(1)));
    await expect(service.joinGroup(id(1), dissolved.invite_code, NOW)).rejects.toMatchObject({ code: "GROUP_DISSOLVED" });

    const alreadyMember = await seedOwnedGroup(repo, id(1), 2, "CDEFGHJK");
    await repo.groups.update({ ...alreadyMember, member_count: 500 });
    for (let n = 10; n < 30; n += 1) {
      const other = makeGroup(id(n), n, `D${String(n).padStart(7, "0")}`);
      await repo.groups.insert(other);
      await repo.groupMembers.insert(makeMember(other.group_id, id(1)));
      await repo.groupMembers.insert(makeMember(other.group_id, id(5)));
    }
    await expect(service.joinGroup(id(1), alreadyMember.invite_code, NOW)).rejects.toMatchObject({ code: "GROUP_ALREADY_MEMBER" });

    const full = makeGroup(id(3), 3, "EFGHJKLM");
    await seedUser(repo, id(3));
    await repo.groups.insert({ ...full, member_count: 500 });
    await expect(service.joinGroup(id(1), full.invite_code, NOW)).rejects.toMatchObject({ code: "GROUP_MEMBER_LIMIT_REACHED" });

    const joinLimit = makeGroup(id(4), 4, "FGHJKLMN");
    await seedUser(repo, id(4));
    await repo.groups.insert(joinLimit);
    await expect(service.joinGroup(id(5), joinLimit.invite_code, NOW)).rejects.toMatchObject({ code: "GROUP_JOIN_LIMIT_REACHED" });
  });

  it("allows a member to leave, rejects owner leave, and dissolves only for owner", async () => {
    const repo = new InMemoryRepository();
    await seedUser(repo, id(1));
    const group = await seedOwnedGroup(repo, id(1), 1, "GJKLMNPQ");
    const service = new GroupsService(repo, { cursorSecret: CURSOR_SECRET });
    await seedUser(repo, id(3));
    await expect(service.joinGroup(id(3), group.invite_code, NOW)).resolves.toMatchObject({
      group_id: group.group_id, member_count: 2, joined_at: NOW.toISOString(),
    });

    await expect(service.leaveGroup(id(1), group.group_id, NOW)).rejects.toMatchObject({ code: "GROUP_OWNER_CANNOT_LEAVE" });
    await expect(service.leaveGroup(id(4), group.group_id, NOW)).rejects.toMatchObject({ code: "GROUP_NOT_MEMBER" });
    await service.leaveGroup(id(3), group.group_id, NOW);
    expect(await repo.groupMembers.findByGroupAndUser(group.group_id, id(3))).toMatchObject({ status: "left", left_at: NOW });
    expect((await repo.groups.findById(group.group_id))?.member_count).toBe(1);
    await expect(service.dissolveGroup(id(3), group.group_id, NOW)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await service.dissolveGroup(id(1), group.group_id, NOW);
    expect((await repo.groups.findById(group.group_id))?.status).toBe("dissolved");
  });

  it("lists only active memberships and only exposes a group to its active members", async () => {
    const repo = new InMemoryRepository();
    await seedUser(repo, id(1), "Owner");
    await seedUser(repo, id(2), "Member");
    const group = await seedOwnedGroup(repo, id(1), 1, "HJKLMNPQ");
    await repo.groupMembers.insert(makeMember(group.group_id, id(2)));
    await repo.groups.update({ ...group, member_count: 2 });
    const service = new GroupsService(repo, { cursorSecret: CURSOR_SECRET });

    expect(await service.listMyGroups(id(2), { limit: 20, cursor: null })).toEqual({
      items: [expect.objectContaining({
        group_id: group.group_id, display_name: "Owner的预言群", role: "member", member_count: 2, joined_at: NOW.toISOString(),
      })],
      has_more: false,
      next_cursor: null,
    });
    await expect(service.getGroup(id(3), group.group_id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.getGroup(id(2), id(999))).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });
  });

  it("dissolve terminates every active membership and resets member_count", async () => {
    const repo = new InMemoryRepository();
    await seedUser(repo, id(1), "Owner");
    await seedUser(repo, id(2), "Member");
    const group = await seedOwnedGroup(repo, id(1), 1, "GJKLMNPQ");
    await repo.groupMembers.insert(makeMember(group.group_id, id(2)));
    await repo.groups.update({ ...group, member_count: 2 });
    const service = new GroupsService(repo, { cursorSecret: CURSOR_SECRET });

    await service.dissolveGroup(id(1), group.group_id, NOW);

    const members = await repo.groupMembers.findByGroup(group.group_id);
    expect(members).toHaveLength(2);
    expect(members.every((member) => member.status === GroupMemberStatus.Left)).toBe(true);
    expect(members.every((member) => member.left_at?.getTime() === NOW.getTime())).toBe(true);
    expect(await repo.groups.findById(group.group_id)).toMatchObject({
      status: GroupStatus.Dissolved,
      member_count: 0,
    });
  });

  it("reclaims the join quota across repeated create-dissolve rounds", async () => {
    const repo = new InMemoryRepository();
    await seedUser(repo, id(1));
    let codeCounter = 0;
    const service = new GroupsService(repo, {
      cursorSecret: CURSOR_SECRET,
      inviteCodeFactory: () => codeAt((codeCounter += 1)),
    });

    for (let round = 0; round < 4; round += 1) {
      const created: Group[] = [];
      for (let n = 0; n < FIXED_CONFIG_V1.USER_MAX_GROUPS_OWNED; n += 1) {
        const result = await service.createGroup(id(1), NOW);
        created.push((await repo.groups.findById(result.group_id))!);
      }
      for (const group of created) {
        await service.dissolveGroup(id(1), group.group_id, NOW);
      }
    }

    await expect(service.createGroup(id(1), NOW)).resolves.toMatchObject({ owner_user_id: id(1) });
    expect((await repo.groups.findByOwner(id(1))).filter((group) => group.status === GroupStatus.Active)).toHaveLength(1);
    expect((await repo.groupMembers.findByUser(id(1))).filter((member) => member.status === GroupMemberStatus.Active)).toHaveLength(1);
  });

  it("ignores dissolved-group memberships for the join limit and list", async () => {
    const repo = new InMemoryRepository();
    await seedUser(repo, id(1));
    await seedUser(repo, id(2));
    for (let n = 1; n <= 20; n += 1) {
      const group = makeGroup(id(n + 100), n, `H${String(n).padStart(7, "0")}`);
      await repo.groups.insert({ ...group, status: GroupStatus.Dissolved, member_count: 0 });
      await repo.groupMembers.insert(makeMember(group.group_id, id(1)));
    }
    const service = new GroupsService(repo, { cursorSecret: CURSOR_SECRET });

    expect((await service.listMyGroups(id(1), { limit: 20, cursor: null })).items).toEqual([]);
    await expect(service.createGroup(id(1), NOW)).resolves.toMatchObject({ owner_user_id: id(1) });
  });

  it("paginates active memberships by joined_at and group_id with signed cursors", async () => {
    const repo = new InMemoryRepository();
    await seedUser(repo, id(1), "Owner");
    await seedUser(repo, id(2), "Member");
    const service = new GroupsService(repo, { cursorSecret: CURSOR_SECRET });
    const base = Date.parse("2026-08-01T00:00:00.000Z");
    for (let n = 1; n <= 5; n += 1) {
      const group = makeGroup(id(1), n, `H${String(n).padStart(7, "0")}`);
      await repo.groups.insert(group);
      await repo.groupMembers.insert(makeMember(group.group_id, id(2), GroupMemberStatus.Active, new Date(base + n * 1000)));
    }

    const first = await service.listMyGroups(id(2), { limit: 2, cursor: null });
    expect(first.items.map((item) => item.group_id)).toEqual([id(101), id(102)]);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).not.toBeNull();

    const second = await service.listMyGroups(id(2), { limit: 2, cursor: first.next_cursor });
    expect(second.items.map((item) => item.group_id)).toEqual([id(103), id(104)]);
    expect(second.has_more).toBe(true);

    const third = await service.listMyGroups(id(2), { limit: 2, cursor: second.next_cursor });
    expect(third.items.map((item) => item.group_id)).toEqual([id(105)]);
    expect(third.has_more).toBe(false);
    expect(third.next_cursor).toBeNull();

    const exact = await service.listMyGroups(id(2), { limit: 5, cursor: null });
    expect(exact.items).toHaveLength(5);
    expect(exact.has_more).toBe(false);
    expect(exact.next_cursor).toBeNull();
  });

  it("rejects malformed, tampered, and out-of-range pagination inputs", async () => {
    const repo = new InMemoryRepository();
    await seedUser(repo, id(1));
    const service = new GroupsService(repo, { cursorSecret: CURSOR_SECRET });

    await expect(service.listMyGroups(id(1), { limit: 0, cursor: null }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.listMyGroups(id(1), { limit: 20, cursor: "not-a-cursor" }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const codec = new MyGroupsCursorCodec(CURSOR_SECRET);
    const valid = codec.encode({ joined_at: NOW.toISOString(), group_id: id(101) });
    const tampered = `${valid.slice(0, -1)}${valid.endsWith("A") ? "B" : "A"}`;
    await expect(service.listMyGroups(id(1), { limit: 20, cursor: tampered }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("unique invite collision is atomic and does not leak a partial group on retry", async () => {
    const repo = new InMemoryRepository();
    await seedUser(repo, id(1));
    await seedOwnedGroup(repo, id(2), 1, "NPQRSTUV");
    const service = new GroupsService(repo, { cursorSecret: CURSOR_SECRET, inviteCodeFactory: (() => {
      const codes = ["NPQRSTUV", "23456789"];
      return () => codes.shift()!;
    })() });

    const created = await service.createGroup(id(1), NOW);
    expect(created.invite_code).toBe("23456789");
    expect(await repo.groups.findByInviteCode("NPQRSTUV")).toMatchObject({ owner_user_id: id(2) });
    expect(await repo.groupMembers.findByGroup(created.group_id)).toHaveLength(1);
  });

  it("repository transaction rollback restores both group indexes and membership reads", async () => {
    const repo = new InMemoryRepository();
    const group = makeGroup(id(1), 7, "QRSTUVWX");
    await expect(repo.withTransaction(async (tx) => {
      await tx.groups!.insert(group);
      await tx.groupMembers!.insert(makeMember(group.group_id, id(1)));
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await repo.groups.findById(group.group_id)).toBeNull();
    expect(await repo.groups.findByInviteCode(group.invite_code)).toBeNull();
    expect(await repo.groupMembers.findByGroup(group.group_id)).toEqual([]);
  });

  it("surfaces invite-code uniqueness at insert rather than relying on prior lookup", async () => {
    const repo = new InMemoryRepository();
    const group = makeGroup(id(1), 8, "23456789");
    await repo.groups.insert(group);
    await expect(repo.groups.insert({ ...group, group_id: id(2) })).rejects.toBeInstanceOf(UniqueConstraintError);
  });
});
