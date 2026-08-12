import { describe, expect, it } from "vitest";
import { SettlementDocStatus, SettlementPhase, SettlementStatus } from "../domain/enums.js";
import type { SettlementDoc } from "../domain/types.js";
import {
  selectFailedSettlementTarget,
  type RetrySettlementTargetMatch,
} from "./retry-settlement-target.js";

const MATCH_ID = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-09T00:00:00.000Z");

function captureError(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

function makeMatch(
  overrides: Partial<RetrySettlementTargetMatch> = {},
): RetrySettlementTargetMatch {
  return {
    match_id: MATCH_ID,
    result_version: 1,
    settled_result_version: 0,
    settlement_status: SettlementStatus.Failed,
    scoring_rule_version: "scoring_v1",
    ...overrides,
  };
}

function makeSettlement(overrides: Partial<SettlementDoc> = {}): SettlementDoc {
  return {
    schema_version: 1,
    settlement_id: "00000000-0000-4000-8000-000000000010",
    match_id: MATCH_ID,
    result_version: 1,
    rule_version: "scoring_v1",
    status: SettlementDocStatus.Failed,
    phase: SettlementPhase.ApplyItems,
    is_correction: false,
    started_at: NOW,
    settled_at: null,
    attempt_count: 1,
    last_error_code: "SETTLEMENT_ITEM_FAILED",
    last_error_message: "item failed",
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe("selectFailedSettlementTarget", () => {
  it("多个 failed settlement 按 settled_result_version 之后的最小版本选择", () => {
    const target = selectFailedSettlementTarget(
      makeMatch({ result_version: 3, settled_result_version: 1 }),
      [
        makeSettlement({
          settlement_id: "00000000-0000-4000-8000-000000000013",
          result_version: 3,
          is_correction: true,
        }),
        makeSettlement({
          settlement_id: "00000000-0000-4000-8000-000000000012",
          result_version: 2,
          is_correction: true,
        }),
      ],
    );

    expect(target.result_version).toBe(2);
  });

  it("首次结算可以从尚未结算的最新结果版本直接重试", () => {
    const failedLatest = makeSettlement({
      settlement_id: "00000000-0000-4000-8000-000000000017",
      result_version: 3,
      is_correction: false,
    });

    expect(
      selectFailedSettlementTarget(
        makeMatch({ result_version: 3, settled_result_version: 0 }),
        [failedLatest],
        [failedLatest],
      ),
    ).toBe(failedLatest);
  });

  it("已存在的 settlement 版本出现空洞时 fail closed", () => {
    const failed = makeSettlement({
      settlement_id: "00000000-0000-4000-8000-000000000012",
      result_version: 2,
      is_correction: true,
    });
    const laterPending = makeSettlement({
      settlement_id: "00000000-0000-4000-8000-000000000013",
      result_version: 4,
      status: SettlementDocStatus.Pending,
      phase: SettlementPhase.Prepare,
      is_correction: true,
    });

    expect(
      captureError(() =>
        selectFailedSettlementTarget(
          makeMatch({ result_version: 4, settled_result_version: 1 }),
          [failed],
          [failed, laterPending],
        ),
      ),
    ).toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("下一版本缺失、同版本重复或版本出现空洞时 fail closed", () => {
    expect(
      captureError(() =>
        selectFailedSettlementTarget(
        makeMatch({ result_version: 3, settled_result_version: 1 }),
        [makeSettlement({ result_version: 3, is_correction: true })],
        ),
      ),
    ).toMatchObject({ code: "INTERNAL_ERROR" });

    expect(
      captureError(() =>
        selectFailedSettlementTarget(
        makeMatch({ result_version: 2, settled_result_version: 1 }),
        [
          makeSettlement({ result_version: 2, is_correction: true }),
          makeSettlement({
            settlement_id: "00000000-0000-4000-8000-000000000011",
            result_version: 2,
            is_correction: true,
          }),
        ],
        ),
      ),
    ).toMatchObject({ code: "INTERNAL_ERROR" });

    expect(
      captureError(() =>
        selectFailedSettlementTarget(
        makeMatch({ result_version: 4, settled_result_version: 1 }),
        [
          makeSettlement({ result_version: 2, is_correction: true }),
          makeSettlement({
            settlement_id: "00000000-0000-4000-8000-000000000014",
            result_version: 4,
            is_correction: true,
          }),
        ],
        ),
      ),
    ).toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("已结算版本存在未完成 settlement 时 fail closed", () => {
    const stalePending = makeSettlement({
      settlement_id: "00000000-0000-4000-8000-000000000015",
      result_version: 1,
      status: SettlementDocStatus.Pending,
      phase: SettlementPhase.Prepare,
      is_correction: false,
    });
    const failedCorrection = makeSettlement({
      settlement_id: "00000000-0000-4000-8000-000000000016",
      result_version: 2,
      is_correction: true,
    });

    expect(
      captureError(() =>
        selectFailedSettlementTarget(
          makeMatch({
            result_version: 2,
            settled_result_version: 1,
            settlement_status: SettlementStatus.Correcting,
          }),
          [failedCorrection],
          [stalePending, failedCorrection],
        ),
      ),
    ).toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("failed settlement 不在完整 settlement 列表中时 fail closed", () => {
    const initialSettlement = makeSettlement({
      settlement_id: "00000000-0000-4000-8000-000000000022",
      result_version: 1,
      status: SettlementDocStatus.Settled,
      phase: SettlementPhase.Done,
      is_correction: false,
      settled_at: NOW,
    });
    const failedSettlement = makeSettlement({
      settlement_id: "00000000-0000-4000-8000-000000000023",
      result_version: 2,
      is_correction: true,
    });

    expect(
      captureError(() =>
        selectFailedSettlementTarget(
          makeMatch({ result_version: 2, settled_result_version: 1 }),
          [failedSettlement],
          [initialSettlement],
        ),
      ),
    ).toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("完整 settlement 列表中的 failed settlement 未传入时 fail closed", () => {
    const initialSettlement = makeSettlement({
      settlement_id: "00000000-0000-4000-8000-000000000026",
      result_version: 1,
      status: SettlementDocStatus.Settled,
      phase: SettlementPhase.Done,
      is_correction: false,
      settled_at: NOW,
    });
    const failedVersionTwo = makeSettlement({
      settlement_id: "00000000-0000-4000-8000-000000000024",
      result_version: 2,
      is_correction: true,
    });
    const failedVersionThree = makeSettlement({
      settlement_id: "00000000-0000-4000-8000-000000000025",
      result_version: 3,
      is_correction: true,
    });

    expect(
      captureError(() =>
        selectFailedSettlementTarget(
          makeMatch({ result_version: 3, settled_result_version: 1 }),
          [failedVersionTwo],
          [initialSettlement, failedVersionTwo, failedVersionThree],
        ),
      ),
    ).toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("存在更高版本 running 时不得重试较低版本的 failed settlement", () => {
    const runningVersion = makeSettlement({
      settlement_id: "00000000-0000-4000-8000-000000000018",
      result_version: 2,
      status: SettlementDocStatus.Running,
      phase: SettlementPhase.ApplyItems,
      is_correction: false,
    });
    const failedVersion = makeSettlement({
      settlement_id: "00000000-0000-4000-8000-000000000019",
      result_version: 1,
      is_correction: false,
    });

    expect(
      captureError(() =>
        selectFailedSettlementTarget(
          makeMatch({ result_version: 2, settled_result_version: 0 }),
          [failedVersion],
          [failedVersion, runningVersion],
        ),
      ),
    ).toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("settlement 版本序列中的 is_correction 冲突时 fail closed", () => {
    const initialSettlement = makeSettlement({
      settlement_id: "00000000-0000-4000-8000-000000000020",
      result_version: 1,
      status: SettlementDocStatus.Settled,
      phase: SettlementPhase.Done,
      is_correction: true,
      settled_at: NOW,
    });
    const failedCorrection = makeSettlement({
      settlement_id: "00000000-0000-4000-8000-000000000021",
      result_version: 2,
      is_correction: true,
    });

    expect(
      captureError(() =>
        selectFailedSettlementTarget(
          makeMatch({
            result_version: 2,
            settled_result_version: 1,
            settlement_status: SettlementStatus.Correcting,
          }),
          [failedCorrection],
          [initialSettlement, failedCorrection],
        ),
      ),
    ).toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("settled_result_version 之前缺少 settlement 时 fail closed", () => {
    const failedCorrection = makeSettlement({
      settlement_id: "00000000-0000-4000-8000-000000000017",
      result_version: 2,
      is_correction: true,
    });

    expect(
      captureError(() =>
        selectFailedSettlementTarget(
          makeMatch({
            result_version: 2,
            settled_result_version: 1,
            settlement_status: SettlementStatus.Correcting,
          }),
          [failedCorrection],
          [failedCorrection],
        ),
      ),
    ).toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("没有 failed settlement 时按 match 状态返回明确错误", () => {
    expect(
      captureError(() =>
        selectFailedSettlementTarget(
        makeMatch({ settlement_status: SettlementStatus.Waiting }),
        [],
        ),
      ),
    ).toMatchObject({ code: "SETTLEMENT_NOT_READY" });

    expect(captureError(() => selectFailedSettlementTarget(makeMatch(), []))).toMatchObject({
      code: "INTERNAL_ERROR",
    });
  });
});
