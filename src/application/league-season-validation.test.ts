import { describe, expect, it, vi } from "vitest";
import { MatchStatus, SettlementStatus } from "../domain/enums.js";
import { DomainError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import type { Match } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import {
  assertLeagueSeasonAttached,
  isLeagueSeasonFormatValid,
} from "./league-season-validation.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");

function makeMatch(overrides: Partial<Match> = {}): Match {
  const matchId = overrides.match_id ?? newUuid();
  return {
    schema_version: 1,
    match_id: matchId,
    canonical_match_id: matchId,
    superseded_by: null,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: newUuid(),
    away_team_id: newUuid(),
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
  };
}

async function seedCatalog(repo: InMemoryRepository): Promise<void> {
  await repo.matches.insert(makeMatch({ season_id: "2026_2027" }));
  await repo.matches.insert(makeMatch({ season_id: "2025_2026" }));
  await repo.matches.insert(makeMatch({ season_id: "2024_2025" }));
  await repo.matches.insert(makeMatch({
    league_id: "chinese_super_league",
    season_id: "2026",
  }));
}

function spyPredictionMethods(repo: InMemoryRepository) {
  const original = repo.predictions;
  const spies = Object.fromEntries(
    Object.entries(original).map(([key, value]) => [
      key,
      typeof value === "function" ? vi.fn(value.bind(original)) : value,
    ]),
  ) as typeof original;
  Object.defineProperty(repo, "predictions", { configurable: true, get: () => spies });
  return spies;
}

describe("isLeagueSeasonFormatValid", () => {
  it("accepts consecutive YYYY_YYYY for cross-year leagues and YYYY for calendar leagues", () => {
    expect(isLeagueSeasonFormatValid("2026_2027", "2024_2025")).toBe(true);
    expect(isLeagueSeasonFormatValid("2026", "2024")).toBe(true);
    expect(isLeagueSeasonFormatValid("2026_2027", "2026")).toBe(false);
    expect(isLeagueSeasonFormatValid("2026", "2025_2026")).toBe(false);
  });
});

describe("assertLeagueSeasonAttached", () => {
  it("allows an attached season from two seasons ago", async () => {
    const repo = new InMemoryRepository();
    await seedCatalog(repo);
    await expect(assertLeagueSeasonAttached(repo, "premier_league", "2024_2025")).resolves.toEqual({
      league_id: "premier_league",
      season_id: "2024_2025",
      round_ids: ["01"],
    });
  });

  it("rejects a well-formed season missing from the catalog with NOT_ATTACHED", async () => {
    const repo = new InMemoryRepository();
    await seedCatalog(repo);
    await expect(assertLeagueSeasonAttached(repo, "premier_league", "2023_2024")).rejects.toEqual(
      expect.objectContaining({
        name: "DomainError",
        code: "VALIDATION_ERROR",
        details: { field: "season_id", reason: "NOT_ATTACHED" },
      }),
    );
    await expect(assertLeagueSeasonAttached(repo, "premier_league", "2023_2024")).rejects.toBeInstanceOf(DomainError);
  });

  it("rejects an illegal season format with FORMAT", async () => {
    const repo = new InMemoryRepository();
    await seedCatalog(repo);
    await expect(assertLeagueSeasonAttached(repo, "premier_league", "2026")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "season_id", reason: "FORMAT" },
    });
  });

  it("rejects an unsupported league with field league_id", async () => {
    const repo = new InMemoryRepository();
    await expect(assertLeagueSeasonAttached(repo, "nba", "2026_2027")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "league_id" },
    });
  });

  it("judges attachment from the catalog only and does not read predictions", async () => {
    const repo = new InMemoryRepository();
    await seedCatalog(repo);
    const spies = spyPredictionMethods(repo);
    await assertLeagueSeasonAttached(repo, "premier_league", "2024_2025");
    await expect(assertLeagueSeasonAttached(repo, "premier_league", "2023_2024")).rejects.toMatchObject({
      details: { reason: "NOT_ATTACHED" },
    });
    for (const spy of Object.values(spies)) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
