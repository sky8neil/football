import { describe, expect, it } from "vitest";
import { SUMMARY_UPCOMING_WINDOW_DAYS } from "./config.js";
import { evaluateLeaguePhase, summarizePersonalLeague, type LeaguePhaseInput, type PersonalLeagueSummaryInput } from "./league-season-summary.js";
import type { LeagueSeason, Match, Prediction } from "./types.js";

const now = new Date("2026-05-01T12:00:00Z");
const day = 86_400_000;
const at = (days: number) => new Date(now.getTime() + days * day);
const season = (seasonId: string, completionStatus: LeagueSeason["completion_status"] = "open"): LeagueSeason => ({
  schema_version: 1, league_id: "premier_league", season_id: seasonId,
  format: { kind: "double_round_robin", team_count: 2, round_count: 2 },
  schedule_status: "locked", completion_status: completionStatus, completion_confirmed_at: null,
  reopened_at: null, reopen_count: 0, ended_at: null, manual_override: null, created_at: now, updated_at: now,
});
const match = (id: string, overrides: Partial<Match> = {}): Match => ({
  schema_version: 1, match_id: id, canonical_match_id: id, superseded_by: null,
  league_id: "premier_league", season_id: "2025_2026", round_id: id, home_team_id: "home", away_team_id: "away",
  kickoff_at: at(-1), kickoff_confirmed: true, prediction_deadline_at: null, prediction_closed_at: null,
  period_anchor_at: null, match_status: "finished", settlement_status: "settled",
  regular_home_score: 1, regular_away_score: 0, extra_home_score: null, extra_away_score: null,
  penalty_home_score: null, penalty_away_score: null, result_version: 1, settled_result_version: 1,
  result_source: null, scoring_rule_version: "scoring_v1", finish_detected_at: null, settled_at: null,
  created_at: now, updated_at: now, ...overrides,
});
const prediction = (id: string, overrides: Partial<Prediction> = {}): Prediction => ({
  schema_version: 1, prediction_id: id, user_id: "user", match_id: id, canonical_match_id: id,
  idempotency_key: id, pred_home_score: 1, pred_away_score: 0, derived_result: "HOME", submitted_at: now,
  scoring_rule_version: "scoring_v1", match_score: null, wdl_hit: false, exact_hit: false,
  applied_result_version: 1, created_at: now, updated_at: now, ...overrides,
});
const games = Array.from({ length: 10 }, (_, index) => match(String(index)));
const picks = games.map((game, index) => prediction(game.match_id, { wdl_hit: index < 6, exact_hit: index < 2 }));
const summaryInput = (overrides: Partial<PersonalLeagueSummaryInput> = {}): PersonalLeagueSummaryInput => ({
  leagueId: "premier_league", seasonId: "2025_2026", userId: "user", season: season("2025_2026", "completed"),
  matches: games, predictions: picks, ...overrides,
});
const phaseInput = (overrides: Partial<LeaguePhaseInput> = {}): LeaguePhaseInput => ({
  leagueId: "premier_league", seasons: [season("2025_2026")], matches: [], now,
  upcomingWindowDays: SUMMARY_UPCOMING_WINDOW_DAYS, ...overrides,
});

describe("personal league summary", () => {
  it("counts 10 predictions, 6 WDL hits and 2 exact hits without double counting", () => {
    const result = summarizePersonalLeague(summaryInput());
    expect(result).toEqual({ availability: "available", reason: null, predicted_matches: 10, wdl_hits: 6,
      exact_hits: 2, is_provisional: false, has_duplicate_predictions: false });
    expect(result.exact_hits).toBeLessThanOrEqual(result.wdl_hits);
  });
  it("includes postponed and abandoned games without inventing hits", () => {
    const matches = games.map((game, index) => index === 8 ? { ...game, match_status: "postponed" as const }
      : index === 9 ? { ...game, match_status: "abandoned" as const } : game);
    const predictions = picks.map((pick, index) => index >= 8 ? { ...pick, wdl_hit: null, exact_hit: null } : pick);
    expect(summarizePersonalLeague(summaryInput({ matches, predictions }))).toMatchObject({ predicted_matches: 10, wdl_hits: 6, exact_hits: 2 });
  });
  it("does not publish an open season", () => {
    expect(summarizePersonalLeague(summaryInput({ season: season("2025_2026") }))).toMatchObject({
      availability: "not_available", reason: "season_not_completed", predicted_matches: 0, wdl_hits: 0, exact_hits: 0,
    });
  });
  it("counts a rescheduled logical match once even when the prediction points to the old record", () => {
    const old = match("old", { canonical_match_id: "0", superseded_by: "0", match_status: "postponed" });
    const predictions = picks.map((pick, index) => index === 0 ? { ...pick, match_id: "old" } : pick);
    expect(summarizePersonalLeague(summaryInput({ matches: [old, ...games], predictions }))).toMatchObject({
      availability: "available", predicted_matches: 10, wdl_hits: 6, exact_hits: 2,
    });
  });
  it("excludes predictions by other users or for other leagues and seasons", () => {
    const foreignMatches = [match("other-league", { league_id: "la_liga" }), match("other-season", { season_id: "2026_2027" })];
    const predictions = [...picks, prediction("other-league", { wdl_hit: true }), prediction("other-season", { wdl_hit: true }),
      prediction("0", { user_id: "other", wdl_hit: true })];
    expect(summarizePersonalLeague(summaryInput({ matches: [...games, ...foreignMatches], predictions }))).toMatchObject({
      availability: "available", predicted_matches: 10, wdl_hits: 6, exact_hits: 2, has_duplicate_predictions: false,
    });
  });
  it("blocks duplicate predictions instead of combining or selecting hits", () => {
    const duplicate = prediction("duplicate", { canonical_match_id: "0", wdl_hit: false, exact_hit: false });
    expect(summarizePersonalLeague(summaryInput({ predictions: [...picks, duplicate] }))).toEqual({
      availability: "not_available", reason: "data_conflict", predicted_matches: 0, wdl_hits: 0, exact_hits: 0,
      is_provisional: false, has_duplicate_predictions: true,
    });
  });
  it("marks stale applied versions provisional using the maximum across rescheduled records", () => {
    const old = match("old", { canonical_match_id: "0", superseded_by: "0", result_version: 3 });
    expect(summarizePersonalLeague(summaryInput({ matches: [old, ...games] })).is_provisional).toBe(true);
    expect(summarizePersonalLeague(summaryInput()).is_provisional).toBe(false);
  });
  it.each(["settling", "correcting"] as const)("marks %s settlements provisional", (settlement_status) => {
    expect(summarizePersonalLeague(summaryInput({ matches: [{ ...games[0]!, settlement_status }, ...games.slice(1)] })).is_provisional).toBe(true);
  });
  it("returns zero for a user with no predictions", () => {
    expect(summarizePersonalLeague(summaryInput({ predictions: [] }))).toMatchObject({
      availability: "available", predicted_matches: 0, wdl_hits: 0, exact_hits: 0, is_provisional: false,
    });
  });
});

