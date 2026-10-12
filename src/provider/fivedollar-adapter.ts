import { ProviderDataError } from "./http.js";
import type { ProviderAdapter, ProviderAdapterCallOptions, ProviderAdapterLeague, ProviderHttpClient } from "./adapter.js";
import { asArray, asIdentifier, asRecord, asText, getProviderResponse } from "./adapter.js";
import type { ApiFootballFixture, ApiFootballTeam } from "./types.js";

function fixturePath(path: string): string {
  if (!/^(fixtures|leagues\/\d+\/fixtures)$/.test(path) || /(odds|corners|cards|events|lineups|xg|context)/i.test(path)) {
    throw new ProviderDataError("DIAG_PROVIDER_FORMAT source_id=5d field=path");
  }
  return path;
}

function mappedStatus(status: unknown, statusCode: unknown): string {
  switch (status) {
    case "scheduled": return "NS";
    case "in_play":
    case "live": return statusCode === "half" ? "HT" : "LIVE";
    case "finished": return statusCode === "full" ? "FT" : "UNKNOWN_FINISH";
    case "unknown": return "UNKNOWN";
    case "postponed": return "PST";
    case "cancelled": return "CANC";
    default: return typeof status === "string" ? status : "";
  }
}

function mapFixture(value: unknown, league: ProviderAdapterLeague): ApiFootballFixture {
  const row = asRecord(value);
  if (row === null) return {} as ApiFootballFixture;
  const sourceLeague = asRecord(row.league);
  const teams = asRecord(row.teams);
  const home = asRecord(teams?.home);
  const away = asRecord(teams?.away);
  const goals = asRecord(row.goals);
  const kickoff = asText(row.kickoff_utc) ?? "";
  const timestamp = typeof row.kickoff_ts === "number"
    ? row.kickoff_ts
    : Number.isFinite(Date.parse(kickoff)) ? Math.floor(Date.parse(kickoff) / 1000) : 0;
  const id = asIdentifier(row.id) ?? "";
  return {
    provider: "5dollar",
    fixture: { id, date: kickoff, timestamp, status: { short: mappedStatus(row.status, row.status_code) } },
    league: {
      id: asIdentifier(sourceLeague?.id) ?? league.source_league_ref,
      ...(asText(sourceLeague?.name) ? { name: asText(sourceLeague?.name)! } : {}),
      season: league.season_ref,
      round: typeof row.round === "number" || typeof row.round === "string" ? String(row.round) : "",
    },
    teams: {
      home: { id: asIdentifier(home?.id) ?? "", ...(asText(home?.name) ? { name: asText(home?.name)! } : {}) },
      away: { id: asIdentifier(away?.id) ?? "", ...(asText(away?.name) ? { name: asText(away?.name)! } : {}) },
    },
    score: {
      fulltime: { home: typeof goals?.home === "number" ? goals.home : null, away: typeof goals?.away === "number" ? goals.away : null },
      halftime: { home: null, away: null },
    },
  };
}

function parseData(value: unknown): { rows: unknown[]; hasMore: boolean } {
  const body = asRecord(value);
  const pagination = asRecord(body?.pagination);
  if (body === null || !Array.isArray(body.data)) throw new ProviderDataError("DIAG_PROVIDER_FORMAT source_id=5d field=data");
  return { rows: body.data, hasMore: pagination?.has_more === true };
}

function dateInstants(dateFrom: string, dateTo: string): Array<{ start_time: string; end_time: string }> {
  const from = new Date(`${dateFrom}T00:00:00.000Z`);
  const to = new Date(`${dateTo}T00:00:00.000Z`);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to < from) throw new ProviderDataError("invalid provider date range");
  const result: Array<{ start_time: string; end_time: string }> = [];
  for (let start = from; start <= to;) {
    const end = new Date(start.getTime() + 86_400_000);
    result.push({ start_time: String(Math.floor(start.getTime() / 1000)), end_time: String(Math.floor(end.getTime() / 1000)) });
    start = end;
  }
  return result;
}

export class FiveDollarAdapter implements ProviderAdapter {
  readonly sourceId = "5d" as const;
  readonly provider = "5dollar" as const;
  private liveCache: readonly ApiFootballFixture[] | null = null;
  private liveCacheKey = "";

  constructor(private readonly http: ProviderHttpClient) {}

  async fetchSeasonFixtures(league: ProviderAdapterLeague, options?: ProviderAdapterCallOptions): Promise<readonly ApiFootballFixture[]> {
    return this.fetchPages(`leagues/${encodeURIComponent(league.source_league_ref)}/fixtures`, {}, league, options);
  }

  async fetchFixturesByDateRange(
    league: ProviderAdapterLeague,
    dateFrom: string,
    dateTo: string,
    options?: ProviderAdapterCallOptions,
  ): Promise<readonly ApiFootballFixture[]> {
    const results: ApiFootballFixture[] = [];
    for (const window of dateInstants(dateFrom, dateTo)) {
      results.push(...await this.fetchPages("fixtures", window, league, options));
    }
    return results;
  }

  async fetchLiveFixtures(options?: ProviderAdapterCallOptions): Promise<readonly ApiFootballFixture[]> {
    const cacheKey = options?.serverNow ? options.serverNow.toISOString().slice(0, 16) : new Date().toISOString().slice(0, 16);
    if (this.liveCacheKey === cacheKey && this.liveCache !== null) return this.liveCache;
    const league: ProviderAdapterLeague = { league_id: "", source_league_ref: "", season_ref: "2026" };
    this.liveCache = await this.fetchPages("fixtures", { status: "live" }, league, options);
    this.liveCacheKey = cacheKey;
    return this.liveCache;
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

  private async fetchPages(
    path: string,
    query: Record<string, string>,
    league: ProviderAdapterLeague,
    options?: ProviderAdapterCallOptions,
  ): Promise<ApiFootballFixture[]> {
    const output: ApiFootballFixture[] = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      await options?.beforeRequest?.();
      const body = await this.http.getJson(fixturePath(path), { ...query, page: String(page), per_page: "100" });
      const parsed = parseData(body);
      output.push(...parsed.rows.map((row) => mapFixture(row, league)));
      hasMore = parsed.hasMore;
      page += 1;
    }
    return output;
  }
}
