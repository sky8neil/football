import { describe, expect, it } from "vitest";
import { LevelHistoryReason, LevelScope, SCHEMA_VERSION } from "./enums.js";
import {
  assertLevelHistoryInvariants,
  assertMatchResultVersionInvariants,
  assertPredictionInvariants,
  assertRankingInvariants,
  assertSchemaVersion,
  assertSeasonStatsInvariants,
  assertSettlementDocumentInvariant,
  assertSettlementItemInvariant,
  assertUserCareerInvariants,
} from "./invariants.js";
import { newUuid } from "./ids.js";
import { defaultLevelState } from "./types.js";
import type {
  LevelHistoryEntry,
  Match,
  Prediction,
  RankingEntry,
  SettlementDoc,
  SettlementItem,
  User,
  UserSeasonStats,
} from "./types.js";

describe("LevelHistoryReason", () => {
  it("只暴露 weekly_eval、correction_reeval 与 rebuild", () => {
    expect(Object.keys(LevelHistoryReason)).toEqual([
      "WeeklyEval",
      "CorrectionReeval",
      "Rebuild",
    ]);
  });
});

describe("assertSchemaVersion（规范 2.5）", () => {
  it("接受固定 schema_version=1", () => {
    expect(() => assertSchemaVersion(SCHEMA_VERSION)).not.toThrow();
    expect(() => assertSchemaVersion(1)).not.toThrow();
  });

  it("拒绝 0、2、非整数与非数字，Fail Closed", () => {
    for (const value of [0, 2, 1.5, "1", null, undefined, NaN]) {
      expect(() => assertSchemaVersion(value as number)).toThrow(
        expect.objectContaining({ code: "INTERNAL_ERROR" }),
      );
    }
  });
});

