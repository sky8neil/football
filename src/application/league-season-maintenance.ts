import { activeLeagueSeason, SUPPORTED_LEAGUES } from "../domain/config.js";
import { SCHEMA_VERSION } from "../domain/enums.js";
import { evaluateLeagueSeason, isTerminalSeasonMatch } from "../domain/league-season-status.js";
import type { LeagueSeason, LeagueSeasonFormat, Match } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";

export interface LeagueSeasonMaintenanceResult {
  seasons_checked: number;
  completed: number;
  reopened: number;
}

function computeSeasonEndedAt(matches: readonly Match[]): Date | null {
  let latest: Date | null = null;
  for (const match of matches) {
    if (match.superseded_by != null || !isTerminalSeasonMatch(match)) continue;
    const at = match.finish_detected_at ?? match.kickoff_at;
    if (!(at instanceof Date) || !Number.isFinite(at.getTime())) continue;
    if (latest === null || at.getTime() > latest.getTime()) {
      latest = at;
    }
  }
  return latest;
}

export class LeagueSeasonMaintenanceService {
  constructor(private readonly repo: AppRepository, private readonly log?: (entry: Record<string, unknown>) => void) {}

  async run(serverNow: Date): Promise<LeagueSeasonMaintenanceResult> {
    const seasons = this.repo.leagueSeasons;
    const teams = this.repo.seasonTeams;
    if (!seasons || !teams) throw new Error("league season repositories unavailable");
    const result = { seasons_checked: 0, completed: 0, reopened: 0 };
    for (const league of SUPPORTED_LEAGUES) {
      const known = await seasons.findByLeague(league.league_id);
      const seasonIds = [...new Set([...known.map((row) => row.season_id), activeLeagueSeason(league, serverNow).season_id])];
      for (const seasonId of seasonIds) {
        const matches = await this.repo.matches.findByLeagueSeason(league.league_id, seasonId);
        const teamIds = [...new Set((await teams.findByLeagueSeason(league.league_id, seasonId)).map((team) => team.team_id))].sort();
        if (teamIds.length === 0) {
          this.log?.({ event: "league_season_roster_missing", league_id: league.league_id, season_id: seasonId,
            matches: matches.filter((match) => match.superseded_by == null).length });
        }
        result.seasons_checked++;
        const format: LeagueSeasonFormat = { kind: "double_round_robin", round_count: league.round_max, team_count: league.round_max / 2 + 1 };
        let previous = await seasons.findByKey(league.league_id, seasonId);
        const inserted = previous === null;
        if (!previous) {
          previous = {
            schema_version: SCHEMA_VERSION, league_id: league.league_id, season_id: seasonId, format,
            schedule_status: "uninitialized", completion_status: "open", completion_confirmed_at: null,
            reopened_at: null, reopen_count: 0, ended_at: null, manual_override: null, created_at: serverNow, updated_at: serverNow,
          };
          await seasons.insert(previous);
        }
        const evaluation = evaluateLeagueSeason({ format, teamIds, matches, previous, now: serverNow });
        if (previous.manual_override !== null) {
          evaluation.completion_status = "completed";
          evaluation.completion_confirmed_at = previous.completion_confirmed_at ?? previous.manual_override.confirmed_at;
          evaluation.reopened_at = previous.reopened_at;
          evaluation.reopen_count = previous.reopen_count;
        }
        const endedAt = previous.manual_override !== null
          ? (previous.ended_at ?? computeSeasonEndedAt(matches))
          : evaluation.completion_status === "completed"
            ? computeSeasonEndedAt(matches)
            : null;
        const next: LeagueSeason = {
          ...previous, format, schedule_status: evaluation.schedule_status, completion_status: evaluation.completion_status,
          completion_confirmed_at: evaluation.completion_confirmed_at, reopened_at: evaluation.reopened_at,
          reopen_count: evaluation.reopen_count, ended_at: endedAt,
        };
        if (inserted || JSON.stringify(previous) !== JSON.stringify(next)) {
          await seasons.update({ ...next, updated_at: serverNow });
        }
        if (previous.completion_status !== next.completion_status) {
          if (next.completion_status === "completed") result.completed++;
          else result.reopened++;
          this.log?.({ event: "league_season_transition", league_id: league.league_id, season_id: seasonId,
            from: previous.completion_status, to: next.completion_status });
        }
      }
    }
    return result;
  }
}
