import { describe, expect, it } from "vitest";
import { MatchStatus, ResultSource, SettlementStatus } from "../domain/enums.js";
import {
  ResultCorrectionCode,
  nextSettlementVersion,
  planResultCorrection,
} from "./result-correction-plan.js";

const FINISHED = MatchStatus.Finished;
const WAITING = SettlementStatus.Waiting;
const PROVIDER = ResultSource.Provider;
const ADMIN = ResultSource.Admin;

function makePlanInput(
  overrides: Partial<{
    currentResultVersion: number;
    currentHome: number | null;
    currentAway: number | null;
    nextHome: number;
    nextAway: number;
    matchStatus: string;
    settlementStatus: string;
    source: ResultSource;
    settledResultVersion: number;
  }> = {},
) {
  return {
    currentResultVersion: 0,
    currentHome: null,
    currentAway: null,
    nextHome: 2,
    nextAway: 1,
    matchStatus: FINISHED,
    settlementStatus: WAITING,
    source: PROVIDER,
    settledResultVersion: 0,
    ...overrides,
  };
}

function plan(input = makePlanInput()) {
  return planResultCorrection(
    input.currentResultVersion,
    input.currentHome,
    input.currentAway,
    input.nextHome,
    input.nextAway,
    input.matchStatus,
    input.settlementStatus,
    input.source,
    input.settledResultVersion,
  );
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

describe("planResultCorrection - 赛果修正版本计划", () => {
  it("首次结果 v0 -> v1：无当前比分，is_correction=false，无需修正结算", () => {
    expect(plan()).toEqual({
      next_result_version: 1,
      is_correction: false,
      needs_correction_settlement: false,
      source: PROVIDER,
    });
  });

  it("provider 来源首次结果记录 source=provider", () => {
    expect(plan(makePlanInput({ source: PROVIDER })).source).toBe(PROVIDER);
  });

  it("admin 来源记录 source=admin", () => {
    expect(plan(makePlanInput({ source: ADMIN })).source).toBe(ADMIN);
  });

  it("修正 2:1 -> 1:1：next=v2、is_correction=true", () => {
    expect(
      plan(
        makePlanInput({
          currentResultVersion: 1,
          currentHome: 2,
          currentAway: 1,
          nextHome: 1,
          nextAway: 1,
        }),
      ),
    ).toEqual({
      next_result_version: 2,
      is_correction: true,
      needs_correction_settlement: false,
      source: PROVIDER,
    });
  });

  it("未 settled 时新结果 needs_correction_settlement=false", () => {
    expect(plan(makePlanInput({ settlementStatus: WAITING })).needs_correction_settlement).toBe(
      false,
    );
  });

  it("已 settled 后新结果 needs_correction_settlement=true（需要修正结算）", () => {
      expect(
        plan(
          makePlanInput({
            currentResultVersion: 1,
            currentHome: 2,
            currentAway: 1,
            nextHome: 2,
            nextAway: 0,
            settlementStatus: SettlementStatus.Settled,
            settledResultVersion: 1,
          }),
        ),
      ).toMatchObject({
      next_result_version: 2,
      is_correction: true,
      needs_correction_settlement: true,
    });
  });

  it("settled_result_version=1 且 status=correcting：needs_correction_settlement=true", () => {
    expect(
      plan(
        makePlanInput({
          currentResultVersion: 1,
          currentHome: 2,
          currentAway: 1,
          nextHome: 1,
          nextAway: 1,
          settlementStatus: SettlementStatus.Correcting,
          settledResultVersion: 1,
        }),
      ).needs_correction_settlement,
    ).toBe(true);
  });

  it("settled_result_version=1 且 status=failed：needs_correction_settlement=true", () => {
    expect(
      plan(
        makePlanInput({
          currentResultVersion: 1,
          currentHome: 2,
          currentAway: 1,
          nextHome: 1,
          nextAway: 1,
          settlementStatus: SettlementStatus.Failed,
          settledResultVersion: 1,
        }),
      ).needs_correction_settlement,
    ).toBe(true);
  });

  it("settled_result_version=0 且 status=settling：needs_correction_settlement=false", () => {
    expect(
      plan(makePlanInput({ settlementStatus: SettlementStatus.Settling }))
        .needs_correction_settlement,
    ).toBe(false);
  });

  it("settled_result_version=0 且 status=failed：needs_correction_settlement=false", () => {
    expect(
      plan(makePlanInput({ settlementStatus: SettlementStatus.Failed }))
        .needs_correction_settlement,
    ).toBe(false);
  });

  it("match_status 非 finished 抛 MATCH_NOT_FINISHED", () => {
    for (const match_status of [
      MatchStatus.Scheduled,
      MatchStatus.Live,
      MatchStatus.Postponed,
      MatchStatus.Cancelled,
      MatchStatus.Abandoned,
    ]) {
      expect(captureError(() => plan(makePlanInput({ matchStatus: match_status })))).toMatchObject({
        code: ResultCorrectionCode.MatchNotFinished,
      });
    }
  });

  it("比分为非整数抛 INVALID_SCORE", () => {
    expect(captureError(() => plan(makePlanInput({ nextHome: 2.5 })))).toMatchObject({
      code: ResultCorrectionCode.InvalidScore,
    });
    expect(captureError(() => plan(makePlanInput({ nextAway: 0.5 })))).toMatchObject({
      code: ResultCorrectionCode.InvalidScore,
    });
  });

  it("比分越界 0..99 抛 INVALID_SCORE", () => {
    expect(captureError(() => plan(makePlanInput({ nextHome: 100 })))).toMatchObject({
      code: ResultCorrectionCode.InvalidScore,
    });
    expect(captureError(() => plan(makePlanInput({ nextAway: -1 })))).toMatchObject({
      code: ResultCorrectionCode.InvalidScore,
    });
  });

  it("新比分与当前相同抛 RESULT_UNCHANGED", () => {
    expect(
      captureError(() =>
        plan(
          makePlanInput({
            currentResultVersion: 1,
            currentHome: 2,
            currentAway: 1,
            nextHome: 2,
            nextAway: 1,
          }),
        ),
      ),
    ).toMatchObject({
      code: ResultCorrectionCode.ResultUnchanged,
    });
  });

  it("currentResultVersion 为负数抛 INVALID_RESULT_VERSION", () => {
    expect(captureError(() => plan(makePlanInput({ currentResultVersion: -1 })))).toMatchObject({
      code: ResultCorrectionCode.InvalidResultVersion,
    });
  });
});

describe("nextSettlementVersion - 结算版本推进", () => {
  it("无 result（result_version=0）-> null", () => {
    expect(nextSettlementVersion(0, 0)).toBeNull();
  });

  it("已追平（settled == current）-> null", () => {
    expect(nextSettlementVersion(2, 2)).toBeNull();
  });

  it("v1 已存在且未结算：current=1 settled=0 -> 1", () => {
    expect(nextSettlementVersion(1, 0)).toBe(1);
  });

  it("v2 已存在但只结算到 v1：current=2 settled=1 -> 2", () => {
    expect(nextSettlementVersion(2, 1)).toBe(2);
  });

  it("v3 已存在且 v1 未完成：current=3 settled=0 -> 1（禁止跳到最新版本）", () => {
    expect(nextSettlementVersion(3, 0)).toBe(1);
  });

  it("v3 已存在且只结算到 v2：current=3 settled=2 -> 3", () => {
    expect(nextSettlementVersion(3, 2)).toBe(3);
  });
});
