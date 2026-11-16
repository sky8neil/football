import { describe, expect, it } from "vitest";
import { InMemoryRepository, type AppRepository } from "../infrastructure/repositories.js";
import { PersonalLeagueSummaryService } from "./personal-league-summary-service.js";
import { match, now, prediction, season, user } from "./league-summary-fixtures.test-helper.js";

describe("PersonalLeagueSummaryService", () => {
  it("reports open or missing seasons as unavailable", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(user());
    await repo.leagueSeasons.insert(season("2025_2026"));
    await repo.matches.insert(match("game"));
    const service = new PersonalLeagueSummaryService(repo);
    expect(await service.get("user", "premier_league", undefined, now)).toMatchObject({ availability: "not_available", season_id: "2025_2026", reason: "not_available", summary: null });
    expect(await service.get("user", "premier_league", "2024_2025", now)).toMatchObject({ availability: "not_available", season_id: "2024_2025" });
    expect(await service.get("user", "la_liga", undefined, now)).toMatchObject({ availability: "not_available", season_id: null });
  });
  it("returns the completed season until the new season starts and supports explicit history", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(user());
    await repo.leagueSeasons.insert(season("2025_2026", "completed", { completion_confirmed_at: new Date("2026-04-20T00:00:00Z") }));
    await repo.leagueSeasons.insert(season("2026_2027"));
    await repo.matches.insert(match("old"));
    await repo.matches.insert(match("replacement", { canonical_match_id: "old" }));
    await repo.matches.update(match("old", { superseded_by: "replacement" }));
    await repo.predictions.insert(prediction("old", { wdl_hit: true, exact_hit: true, applied_result_version: 0 }));
    await repo.matches.insert(match("second"));
    await repo.predictions.insert(prediction("second", { wdl_hit: true }));
    await repo.matches.insert(match("next", { season_id: "2026_2027", match_status: "scheduled", kickoff_at: new Date("2026-08-01T00:00:00Z") }));
    await repo.predictions.insert(prediction("next", { wdl_hit: true, exact_hit: true }));
    const service = new PersonalLeagueSummaryService(repo);
    const expected = { availability: "available", league_id: "premier_league", season_id: "2025_2026", reason: null,
      completion_confirmed_at: "2026-04-20T00:00:00.000Z", ended_at: null,
      summary: { predicted_matches: 2, wdl_hits: 2, exact_hits: 1, is_provisional: true } };
    expect(await service.get("user", "premier_league", undefined, now)).toEqual(expected);
    await repo.matches.update(match("next", { season_id: "2026_2027", match_status: "live" }));
    expect(await service.get("user", "premier_league", undefined, now)).toMatchObject({
      availability: "not_available", season_id: "2026_2027", summary: null, completion_confirmed_at: null, ended_at: null,
    });
    expect(await service.get("user", "premier_league", "2025_2026", now)).toEqual(expected);
    await repo.predictions.update(prediction("old", { wdl_hit: true, exact_hit: true }));
    expect(await service.get("user", "premier_league", "2025_2026", now)).toMatchObject({ summary: { ...expected.summary, is_provisional: false } });
  });
  it("validates identity, league and season shape in order", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(user());
    const service = new PersonalLeagueSummaryService(repo);
    await expect(service.get("missing", "missing", undefined, now)).rejects.toMatchObject({ code: "user_NOT_FOUND", message: expect.stringContaining("user") });
    await expect(service.get("user", "missing", undefined, now)).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "league_id" });
    for (const id of ["2026", "2026_27", "bad"]) {
      await expect(service.get("user", "premier_league", id, now)).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "season_id" });
    }
    await expect(service.get("user", "chinese_super_league", "2025_2026", now)).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "season_id" });
  });
  it("returns data_conflict for duplicate canonical predictions", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(user());
    await repo.leagueSeasons.insert(season("2025_2026", "completed"));
    await repo.matches.insert(match("game"));
    const duplicate = prediction("duplicate", { canonical_match_id: "game" });
    const conflictingRepo: AppRepository = Object.create(repo) as AppRepository;
    Object.defineProperty(conflictingRepo, "predictions", { value: { ...repo.predictions,
      findByUserAndCanonicalMatchIds: async () => [prediction("game"), duplicate] } });
    expect(await new PersonalLeagueSummaryService(conflictingRepo).get("user", "premier_league", "2025_2026", now))
      .toMatchObject({ availability: "not_available", reason: "data_conflict", summary: null });
  });
});