describe("核心 invariant 入口强制 schema_version", () => {
  it("user career 拒绝非法 schema_version", () => {
    const user = {
      schema_version: 2,
      user_id: newUuid(),
      openid: "openid",
      unionid: null,
      nickname: null,
      favorite_team_id: null,
      status: "active",
      career_points: 0,
      career_valid_predictions: 0,
      career_wdl_hits: 0,
      career_exact_hits: 0,
      career_level: 1,
      career_best_level: 1,
      career_last_scoring_match_at: null,
      career_level_state: defaultLevelState(),
      deleted_at: null,
      created_at: new Date("2026-08-01T00:00:00Z"),
      updated_at: new Date("2026-08-01T00:00:00Z"),
    } as unknown as User;
    expect(() => assertUserCareerInvariants(user)).toThrow(
      expect.objectContaining({ code: "INTERNAL_ERROR" }),
    );
  });

  it("17.6 对称：season stats 拒绝 best_level < level，接受 best_level >= level", () => {
    const base = {
      schema_version: SCHEMA_VERSION,
      user_id: newUuid(),
      level_season_id: "2026_2027",
      points: 0,
      valid_predictions: 0,
      wdl_hits: 0,
      exact_hits: 0,
      level_state: defaultLevelState(),
      is_level_frozen: false,
      updated_at: new Date("2026-08-01T00:00:00Z"),
    };
    expect(() =>
      assertSeasonStatsInvariants({
        ...base,
        level: 4,
        best_level: 3,
      } as UserSeasonStats),
    ).toThrow(expect.objectContaining({ code: "INTERNAL_ERROR" }));
    expect(() =>
      assertSeasonStatsInvariants({
        ...base,
        level: 3,
        best_level: 3,
        valid_predictions: 20,
      } as UserSeasonStats),
    ).not.toThrow();
    expect(() =>
      assertSeasonStatsInvariants({
        ...base,
        level: 3,
        best_level: 5,
        valid_predictions: 20,
      } as UserSeasonStats),
    ).not.toThrow();
    expect(() =>
      assertSeasonStatsInvariants({
        ...base,
        level: 2,
        best_level: 2,
        valid_predictions: 19,
      } as UserSeasonStats),
    ).toThrow(expect.objectContaining({ code: "INTERNAL_ERROR" }));
  });

  it("§40 仅 rebuild 允许 level_history 跨级", () => {
    const entry: LevelHistoryEntry = {
      schema_version: SCHEMA_VERSION,
      level_history_id: newUuid(),
      user_id: newUuid(),
      scope: LevelScope.Career,
      level_season_id: null,
      from_level: 2,
      to_level: 5,
      reason: LevelHistoryReason.WeeklyEval,
      eval_as_of: new Date("2026-08-10T02:00:00Z"),
      window_n: 20,
      window_score_sum: 200,
      b_points: 300,
      level_rule_version: "level_v3.0",
      settlement_id: null,
      changed_at: new Date("2026-08-10T02:10:00Z"),
    };
    expect(() => assertLevelHistoryInvariants(entry)).toThrow(
      expect.objectContaining({ code: "INTERNAL_ERROR" }),
    );
    expect(() => assertLevelHistoryInvariants({ ...entry, reason: LevelHistoryReason.Rebuild }))
      .not.toThrow();
  });

  it("season stats / ranking / prediction / settlement / match 同样拒绝", () => {
    const season = {
      schema_version: 0,
      user_id: newUuid(),
      level_season_id: "2026_2027",
      points: 0,
      valid_predictions: 0,
      wdl_hits: 0,
      exact_hits: 0,
      level: 1,
      best_level: 1,
      updated_at: new Date("2026-08-01T00:00:00Z"),
    } as unknown as UserSeasonStats;
    expect(() => assertSeasonStatsInvariants(season)).toThrow(
      expect.objectContaining({ code: "INTERNAL_ERROR" }),
    );

    const ranking = {
      schema_version: 99,
      period_type: "week",
      period_key: "2026-W32",
      user_id: newUuid(),
      period_score: 0,
      valid_predictions: 0,
      wdl_hits: 0,
      exact_hits: 0,
      last_scoring_match_at: null,
      global_rank: null,
      is_final: false,
      updated_at: new Date("2026-08-01T00:00:00Z"),
    } as unknown as RankingEntry;
    expect(() => assertRankingInvariants(ranking)).toThrow(
      expect.objectContaining({ code: "INTERNAL_ERROR" }),
    );

    const prediction = {
      schema_version: 2,
      prediction_id: newUuid(),
      user_id: newUuid(),
      match_id: newUuid(),
      idempotency_key: newUuid(),
      home_score: 1,
      away_score: 0,
      derived_result: "HOME",
      rule_version: "scoring_v1",
      match_score: null,
      wdl_hit: null,
      exact_hit: null,
      applied_result_version: 0,
      submitted_at: new Date("2026-08-01T00:00:00Z"),
      updated_at: new Date("2026-08-01T00:00:00Z"),
    } as unknown as Prediction;
    expect(() => assertPredictionInvariants(prediction)).toThrow(
      expect.objectContaining({ code: "INTERNAL_ERROR" }),
    );

    const settlement = {
      schema_version: 0,
      settlement_id: newUuid(),
      match_id: newUuid(),
      result_version: 1,
      rule_version: "scoring_v1",
      is_correction: false,
      status: "pending",
      phase: "prepare",
      attempt_count: 0,
      started_at: null,
      finished_at: null,
      last_error_code: null,
      last_error_message: null,
      created_at: new Date("2026-08-01T00:00:00Z"),
      updated_at: new Date("2026-08-01T00:00:00Z"),
    } as unknown as SettlementDoc;
    expect(() => assertSettlementDocumentInvariant(settlement)).toThrow(
      expect.objectContaining({ code: "INTERNAL_ERROR" }),
    );

    const item = {
      schema_version: 2,
      settlement_id: newUuid(),
      prediction_id: newUuid(),
      user_id: newUuid(),
      old_score: 0,
      new_score: 3,
      score_delta: 3,
      old_wdl_hit: false,
      new_wdl_hit: true,
      old_exact_hit: false,
      new_exact_hit: false,
      valid_prediction_delta: 1,
      source_result_version: 1,
      status: "pending",
      applied_at: null,
      attempt_count: 0,
      last_error_code: null,
      last_error_message: null,
      created_at: new Date("2026-08-01T00:00:00Z"),
      updated_at: new Date("2026-08-01T00:00:00Z"),
    } as unknown as SettlementItem;
    expect(() => assertSettlementItemInvariant(item)).toThrow(
      expect.objectContaining({ code: "INTERNAL_ERROR" }),
    );

    const match = {
      schema_version: 2,
      match_id: newUuid(),
      league_id: "epl",
      season_id: "2026_2027",
      round_id: "01",
      home_team_id: newUuid(),
      away_team_id: newUuid(),
      kickoff_at: new Date("2026-08-09T12:00:00Z"),
      kickoff_confirmed: true,
      match_status: "scheduled",
      settlement_status: "pending",
      prediction_deadline_at: new Date("2026-08-09T11:50:00Z"),
      prediction_closed_at: null,
      period_anchor_at: null,
      finish_detected_at: null,
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
      created_at: new Date("2026-08-01T00:00:00Z"),
      updated_at: new Date("2026-08-01T00:00:00Z"),
    } as unknown as Match;
    expect(() => assertMatchResultVersionInvariants(match)).toThrow(
      expect.objectContaining({ code: "INTERNAL_ERROR" }),
    );
  });

  it("career/season 等级必须 1..6；career Lv2 起需有效预测>=20", () => {
    const userBase = {
      schema_version: SCHEMA_VERSION,
      user_id: newUuid(),
      openid: "openid",
      unionid: null,
      nickname: null,
      favorite_team_id: null,
      status: "active" as const,
      career_points: 0,
      career_valid_predictions: 19,
      career_wdl_hits: 0,
      career_exact_hits: 0,
      career_last_scoring_match_at: null,
      career_level: 2,
      career_best_level: 2,
      career_level_state: defaultLevelState(),
      deleted_at: null,
      created_at: new Date("2026-08-01T00:00:00Z"),
      updated_at: new Date("2026-08-01T00:00:00Z"),
    };
    expect(() => assertUserCareerInvariants(userBase as User)).toThrow(
      expect.objectContaining({ code: "INTERNAL_ERROR" }),
    );
    expect(() =>
      assertUserCareerInvariants({ ...userBase, career_valid_predictions: 20 } as User),
    ).not.toThrow();
    expect(() =>
      assertUserCareerInvariants({ ...userBase, career_level: 7, career_best_level: 7 } as User),
    ).toThrow(expect.objectContaining({ code: "INTERNAL_ERROR" }));
    expect(() =>
      assertUserCareerInvariants({
        ...userBase,
        career_level: 1,
        career_best_level: 1,
        career_valid_predictions: 0,
      } as User),
    ).not.toThrow();

    const season = {
      schema_version: SCHEMA_VERSION,
      user_id: newUuid(),
      level_season_id: "2026_2027",
      points: 0,
      valid_predictions: 0,
      wdl_hits: 0,
      exact_hits: 0,
      level: 8,
      best_level: 8,
      level_state: defaultLevelState(),
      is_level_frozen: false,
      created_at: new Date("2026-08-01T00:00:00Z"),
      updated_at: new Date("2026-08-01T00:00:00Z"),
    } as unknown as UserSeasonStats;
    expect(() => assertSeasonStatsInvariants(season)).toThrow(
      expect.objectContaining({ code: "INTERNAL_ERROR" }),
    );

    expect(() =>
      assertUserCareerInvariants({
        ...userBase,
        career_level: 1,
        career_best_level: 1,
        career_valid_predictions: 0,
        career_level_state: { ...defaultLevelState(), last_eval_n: 301 },
      } as User),
    ).toThrow(expect.objectContaining({ code: "INTERNAL_ERROR" }));
  });
});
