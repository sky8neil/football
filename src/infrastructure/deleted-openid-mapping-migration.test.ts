import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, UserStatus } from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { DeletedOpenidMapping, User } from "../domain/types.js";
import { InMemoryRepository } from "./repositories.js";
import {
  migrateDeletedOpenidMappings,
  rollbackDeletedOpenidMappings,
} from "./deleted-openid-mapping-migration.js";

const NOW = new Date("2026-08-14T00:00:00.000Z");

function makeUser(overrides: Partial<User> = {}): User {
  return {
    schema_version: SCHEMA_VERSION,
    user_id: newUuid(),
    openid: `openid_${newUuid()}`,
    unionid: "unionid-x",
    nickname: "Old",
    favorite_team_id: null,
    status: "active",
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_level: 1,
    career_best_level: 1,
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  } as User;
}

function makeMapping(overrides: Partial<DeletedOpenidMapping> = {}): DeletedOpenidMapping {
  return {
    schema_version: SCHEMA_VERSION,
    original_openid: `openid_${newUuid()}`,
    deleted_user_id: newUuid(),
    deleted_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  } as DeletedOpenidMapping;
}

describe("migrateDeletedOpenidMappings（D-P1 §6.10 M3）", () => {
  it("D10：脏 deleted（openid 仍为原微信 openid）→ 写 mapping + 墓碑 + 清 PII，resolver 仍 deleted", async () => {
    const repo = new InMemoryRepository();
    const openid = "openid-dirty-migrate";
    const user = makeUser({ openid, status: "deleted", deleted_at: NOW, nickname: "Old" });
    await repo.users.insert(user);

    const result = await migrateDeletedOpenidMappings(repo, NOW);
    expect(result.migrated).toBe(1);
    expect(result.unmigrated).toBe(0);

    const stored = await repo.users.findById(user.user_id);
    expect(stored).toMatchObject({
      openid: `deleted:${user.user_id}`,
      unionid: null,
      nickname: null,
      status: UserStatus.Deleted,
    });
    const mapping = await repo.deletedOpenidMappings.findByOriginalOpenid(openid);
    expect(mapping).toMatchObject({
      original_openid: openid,
      deleted_user_id: user.user_id,
      deleted_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    });
  });

  it("D11：已墓碑且无 mapping 的 deleted 用户 → 跳过并记录 unmigrated（SPEC_GAP）", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({
      status: "deleted",
      deleted_at: NOW,
      nickname: null,
    });
    user.openid = `deleted:${user.user_id}`;
    await repo.users.insert(user);

    const result = await migrateDeletedOpenidMappings(repo, NOW);
    expect(result.migrated).toBe(0);
    expect(result.unmigrated).toBe(1);
    expect(result.unmigrated_user_ids).toEqual([user.user_id]);
    expect(await repo.deletedOpenidMappings.findByDeletedUserId(user.user_id)).toBeNull();
  });

  it("active 用户不受迁移影响", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({ openid: "openid-active-stay" });
    await repo.users.insert(user);

    const result = await migrateDeletedOpenidMappings(repo, NOW);
    expect(result.migrated).toBe(0);
    expect(result.unmigrated).toBe(0);
    expect(await repo.users.findById(user.user_id)).toMatchObject({
      openid: "openid-active-stay",
      status: UserStatus.Active,
    });
  });
});

describe("rollbackDeletedOpenidMappings（§6.10 down-migration）", () => {
  it("无 active 占用 original_openid 时把墓碑 openid 写回原 openid", async () => {
    const repo = new InMemoryRepository();
    const openid = "openid-rollback";
    const user = makeUser({
      status: "deleted",
      deleted_at: NOW,
      nickname: null,
    });
    user.openid = `deleted:${user.user_id}`;
    await repo.users.insert(user);
    const mapping = makeMapping({ original_openid: openid, deleted_user_id: user.user_id });
    await repo.deletedOpenidMappings.upsert(mapping);

    const result = await rollbackDeletedOpenidMappings(repo, [mapping], NOW);
    expect(result.restored).toBe(1);
    expect(result.skipped).toBe(0);
    expect(await repo.users.findById(user.user_id)).toMatchObject({
      openid: openid,
      status: UserStatus.Deleted,
    });
  });

  it("已有 active 占用 original_openid 时禁止写回（保护 uk_openid / 隔离）", async () => {
    const repo = new InMemoryRepository();
    const openid = "openid-rollback-active";
    const oldUser = makeUser({
      status: "deleted",
      deleted_at: NOW,
      nickname: null,
    });
    oldUser.openid = `deleted:${oldUser.user_id}`;
    await repo.users.insert(oldUser);
    await repo.users.insert(makeUser({ openid }));
    const mapping = makeMapping({ original_openid: openid, deleted_user_id: oldUser.user_id });
    await repo.deletedOpenidMappings.upsert(mapping);

    const result = await rollbackDeletedOpenidMappings(repo, [mapping], NOW);
    expect(result.restored).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await repo.users.findById(oldUser.user_id)).toMatchObject({
      openid: `deleted:${oldUser.user_id}`,
      status: UserStatus.Deleted,
    });
  });

  it("mapping 指向 active 用户或已恢复用户时跳过", async () => {
    const repo = new InMemoryRepository();
    const activeUser = makeUser({ openid: "openid-active-now" });
    await repo.users.insert(activeUser);
    const mapping = makeMapping({
      original_openid: "openid-rollback-active-user",
      deleted_user_id: activeUser.user_id,
    });
    await repo.deletedOpenidMappings.upsert(mapping);

    const result = await rollbackDeletedOpenidMappings(repo, [mapping], NOW);
    expect(result.restored).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await repo.users.findById(activeUser.user_id)).toMatchObject({
      openid: "openid-active-now",
      status: UserStatus.Active,
    });
  });
});
