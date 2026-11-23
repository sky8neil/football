import { findSupportedLeagueById, isSupportedLeagueId } from "../domain/config.js";
import { validationError } from "../domain/errors.js";
import type { AppRepository, LeagueSeasonCatalogEntry } from "../infrastructure/repositories.js";

export function isLeagueSeasonFormatValid(leagueSeasonId: string, candidate: string): boolean {
  if (/^\d{4}$/.test(leagueSeasonId)) {
    return /^\d{4}$/.test(candidate);
  }
  const match = /^(\d{4})_(\d{4})$/.exec(candidate);
  return match !== null && Number(match[2]) === Number(match[1]) + 1;
}

export async function assertLeagueSeasonAttached(
  repo: Pick<AppRepository, "matches">,
  leagueId: string,
  seasonId: string,
): Promise<LeagueSeasonCatalogEntry> {
  if (!isSupportedLeagueId(leagueId) || findSupportedLeagueById(leagueId) === undefined) {
    throw validationError("league_id 不是有效联赛", { field: "league_id" });
  }
  const league = findSupportedLeagueById(leagueId);
  if (league === undefined || !isLeagueSeasonFormatValid(league.season_id, seasonId)) {
    throw validationError("赛季格式非法", { field: "season_id", reason: "FORMAT" });
  }
  const catalog = await repo.matches.findLeagueSeasonCatalog(leagueId);
  const entry = catalog.find((item) => item.league_id === leagueId && item.season_id === seasonId);
  if (entry === undefined) {
    throw validationError("该联赛赛季未接入", { field: "season_id", reason: "NOT_ATTACHED" });
  }
  return entry;
}
