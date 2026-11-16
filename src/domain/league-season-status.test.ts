import { describe, expect, it } from "vitest";
import { evaluateLeagueSeason, type EvaluateInput, type StatusMatchInput } from "./league-season-status.js";

const now = new Date("2026-05-01T00:00:00Z");
const match = (id: string, home: string, away: string, status: StatusMatchInput["match_status"] = "finished"): StatusMatchInput => ({
  match_id: id, canonical_match_id: id, superseded_by: null, round_id: id, home_team_id: home, away_team_id: away, match_status: status,
});
const games = [match("1", "a", "b"), match("2", "b", "a")];
const input = (overrides: Partial<EvaluateInput> = {}): EvaluateInput => ({
  format: { kind: "double_round_robin", team_count: 2, round_count: 2 }, teamIds: ["a", "b"], matches: games, previous: null, now, ...overrides,
});

describe("league season status", () => {
  it("keeps incomplete team and pair sets open", () => {
    expect(evaluateLeagueSeason(input({ teamIds: [], matches: [] }))).toMatchObject({ schedule_status: "uninitialized", completion_status: "open", reason: "uninitialized" });
    expect(evaluateLeagueSeason(input({ format: { kind: "double_round_robin", team_count: 3, round_count: 4 } }))).toMatchObject({ schedule_status: "partial", reason: "missing_teams" });
    expect(evaluateLeagueSeason(input({ matches: games.slice(0, 1) }))).toMatchObject({ schedule_status: "partial", completion_status: "open", reason: "missing_pairs" });
  });
  it.each(["scheduled", "live", "postponed"] as const)("keeps %s matches open", (status) => {
    expect(evaluateLeagueSeason(input({ matches: [games[0]!, { ...games[1]!, match_status: status }] }))).toMatchObject({ schedule_status: "locked", completion_status: "open", reason: "non_terminal" });
  });
  it("ignores superseded postponed matches and accepts terminal cancellations", () => {
    const ignored = { ...match("old", "a", "b", "postponed"), superseded_by: "1" };
    expect(evaluateLeagueSeason(input({ matches: [{ ...games[0]!, match_status: "cancelled" }, { ...games[1]!, match_status: "abandoned" }, ignored] }))).toMatchObject({ completion_status: "completed", completion_confirmed_at: now });
  });
  it("blocks unconfirmed duplicates even when terminal", () => {
    const duplicate = { ...games[0]!, match_id: "duplicate", canonical_match_id: "duplicate" };
    expect(evaluateLeagueSeason(input({ matches: [...games, duplicate] }))).toMatchObject({ completion_status: "open", reason: "unconfirmed_duplicate" });
    expect(evaluateLeagueSeason(input({ matches: [...games, { ...duplicate, canonical_match_id: "1" }] })).completion_status).toBe("completed");
  });
  it("reopens on an additional unfinished match and preserves the first confirmation through recompletion", () => {
    const first = evaluateLeagueSeason(input());
    const later = new Date(now.getTime() + 1000);
    const extra = match("3", "a", "b", "scheduled");
    const reopened = evaluateLeagueSeason(input({ matches: [...games, extra], previous: first, now: later }));
    expect(reopened).toMatchObject({ completion_status: "open", completion_confirmed_at: now, reopened_at: later, reopen_count: 1, reason: "reopened" });
    const finished = evaluateLeagueSeason(input({ matches: [...games, { ...extra, match_status: "finished" }], previous: reopened, now: new Date(later.getTime() + 1000) }));
    expect(finished).toMatchObject({ completion_status: "completed", completion_confirmed_at: now, reopened_at: later, reopen_count: 1 });
  });
  it("supports unordered single round robin pairs and custom schedules", () => {
    expect(evaluateLeagueSeason(input({ format: { kind: "single_round_robin", team_count: 2, round_count: 1 }, matches: [games[1]!] })).completion_status).toBe("completed");
    expect(evaluateLeagueSeason(input({ format: { kind: "custom", team_count: 2, round_count: 5 }, matches: [games[0]!] })).completion_status).toBe("completed");
  });
});
