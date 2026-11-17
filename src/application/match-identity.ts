import { internalError } from "../domain/errors.js";
import type { Match } from "../domain/types.js";
import type { UnitOfWork } from "../infrastructure/repositories.js";

export async function resolveEffectiveMatch(repo: Pick<UnitOfWork, "matches">, matchId: string): Promise<Match | null> {
  const visited = new Set<string>();
  let currentId = matchId;
  for (let hops = 0; hops <= 3; hops += 1) {
    if (visited.has(currentId)) throw internalError("比赛取代关系存在环");
    visited.add(currentId);
    const match = await repo.matches.findById(currentId);
    if (match === null || match.superseded_by === null) return match;
    if (hops === 3) throw internalError("比赛取代关系超过三跳");
    currentId = match.superseded_by;
  }
  throw internalError("比赛取代关系异常");
}

export async function findRescheduleCandidates(
  repo: Pick<UnitOfWork, "matches">,
  input: { leagueId: string; seasonId: string; homeTeamId: string; awayTeamId: string },
): Promise<Match[]> {
  const matches = await repo.matches.findByLeagueSeason(input.leagueId, input.seasonId);
  return matches.filter((match) => match.superseded_by == null &&
    match.league_id === input.leagueId && match.season_id === input.seasonId && match.home_team_id === input.homeTeamId &&
    match.away_team_id === input.awayTeamId);
}
