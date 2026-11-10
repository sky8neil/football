import { describe, expect, it } from "vitest";
import { MatchStatus, SettlementStatus } from "../domain/enums.js";
import type { Match } from "../domain/types.js";
import { activeWindow } from "../application/provider-active-window.js";
import {
  buildActiveWindowFilters,
  selectActiveWindow,
  type ActiveWindowJob,
  type ActiveWindowQuery,
} from "./active-window-query.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    schema_version: 1,
    match_id: "m1",
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: "home",
    away_team_id: "away",
    kickoff_at: NOW,
    kickoff_confirmed: true,
    prediction_deadline_at: NOW,
    prediction_closed_at: null,
    period_anchor_at: null,
    match_status: MatchStatus.Scheduled,
    settlement_status: SettlementStatus.Pending,
    regular_home_score: null,
    regular_away_score: null,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 0,
    settled_result_version: 0,
    result_source: null,
    scoring_rule_version: "scoring_v1",
    finish_detected_at: null,
    settled_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  } as Match;
}

function query(jobType: ActiveWindowJob, limit = 50): ActiveWindowQuery {
  return { jobType, now: NOW, limit };
}

function idsOf(matches: readonly Match[]): string[] {
  return matches.map((match) => match.match_id);
}

function loaderPath(matches: readonly Match[], jobType: ActiveWindowJob, limit: number): string[] {
  const selected = [...activeWindow(matches, NOW, jobType)].sort((left, right) => {
    const delta = left.kickoff_at.getTime() - right.kickoff_at.getTime();
    if (delta !== 0) return delta;
    return left.match_id < right.match_id ? -1 : left.match_id > right.match_id ? 1 : 0;
  });
  const seen = new Set<string>();
  const unique: Match[] = [];
  for (const match of selected) {
    if (seen.has(match.match_id)) continue;
    seen.add(match.match_id);
    unique.push(match);
  }
  return idsOf(unique.slice(0, Math.max(0, limit)));
}

const FIXTURES: Match[] = [
  makeMatch({ match_id: "sched-3d", kickoff_at: at(3 * 24 * HOUR_MS) }),
  makeMatch({ match_id: "sched-25h", kickoff_at: at(25 * HOUR_MS) }),
  makeMatch({ match_id: "sched-24h", kickoff_at: at(24 * HOUR_MS) }),
  makeMatch({ match_id: "sched-12h", kickoff_at: at(12 * HOUR_MS) }),
  makeMatch({ match_id: "sched-3h", kickoff_at: at(3 * HOUR_MS) }),
  makeMatch({ match_id: "sched-2h", kickoff_at: at(2 * HOUR_MS) }),
  makeMatch({ match_id: "sched-1h", kickoff_at: at(HOUR_MS) }),
  makeMatch({ match_id: "sched-now", kickoff_at: NOW }),
  makeMatch({ match_id: "sched-30m-ago", kickoff_at: at(-30 * MINUTE_MS) }),
  makeMatch({ match_id: "sched-106m-ago", kickoff_at: at(-106 * MINUTE_MS) }),
  makeMatch({ match_id: "live-now", match_status: MatchStatus.Live, kickoff_at: NOW }),
  makeMatch({
    match_id: "live-2h-ago",
    match_status: MatchStatus.Live,
    kickoff_at: at(-2 * HOUR_MS),
  }),
  makeMatch({
    match_id: "fin-pending-12h",
    match_status: MatchStatus.Finished,
    settlement_status: SettlementStatus.Pending,
    kickoff_at: at(-12 * HOUR_MS),
    finish_detected_at: at(-10 * HOUR_MS),
  }),
  makeMatch({
    match_id: "fin-waiting-6h",
    match_status: MatchStatus.Finished,
    settlement_status: SettlementStatus.Waiting,
    kickoff_at: at(-6 * HOUR_MS),
    finish_detected_at: at(-4 * HOUR_MS),
  }),
  makeMatch({
    match_id: "fin-settled-12h",
    match_status: MatchStatus.Finished,
    settlement_status: SettlementStatus.Settled,
    kickoff_at: at(-12 * HOUR_MS),
    finish_detected_at: at(-10 * HOUR_MS),
  }),
  makeMatch({
    match_id: "fin-voided-12h",
    match_status: MatchStatus.Finished,
    settlement_status: SettlementStatus.Voided,
    kickoff_at: at(-12 * HOUR_MS),
    finish_detected_at: at(-10 * HOUR_MS),
  }),
  makeMatch({
    match_id: "fin-pending-detected",
    match_status: MatchStatus.Finished,
    settlement_status: SettlementStatus.Pending,
    kickoff_at: at(-30 * MINUTE_MS),
    finish_detected_at: at(-5 * MINUTE_MS),
  }),
  makeMatch({
    match_id: "live-waiting-2h",
    match_status: MatchStatus.Live,
    settlement_status: SettlementStatus.Waiting,
    kickoff_at: at(-2 * HOUR_MS),
  }),
  makeMatch({
    match_id: "sched-settling-12h",
    kickoff_at: at(12 * HOUR_MS),
    settlement_status: SettlementStatus.Settling,
  }),
];

