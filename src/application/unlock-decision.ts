/**
 * unlock_v1 纯决策切片。
 *
 * 根据当前 career_points 和已存在的 unlock_code 决定需要尝试创建的解锁记录；
 * 不删除历史解锁，也不直接访问 repository。调用方负责在唯一约束下持久化结果。
 */
import { UNLOCK_CONFIG_V1 } from "../domain/config.js";
import { validationError } from "../domain/errors.js";

export interface UnlockGrant {
  unlock_code: string;
  threshold_points: number;
  source_version: string;
}

export function decideUnlockGrants(
  careerPoints: number,
  existingUnlockCodes: ReadonlySet<string>,
): UnlockGrant[] {
  if (!Number.isInteger(careerPoints) || careerPoints < 0) {
    throw validationError("career_points 必须为非负整数", {
      career_points: careerPoints,
    });
  }

  return UNLOCK_CONFIG_V1.thresholds
    .filter(
      (threshold) =>
        careerPoints >= threshold.threshold_points &&
        !existingUnlockCodes.has(threshold.unlock_code),
    )
    .map((threshold) => ({
      unlock_code: threshold.unlock_code,
      threshold_points: threshold.threshold_points,
      source_version: UNLOCK_CONFIG_V1.source_version,
    }));
}
