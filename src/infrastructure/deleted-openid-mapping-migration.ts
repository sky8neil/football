/**
 * D-P1 方案 B 数据迁移（开发文档 §6.10）。
 *
 * M3（前向迁移）：把「脏 deleted 用户（users.openid 仍为原微信 openid）」改写为
 * 墓碑 openid + 写入 deleted_openid_mappings，保证 resolver 迁移后仍识别为 deleted。
 * 已墓碑（openid = "deleted:<user_id>"）且无 mapping 的历史用户无法重建原 openid，
 * 记录 unmigrated（SPEC_GAP：此类用户会表现为 unregistered，可重注册新用户）。
 *
 * down-migration（回滚）：仅当 mapping.deleted_user_id 对应 users 行仍为墓碑 deleted
 * 且 original_openid 未被 active 用户占用时，把墓碑 openid 写回原 openid；
 * 否则跳过（保护 uk_openid / 新老账号隔离）。
 */
import { SCHEMA_VERSION, UserStatus } from "../domain/enums.js";
import { assertValidServerNow } from "../application/period-finalize.js";
import type { DeletedOpenidMapping } from "../domain/types.js";
import type { AppRepository } from "./repositories.js";

export interface DeletedOpenidMappingMigrationResult {
  migrated: number;
  unmigrated: number;
  /** 已墓碑但无 mapping、无法重建原 openid 的 user_id（SPEC_GAP 可观测性）。 */
  unmigrated_user_ids: string[];
}

export interface DeletedOpenidMappingRollbackResult {
  restored: number;
  skipped: number;
}

function isTombstonedOpenid(openid: string, userId: string): boolean {
  return openid === `deleted:${userId}`;
}

/** M3：一次性前向迁移。事务内原子执行；失败回滚不残留 mapping。 */
export async function migrateDeletedOpenidMappings(
  repo: AppRepository,
  serverNow: Date,
): Promise<DeletedOpenidMappingMigrationResult> {
  assertValidServerNow(serverNow);
  return repo.withTransaction(async (tx) => {
    const users = await tx.users.findAll();
    const result: DeletedOpenidMappingMigrationResult = {
      migrated: 0,
      unmigrated: 0,
      unmigrated_user_ids: [],
    };

    for (const user of users) {
      if (user.status !== UserStatus.Deleted) {
        continue;
      }
      if (isTombstonedOpenid(user.openid, user.user_id)) {
        // 原 openid 已不可恢复；不写 mapping（SPEC_GAP），记录审计。
        result.unmigrated += 1;
        result.unmigrated_user_ids.push(user.user_id);
        continue;
      }
      // 脏/旧形态：openid 仍是微信身份 → mapping + 墓碑 + 清 PII。
      await tx.deletedOpenidMappings.upsert({
        schema_version: SCHEMA_VERSION,
        original_openid: user.openid,
        deleted_user_id: user.user_id,
        deleted_at: user.deleted_at ?? serverNow,
        created_at: serverNow,
        updated_at: serverNow,
      });
      await tx.users.update({
        ...user,
        openid: `deleted:${user.user_id}`,
        unionid: null,
        nickname: null,
        favorite_team_id: null,
        updated_at: serverNow,
      });
      result.migrated += 1;
    }
    return result;
  });
}

/**
 * down-migration：把 mapping 写回 users 主记录（仅旧代码依赖 users.openid 识别 deleted 时）。
 * 若 original_openid 已被 active 占用，禁止写回（会破坏 uk_openid / 隔离）。
 */
export async function rollbackDeletedOpenidMappings(
  repo: AppRepository,
  mappings: readonly DeletedOpenidMapping[],
  serverNow: Date,
): Promise<DeletedOpenidMappingRollbackResult> {
  assertValidServerNow(serverNow);
  return repo.withTransaction(async (tx) => {
    const result: DeletedOpenidMappingRollbackResult = { restored: 0, skipped: 0 };
    for (const mapping of mappings) {
      const user = await tx.users.findById(mapping.deleted_user_id);
      if (
        user === null ||
        user.status !== UserStatus.Deleted ||
        !isTombstonedOpenid(user.openid, user.user_id)
      ) {
        // 用户不存在、已非 deleted、或已恢复：无需写回。
        result.skipped += 1;
        continue;
      }
      const activeOwner = await tx.users.findByOpenid(mapping.original_openid);
      if (activeOwner !== null) {
        // 已有新 active 占用该 openid：禁止写回，保持墓碑 + mapping（已知限制）。
        result.skipped += 1;
        continue;
      }
      await tx.users.update({
        ...user,
        openid: mapping.original_openid,
        updated_at: serverNow,
      });
      result.restored += 1;
    }
    return result;
  });
}
