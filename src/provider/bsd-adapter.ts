import { ProviderDataError } from "./http.js";
import type { ProviderAdapter, ProviderAdapterCallOptions, ProviderAdapterLeague, ProviderHttpClient } from "./adapter.js";
import { asArray, asIdentifier, asRecord, asText, utcDate } from "./adapter.js";
import type { ApiFootballFixture, ApiFootballTeam } from "./types.js";

function mapStatus(status: unknown): string {
  switch (status) {
    case "upcoming":
    case "notstarted": return "NS";
    case "live": return "LIVE";
    case "finished": return "FT";
    case "cancelled": return "CANC";
    case "postponed": return "PST";
    case "unresolved": return "UNRESOLVED";
    case "aet":
    case "extratime":
    case "penalties": return "AWARDED";
    default: return typeof status === "string" ? status : "";
  }
}

function eventIdentifier(value: unknown): string | number | undefined {
  return asIdentifier(value);
}

function nextEventsUrl(value: string): string {
  const url = new URL(value, "https://sports.bzzoiro.com/api/v2/events/");
  const path = url.pathname.replace(/\/+$/, "");
  if (!/(^|\/)events(?:\/\d+)?$/.test(path) || /(odds|bookmaker|bet|predict|market)/i.test(path)) {
    throw new ProviderDataError("DIAG_PROVIDER_FORMAT source_id=bsd field=next");
  }
  return url.toString();
}

function mapEvent(value: unknown, league: ProviderAdapterLeague): ApiFootballFixture {
  const event = asRecord(value);
  if (event === null) return {} as ApiFootballFixture;
  const kickoff = asText(event.event_date) ?? "";
  const homeName = asText(event.home_team);
  const awayName = asText(event.away_team);
  const dateSeason = utcDate(kickoff).slice(0, 4) || league.season_ref;
  const status = mapStatus(event.status);
  return {
    provider: "bsd",
    fixture: {
      id: eventIdentifier(event.id) ?? "",
      date: kickoff,
      timestamp: Number.isFinite(Date.parse(kickoff)) ? Math.floor(Date.parse(kickoff) / 1000) : 0,
      status: { short: status },
    },
    league: {
      id: asIdentifier(event.league_id) ?? league.source_league_ref,
      ...(asText(event.league_name) ? { name: asText(event.league_name)! } : {}),
      season: dateSeason,
      round: typeof event.round_number === "number"
        ? String(event.round_number).padStart(2, "0")
        : "",
    },
    teams: {
      home: { id: asIdentifier(event.home_team_id) ?? "", ...(homeName ? { name: homeName } : {}) },
      away: { id: asIdentifier(event.away_team_id) ?? "", ...(awayName ? { name: awayName } : {}) },
    },
    score: {
      fulltime: {
        home: typeof event.home_score === "number" ? event.home_score : null,
        away: typeof event.away_score === "number" ? event.away_score : null,
      },
      halftime: { home: null, away: null },
    },
  };
}

function mapTeamsFromFixtures(fixtures: readonly ApiFootballFixture[]): ApiFootballTeam[] {
  const teams = new Map<string, ApiFootballTeam>();
  for (const fixture of fixtures) {
    for (const side of [fixture.teams?.home, fixture.teams?.away]) {
      const id = asIdentifier(side?.id);
      const name = asText(side?.name);
      if (id !== undefined && name !== undefined) teams.set(String(id), {
        provider: fixture.provider ?? "bsd",
        team: { id, name },
      });
    }
  }
  return [...teams.values()];
}

export class BsdAdapter implements ProviderAdapter {
  readonly sourceId = "bsd" as const;
  readonly provider = "bsd" as const;

  constructor(
    private readonly http: ProviderHttpClient,
    private readonly log?: (entry: Record<string, unknown>) => void,
  ) {}

  async fetchSeasonFixtures(league: ProviderAdapterLeague, options?: ProviderAdapterCallOptions): Promise<readonly ApiFootballFixture[]> {
    return this.fetchFixturesByDateRange(league, `${league.season_ref}-01-01`, `${league.season_ref}-12-31`, options);
  }

  async fetchFixturesByDateRange(
    league: ProviderAdapterLeague,
    dateFrom: string,
    dateTo: string,
    options?: ProviderAdapterCallOptions,
  ): Promise<readonly ApiFootballFixture[]> {
    const all: ApiFootballFixture[] = [];
    let offset = 0;
    let next: string | null = null;
    do {
      await options?.beforeRequest?.();
      const response = asRecord(await this.http.getJson(
        next === null ? "events/" : nextEventsUrl(next),
        next ? {} : {
          league_id: league.source_league_ref,
          date_from: dateFrom,
          date_to: dateTo,
          limit: "200",
          offset: String(offset),
        },
      ));
      if (response === null || !Array.isArray(response.results)) {
        throw new ProviderDataError("DIAG_PROVIDER_FORMAT source_id=bsd field=results");
      }
      for (const rawEvent of asArray(response.results)) {
        const event = asRecord(rawEvent);
        if (event?.stage !== "regular-season") {
          this.log?.({ event: "provider_fixture_ignored", source_id: "bsd", reason: "non_regular_stage", stage: event?.stage ?? null });
          continue;
        }
        all.push(mapEvent(rawEvent, league));
      }
      next = typeof response.next === "string" && response.next.length > 0 ? response.next : null;
      offset += asArray(response.results).length;
    } while (next !== null);
    return all;
  }

  async fetchTeams(league: ProviderAdapterLeague, options?: ProviderAdapterCallOptions): Promise<readonly ApiFootballTeam[]> {
    return mapTeamsFromFixtures(await this.fetchSeasonFixtures(league, options));
  }
}
