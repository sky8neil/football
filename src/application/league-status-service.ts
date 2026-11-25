import {
  activeLeagueSeason,
  nextLeagueSeasonId,
  previousLeagueSeasonId,
  SUMMARY_UPCOMING_WINDOW_DAYS,
  SUPPORTED_LEAGUES,
  type SupportedLeague,
} from "../domain/config.js";
import { SCHEMA_VERSION } from "../domain/enums.js";
import { evaluateLeaguePhase } from "../domain/league-season-summary.js";
import type { LeagueSeason, Match } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";

export const DEFAULT_LEAGUE_STATUS_CACHE_TTL_MS = 15_000;
const RECENT_SEASONS_LIMIT = 3;

export interface LeagueStatusItem {
  league_id: string;
  phase: "in_season" | "break" | "completed" | "between_seasons";
  active_season_id: string | null;
  has_live_match: boolean;
  next_kickoff_at: string | null;
  next_matchday: { date: string; kickoff_at: string } | null;
  next_season_kickoff_at: string | null;
}

export interface LeagueStatusServiceOptions {
  cacheTtlMs?: number;
}

function sortSeasonIdsDesc(seasonIds: readonly string[]): string[] {
  return [...seasonIds].sort((left, right) => right.localeCompare(left));
}

function cloneStatusItems(items: readonly LeagueStatusItem[]): LeagueStatusItem[] {
  return items.map((item) => ({
    ...item,
    next_matchday: item.next_matchday === null ? null : { ...item.next_matchday },
  }));
}

async function selectRelevantSeasonIds(
  repo: AppRepository,
  league: SupportedLeague,
  seasons: readonly LeagueSeason[],
  serverNow: Date,
): Promise<string[]> {
  const candidates = new Set<string>(
    sortSeasonIdsDesc(seasons.map((season) => season.season_id)).slice(0, RECENT_SEASONS_LIMIT),
  );
  candidates.add(activeLeagueSeason(league, serverNow).season_id);
  const prev = previousLeagueSeasonId(league, serverNow);
  if (prev !== null) candidates.add(prev);
  const next = nextLeagueSeasonId(league, serverNow);
  if (next !== null) candidates.add(next);
  if (typeof repo.matches.findLeagueSeasonCatalog === "function") {
    const catalog = await repo.matches.findLeagueSeasonCatalog(league.league_id);
    for (const seasonId of sortSeasonIdsDesc(catalog.map((entry) => entry.season_id)).slice(0, RECENT_SEASONS_LIMIT)) {
      candidates.add(seasonId);
    }
  }
  return [...candidates];
}

export async function loadLeagueStatus(repo: AppRepository, league: SupportedLeague, serverNow: Date): Promise<LeagueStatusItem> {
  const allSeasons = await repo.leagueSeasons!.findByLeague(league.league_id);
  const relevantIds = await selectRelevantSeasonIds(repo, league, allSeasons, serverNow);
  const relevantSet = new Set(relevantIds);
  const seasons = allSeasons.filter((season) => relevantSet.has(season.season_id));
  const matchBatches = await Promise.all(
    relevantIds.map((seasonId) => repo.matches.findByLeagueSeason(league.league_id, seasonId)),
  );
  const matches: Match[] = matchBatches.flat();
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
  private readonly cacheTtlMs: number;
  private cached: { serverNowMs: number; items: LeagueStatusItem[] } | null = null;
  private inFlight: { serverNowMs: number; promise: Promise<LeagueStatusItem[]> } | null = null;

  constructor(
    private readonly repo: AppRepository,
    options: LeagueStatusServiceOptions = {},
  ) {
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? DEFAULT_LEAGUE_STATUS_CACHE_TTL_MS);
  }

  async list(serverNow: Date): Promise<LeagueStatusItem[]> {
    const serverNowMs = serverNow.getTime();
    if (this.cacheTtlMs > 0 && Number.isFinite(serverNowMs)) {
      if (
        this.cached !== null &&
        serverNowMs >= this.cached.serverNowMs &&
        serverNowMs - this.cached.serverNowMs < this.cacheTtlMs
      ) {
        return cloneStatusItems(this.cached.items);
      }
      if (
        this.inFlight !== null &&
        serverNowMs >= this.inFlight.serverNowMs &&
        serverNowMs - this.inFlight.serverNowMs < this.cacheTtlMs
      ) {
        return cloneStatusItems(await this.inFlight.promise);
      }
      const promise = Promise.all(
        SUPPORTED_LEAGUES.map((league) => loadLeagueStatus(this.repo, league, serverNow)),
      );
      this.inFlight = { serverNowMs, promise };
      try {
        const items = await promise;
        this.cached = { serverNowMs, items: cloneStatusItems(items) };
        return cloneStatusItems(items);
      } finally {
        if (this.inFlight?.promise === promise) {
          this.inFlight = null;
        }
      }
    }
    return Promise.all(SUPPORTED_LEAGUES.map((league) => loadLeagueStatus(this.repo, league, serverNow)));
  }
}
