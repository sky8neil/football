import { describe, expect, it, vi } from "vitest";
import { MatchStatus, SettlementStatus } from "../../domain/enums.js";
import { DomainError } from "../../domain/errors.js";
import { newUuid } from "../../domain/ids.js";
import type { Match } from "../../domain/types.js";
import { InMemoryRepository } from "../../infrastructure/repositories.js";
import { formatSeasonLabel, getLeagueSeasons } from "./league-seasons.js";

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
  await repo.matches.insert(makeMatch({
    league_id: "premier_league", season_id: "2025_2026", round_id: "03",
  }));
  await repo.matches.insert(makeMatch({
    league_id: "premier_league", season_id: "2025_2026", round_id: "01",
  }));
  await repo.matches.insert(makeMatch({
    league_id: "premier_league", season_id: "2026_2027", round_id: "02",
  }));
  await repo.matches.insert(makeMatch({
    league_id: "bundesliga", season_id: "2026_2027", round_id: "01",
  }));
  await repo.matches.insert(makeMatch({
    league_id: "bundesliga", season_id: "2024_2025", round_id: "10",
  }));
  await repo.matches.insert(makeMatch({
    league_id: "chinese_super_league", season_id: "2026", round_id: "01",
  }));
  await repo.matches.insert(makeMatch({
    league_id: "chinese_super_league", season_id: "2024", round_id: "08",
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

describe("GET /v1/league-seasons", () => {
  it("returns the full catalog ordered by league_id asc and season_id desc", async () => {
    const repo = new InMemoryRepository();
    await seedCatalog(repo);
    const response = await getLeagueSeasons(repo, { query: {}, request_id: "req-all" });
    expect(response).toEqual({
      status: 200,
      body: {
        data: {
          items: [
            {
              league_id: "bundesliga",
              season_id: "2026_2027",
              season_label: "2026/2027",
              round_ids: ["01"],
            },
            {
              league_id: "bundesliga",
              season_id: "2024_2025",
              season_label: "2024/2025",
              round_ids: ["10"],
            },
            {
              league_id: "chinese_super_league",
              season_id: "2026",
              season_label: "2026",
              round_ids: ["01"],
            },
            {
              league_id: "chinese_super_league",
              season_id: "2024",
              season_label: "2024",
              round_ids: ["08"],
            },
            {
              league_id: "premier_league",
              season_id: "2026_2027",
              season_label: "2026/2027",
              round_ids: ["02"],
            },
            {
              league_id: "premier_league",
              season_id: "2025_2026",
              season_label: "2025/2026",
              round_ids: ["01", "03"],
            },
          ],
        },
        request_id: "req-all",
      },
    });
  });

  it("filters by league_id", async () => {
    const repo = new InMemoryRepository();
    await seedCatalog(repo);
    const response = await getLeagueSeasons(repo, {
      query: { league_id: "premier_league" },
      request_id: "req-one",
    });
    expect(response.body.data.items).toEqual([
      {
        league_id: "premier_league",
        season_id: "2026_2027",
        season_label: "2026/2027",
        round_ids: ["02"],
      },
      {
        league_id: "premier_league",
        season_id: "2025_2026",
        season_label: "2025/2026",
        round_ids: ["01", "03"],
      },
    ]);
  });

  it("rejects unsupported league_id with VALIDATION_ERROR", async () => {
    const repo = new InMemoryRepository();
    await expect(getLeagueSeasons(repo, {
      query: { league_id: "nba" },
      request_id: "req-bad",
    })).rejects.toEqual(expect.objectContaining({
      name: "DomainError",
      code: "VALIDATION_ERROR",
      details: { field: "league_id" },
    }));
    await expect(getLeagueSeasons(repo, {
      query: { league_id: "nba" },
      request_id: "req-bad",
    })).rejects.toBeInstanceOf(DomainError);
  });

  it("formats season_label for cross-year and calendar seasons", () => {
    expect(formatSeasonLabel("2025_2026")).toBe("2025/2026");
    expect(formatSeasonLabel("2026")).toBe("2026");
  });

  it("keeps seasons from two seasons ago in the catalog", async () => {
    const repo = new InMemoryRepository();
    await seedCatalog(repo);
    const response = await getLeagueSeasons(repo, { query: {}, request_id: "req-hist" });
    expect(response.body.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        league_id: "bundesliga",
        season_id: "2024_2025",
        season_label: "2024/2025",
      }),
      expect.objectContaining({
        league_id: "chinese_super_league",
        season_id: "2024",
        season_label: "2024",
      }),
    ]));
  });

  it("does not read predictions", async () => {
    const repo = new InMemoryRepository();
    await seedCatalog(repo);
    const spies = spyPredictionMethods(repo);
    await getLeagueSeasons(repo, { query: {}, request_id: "req-spy" });
    await getLeagueSeasons(repo, { query: { league_id: "premier_league" }, request_id: "req-spy-2" });
    for (const spy of Object.values(spies)) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
