import type { LeagueSeason, Match, Prediction } from "./types.js";

export interface LeaguePhaseInput {
  leagueId: string;
  seasons: readonly LeagueSeason[];
  matches: readonly Match[];
  now: Date;
  upcomingWindowDays: number;
}

export type LeaguePhaseValue = "in_season" | "break" | "completed" | "between_seasons";

export interface LeaguePhaseResult {
  phase: LeaguePhaseValue;
  active_season_id: string | null;
  has_live_match: boolean;
  next_kickoff_at: Date | null;
  next_season_kickoff_at: Date | null;
}

export function evaluateLeaguePhase(input: LeaguePhaseInput): LeaguePhaseResult {
  const seasons = input.seasons.filter((season) => season.league_id === input.leagueId)
    .sort((first, second) => first.season_id.localeCompare(second.season_id));
  const matches = input.matches.filter((match) => match.league_id === input.leagueId && match.superseded_by == null);
  const seasonMatches = (season: LeagueSeason) => matches.filter((match) => match.season_id === season.season_id);
  const started = (season: LeagueSeason) => seasonMatches(season)
    .some((match) => match.match_status === "finished" || match.match_status === "live");
  const lastIndex = (predicate: (season: LeagueSeason, index: number) => boolean): number => {
    for (let index = seasons.length - 1; index >= 0; index--) {
      if (predicate(seasons[index]!, index)) return index;
    }
    return -1;
  };
  const completedIndex = lastIndex((season, index) => season.completion_status === "completed"
    && (seasons[index + 1] === undefined || !started(seasons[index + 1]!)));
  const activeIndex = completedIndex >= 0 ? completedIndex : (() => {
    const startedIndex = lastIndex(started);
    return startedIndex >= 0 ? startedIndex : lastIndex((season) => seasonMatches(season).length > 0);
  })();
  const active = seasons[activeIndex];
  if (active === undefined) {
    return { phase: "break", active_season_id: null, has_live_match: false, next_kickoff_at: null, next_season_kickoff_at: null };
  }
  const activeMatches = seasonMatches(active);
  const nextSeason = seasons[activeIndex + 1];
  const nextMatches = nextSeason === undefined ? [] : seasonMatches(nextSeason);
  const nextKickoff = (candidates: readonly Match[]): Date | null => {
    const upcoming = candidates.filter((match) => match.match_status === "scheduled" && match.kickoff_at >= input.now)
      .sort((first, second) => first.kickoff_at.getTime() - second.kickoff_at.getTime());
    return upcoming[0]?.kickoff_at ?? null;
  };
  const hasLiveMatch = activeMatches.some((match) => match.match_status === "live");
  const nextKickoffAt = nextKickoff(activeMatches);
  const phase: LeaguePhaseValue = active.completion_status === "completed"
    ? nextMatches.length > 0 ? "between_seasons" : "completed"
    : hasLiveMatch || (nextKickoffAt !== null && nextKickoffAt.getTime() <= input.now.getTime() + input.upcomingWindowDays * 86_400_000)
      ? "in_season" : "break";
  return {
    phase, active_season_id: active.season_id, has_live_match: hasLiveMatch,
    next_kickoff_at: nextKickoffAt, next_season_kickoff_at: nextKickoff(nextMatches),
  };
}

export interface PersonalLeagueSummaryInput {
  leagueId: string;
  seasonId: string;
  userId: string;
  season: LeagueSeason;
  matches: readonly Match[];
  predictions: readonly Prediction[];
}

export type PersonalLeagueSummaryAvailability = "available" | "not_available";

export interface PersonalLeagueSummary {
  availability: PersonalLeagueSummaryAvailability;
  reason: string | null;
  predicted_matches: number;
  wdl_hits: number;
  exact_hits: number;
  is_provisional: boolean;
  has_duplicate_predictions: boolean;
}

export function summarizePersonalLeague(input: PersonalLeagueSummaryInput): PersonalLeagueSummary {
  const empty: PersonalLeagueSummary = {
    availability: "not_available", reason: "season_not_completed", predicted_matches: 0,
    wdl_hits: 0, exact_hits: 0, is_provisional: false, has_duplicate_predictions: false,
  };
  if (input.season.completion_status !== "completed") return empty;

  const matches = new Map<string, Match[]>();
  for (const match of input.matches) {
    if (match.league_id !== input.leagueId || match.season_id !== input.seasonId) continue;
    const records = matches.get(match.canonical_match_id) ?? [];
    records.push(match);
    matches.set(match.canonical_match_id, records);
  }
  const predictions = input.predictions.filter((prediction) => prediction.user_id === input.userId
    && matches.has(prediction.canonical_match_id));
  if (new Set(predictions.map((prediction) => prediction.canonical_match_id)).size !== predictions.length) {
    return { ...empty, reason: "data_conflict", has_duplicate_predictions: true };
  }
  return {
    availability: "available", reason: null, predicted_matches: predictions.length,
    wdl_hits: predictions.filter((prediction) => prediction.wdl_hit === true).length,
    exact_hits: predictions.filter((prediction) => prediction.exact_hit === true).length,
    is_provisional: predictions.some((prediction) => {
      const records = matches.get(prediction.canonical_match_id)!;
      return records.some((match) => prediction.applied_result_version < match.result_version
        || (match.superseded_by == null && (match.settlement_status === "settling" || match.settlement_status === "correcting")));
    }),
    has_duplicate_predictions: false,
  };
}
