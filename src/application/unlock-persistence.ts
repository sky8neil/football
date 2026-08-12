/**
 * unlock_v1 持久化切片。
 *
 * 读取用户当前 career_points 与已有解锁，在一个事务中创建尚未授予的解锁。
 * 解锁记录只追加不删除；唯一索引负责持久化层幂等。
 */
import { SCHEMA_VERSION } from "../domain/enums.js";
import { notFoundError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import type { Unlock } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { assertValidServerNow } from "./period-finalize.js";
import { decideUnlockGrants } from "./unlock-decision.js";

export interface UnlockPersistenceOutcome {
  created: Unlock[];
}

export class UnlockPersistenceService {
  constructor(private readonly repo: AppRepository) {}

  async persistForUser(userId: string, serverNow: Date): Promise<UnlockPersistenceOutcome> {
    assertValidServerNow(serverNow);
    return this.repo.withTransaction(async (tx) => {
      const user = await tx.users.findById(userId);
      if (user === null) {
        throw notFoundError("USER");
      }

      const existing = await tx.unlocks.findByUser(userId);
      const existingCodes = new Set(existing.map((unlock) => unlock.unlock_code));
      const grants = decideUnlockGrants(user.career_points, existingCodes);
      const created: Unlock[] = [];

      for (const grant of grants) {
        const unlock: Unlock = {
          schema_version: SCHEMA_VERSION,
          unlock_id: newUuid(),
          user_id: user.user_id,
          unlock_code: grant.unlock_code,
          threshold_points: grant.threshold_points,
          source_version: grant.source_version,
          unlocked_at: serverNow,
        };
        await tx.unlocks.insert(unlock);
        created.push(unlock);
      }

      return { created };
    });
  }
}
