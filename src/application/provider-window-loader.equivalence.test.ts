import { describe, expect, it, vi } from "vitest";
import { SUPPORTED_LEAGUES } from "../domain/config.js";
import { MatchStatus, Provider, SettlementStatus, SyncJobType } from "../domain/enums.js";
import type { Match } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { makeApiFixture } from "../provider/fixture-factory.js";
import type { ApiFootballFixturesQuery } from "../provider/http.js";
import type { ApiFootballFixture } from "../provider/types.js";
import { activeWindow } from "./provider-active-window.js";
import { loadActiveWindowFixtures } from "./provider-window-loader.js";

const NOW = new Date("2026-10-11T12:00:00.000Z");
const HOUR = 60 * 60_000;
const JOBS = [SyncJobType.NearMatch, SyncJobType.LiveMatch, SyncJobType.PostFinishVerify] as const;
const LEAGUE_A = SUPPORTED_LEAGUES[0]!;
const LEAGUE_B = SUPPORTED_LEAGUES[5]!;

function makeMatch(overrides: Partial<Match> & Pick<Match, "match_id" | "league_id" | "season_id" | "kickoff_at">): Match {
  return {
    schema_version: 1,
    round_id: "01",
    home_team_id: "home",
    away_team_id: "away",
    kickoff_confirmed: true,
    prediction_deadline_at: overrides.kickoff_at,
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

const SEED: Array<{ match: Match; fixtureId: number }> = [
  {
    match: makeMatch({
      match_id: "pl-sched-2h-ago",
      league_id: LEAGUE_A.league_id,
      season_id: LEAGUE_A.season_id,
      kickoff_at: new Date(NOW.getTime() - 2 * HOUR),
    }),
    fixtureId: 11001,
  },
  {
    match: makeMatch({
      match_id: "pl-sched-1h",
      league_id: LEAGUE_A.league_id,
      season_id: LEAGUE_A.season_id,
      kickoff_at: new Date(NOW.getTime() + HOUR),
    }),
    fixtureId: 11002,
  },
  {
    match: makeMatch({
      match_id: "pl-sched-3h",
      league_id: LEAGUE_A.league_id,
      season_id: LEAGUE_A.season_id,
      kickoff_at: new Date(NOW.getTime() + 3 * HOUR),
    }),
    fixtureId: 11003,
  },
  {
    match: makeMatch({
      match_id: "pl-sched-12h",
      league_id: LEAGUE_A.league_id,
      season_id: LEAGUE_A.season_id,
      kickoff_at: new Date(NOW.getTime() + 12 * HOUR),
    }),
    fixtureId: 11004,
  },
  {
    match: makeMatch({
      match_id: "pl-sched-25h",
      league_id: LEAGUE_A.league_id,
      season_id: LEAGUE_A.season_id,
      kickoff_at: new Date(NOW.getTime() + 25 * HOUR),
    }),
    fixtureId: 11005,
  },
  {
    match: makeMatch({
      match_id: "pl-live",
      league_id: LEAGUE_A.league_id,
      season_id: LEAGUE_A.season_id,
      kickoff_at: NOW,
      match_status: MatchStatus.Live,
    }),
    fixtureId: 11006,
  },
  {
    match: makeMatch({
      match_id: "pl-fin-pending",
      league_id: LEAGUE_A.league_id,
      season_id: LEAGUE_A.season_id,
      kickoff_at: new Date(NOW.getTime() - 12 * HOUR),
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Pending,
      finish_detected_at: new Date(NOW.getTime() - 10 * HOUR),
    }),
    fixtureId: 11007,
  },
  {
    match: makeMatch({
      match_id: "pl-fin-waiting",
      league_id: LEAGUE_A.league_id,
      season_id: LEAGUE_A.season_id,
      kickoff_at: new Date(NOW.getTime() - 6 * HOUR),
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Waiting,
      finish_detected_at: new Date(NOW.getTime() - 4 * HOUR),
    }),
    fixtureId: 11008,
  },
  {
    match: makeMatch({
      match_id: "pl-fin-settled",
      league_id: LEAGUE_A.league_id,
      season_id: LEAGUE_A.season_id,
      kickoff_at: new Date(NOW.getTime() - 12 * HOUR),
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Settled,
      finish_detected_at: new Date(NOW.getTime() - 10 * HOUR),
    }),
    fixtureId: 11009,
  },
  {
    match: makeMatch({
      match_id: "csl-sched-3h",
      league_id: LEAGUE_B.league_id,
      season_id: LEAGUE_B.season_id,
      kickoff_at: new Date(NOW.getTime() + 3 * HOUR),
    }),
    fixtureId: 22001,
  },
  {
    match: makeMatch({
      match_id: "csl-live",
      league_id: LEAGUE_B.league_id,
      season_id: LEAGUE_B.season_id,
      kickoff_at: NOW,
      match_status: MatchStatus.Live,
    }),
    fixtureId: 22002,
  },
  {
    match: makeMatch({
      match_id: "csl-fin-pending",
      league_id: LEAGUE_B.league_id,
      season_id: LEAGUE_B.season_id,
      kickoff_at: new Date(NOW.getTime() - 8 * HOUR),
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Pending,
      finish_detected_at: new Date(NOW.getTime() - 6 * HOUR),
    }),
    fixtureId: 22003,
  },
];

async function seed(repo: InMemoryRepository): Promise<void> {
  for (const row of SEED) {
    await repo.matches.insert(row.match);
    await repo.matchProviderMappings.insert({
      schema_version: 1,
      match_id: row.match.match_id,
      provider: Provider.ApiFootball,
      provider_match_id: String(row.fixtureId),
      created_at: NOW,
      updated_at: NOW,
    });
  }
}

function fixturesForLeague(apiFootballLeagueId: string): ApiFootballFixture[] {
  const league = SUPPORTED_LEAGUES.find((row) => row.api_football_league_id === apiFootballLeagueId);
  if (league === undefined) return [];
  return SEED
    .filter((row) => row.match.league_id === league.league_id)
    .map((row) => makeApiFixture({ fixtureId: row.fixtureId }));
}

describe("loadActiveWindowFixtures 与旧路径候选集合等价", () => {
  it.each(JOBS)("%s 返回的 fixture id 集合与 findBySeason+activeWindow 一致，且 getFixtures 次数不超过旧路径", async (jobType) => {
    const repo = new InMemoryRepository();
    await seed(repo);

    const seasonMatches = (
      await Promise.all(SUPPORTED_LEAGUES.map((league) => repo.matches.findBySeason(league.season_id)))
    ).flat();
    const oldCandidates = activeWindow(seasonMatches, NOW, jobType);
    const oldFixtureIds = new Set(
      SEED.filter((row) => oldCandidates.some((match) => match.match_id === row.match.match_id))
        .map((row) => String(row.fixtureId)),
    );
    const oldGetFixturesCalls = new Set(oldCandidates.map((match) => match.league_id)).size;

    const getFixtures = vi.fn(async (query: ApiFootballFixturesQuery) => fixturesForLeague(query.leagueId));
    const loaded = await loadActiveWindowFixtures(repo, { getFixtures }, jobType, NOW);
    const newFixtureIds = new Set(
      loaded
        .map((item) => item.fixture.fixture?.id)
        .filter((id): id is string | number => id !== undefined)
        .map((id) => String(id)),
    );

    expect([...newFixtureIds].sort()).toEqual([...oldFixtureIds].sort());
    expect(getFixtures).toHaveBeenCalledTimes(oldGetFixturesCalls);
    expect(getFixtures.mock.calls.length).toBeLessThanOrEqual(oldGetFixturesCalls);
  });
});
