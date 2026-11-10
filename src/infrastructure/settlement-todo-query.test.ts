import { describe, expect, it } from "vitest";
import { MatchStatus, SettlementStatus } from "../domain/enums.js";
import type { Match } from "../domain/types.js";
import {
  isSettlementTodoStatus,
  kickoffMs,
  selectSettlementFallbackPage,
  selectSettlementTodos,
} from "./settlement-todo-query.js";

const T1 = new Date("2026-08-08T12:00:00.000Z");
const T2 = new Date("2026-08-08T13:00:00.000Z");
const T3 = new Date("2026-08-08T14:00:00.000Z");

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    schema_version: 1,
    match_id: "m1",
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: "home",
    away_team_id: "away",
    kickoff_at: T1,
    kickoff_confirmed: true,
    prediction_deadline_at: T1,
    prediction_closed_at: null,
    period_anchor_at: null,
    match_status: MatchStatus.Finished,
    settlement_status: SettlementStatus.Pending,
    regular_home_score: 1,
    regular_away_score: 0,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 1,
    settled_result_version: 0,
    result_source: "provider",
    scoring_rule_version: "scoring_v1",
    finish_detected_at: T1,
    settled_at: null,
    created_at: T1,
    updated_at: T1,
    ...overrides,
  } as Match;
}

describe("isSettlementTodoStatus", () => {
  it("待办状态为 true，settled/voided 为 false", () => {
    for (const status of [
      SettlementStatus.Pending,
      SettlementStatus.Waiting,
      SettlementStatus.Settling,
      SettlementStatus.Failed,
      SettlementStatus.Correcting,
    ]) {
      expect(isSettlementTodoStatus(status)).toBe(true);
    }
    expect(isSettlementTodoStatus(SettlementStatus.Settled)).toBe(false);
    expect(isSettlementTodoStatus(SettlementStatus.Voided)).toBe(false);
  });
});

describe("selectSettlementTodos", () => {
  it("只返回 finished 且状态 ∈ {pending, waiting, settling, failed, correcting}", () => {
    const matches = [
      makeMatch({ match_id: "pending", settlement_status: SettlementStatus.Pending }),
      makeMatch({ match_id: "waiting", settlement_status: SettlementStatus.Waiting }),
      makeMatch({ match_id: "settling", settlement_status: SettlementStatus.Settling }),
      makeMatch({ match_id: "failed", settlement_status: SettlementStatus.Failed }),
      makeMatch({ match_id: "correcting", settlement_status: SettlementStatus.Correcting }),
    ];
    const selected = selectSettlementTodos(matches, { limit: 20 });
    expect(selected.map((row) => row.match_id).sort()).toEqual(
      ["correcting", "failed", "pending", "settling", "waiting"].sort(),
    );
  });

  it("settled 与 voided 不返回", () => {
    const matches = [
      makeMatch({ match_id: "ok", settlement_status: SettlementStatus.Pending }),
      makeMatch({ match_id: "settled", settlement_status: SettlementStatus.Settled }),
      makeMatch({ match_id: "voided", settlement_status: SettlementStatus.Voided }),
    ];
    expect(selectSettlementTodos(matches, { limit: 10 }).map((row) => row.match_id)).toEqual(["ok"]);
  });

  it("非 finished（scheduled/live）不返回", () => {
    const matches = [
      makeMatch({ match_id: "ok", match_status: MatchStatus.Finished }),
      makeMatch({ match_id: "scheduled", match_status: MatchStatus.Scheduled }),
      makeMatch({ match_id: "live", match_status: MatchStatus.Live }),
    ];
    expect(selectSettlementTodos(matches, { limit: 10 }).map((row) => row.match_id)).toEqual(["ok"]);
  });

  it("按 kickoff_at 升序，同 kickoff 按 match_id 升序", () => {
    const matches = [
      makeMatch({ match_id: "c", kickoff_at: T2 }),
      makeMatch({ match_id: "a", kickoff_at: T3 }),
      makeMatch({ match_id: "b", kickoff_at: T2 }),
      makeMatch({ match_id: "d", kickoff_at: T1 }),
    ];
    expect(selectSettlementTodos(matches, { limit: 10 }).map((row) => row.match_id)).toEqual([
      "d",
      "b",
      "c",
      "a",
    ]);
  });

  it("limit 生效：10 条候选、limit=3 → 3 条", () => {
    const matches = Array.from({ length: 10 }, (_, index) =>
      makeMatch({
        match_id: `m${String(index).padStart(2, "0")}`,
        kickoff_at: new Date(T1.getTime() + index * 60_000),
      }),
    );
    expect(selectSettlementTodos(matches, { limit: 3 }).map((row) => row.match_id)).toEqual([
      "m00",
      "m01",
      "m02",
    ]);
  });

  it("after 指向中间记录时只返回其后的记录（含同 kickoff、match_id 更大的一条）", () => {
    const matches = [
      makeMatch({ match_id: "m1", kickoff_at: T1 }),
      makeMatch({ match_id: "m2", kickoff_at: T2 }),
      makeMatch({ match_id: "m3", kickoff_at: T2 }),
      makeMatch({ match_id: "m4", kickoff_at: T3 }),
    ];
    expect(
      selectSettlementTodos(matches, {
        limit: 10,
        after: { kickoff_at: T2, match_id: "m2" },
      }).map((row) => row.match_id),
    ).toEqual(["m3", "m4"]);
  });
});

describe("selectSettlementFallbackPage", () => {
  it("包含 settled、排除 voided，游标分页正确", () => {
    const matches = [
      makeMatch({ match_id: "m1", kickoff_at: T1, settlement_status: SettlementStatus.Pending }),
      makeMatch({ match_id: "m2", kickoff_at: T2, settlement_status: SettlementStatus.Settled }),
      makeMatch({ match_id: "m3", kickoff_at: T2, settlement_status: SettlementStatus.Waiting }),
      makeMatch({ match_id: "voided", kickoff_at: T2, settlement_status: SettlementStatus.Voided }),
      makeMatch({ match_id: "m4", kickoff_at: T3, settlement_status: SettlementStatus.Settled }),
      makeMatch({
        match_id: "live",
        kickoff_at: T1,
        match_status: MatchStatus.Live,
        settlement_status: SettlementStatus.Pending,
      }),
    ];
    expect(selectSettlementFallbackPage(matches, { limit: 10 }).map((row) => row.match_id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
    expect(
      selectSettlementFallbackPage(matches, {
        limit: 10,
        after: { kickoff_at: T2, match_id: "m2" },
      }).map((row) => row.match_id),
    ).toEqual(["m3", "m4"]);
  });
});

describe("kickoffMs", () => {
  it("Date / ISO 字符串 / 数字都能转成同一毫秒", () => {
    expect(kickoffMs(T2)).toBe(T2.getTime());
    expect(kickoffMs(T2.toISOString())).toBe(T2.getTime());
    expect(kickoffMs(T2.getTime())).toBe(T2.getTime());
  });

  it("非法值兜底 0", () => {
    expect(kickoffMs("not-a-date")).toBe(0);
    expect(kickoffMs(Number.NaN)).toBe(0);
    expect(kickoffMs(Number.POSITIVE_INFINITY)).toBe(0);
    expect(kickoffMs(new Date("invalid"))).toBe(0);
    expect(kickoffMs(null)).toBe(0);
    expect(kickoffMs(undefined)).toBe(0);
    expect(kickoffMs({})).toBe(0);
  });
});
