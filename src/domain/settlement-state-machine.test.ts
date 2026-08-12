import { describe, expect, it } from "vitest";
import {
  shouldVoidOnCancel,
  validateSettlementTransition,
} from "./settlement-state-machine.js";
import {
  MatchStatus,
  SettlementStatus,
  type SettlementStatus as SettlementStatusType,
} from "./enums.js";

const S = SettlementStatus;

describe("结算状态机（规范 11 + 49.3）", () => {
  it("49.3 允许 settling -> correcting", () => {
    expect(
      validateSettlementTransition(S.Settling, S.Correcting),
      "settling->correcting",
    ).toBe(true);
  });

  it("11.2 + 49.3 全部合法转移", () => {
    const allowed: ReadonlyArray<[SettlementStatusType, SettlementStatusType]> = [
      [S.Pending, S.Waiting],
      [S.Pending, S.Voided],
      [S.Waiting, S.Settling],
      [S.Waiting, S.Voided],
      [S.Settling, S.Settled],
      [S.Settling, S.Failed],
      [S.Settling, S.Correcting],
      [S.Failed, S.Settling],
      [S.Failed, S.Correcting],
      [S.Settled, S.Correcting],
      [S.Correcting, S.Settled],
      [S.Correcting, S.Failed],
    ];
    for (const [from, to] of allowed) {
      expect(validateSettlementTransition(from, to), `${from}->${to}`).toBe(true);
    }
  });

  it("11.2 禁止其它自动转移", () => {
    const forbidden: ReadonlyArray<[SettlementStatusType, SettlementStatusType]> = [
      [S.Pending, S.Settled],
      [S.Pending, S.Correcting],
      [S.Pending, S.Failed],
      [S.Waiting, S.Settled],
      [S.Waiting, S.Correcting],
      [S.Waiting, S.Failed],
      [S.Settling, S.Voided],
      [S.Settled, S.Settled],
      [S.Settled, S.Voided],
      [S.Correcting, S.Voided],
      [S.Failed, S.Voided],
      [S.Voided, S.Waiting],
      [S.Voided, S.Settled],
    ];
    for (const [from, to] of forbidden) {
      expect(validateSettlementTransition(from, to), `${from}->${to}`).toBe(false);
    }
  });

  it("11.3 cancelled 且尚未 settled => voided", () => {
    expect(shouldVoidOnCancel(MatchStatus.Cancelled, S.Pending)).toBe(true);
    expect(shouldVoidOnCancel(MatchStatus.Cancelled, S.Waiting)).toBe(true);
    expect(shouldVoidOnCancel(MatchStatus.Cancelled, S.Settling)).toBe(true);
    expect(shouldVoidOnCancel(MatchStatus.Cancelled, S.Failed)).toBe(true);
  });

  it("11.3 已 settled 后取消不算正常业务（不自动 voided）", () => {
    expect(shouldVoidOnCancel(MatchStatus.Cancelled, S.Settled)).toBe(false);
  });
});