describe("league phase", () => {
  it("recognizes live matches even after kickoff and ignores superseded matches", () => {
    const live = match("live", { match_status: "live", kickoff_at: at(-1) });
    expect(evaluateLeaguePhase(phaseInput({ matches: [live] }))).toMatchObject({ phase: "in_season", has_live_match: true });
    expect(evaluateLeaguePhase(phaseInput({ matches: [{ ...live, superseded_by: "new" }] }))).toMatchObject({ phase: "break", active_season_id: null, has_live_match: false });
  });
  it.each([0, 14])("includes scheduled kickoff at day %s in the window", (days) => {
    expect(evaluateLeaguePhase(phaseInput({ matches: [match("future", { match_status: "scheduled", kickoff_at: at(days) })] })))
      .toMatchObject({ phase: "in_season", active_season_id: "2025_2026", next_kickoff_at: at(days) });
  });
  it("reports break but retains the next kickoff outside the window", () => {
    expect(evaluateLeaguePhase(phaseInput({ matches: [match("later", { match_status: "scheduled", kickoff_at: at(15) })] })))
      .toMatchObject({ phase: "break", active_season_id: "2025_2026", next_kickoff_at: at(15) });
  });
  it("reports completed with no next season schedule", () => {
    expect(evaluateLeaguePhase(phaseInput({ seasons: [season("2025_2026", "completed"), season("2026_2027")], matches: [games[0]!] })))
      .toMatchObject({ phase: "completed", active_season_id: "2025_2026", next_season_kickoff_at: null });
  });
  it("retains the completed season when the next season schedule is announced but not started", () => {
    const next = match("next", { season_id: "2026_2027", match_status: "scheduled", kickoff_at: at(20) });
    const makeup = match("makeup", { match_status: "scheduled", kickoff_at: at(3) });
    expect(evaluateLeaguePhase(phaseInput({ seasons: [season("2026_2027"), season("2025_2026", "completed")], matches: [games[0]!, next, makeup] })))
      .toMatchObject({ phase: "between_seasons", active_season_id: "2025_2026", next_kickoff_at: at(3), next_season_kickoff_at: at(20) });
  });
  it.each(["live", "finished"] as const)("selects the new season after a %s match actually starts", (match_status) => {
    const next = match("next", { season_id: "2026_2027", match_status, kickoff_at: at(-1) });
    expect(evaluateLeaguePhase(phaseInput({ seasons: [season("2025_2026", "completed"), season("2026_2027")], matches: [games[0]!, next] })))
      .toMatchObject({ phase: match_status === "live" ? "in_season" : "break", active_season_id: "2026_2027" });
  });
  it("does not treat a past scheduled kickoff as actual start", () => {
    const next = match("next", { season_id: "2026_2027", match_status: "scheduled", kickoff_at: at(-1) });
    expect(evaluateLeaguePhase(phaseInput({ seasons: [season("2025_2026", "completed"), season("2026_2027")], matches: [games[0]!, next] })))
      .toMatchObject({ phase: "between_seasons", active_season_id: "2025_2026", next_season_kickoff_at: null });
  });
  it("returns break and no active season when no match records exist", () => {
    expect(evaluateLeaguePhase(phaseInput())).toEqual({ phase: "break", active_season_id: null, has_live_match: false, next_kickoff_at: null, next_season_kickoff_at: null });
  });
});
