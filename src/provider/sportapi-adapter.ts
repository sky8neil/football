import { ProviderDataError } from "./http.js";
import type { ProviderAdapter, ProviderAdapterCallOptions, ProviderAdapterLeague, ProviderHttpClient } from "./adapter.js";
import { asArray, asIdentifier, asRecord, asText, getProviderResponse } from "./adapter.js";
import type { ApiFootballFixture, ApiFootballTeam } from "./types.js";

const BROWSER_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function statusCode(value: unknown): string {
  switch (value) {
    case "Scheduled": return "NS";
    case "LIVE": return "LIVE";
    case "FT": return "FT";
    case "Postponed": return "PST";
    case "Cancelled": return "CANC";
    case "Suspended": return "SUSPENDED";
    case "AET": return "AET";
    case "PENS": return "PEN";
    default: return typeof value === "string" ? value : "";
  }
}

function fixtureLeagueId(row: Record<string, unknown>): string {
  const nested = asRecord(row.league);
  const value = row.league_id ?? nested?.id;
  return typeof value === "number" || typeof value === "string" ? String(value) : "";
}

function mapFixture(value: unknown, league: ProviderAdapterLeague): ApiFootballFixture | null {
  const row = asRecord(value);
  if (row === null || fixtureLeagueId(row) !== league.source_league_ref) return null;
  const kickoff = asText(row.kickoff_utc) ?? "";
  const homeName = asText(row.home_team);
  const awayName = asText(row.away_team);
  return {
    provider: "sportapi",
    fixture: {
      id: asIdentifier(row.id) ?? "",
      date: kickoff,
      timestamp: Number.isFinite(Date.parse(kickoff)) ? Math.floor(Date.parse(kickoff) / 1000) : 0,
      status: { short: statusCode(row.status) },
    },
    league: {
      id: fixtureLeagueId(row),
      ...(asText(row.league_name) ? { name: asText(row.league_name)! } : {}),
      season: league.season_ref,
      round: "",
    },
    teams: {
      home: { id: asIdentifier(row.home_id) ?? "", ...(homeName ? { name: homeName } : {}) },
      away: { id: asIdentifier(row.away_id) ?? "", ...(awayName ? { name: awayName } : {}) },
    },
    score: {
      fulltime: {
        home: typeof row.home_score === "number" ? row.home_score : null,
        away: typeof row.away_score === "number" ? row.away_score : null,
      },
      halftime: { home: null, away: null },
    },
  };
}

function dates(dateFrom: string, dateTo: string): string[] {
  const from = new Date(`${dateFrom}T00:00:00.000Z`);
  const to = new Date(`${dateTo}T00:00:00.000Z`);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to < from) throw new ProviderDataError("invalid provider date range");
  const result: string[] = [];
  for (let day = from; day <= to; day = new Date(day.getTime() + 86_400_000)) result.push(day.toISOString().slice(0, 10));
  return result;
}

function parseFixtures(value: unknown): unknown[] {
  const body = asRecord(value);
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(value)) return value;
  throw new ProviderDataError("DIAG_PROVIDER_FORMAT source_id=sp field=data");
}

export class SportApiAdapter implements ProviderAdapter {
  readonly sourceId = "sp" as const;
  readonly provider = "sportapi" as const;
  private readonly cache = new Map<string, { etag: string | null; rows: unknown[] }>();

  constructor(private readonly http: ProviderHttpClient) {}

  async fetchSeasonFixtures(league: ProviderAdapterLeague, options?: ProviderAdapterCallOptions): Promise<readonly ApiFootballFixture[]> {
    return this.fetchFixturesByDateRange(league, `${league.season_ref}-01-01`, `${league.season_ref}-12-31`, options);
  }

  async fetchFixturesByDateRange(
    league: ProviderAdapterLeague,
    dateFrom: string,
    dateTo: string,
    options?: ProviderAdapterCallOptions,
  ): Promise<readonly ApiFootballFixture[]> {
    const output: ApiFootballFixture[] = [];
    for (const date of dates(dateFrom, dateTo)) {
      const cached = this.cache.get(date);
      await options?.beforeRequest?.();
      const response = await getProviderResponse(
        this.http,
        `fixtures/date/${date}`,
        {},
        {
          "User-Agent": BROWSER_USER_AGENT,
          ...(cached?.etag ? { "If-None-Match": cached.etag } : {}),
        },
      );
      if (response.status === 304) {
        output.push(...(cached?.rows ?? []).map((row) => mapFixture(row, league)).filter((row): row is ApiFootballFixture => row !== null));
        continue;
      }
      const rows = parseFixtures(response.data);
      this.cache.set(date, { etag: response.headers.get("etag"), rows });
      const fixtures = rows
        .map((row) => mapFixture(row, league))
        .filter((row): row is ApiFootballFixture => row !== null);
      output.push(...fixtures);
    }
    return output;
  }

  async fetchTeams(league: ProviderAdapterLeague, options?: ProviderAdapterCallOptions): Promise<readonly ApiFootballTeam[]> {
    const fixtures = await this.fetchSeasonFixtures(league, options);
    const teams = new Map<string, ApiFootballTeam>();
    for (const fixture of fixtures) for (const side of [fixture.teams.home, fixture.teams.away]) {
      const id = asIdentifier(side.id);
      const name = asText(side.name);
      if (id !== undefined && name) teams.set(String(id), { provider: this.provider, team: { id, name } });
    }
    return [...teams.values()];
  }
}
