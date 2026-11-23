import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

const presentation = (() => {
  const module = { exports: {} };
  const factory = runInThisContext(
    `(function(module, exports) {\n${readFileSync(join(HERE, "level-presentation.js"), "utf8")}\n})`,
    { filename: join(HERE, "level-presentation.js") },
  );
  factory(module, module.exports);
  return module.exports;
})();

const { buildLevelView } = presentation;

const textOf = (view) => `${view.title} ${view.detail}`;

describe("buildLevelView", () => {
  it("maps max when level is 6 or above", () => {
    const view = buildLevelView({
      level: 6,
      bPoints: 726,
      isRated: true,
      remainingToRated: 0,
      nextThreshold: null,
    });
    expect(view).toEqual({
      state: "max",
      title: "已达最高等级",
      detail: "已达最高等级 · 顶级球星",
      progressPercent: 100,
      showProgress: false,
    });
    expect(textOf(view)).not.toContain("—");
  });

  it("maps unrated before pending when not yet rated", () => {
    const remaining = buildLevelView({
      level: 1,
      bPoints: null,
      isRated: false,
      remainingToRated: 20,
      nextThreshold: 80,
    });
    expect(remaining).toEqual({
      state: "unrated",
      title: "当前为初始等级 Lv.1",
      detail: "还需完成 20 场有效预测，参与首次定级",
      progressPercent: 0,
      showProgress: false,
    });

    const waiting = buildLevelView({
      level: 1,
      bPoints: null,
      isRated: false,
      remainingToRated: 0,
      nextThreshold: 80,
    });
    expect(waiting.state).toBe("unrated");
    expect(waiting.detail).toBe("已达到定级场次，等待每周评估");
    expect(textOf(waiting)).not.toContain("还需 0 场");
  });

  it("maps pending when rated but evaluation points are missing", () => {
    expect(buildLevelView({
      level: 2,
      bPoints: null,
      isRated: true,
      remainingToRated: 0,
      nextThreshold: 80,
    })).toEqual({
      state: "pending",
      title: "等待评估",
      detail: "暂无可用的评估积分，每周一 10:00 评估后更新",
      progressPercent: 0,
      showProgress: false,
    });
  });

  it("maps pending when nextThreshold is null instead of treating null as 0", () => {
    const view = buildLevelView({
      level: 1,
      bPoints: 80,
      isRated: true,
      remainingToRated: 0,
      nextThreshold: null,
    });
    expect(view).toEqual({
      state: "pending",
      title: "等待评估",
      detail: "暂无可用的评估积分，每周一 10:00 评估后更新",
      progressPercent: 0,
      showProgress: false,
    });
    expect(view.progressPercent).not.toBe(100);
    expect(view.state).not.toBe("reached");
  });

  it("maps below when evaluation points are under the next threshold", () => {
    expect(buildLevelView({
      level: 5,
      bPoints: 474,
      isRated: true,
      remainingToRated: 0,
      nextThreshold: 630,
    })).toEqual({
      state: "below",
      title: "评估积分 474 / 630",
      detail: "还差 156 分",
      progressPercent: 75,
      showProgress: true,
    });
  });

  it("maps reached when evaluation points meet the threshold", () => {
    const view = buildLevelView({
      level: 5,
      bPoints: 726,
      isRated: true,
      remainingToRated: 0,
      nextThreshold: 630,
    });
    expect(view).toEqual({
      state: "reached",
      title: "评估积分已达门槛",
      detail: "上次评估积分已达门槛，升级还需满足表现条件，以每周评估结果为准",
      progressPercent: 100,
      showProgress: true,
    });
    expect(textOf(view)).not.toContain("还差 0 分");
  });
});
