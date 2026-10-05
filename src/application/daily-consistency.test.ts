import { describe, expect, it } from "vitest";
import {
  checkDailyConsistency,
  type DailyConsistencyInput,
} from "./daily-consistency.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");

function baseInput(): DailyConsistencyInput {
  return {
    career: [
      {
        user_id: "user-1",
        actual: {
          career_points: 3,
          career_valid_predictions: 1,
          career_wdl_hits: 1,
          career_exact_hits: 0,
          career_level: 1,
          career_best_level: 1,
        },
        expected: {
          career_points: 12,
          career_valid_predictions: 1,
          career_wdl_hits: 1,
          career_exact_hits: 1,
          career_level: 2,
          career_best_level: 2,
        },
      },
    ],
    season_stats: [
      {
        user_id: "user-1",
        level_season_id: "2026_2027",
        actual: {
          points: 3,
          valid_predictions: 1,
          wdl_hits: 1,
          exact_hits: 0,
          level: 1,
          best_level: 1,
        },
        expected: {
          points: 12,
          valid_predictions: 1,
          wdl_hits: 1,
          exact_hits: 1,
          level: 2,
          best_level: 2,
        },
      },
    ],
    rankings: [
      {
        period_type: "week",
        period_key: "2026-W32",
        user_id: "user-1",
        actual: {
          period_score: 3,
          valid_predictions: 1,
          wdl_hits: 1,
          exact_hits: 0,
          last_scoring_match_at: null,
          global_rank: null,
        },
        expected: {
          period_score: 12,
          valid_predictions: 3,
          wdl_hits: 2,
          exact_hits: 1,
          last_scoring_match_at: NOW,
          global_rank: 1,
        },
      },
    ],
    board_snapshots: [],
    active_settlements: [],
  };
}

describe("daily consistency comparison", () => {
  it("reports cache differences without changing input data", () => {
    const input = baseInput();

    const result = checkDailyConsistency(input);

    expect(result.skipped_active_settlement).toEqual([]);
    expect(result.differences).toEqual([
      expect.objectContaining({
        scope: "career",
        key: "user-1",
        fields: [
          "career_points",
          "career_exact_hits",
          "career_level",
          "career_best_level",
        ],
      }),
      expect.objectContaining({
        scope: "season_stats",
        key: "user-1:2026_2027",
        fields: ["points", "exact_hits", "level", "best_level"],
      }),
      expect.objectContaining({
        scope: "ranking",
        key: "week:2026-W32:user-1",
        fields: [
          "period_score",
          "valid_predictions",
          "wdl_hits",
          "exact_hits",
          "last_scoring_match_at",
          "global_rank",
        ],
      }),
    ]);
    expect(input.career[0]?.actual.career_points).toBe(3);
  });

  it("skips affected users and periods for active settlements", () => {
    const input = baseInput();
    input.rankings.push({
      period_type: "week",
      period_key: "2026-W32",
      user_id: "user-2",
      actual: {
        period_score: 6,
        valid_predictions: 2,
        wdl_hits: 1,
        exact_hits: 0,
        last_scoring_match_at: NOW,
        global_rank: 2,
      },
      expected: {
        period_score: 6,
        valid_predictions: 2,
        wdl_hits: 1,
        exact_hits: 0,
        last_scoring_match_at: NOW,
        global_rank: 1,
      },
    });
    input.active_settlements = [
      {
        match_id: "match-1",
        user_ids: ["user-1"],
        season_id: "2026_2027",
        periods: [{ period_type: "week", period_key: "2026-W32" }],
      },
    ];

    const result = checkDailyConsistency(input);

    expect(result.differences).toEqual([]);
    expect(result.skipped_active_settlement).toEqual([
      {
        kind: "skipped_active_settlement",
        match_id: "match-1",
        user_ids: ["user-1"],
        season_id: "2026_2027",
        periods: [{ period_type: "week", period_key: "2026-W32" }],
      },
    ]);
  });

  it("does not skip unrelated users or periods", () => {
    const input = baseInput();
    input.career.push({
      user_id: "user-2",
      actual: input.career[0]!.actual,
      expected: {
        ...input.career[0]!.actual,
        career_points: 9,
      },
    });
    input.active_settlements = [
      {
        match_id: "match-1",
        user_ids: ["user-1"],
        season_id: "2026_2027",
        periods: [{ period_type: "week", period_key: "2026-W32" }],
      },
    ];

    const result = checkDailyConsistency(input);

    expect(result.differences).toHaveLength(1);
    expect(result.differences[0]).toMatchObject({
      scope: "career",
      key: "user-2",
      fields: ["career_points"],
    });
  });

  it("reports career and strength snapshot differences without mutating caches", () => {
    const input = baseInput();
    input.board_snapshots = [
      {
        board: "career",
        snapshot_at: NOW,
        user_id: "user-1",
        actual: {
          rank: 2,
          career_points: 3,
          career_exact_hits: 0,
          career_valid_predictions: 1,
          career_last_scoring_match_at: null,
          window_score_sum: null,
          window_n: null,
        },
        expected: {
          rank: 1,
          career_points: 12,
          career_exact_hits: 1,
          career_valid_predictions: 1,
          career_last_scoring_match_at: NOW,
          window_score_sum: null,
          window_n: null,
        },
      },
      {
        board: "strength",
        snapshot_at: NOW,
        user_id: "user-2",
        actual: {
          rank: 1,
          career_points: null,
          career_exact_hits: null,
          career_valid_predictions: null,
          career_last_scoring_match_at: null,
          window_score_sum: 250,
          window_n: 50,
        },
        expected: {
          rank: 2,
          career_points: null,
          career_exact_hits: null,
          career_valid_predictions: null,
          career_last_scoring_match_at: null,
          window_score_sum: 240,
          window_n: 50,
        },
      },
    ];

    const result = checkDailyConsistency(input);

    expect(result.differences).toContainEqual(expect.objectContaining({
      scope: "board_snapshot",
      key: `career:${NOW.toISOString()}:user-1`,
      fields: expect.arrayContaining(["rank", "career_points"]),
    }));
    expect(result.differences).toContainEqual(expect.objectContaining({
      scope: "board_snapshot",
      key: `strength:${NOW.toISOString()}:user-2`,
      fields: expect.arrayContaining(["rank", "window_score_sum"]),
    }));
    expect(input.board_snapshots[0]?.actual.career_points).toBe(3);
  });

  it("skips active-settlement users in snapshot comparisons", () => {
    const input = baseInput();
    input.board_snapshots = [{
      board: "career",
      snapshot_at: NOW,
      user_id: "user-1",
      actual: {
        rank: 2,
        career_points: 3,
        career_exact_hits: 0,
        career_valid_predictions: 1,
        career_last_scoring_match_at: null,
        window_score_sum: null,
        window_n: null,
      },
      expected: {
        rank: 1,
        career_points: 12,
        career_exact_hits: 1,
        career_valid_predictions: 1,
        career_last_scoring_match_at: NOW,
        window_score_sum: null,
        window_n: null,
      },
    }];
    input.active_settlements = [{
      match_id: "match-1",
      user_ids: ["user-1"],
      season_id: "2026_2027",
      periods: [{ period_type: "week", period_key: "2026-W32" }],
    }];

    const result = checkDailyConsistency(input);

    expect(result.differences.some((difference) => difference.scope === "board_snapshot"))
      .toBe(false);
  });
});
