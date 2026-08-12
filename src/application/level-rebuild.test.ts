import { describe, expect, it } from "vitest";
import { LevelHistoryReason, LevelScope } from "../domain/enums.js";
import { rebuildLevelState } from "./level-rebuild.js";

describe("rebuildLevelState - current/best 等级重建", () => {
  it("career 按统计重算 current_level，best 升到 new", () => {
    const result = rebuildLevelState(LevelScope.Career, 40, 30, 1, 1);
    expect(result.current_level).toBe(3); // 75% 准确率、样本 40 => 3
    expect(result.best_level).toBe(3);
  });

  it("current 可下降（按事实重算），best 只增不减", () => {
    const result = rebuildLevelState(LevelScope.Season, 40, 22, 6, 8);
    expect(result.current_level).toBe(5); // 55% 准确率、样本 40 => 5
    expect(result.best_level).toBe(8);
  });

  it("career 样本 <20 时 current 受样本上限限制为 1", () => {
    const result = rebuildLevelState(LevelScope.Career, 19, 19, 1, 1);
    expect(result.current_level).toBe(1);
    expect(result.should_record_history).toBe(false);
  });
});

describe("rebuildLevelState - level_history 决策", () => {
  it("等级变化时 should_record_history=true 且返回 from/to", () => {
    const result = rebuildLevelState(LevelScope.Season, 40, 28, 5, 5);
    expect(result.should_record_history).toBe(true);
    expect(result.from_level).toBe(5);
    expect(result.to_level).toBe(6);
  });

  it("等级不变时不记录 history，from/to 为 null", () => {
    const result = rebuildLevelState(LevelScope.Season, 40, 28, 6, 6);
    expect(result.should_record_history).toBe(false);
    expect(result.from_level).toBeNull();
    expect(result.to_level).toBeNull();
  });

  it("season_start reason 仅透传，不因 reason 自行创建历史", () => {
    const unchanged = rebuildLevelState(
      LevelScope.Season,
      40,
      28,
      6,
      6,
      LevelHistoryReason.SeasonStart,
    );
    expect(unchanged.should_record_history).toBe(false);
    expect(unchanged.from_level).toBeNull();
    expect(unchanged.to_level).toBeNull();
    expect(unchanged.reason).toBe(LevelHistoryReason.SeasonStart);

    const changed = rebuildLevelState(
      LevelScope.Season,
      40,
      22,
      6,
      6,
      LevelHistoryReason.SeasonStart,
    );
    expect(changed.should_record_history).toBe(true);
    expect(changed.from_level).toBe(6);
    expect(changed.to_level).toBe(5);
    expect(changed.reason).toBe(LevelHistoryReason.SeasonStart);
  });

  it("current 超过 best 时 best 升到 current", () => {
    const result = rebuildLevelState(LevelScope.Season, 40, 28, 4, 4);
    expect(result.current_level).toBe(6);
    expect(result.best_level).toBe(6);
  });
});

describe("rebuildLevelState - 非法输入 fail-closed", () => {
  it("非法统计抛明确错误（负值 / wdl>valid / 非整数）", () => {
    expect(() => rebuildLevelState(LevelScope.Season, -1, 0, 1, 1)).toThrow(
      /非负整数/,
    );
    expect(() => rebuildLevelState(LevelScope.Season, 5, 6, 1, 1)).toThrow(
      /wdl_hits/,
    );
    expect(() => rebuildLevelState(LevelScope.Season, 1.5, 1, 1, 1)).toThrow();
  });

  it("current/best 等级越界或非整数抛错误", () => {
    expect(() => rebuildLevelState(LevelScope.Season, 10, 5, 0, 1)).toThrow();
    expect(() => rebuildLevelState(LevelScope.Season, 10, 5, 9, 1)).toThrow();
    expect(() => rebuildLevelState(LevelScope.Season, 10, 5, 1, 0)).toThrow();
    expect(() => rebuildLevelState(LevelScope.Season, 10, 5, 1, 1.5)).toThrow();
  });

  it("未知 scope 抛错误", () => {
    expect(() =>
      rebuildLevelState("unknown" as LevelScope, 10, 5, 1, 1),
    ).toThrow();
  });
});
