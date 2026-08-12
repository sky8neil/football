/**
 * 等级纯重建函数（阶段 5 切片 H）。
 *
 * 从已重建统计（见 stats-rebuild.ts）重算 current_level 与 best_level，
 * 并给出 level_history 写入决策。本模块不访问 repository / 数据库，也不
 * 自行创建 level_history 记录：仅返回 should_record_history、from/to 与
 * reason，由调用方负责落库。
 *
 * 规则（规范 17.x）：
 * - current_level = calculate_level(scope, valid_predictions, wdl_hits)，可升可降。
 * - best_level 只增不减（17.6）。
 * - 仅当 from_level != to_level 才写 level_history（17.7）。
 * - reason 仅作为输入/输出透传（如 season_start），不参与是否记录决策。
 */
import { LevelScope, type LevelHistoryReason } from "../domain/enums.js";
import { validationError } from "../domain/errors.js";
import {
  calculateLevel,
  LEVEL_MAX,
  LEVEL_MIN,
  nextBestLevel,
  shouldRecordLevelChange,
} from "../domain/levels.js";

export interface RebuiltLevelState {
  current_level: number;
  best_level: number;
  should_record_history: boolean;
  from_level: number | null;
  to_level: number | null;
  reason: LevelHistoryReason;
}

function assertStoredLevel(field: string, value: number): void {
  if (
    !Number.isInteger(value) ||
    value < LEVEL_MIN ||
    value > LEVEL_MAX
  ) {
    throw validationError(`${field} 必须是 ${LEVEL_MIN}..${LEVEL_MAX} 的整数`, {
      [field]: value,
    });
  }
}

/**
 * 重算用户等级。reason 透传返回（默认 rebuild），仅在等级变化时由调用方
 * 用于写入 level_history；本函数不自行创建任何历史记录。
 */
export function rebuildLevelState(
  scope: LevelScope,
  validPredictions: number,
  wdlHits: number,
  currentLevel: number,
  bestLevel: number,
  reason: LevelHistoryReason = "rebuild",
): RebuiltLevelState {
  assertStoredLevel("current_level", currentLevel);
  assertStoredLevel("best_level", bestLevel);

  const newLevel = calculateLevel(scope, validPredictions, wdlHits);
  const newBestLevel = nextBestLevel(bestLevel, newLevel);
  const record = shouldRecordLevelChange(currentLevel, newLevel);

  return {
    current_level: newLevel,
    best_level: newBestLevel,
    should_record_history: record,
    from_level: record ? currentLevel : null,
    to_level: record ? newLevel : null,
    reason,
  };
}
