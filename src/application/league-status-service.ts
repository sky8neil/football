import { SUMMARY_UPCOMING_WINDOW_DAYS, SUPPORTED_LEAGUES, type SupportedLeague } from "../domain/config.js";
import { SCHEMA_VERSION } from "../domain/enums.js";
import { evaluateLeaguePhase } from "../domain/league-season-summary.js";
import type { LeagueSeason } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";

export interface LeagueStatusItem {
  league_id: string;
  phase: "in_season" | "break" | "completed" | "between_seasons";
  active_season_id: string | null;
  has_live_match: boolean;
  next_kickoff_at: string | null;
  next_matchday: { date: string; kickoff_at: string } | null;
  next_season_kickoff_at: string | null;
}

export async function loadLeagueStatus(repo: AppRepository, league: SupportedLeague, serverNow: Date): Promise<LeagueStatusItem> {
  const seasons = await repo.leagueSeasons!.findByLeague(league.league_id);
  const matches = await repo.matches.findByLeague(league.league_id);
  const knownIds = new Set(seasons.map((season) => season.season_id));
  for (const seasonId of new Set(matches.map((match) => match.season_id))) {
    if (knownIds.has(seasonId)) continue;
    const season: LeagueSeason = {
      schema_version: SCHEMA_VERSION, league_id: league.league_id, season_id: seasonId,
      format: { kind: "double_round_robin", round_count: league.round_max, team_count: league.round_max / 2 + 1 },
      schedule_status: "uninitialized", completion_status: "open", completion_confirmed_at: null,
      reopened_at: null, reopen_count: 0, ended_at: null, manual_override: null, created_at: serverNow, updated_at: serverNow,
    };
    seasons.push(season);
  }
  const result = evaluateLeaguePhase({ leagueId: league.league_id, seasons, matches, now: serverNow, upcomingWindowDays: SUMMARY_UPCOMING_WINDOW_DAYS });
  const kickoff = result.next_kickoff_at?.toISOString() ?? null;
  return {
    league_id: league.league_id, phase: result.phase, active_season_id: result.active_season_id,
    has_live_match: result.has_live_match, next_kickoff_at: kickoff,
    next_matchday: kickoff === null ? null : { date: new Date(result.next_kickoff_at!.getTime() + 8 * 3_600_000).toISOString().slice(0, 10), kickoff_at: kickoff },
    next_season_kickoff_at: result.next_season_kickoff_at?.toISOString() ?? null,
  };
}

export class LeagueStatusService {
  constructor(private readonly repo: AppRepository) {}

  async list(serverNow: Date): Promise<LeagueStatusItem[]> {
    return Promise.all(SUPPORTED_LEAGUES.map((league) => loadLeagueStatus(this.repo, league, serverNow)));
  }
}
