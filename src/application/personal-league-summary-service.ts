import { SUPPORTED_LEAGUES } from "../domain/config.js";
import { notFoundError, validationError } from "../domain/errors.js";
import { summarizePersonalLeague } from "../domain/league-season-summary.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { loadLeagueStatus } from "./league-status-service.js";

export interface PersonalLeagueSummaryResponse {
  availability: "available" | "not_available";
  league_id: string;
  season_id: string | null;
  completion_confirmed_at: string | null;
  ended_at: string | null;
  summary: { predicted_matches: number; wdl_hits: number; exact_hits: number; is_provisional: boolean } | null;
  reason: string | null;
}

export class PersonalLeagueSummaryService {
  constructor(private readonly repo: AppRepository) {}

  async get(userId: string, leagueId: string, seasonId: string | undefined, serverNow: Date): Promise<PersonalLeagueSummaryResponse> {
    if (await this.repo.users.findById(userId) === null) throw notFoundError("user");
    const league = SUPPORTED_LEAGUES.find((item) => item.league_id === leagueId);
    if (league === undefined) throw validationError("league_id");
    if (seasonId !== undefined) {
      const pattern = league.season_id.includes("_") ? /^\d{4}_\d{4}$/ : /^\d{4}$/;
      if (!pattern.test(seasonId)) throw validationError("season_id");
    }
    const selectedId = seasonId ?? (await loadLeagueStatus(this.repo, league, serverNow)).active_season_id;
    const season = selectedId === null ? null : await this.repo.leagueSeasons!.findByKey(leagueId, selectedId);
    const unavailable = (reason: string): PersonalLeagueSummaryResponse => ({
      availability: "not_available",
      league_id: leagueId,
      season_id: selectedId,
      completion_confirmed_at: season?.completion_confirmed_at?.toISOString() ?? null,
      ended_at: season?.ended_at?.toISOString() ?? null,
      summary: null,
      reason,
    });
    if (season === null || season.completion_status !== "completed") return unavailable("not_available");
    const matches = await this.repo.matches.findByLeagueSeason(leagueId, selectedId!);
    const ids = [...new Set(matches.map((match) => match.canonical_match_id))];
    const predictions = await this.repo.predictions.findByUserAndCanonicalMatchIds(userId, ids);
    const result = summarizePersonalLeague({ leagueId, seasonId: selectedId!, userId, season, matches, predictions });
    if (result.availability === "not_available") return unavailable(result.reason ?? "not_available");
    return {
      availability: "available",
      league_id: leagueId,
      season_id: selectedId,
      completion_confirmed_at: season.completion_confirmed_at?.toISOString() ?? null,
      ended_at: season.ended_at?.toISOString() ?? null,
      reason: null,
      summary: { predicted_matches: result.predicted_matches, wdl_hits: result.wdl_hits, exact_hits: result.exact_hits, is_provisional: result.is_provisional },
    };
  }
}
