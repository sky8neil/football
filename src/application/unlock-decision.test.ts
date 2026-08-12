import { describe, expect, it } from "vitest";
import { UNLOCK_CONFIG_V1 } from "../domain/config.js";
import { decideUnlockGrants } from "./unlock-decision.js";

describe("unlock_v1 解锁决策", () => {
  it("未达到第一个阈值时不产生解锁", () => {
    expect(decideUnlockGrants(29, new Set())).toEqual([]);
  });

  it("恰好达到阈值时产生对应解锁", () => {
    expect(decideUnlockGrants(30, new Set())).toEqual([
      {
        unlock_code: "profile_card_style_1",
        threshold_points: 30,
        source_version: "unlock_v1",
      },
    ]);
  });

  it("高积分首次评估按阈值顺序补发所有符合的解锁", () => {
    expect(decideUnlockGrants(200, new Set())).toEqual(
      UNLOCK_CONFIG_V1.thresholds.map((threshold) => ({
        unlock_code: threshold.unlock_code,
        threshold_points: threshold.threshold_points,
        source_version: UNLOCK_CONFIG_V1.source_version,
      })),
    );
  });

  it("已存在的解锁幂等跳过，只返回尚未授予的解锁", () => {
    expect(
      decideUnlockGrants(
        200,
        new Set(["profile_card_style_1", "favorite_team_name_accent"]),
      ),
    ).toEqual([
      {
        unlock_code: "favorite_team_avatar_frame_1",
        threshold_points: 200,
        source_version: "unlock_v1",
      },
    ]);
  });

  it("积分下降不会产生回收动作", () => {
    expect(
      decideUnlockGrants(
        20,
        new Set([
          "profile_card_style_1",
          "favorite_team_name_accent",
          "favorite_team_avatar_frame_1",
        ]),
      ),
    ).toEqual([]);
  });

  it("非法 career_points fail closed", () => {
    expect(() => decideUnlockGrants(-1, new Set())).toThrow(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
    expect(() => decideUnlockGrants(30.5, new Set())).toThrow(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
  });
});