describe("buildActiveWindowFilters", () => {
  it("near_match：scheduled + kickoff_at <= now+24h", () => {
    const fragments = buildActiveWindowFilters(query("near_match"));
    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.equals).toEqual({ match_status: MatchStatus.Scheduled });
    expect(fragments[0]!.kickoffAtLte?.getTime()).toBe(at(24 * HOUR_MS).getTime());
  });

  it("live_match：live 等值 + scheduled 且 kickoff_at <= now+2h", () => {
    const fragments = buildActiveWindowFilters(query("live_match"));
    expect(fragments).toHaveLength(2);
    expect(fragments[0]).toEqual({ equals: { match_status: MatchStatus.Live } });
    expect(fragments[1]!.equals).toEqual({ match_status: MatchStatus.Scheduled });
    expect(fragments[1]!.kickoffAtLte?.getTime()).toBe(at(2 * HOUR_MS).getTime());
  });

  it("post_finish_verify：finished×{pending,waiting} 等值 + pending/waiting 且 kickoff_at <= now", () => {
    const fragments = buildActiveWindowFilters(query("post_finish_verify"));
    expect(fragments).toHaveLength(4);
    expect(fragments[0]!.equals).toEqual({
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Pending,
    });
    expect(fragments[0]!.kickoffAtLte).toBeUndefined();
    expect(fragments[1]!.equals).toEqual({
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Waiting,
    });
    expect(fragments[1]!.kickoffAtLte).toBeUndefined();
    expect(fragments[2]!.equals).toEqual({ settlement_status: SettlementStatus.Pending });
    expect(fragments[2]!.kickoffAtLte?.getTime()).toBe(NOW.getTime());
    expect(fragments[3]!.equals).toEqual({ settlement_status: SettlementStatus.Waiting });
    expect(fragments[3]!.kickoffAtLte?.getTime()).toBe(NOW.getTime());
  });
});

/**
 * 模拟 CloudBase 侧的行为：每个片段做「等值 + kickoff_at <= 上界」筛选，取并集。
 * 用于验证数据库片段是 activeWindow() 的**超集**——这是接线后不丢更新的前提。
 */
function applyFragments(matches: readonly Match[], jobType: ActiveWindowJob): Match[] {
  const byId = new Map<string, Match>();
  for (const fragment of buildActiveWindowFilters(query(jobType))) {
    for (const match of matches) {
      const equalsOk = Object.entries(fragment.equals).every(
        ([field, expected]) => (match as unknown as Record<string, unknown>)[field] === expected,
      );
      if (!equalsOk) continue;
      if (fragment.kickoffAtLte !== undefined) {
        const kickoff = match.kickoff_at instanceof Date
          ? match.kickoff_at.getTime()
          : new Date(match.kickoff_at as unknown as string).getTime();
        if (kickoff > fragment.kickoffAtLte.getTime()) continue;
      }
      byId.set(match.match_id, match);
    }
  }
  return [...byId.values()];
}

describe("数据库片段必须是 activeWindow 的超集（接线不丢更新）", () => {
  it.each(["near_match", "live_match", "post_finish_verify"] as const)(
    "%s：窗口内每场比赛都能被某个片段查出来",
    (jobType) => {
      const expected = new Set(idsOf(activeWindow(FIXTURES, NOW, jobType)));
      const fromDb = new Set(idsOf(applyFragments(FIXTURES, jobType)));
      const missed = [...expected].filter((id) => !fromDb.has(id));
      expect(missed).toEqual([]);
    },
  );

  it("finish_detected_at 已置但 status 未转 finished、开球不足 105 分钟的比赛不会漏", () => {
    const early = makeMatch({
      match_id: "live-finish-detected-30m",
      match_status: MatchStatus.Live,
      settlement_status: SettlementStatus.Pending,
      kickoff_at: at(-30 * MINUTE_MS),
      finish_detected_at: at(-5 * MINUTE_MS),
    });
    const expected = idsOf(activeWindow([early], NOW, "post_finish_verify"));
    expect(expected).toEqual(["live-finish-detected-30m"]);
    expect(idsOf(applyFragments([early], "post_finish_verify"))).toContain(
      "live-finish-detected-30m",
    );
  });
});

describe("selectActiveWindow", () => {
  it.each(["near_match", "live_match", "post_finish_verify"] as const)(
    "%s 与 findBySeason 全量 + activeWindow 结果完全一致",
    (jobType) => {
      const limit = 50;
      expect(idsOf(selectActiveWindow(FIXTURES, query(jobType, limit)))).toEqual(
        loaderPath(FIXTURES, jobType, limit),
      );
    },
  );

  it("limit 生效且按 kickoff_at 升序截断", () => {
    const selected = selectActiveWindow(FIXTURES, query("near_match", 2));
    expect(idsOf(selected)).toEqual(["sched-3h", "sched-12h"]);
    expect(selected[0]!.kickoff_at.getTime()).toBeLessThan(selected[1]!.kickoff_at.getTime());
  });

  it("重复 match_id 只出现一次", () => {
    const duplicate = makeMatch({ match_id: "dup", kickoff_at: at(12 * HOUR_MS) });
    const selected = selectActiveWindow([duplicate, { ...duplicate }], query("near_match", 10));
    expect(idsOf(selected)).toEqual(["dup"]);
  });

  it("kickoff_at 落库为 ISO 字符串时排序不炸", () => {
    const matches = [
      makeMatch({
        match_id: "iso-late",
        kickoff_at: at(12 * HOUR_MS).toISOString() as unknown as Date,
      }),
      makeMatch({
        match_id: "iso-early",
        kickoff_at: at(3 * HOUR_MS).toISOString() as unknown as Date,
      }),
    ];
    expect(idsOf(selectActiveWindow(matches, query("near_match", 10)))).toEqual([
      "iso-early",
      "iso-late",
    ]);
  });
});
