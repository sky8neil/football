import { UserStatus } from "../domain/enums.js";
import { conflictError, notFoundError, validationError } from "../domain/errors.js";
import { isValidUuid } from "../domain/ids.js";
import type { AppRepository } from "../infrastructure/repositories.js";

export const DEFAULT_RESOURCES = [
  "avatar_frame",
  "profile_card",
  "share_card",
] as const;

export interface UnlockRecordData {
  unlock_id: string;
  unlock_code: string;
  threshold_points: number;
  source_version: string;
  unlocked_at: string;
}

export interface UnlocksData {
  default_resources: string[];
  unlocked: UnlockRecordData[];
}

export class UnlocksQueryService {
  constructor(private readonly repo: Pick<AppRepository, "users" | "unlocks">) {}

  async getUnlocks(userId: string): Promise<UnlocksData> {
    if (!isValidUuid(userId)) {
      throw validationError("user_id 必须为 UUID v4", { field: "user_id" });
    }

    const user = await this.repo.users.findById(userId);
    if (user === null) {
      throw notFoundError("USER");
    }
    if (user.status !== UserStatus.Active) {
      throw conflictError("USER_DELETED", "该账号已被注销");
    }

    const unlocks = await this.repo.unlocks.findByUser(userId);
    return {
      default_resources: [...DEFAULT_RESOURCES],
      unlocked: [...unlocks]
        .sort((a, b) => {
          const thresholdOrder = a.threshold_points - b.threshold_points;
          if (thresholdOrder !== 0) {
            return thresholdOrder;
          }
          return a.unlock_id.localeCompare(b.unlock_id);
        })
        .map((unlock) => ({
          unlock_id: unlock.unlock_id,
          unlock_code: unlock.unlock_code,
          threshold_points: unlock.threshold_points,
          source_version: unlock.source_version,
          unlocked_at: unlock.unlocked_at.toISOString(),
        })),
    };
  }
}
