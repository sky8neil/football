import { describe, expect, it } from "vitest";
import type { Match, Prediction } from "../domain/types.js";
import { planIdentityMigration } from "./match-identity-migration.js";

const match = (match_id: string, match_status = "finished", overrides: Record<string, unknown> = {}): Match => ({
  match_id, match_status, canonical_match_id: match_id, superseded_by: null,
  league_id: "league", season_id: "season", home_team_id: "home", away_team_id: "away", ...overrides,
} as unknown as Match);
const prediction = (prediction_id: string, match_id: string, overrides: Record<string, unknown> = {}): Prediction => ({
  prediction_id, match_id, user_id: prediction_id, canonical_match_id: match_id, ...overrides,
} as Prediction);
const mergeMatches = () => [match("old", "postponed"), match("final")];

describe("planIdentityMigration", () => {
  it("leaves complete independent identities unchanged", () => {
    expect(planIdentityMigration({ matches: [match("one")], predictions: [prediction("p", "one")] })).toEqual({ match_updates: [], prediction_updates: [], review: [] });
  });
  it("merges one postponed match into the sole finished match with evidence", () => {
    const plan = planIdentityMigration({ matches: mergeMatches(), predictions: [] });
    expect(plan.review).toEqual([]);
    expect(plan.match_updates).toEqual([expect.objectContaining({ match_id: "old", after: { canonical_match_id: "final", superseded_by: "final" }, reasons: [expect.stringContaining("唯一 finished final")] })]);
  });
  it.each([
    ["two finished", [match("a"), match("b")], "多条 finished"],
    ["no finished", [match("a", "postponed"), match("b", "postponed")], "无 finished"],
    ["cancelled", [match("a"), match("b", "cancelled")], "cancelled"],
  ])("reviews %s without updates", (_name, matches, evidence) => {
    const plan = planIdentityMigration({ matches: matches as Match[], predictions: [] });
    expect(plan.match_updates).toEqual([]);
    expect(plan.review).toEqual([expect.objectContaining({ kind: "ambiguous_identity", details: expect.stringContaining(evidence) })]);
  });
  it("backfills only missing identity fields and preserves existing values", () => {
    const matches = [match("one", "finished", { canonical_match_id: undefined, superseded_by: undefined }), match("two", "finished", { home_team_id: "other", canonical_match_id: "confirmed" })];
    expect(planIdentityMigration({ matches, predictions: [] }).match_updates).toEqual([expect.objectContaining({ match_id: "one", before: { canonical_match_id: null, superseded_by: null }, after: { canonical_match_id: "one", superseded_by: null }, reasons: ["backfill_canonical", "backfill_superseded"] })]);
  });
  it("updates missing and incorrect prediction identities to the planned identity", () => {
    const plan = planIdentityMigration({ matches: mergeMatches(), predictions: [prediction("p1", "old", { canonical_match_id: undefined }), prediction("p2", "final", { canonical_match_id: "incorrect" })] });
    expect(plan.prediction_updates).toEqual([expect.objectContaining({ prediction_id: "p1", after_canonical_match_id: "final", reasons: expect.any(Array) }), expect.objectContaining({ prediction_id: "p2", after_canonical_match_id: "final" })]);
  });
  it("reviews duplicate predictions without choosing either update", () => {
    const plan = planIdentityMigration({ matches: mergeMatches(), predictions: [prediction("p1", "old", { user_id: "user" }), prediction("p2", "final", { user_id: "user", canonical_match_id: undefined })] });
    expect(plan.prediction_updates).toEqual([]);
    expect(plan.review).toEqual([expect.objectContaining({ kind: "duplicate_prediction", key: { user_id: "user", canonical_match_id: "final" } })]);
  });
  it("reviews predictions with a missing match", () => {
    const plan = planIdentityMigration({ matches: [], predictions: [prediction("p", "missing")] });
    expect(plan.prediction_updates).toEqual([]);
    expect(plan.review).toEqual([expect.objectContaining({ kind: "dangling_prediction_match", key: { prediction_id: "p", match_id: "missing" } })]);
  });
  it("is idempotent after applying the plan in memory", () => {
    const matches = mergeMatches();
    const predictions = [prediction("p", "old", { canonical_match_id: undefined })];
    const plan = planIdentityMigration({ matches, predictions });
    for (const update of plan.match_updates) Object.assign(matches.find((item) => item.match_id === update.match_id)!, update.after);
    for (const update of plan.prediction_updates) predictions.find((item) => item.prediction_id === update.prediction_id)!.canonical_match_id = update.after_canonical_match_id;
    expect(planIdentityMigration({ matches, predictions })).toEqual({ match_updates: [], prediction_updates: [], review: [] });
  });
  it("reviews an incoming supersession that cannot be safely redirected", () => {
    const plan = planIdentityMigration({ matches: [...mergeMatches(), match("older", "postponed", { canonical_match_id: "old", superseded_by: "old" })], predictions: [] });
    expect(plan.match_updates).toEqual([]);
    expect(plan.review).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "ambiguous_identity", details: expect.stringContaining("入向") })]));
  });
});
