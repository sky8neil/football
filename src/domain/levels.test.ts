import { describe, expect, it } from "vitest";
import {
  calculateLevel,
  nextBestLevel,
  sampleSizeLevel,
  shouldRecordLevelChange,
  theoreticalAccuracyLevel,
} from "./levels.js";
import { LevelScope } from "./enums.js";

describe("L. 等级（规范 44-L）", () => {
  it("L92 season <10 场永远最高 level1", () => {
    expect(calculateLevel(LevelScope.Season, 9, 9)).toBe(1);
    expect(calculateLevel(LevelScope.Season, 0, 0)).toBe(1);
  });

  it("L93 season 10~14 样本上限 level2", () => {
    expect(calculateLevel(LevelScope.Season, 10, 5)).toBe(2);
    expect(calculateLevel(LevelScope.Season, 14, 14)).toBe(2);
    expect(sampleSizeLevel(LevelScope.Season, 14)).toBe(2);
  });

  it("L94 career <20 最高 level1", () => {
    expect(calculateLevel(LevelScope.Career, 19, 19)).toBe(1);
    expect(sampleSizeLevel(LevelScope.Career, 19)).toBe(1);
  });

  it("L95 60% 真实准确率正确进入理论 level6", () => {
    expect(theoreticalAccuracyLevel(10, 6)).toBe(6);
    // season 样本 40 场时样本上限为 6，最终 6
    expect(calculateLevel(LevelScope.Season, 40, 24)).toBe(6);
  });

  it("L96 59.96% 显示可为 60.0%，但业务仍按 <60%", () => {
    // 1499/2500 = 59.96%，显示 60.0%
    expect(Number((1499 / 2500) * 100).toFixed(1)).toBe("60.0");
    expect(theoreticalAccuracyLevel(2500, 1499)).toBe(5);
    // 交叉乘法确认未达 60%
    expect(1499 * 100).toBeLessThan(2500 * 60);
  });

  it("L97 current level correction 后可下降（按事实重算）", () => {
    const before = calculateLevel(LevelScope.Season, 40, 28); // 70% => level6
    const after = calculateLevel(LevelScope.Season, 40, 22); // 55% => level5
    expect(before).toBe(6);
    expect(after).toBe(5);
    expect(after).toBeLessThan(before);
  });

  it("L98 best_level 只增不减", () => {
    expect(nextBestLevel(1, 3)).toBe(3);
    expect(nextBestLevel(3, 2)).toBe(3);
    expect(nextBestLevel(5, 5)).toBe(5);
  });

  it("L99 level 不变化时不写 level_history", () => {
    expect(shouldRecordLevelChange(3, 3)).toBe(false);
    expect(shouldRecordLevelChange(3, 4)).toBe(true);
  });

  it("17.2 准确率阈值分档", () => {
    expect(theoreticalAccuracyLevel(10, 4)).toBe(2); // 40%
    expect(theoreticalAccuracyLevel(10, 5)).toBe(4); // 50%
    expect(theoreticalAccuracyLevel(10, 6)).toBe(6); // 60%
    expect(theoreticalAccuracyLevel(10, 7)).toBe(8); // 70%
    expect(theoreticalAccuracyLevel(10, 8)).toBe(8); // 80%
  });

  it("17.5 final = min(accuracy, sample)", () => {
    // 生涯：100% 准确率但样本 30 => 样本上限 2，最终 2
    expect(calculateLevel(LevelScope.Career, 30, 30)).toBe(2);
  });

  it("非法统计失败关闭", () => {
    expect(() => calculateLevel(LevelScope.Season, -1, 0)).toThrow();
    expect(() => calculateLevel(LevelScope.Season, 5, 6)).toThrow();
  });
});
