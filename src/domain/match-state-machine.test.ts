import { describe, expect, it } from "vitest";
import {
  forbiddenTransitionsFrom,
  validateMatchTransition,
} from "./match-state-machine.js";
import {
  MatchStatus,
  type MatchStatus as MatchStatusType,
} from "./enums.js";

const { Scheduled, Live, Finished, Postponed, Cancelled, Abandoned } = MatchStatus;

describe("E. 比赛状态机（规范 44-E）", () => {
  it("E29 scheduled -> live 合法", () => {
    expect(validateMatchTransition(Scheduled, Live)).toBe(true);
  });

  it("E30 scheduled -> finished 合法（错过中间轮询）", () => {
    expect(validateMatchTransition(Scheduled, Finished)).toBe(true);
  });

  it("E31 live -> finished 合法", () => {
    expect(validateMatchTransition(Live, Finished)).toBe(true);
  });

  it("E32 scheduled -> postponed 合法", () => {
    expect(validateMatchTransition(Scheduled, Postponed)).toBe(true);
  });

  it("E33 postponed -> scheduled 合法", () => {
    expect(validateMatchTransition(Postponed, Scheduled)).toBe(true);
  });

  it("E34 live -> abandoned 合法", () => {
    expect(validateMatchTransition(Live, Abandoned)).toBe(true);
  });

  it("E35 abandoned -> finished 合法", () => {
    expect(validateMatchTransition(Abandoned, Finished)).toBe(true);
  });

  it("E36 finished -> live Provider 自动回退禁止", () => {
    expect(validateMatchTransition(Finished, Live)).toBe(false);
  });

  it("E37 cancelled -> scheduled Provider 自动回退禁止", () => {
    expect(validateMatchTransition(Cancelled, Scheduled)).toBe(false);
  });

  it("10.2 全部允许转移", () => {
    const allowed: ReadonlyArray<[MatchStatusType, MatchStatusType]> = [
      [Scheduled, Live],
      [Scheduled, Finished],
      [Scheduled, Postponed],
      [Scheduled, Cancelled],
      [Scheduled, Abandoned],
      [Postponed, Scheduled],
      [Postponed, Live],
      [Postponed, Finished],
      [Postponed, Cancelled],
      [Postponed, Abandoned],
      [Live, Finished],
      [Live, Abandoned],
      [Abandoned, Finished],
      [Abandoned, Cancelled],
    ];
    for (const [from, to] of allowed) {
      expect(validateMatchTransition(from, to), `${from}->${to}`).toBe(true);
    }
  });

  it("10.3 全部禁止自动转移", () => {
    const forbidden: ReadonlyArray<[MatchStatusType, MatchStatusType]> = [
      [Finished, Live],
      [Finished, Scheduled],
      [Finished, Postponed],
      [Cancelled, Scheduled],
      [Cancelled, Live],
      [Cancelled, Finished],
      [Cancelled, Postponed],
      [Cancelled, Abandoned],
      [Live, Scheduled],
      [Live, Postponed],
      [Live, Cancelled],
      [Abandoned, Live],
      [Abandoned, Scheduled],
      [Abandoned, Postponed],
      [Abandoned, Abandoned],
      [Finished, Finished],
    ];
    for (const [from, to] of forbidden) {
      expect(validateMatchTransition(from, to), `${from}->${to}`).toBe(false);
    }
  });

  it("同状态重复同步为幂等 update（10.4）", () => {
    expect(validateMatchTransition(Finished, Finished)).toBe(false);
    expect(validateMatchTransition(Scheduled, Scheduled)).toBe(false);
  });

  it("forbiddenTransitionsFrom 与 validate 一致", () => {
    for (const from of Object.values(MatchStatus) as MatchStatusType[]) {
      for (const to of forbiddenTransitionsFrom(from)) {
        expect(validateMatchTransition(from, to), `${from}->${to}`).toBe(false);
      }
    }
  });
});
