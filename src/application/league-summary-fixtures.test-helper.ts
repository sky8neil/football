import { defaultLevelState, type LeagueSeason, type Match, type Prediction, type User } from "../domain/types.js";

export const now = new Date("2026-05-01T12:00:00Z");
export const season = (seasonId: string, completionStatus: LeagueSeason["completion_status"] = "open", overrides: Partial<LeagueSeason> = {}): LeagueSeason => ({
  schema_version: 1, league_id: "premier_league", season_id: seasonId,
  format: { kind: "double_round_robin", team_count: 2, round_count: 2 }, schedule_status: "locked",
  completion_status: completionStatus, completion_confirmed_at: null, reopened_at: null, reopen_count: 0,
  ended_at: null, manual_override: null, created_at: now, updated_at: now, ...overrides,
});
export const match = (id: string, overrides: Partial<Match> = {}): Match => ({
  schema_version: 1, match_id: id, canonical_match_id: id, superseded_by: null,
  league_id: "premier_league", season_id: "2025_2026", round_id: id, home_team_id: "home", away_team_id: "away",
  kickoff_at: now, kickoff_confirmed: true, prediction_deadline_at: null, prediction_closed_at: null,
  period_anchor_at: null, match_status: "finished", settlement_status: "settled",
  regular_home_score: 1, regular_away_score: 0, extra_home_score: null, extra_away_score: null,
  penalty_home_score: null, penalty_away_score: null, result_version: 1, settled_result_version: 1,
  result_source: null, scoring_rule_version: "scoring_v1", finish_detected_at: null, settled_at: null,
  created_at: now, updated_at: now, ...overrides,
});
export const prediction = (id: string, overrides: Partial<Prediction> = {}): Prediction => ({
  schema_version: 1, prediction_id: id, user_id: "user", match_id: id, canonical_match_id: id,
  idempotency_key: id, pred_home_score: 1, pred_away_score: 0, derived_result: "HOME", submitted_at: now,
  scoring_rule_version: "scoring_v1", match_score: null, wdl_hit: false, exact_hit: false,
  applied_result_version: 1, created_at: now, updated_at: now, ...overrides,
});
export const user = (): User => ({
  schema_version: 1, user_id: "user", openid: "openid", unionid: null, nickname: "user", favorite_team_id: null,
  status: "active", career_points: 0, career_valid_predictions: 0, career_wdl_hits: 0, career_exact_hits: 0,
  career_last_scoring_match_at: null, career_level: 1, career_best_level: 1, career_level_state: defaultLevelState(),
  deleted_at: null, created_at: now, updated_at: now,
});
