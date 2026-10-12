import { ProviderDataError } from "./http.js";
import type { ProviderAdapter, ProviderAdapterCallOptions, ProviderAdapterLeague, ProviderHttpClient } from "./adapter.js";
import { asArray, asIdentifier, asRecord, asText } from "./adapter.js";
import type { ApiFootballFixture, ApiFootballTeam } from "./types.js";

function allowedPath(path: string): string {
  if (!/^(matches|competitions)$/.test(path) || /(events|lineups|xg|context|odds|bet|market)/i.test(path)) {
    throw new ProviderDataError("DIAG_PROVIDER_FORMAT source_id=of field=path");
  }
  return path;
}

function statusCode(value: unknown): string {
  switch (value) {
    case "scheduled": return "NS";
    case "live": return "LIVE";
    case "finished": return "FT";
    case "postponed": return "PST";
    case "cancelled": return "CANC";
    case "unknown": return "UNKNOWN";
    default: return typeof value === "string" ? value : "";
  }
}

function mapMatch(value: unknown, league: ProviderAdapterLeague): ApiFootballFixture {
  const row = asRecord(value);
  if (row === null) return {} as ApiFootballFixture;
  const home = asRecord(row.homeTeam);
  const away = asRecord(row.awayTeam);
  const score = asRecord(row.score);
  const kickoff = asText(row.kickoffAt) ?? "";
  const round = asText(row.round);
  return {
    provider: "openfoot",
    fixture: {
      id: asText(row.id) ?? "",
      date: kickoff,
      timestamp: Number.isFinite(Date.parse(kickoff)) ? Math.floor(Date.parse(kickoff) / 1000) : 0,
      status: { short: statusCode(row.status) },
    },
    league: {
      id: asText(row.competitionId) ?? league.source_league_ref,
      season: league.season_ref,
      round: round ?? "",
    },
    teams: {
      home: { id: asText(home?.id) ?? "", ...(asText(home?.name) ? { name: asText(home?.name)! } : {}) },
      away: { id: asText(away?.id) ?? "", ...(asText(away?.name) ? { name: asText(away?.name)! } : {}) },
    },
    score: {
      fulltime: { home: typeof score?.home === "number" ? score.home : null, away: typeof score?.away === "number" ? score.away : null },
      halftime: { home: null, away: null },
    },
  };
}

function dayStrings(dateFrom: string, dateTo: string): string[] {
  const from = new Date(`${dateFrom}T00:00:00.000Z`);
  const to = new Date(`${dateTo}T00:00:00.000Z`);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to < from) throw new ProviderDataError("invalid provider date range");
  const days: string[] = [];
  for (let day = from; day <= to; day = new Date(day.getTime() + 86_400_000)) days.push(day.toISOString().slice(0, 10));
  return days;
}

export class OpenFootAdapter implements ProviderAdapter {
  readonly sourceId = "of" as const;
  readonly provider = "openfoot" as const;

  constructor(
    private readonly http: ProviderHttpClient,
    private readonly onQuota?: (remaining: number, resetAt: Date, now: Date) => void,
  ) {}

  async fetchSeasonFixtures(league: ProviderAdapterLeague, options?: ProviderAdapterCallOptions): Promise<readonly ApiFootballFixture[]> {
    const season = `${league.season_ref}/${Number(league.season_ref) + 1}`;
    return this.fetchMatches(league, { competition: league.source_league_ref, season }, options);
  }

  async fetchFixturesByDateRange(
    league: ProviderAdapterLeague,
    dateFrom: string,
    dateTo: string,
    options?: ProviderAdapterCallOptions,
  ): Promise<readonly ApiFootballFixture[]> {
    const output: ApiFootballFixture[] = [];
    for (const date of dayStrings(dateFrom, dateTo)) {
      output.push(...await this.fetchMatches(league, { competition: league.source_league_ref, date }, options));
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

  private async fetchMatches(
    league: ProviderAdapterLeague,
    query: Record<string, string>,
    options?: ProviderAdapterCallOptions,
  ): Promise<ApiFootballFixture[]> {
    const output: ApiFootballFixture[] = [];
    let cursor: string | null = null;
    do {
      await options?.beforeRequest?.();
      const response = asRecord(await this.http.getJson(allowedPath("matches"), {
        ...query,
        ...(cursor === null ? {} : { cursor }),
      }));
      const meta = asRecord(response?.meta);
      if (response === null || !Array.isArray(response.data)) throw new ProviderDataError("DIAG_PROVIDER_FORMAT source_id=of field=data");
      const access = asRecord(meta?.access);
      if (typeof access?.remaining === "number" && typeof access.period === "string") {
        const [year, month] = access.period.split("-").map(Number);
        if (year && month) this.onQuota?.(access.remaining, new Date(Date.UTC(year, month, 1)), options?.serverNow ?? new Date());
      }
      if (meta?.partial === true) throw new ProviderDataError("DIAG_PROVIDER_PARTIAL source_id=of");
      output.push(...asArray(response.data).map((row) => mapMatch(row, league)));
      const pagination = asRecord(meta?.pagination);
      cursor = asText(pagination?.next_cursor) ?? null;
    } while (cursor !== null);
    return output;
  }
}
