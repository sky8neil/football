import type { LeagueSeasonFormat } from "./types.js";

export type LeagueSeasonFormatInput = LeagueSeasonFormat;

export interface StatusMatchInput {
  match_id: string;
  canonical_match_id: string;
  superseded_by: string | null;
  round_id: string;
  home_team_id: string;
  away_team_id: string;
  match_status: "scheduled" | "live" | "finished" | "postponed" | "cancelled" | "abandoned";
}

export interface EvaluateInput {
  format: LeagueSeasonFormatInput;
  teamIds: readonly string[];
  matches: readonly StatusMatchInput[];
  previous: {
    schedule_status: "uninitialized" | "partial" | "locked";
    completion_status: "open" | "completed";
    completion_confirmed_at: Date | null;
    reopened_at?: Date | null;
    reopen_count: number;
  } | null;
  now: Date;
}

export interface LeagueSeasonEvaluation {
  schedule_status: "uninitialized" | "partial" | "locked";
  completion_status: "open" | "completed";
  completion_confirmed_at: Date | null;
  reopened_at: Date | null;
  reopen_count: number;
  reason: string;
}

export function evaluateLeagueSeason(input: EvaluateInput): LeagueSeasonEvaluation {
  const matches = input.matches.filter((match) => match.superseded_by == null);
  const pairKey = (home: string, away: string) => JSON.stringify(
    input.format.kind === "single_round_robin" ? [home, away].sort() : [home, away],
  );
  const existing = new Set(matches.map((match) => pairKey(match.home_team_id, match.away_team_id)));
  const required = new Set(existing);
  if (input.format.kind !== "custom") {
    for (let first = 0; first < input.teamIds.length; first++) {
      for (let second = first + 1; second < input.teamIds.length; second++) {
        required.add(pairKey(input.teamIds[first]!, input.teamIds[second]!));
        if (input.format.kind === "double_round_robin") required.add(pairKey(input.teamIds[second]!, input.teamIds[first]!));
      }
    }
  }
  const schedule_status = input.teamIds.length < 2 ? "uninitialized"
    : input.teamIds.length < input.format.team_count || [...required].some((pair) => !existing.has(pair)) ? "partial" : "locked";
  const identities = new Map<string, Set<string>>();
  for (const match of matches) {
    const key = JSON.stringify([match.round_id, match.home_team_id, match.away_team_id]);
    const ids = identities.get(key) ?? new Set<string>();
    ids.add(match.canonical_match_id);
    identities.set(key, ids);
  }
  const duplicate = [...identities.values()].some((ids) => ids.size > 1);
  const nonTerminal = matches.some((match) => !["finished", "cancelled", "abandoned"].includes(match.match_status));
  const completion_status = schedule_status === "locked" && !duplicate && !nonTerminal ? "completed" : "open";
  const reopened = input.previous?.completion_status === "completed" && completion_status === "open";
  const reason = reopened ? "reopened" : schedule_status === "uninitialized" ? "uninitialized"
    : input.teamIds.length < input.format.team_count ? "missing_teams"
      : schedule_status === "partial" ? "missing_pairs" : duplicate ? "unconfirmed_duplicate"
        : nonTerminal ? "non_terminal" : "completed";
  return {
    schedule_status, completion_status,
    completion_confirmed_at: input.previous?.completion_confirmed_at ?? (completion_status === "completed" ? input.now : null),
    reopened_at: reopened ? input.now : input.previous?.reopened_at ?? null,
    reopen_count: (input.previous?.reopen_count ?? 0) + (reopened ? 1 : 0),
    reason,
  };
}
