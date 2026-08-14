import { describe, expect, it } from "vitest";
import { MatchStatus, SettlementStatus } from "../domain/enums.js";
import {
  FirstSettlementCode,
  decideFirstSettlement,
  type FirstSettlementInput,
} from "./first-settlement.js";

const FINISHED = MatchStatus.Finished;
const WAITING = SettlementStatus.Waiting;

const FINISH_AT = new Date("2026-08-09T20:00:00Z");
const TEN_MINUTES_MS = 10 * 60 * 1000;

function makeInput(overrides: Partial<FirstSettlementInput> = {}): FirstSettlementInput {
  return {
    match_status: FINISHED,
    settlement_status: WAITING,
    finish_detected_at: FINISH_AT,
    result_version: 1,
    regular_home_score: 2,
    regular_away_score: 1,
    server_now: new Date(FINISH_AT.getTime() + TEN_MINUTES_MS),
    has_blocking_anomaly: false,
    ...overrides,
  };
}

describe("decideFirstSettlement - 首次结算状态决策", () => {
  it("全部满足：finished + waiting + 无阻塞异常 + 恰好 10 分钟 -> start", () => {
    expect(decideFirstSettlement(makeInput())).toEqual({
      kind: "start",
      code: FirstSettlementCode.Start,
    });
  });

  it("恰好 10 分钟后（含边界）允许结算 -> start", () => {
    expect(
      decideFirstSettlement(makeInput({ server_now: new Date(FINISH_AT.getTime() + TEN_MINUTES_MS) })),
    ).toEqual({ kind: "start", code: FirstSettlementCode.Start });
  });

  it("9 分 59 秒（不足 10 分钟）-> not_ready", () => {
    expect(
      decideFirstSettlement(
        makeInput({ server_now: new Date(FINISH_AT.getTime() + TEN_MINUTES_MS - 1000) }),
      ),
    ).toEqual({ kind: "not_ready", code: FirstSettlementCode.NotReady });
  });

  it("超过 10 分钟 -> start", () => {
    expect(
      decideFirstSettlement(
        makeInput({ server_now: new Date(FINISH_AT.getTime() + TEN_MINUTES_MS + 60_000) }),
      ),
    ).toEqual({ kind: "start", code: FirstSettlementCode.Start });
  });

  it("match_status 非 finished -> not_ready", () => {
    for (const match_status of [
      MatchStatus.Scheduled,
      MatchStatus.Live,
      MatchStatus.Postponed,
      MatchStatus.Cancelled,
      MatchStatus.Abandoned,
    ]) {
      expect(decideFirstSettlement(makeInput({ match_status }))).toEqual({
        kind: "not_ready",
        code: FirstSettlementCode.NotReady,
      });
    }
  });

  it("settlement_status=settled -> settled", () => {
    expect(decideFirstSettlement(makeInput({ settlement_status: SettlementStatus.Settled }))).toEqual({
      kind: "settled",
      code: FirstSettlementCode.AlreadySettled,
    });
  });

  it("settlement_status=settling -> conflict", () => {
    expect(decideFirstSettlement(makeInput({ settlement_status: SettlementStatus.Settling }))).toEqual(
      {
        kind: "conflict",
        code: FirstSettlementCode.AlreadyRunning,
      },
    );
  });

  it("settlement_status=running -> conflict", () => {
    expect(decideFirstSettlement(makeInput({ settlement_status: "running" }))).toEqual({
      kind: "conflict",
      code: FirstSettlementCode.AlreadyRunning,
    });
  });

  it("其他非 waiting 状态（pending/failed/voided/correcting）-> conflict", () => {
    for (const settlement_status of [
      SettlementStatus.Pending,
      SettlementStatus.Failed,
      SettlementStatus.Voided,
      SettlementStatus.Correcting,
    ]) {
      expect(decideFirstSettlement(makeInput({ settlement_status }))).toEqual({
        kind: "conflict",
        code: FirstSettlementCode.AlreadyRunning,
      });
    }
  });

  it("存在阻塞异常 -> not_ready", () => {
    expect(decideFirstSettlement(makeInput({ has_blocking_anomaly: true }))).toEqual({
      kind: "not_ready",
      code: FirstSettlementCode.NotReady,
    });
  });

  it("finish_detected_at 为 null -> not_ready", () => {
    expect(decideFirstSettlement(makeInput({ finish_detected_at: null }))).toEqual({
      kind: "not_ready",
      code: FirstSettlementCode.NotReady,
    });
  });

  it("result_version < 1（0 / 负数）-> not_ready", () => {
    for (const result_version of [0, -1]) {
      expect(decideFirstSettlement(makeInput({ result_version }))).toEqual({
        kind: "not_ready",
        code: FirstSettlementCode.NotReady,
      });
    }
  });

  it("比分为非整数 -> not_ready", () => {
    expect(
      decideFirstSettlement(makeInput({ regular_home_score: 2.5, regular_away_score: 1 })),
    ).toEqual({ kind: "not_ready", code: FirstSettlementCode.NotReady });
    expect(
      decideFirstSettlement(makeInput({ regular_home_score: 2, regular_away_score: 0.5 })),
    ).toEqual({ kind: "not_ready", code: FirstSettlementCode.NotReady });
  });

  it("比分超出 0..99 -> not_ready", () => {
    expect(
      decideFirstSettlement(makeInput({ regular_home_score: 100, regular_away_score: 0 })),
    ).toEqual({ kind: "not_ready", code: FirstSettlementCode.NotReady });
    expect(
      decideFirstSettlement(makeInput({ regular_home_score: 0, regular_away_score: -1 })),
    ).toEqual({ kind: "not_ready", code: FirstSettlementCode.NotReady });
  });
  it("无分 waiting（rv=0 + 比分 null）首次结算决策 -> not_ready", () => {
    expect(
      decideFirstSettlement(
        makeInput({ result_version: 0, regular_home_score: null, regular_away_score: null }),
      ),
    ).toEqual({ kind: "not_ready", code: FirstSettlementCode.NotReady });
  });

  it("无分 waiting 且已过 10 分钟保护期仍 -> not_ready", () => {
    expect(
      decideFirstSettlement(
        makeInput({
          result_version: 0,
          regular_home_score: null,
          regular_away_score: null,
          server_now: new Date(FINISH_AT.getTime() + TEN_MINUTES_MS + 60_000),
        }),
      ),
    ).toEqual({ kind: "not_ready", code: FirstSettlementCode.NotReady });
  });
});
