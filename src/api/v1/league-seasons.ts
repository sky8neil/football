import { findSupportedLeagueById, isSupportedLeagueId } from "../../domain/config.js";
import { validationError } from "../../domain/errors.js";
import { formatSeasonLabel } from "../../domain/season-label.js";
import type { AppRepository } from "../../infrastructure/repositories.js";
import { assertUnknownFields } from "./validation.js";

export { formatSeasonLabel };

const LEAGUE_SEASONS_QUERY_FIELDS = new Set(["league_id"]);

export interface LeagueSeasonCatalogItem {
  league_id: string;
  season_id: string;
  season_label: string;
  round_ids: string[];
}

export interface GetLeagueSeasonsInput {
  query: Record<string, unknown>;
  request_id: string;
}

export interface GetLeagueSeasonsSuccessResponse {
  status: 200;
  body: {
    data: {
      items: LeagueSeasonCatalogItem[];
    };
    request_id: string;
  };
}

export async function getLeagueSeasons(
  repo: Pick<AppRepository, "matches">,
  input: GetLeagueSeasonsInput,
): Promise<GetLeagueSeasonsSuccessResponse> {
  assertUnknownFields(input.query, LEAGUE_SEASONS_QUERY_FIELDS);
  const rawLeagueId = input.query.league_id;
  if (rawLeagueId !== undefined) {
    if (
      typeof rawLeagueId !== "string" ||
      !isSupportedLeagueId(rawLeagueId) ||
      findSupportedLeagueById(rawLeagueId) === undefined
    ) {
      throw validationError("league_id 不是有效联赛", { field: "league_id" });
    }
  }
  const catalog = typeof rawLeagueId === "string"
    ? await repo.matches.findLeagueSeasonCatalog(rawLeagueId)
    : await repo.matches.findLeagueSeasonCatalog();
  return {
    status: 200,
    body: {
      data: {
        items: catalog.map((entry) => ({
          league_id: entry.league_id,
          season_id: entry.season_id,
          season_label: formatSeasonLabel(entry.season_id),
          round_ids: entry.round_ids,
        })),
      },
      request_id: input.request_id,
    },
  };
}
