import { ProviderDataError } from "./http.js";
import type { ProviderAdapter, ProviderAdapterCallOptions, ProviderAdapterLeague, ProviderHttpClient } from "./adapter.js";
import { asArray, asIdentifier, asRecord, asText } from "./adapter.js";
import type { ApiFootballFixture, ApiFootballTeam } from "./types.js";

function mapStatus(status: unknown): string {
  switch (status) {
    case "SCHEDULED":
    case "TIMED": return "NS";
    case "IN_PLAY": return "LIVE";
    case "PAUSED": return "HT";
    case "FINISHED": return "FT";
    case "POSTPONED": return "PST";
    case "CANCELLED": return "CANC";
    case "SUSPENDED": return "SUSP";
    case "AWARDED": return "AWARDED";
    default: return typeof status === "string" ? status : "";
  }
}

function mapMatch(value: unknown): ApiFootballFixture {
  const match = asRecord(value);
  if (match === null) return {} as ApiFootballFixture;
  const competition = asRecord(match.competition);
  const home = asRecord(match.homeTeam);
  const away = asRecord(match.awayTeam);
  const season = asRecord(match.season);
  const score = asRecord(match.score);
  const duration = score?.duration;
  const scoreIsRegular = duration === "REGULAR";
  const finalScoreIsUsable = match.status !== "FINISHED" || scoreIsRegular;
  const regularTime = asRecord(scoreIsRegular ? score?.regularTime : null);
  const fullTime = asRecord(scoreIsRegular ? score?.fullTime : null);
  const finalScore = regularTime ?? fullTime;
  const kickoff = typeof match.utcDate === "string" ? match.utcDate : "";
  const round = match.matchday;

  return {
    provider: "football_data",
    fixture: {
      id: asIdentifier(match.id) ?? "",
      date: kickoff,
      timestamp: Number.isFinite(Date.parse(kickoff)) ? Math.floor(Date.parse(kickoff) / 1000) : 0,
      status: { short: finalScoreIsUsable ? mapStatus(match.status) : "AWARDED" },
    },
    league: {
      id: asIdentifier(competition?.code) ?? "PL",
      ...(asText(competition?.name) ? { name: asText(competition?.name)! } : {}),
      season: typeof season?.startDate === "string" ? season.startDate.slice(0, 4) : "",
      round: typeof round === "number" ? `Matchday ${round}` : "",
    },
    teams: {
      home: { id: asIdentifier(home?.id) ?? "", ...(asText(home?.name) ? { name: asText(home?.name)! } : {}) },
      away: { id: asIdentifier(away?.id) ?? "", ...(asText(away?.name) ? { name: asText(away?.name)! } : {}) },
    },
    score: {
      fulltime: {
        home: typeof finalScore?.home === "number" ? finalScore.home : null,
        away: typeof finalScore?.away === "number" ? finalScore.away : null,
      },
      halftime: { home: null, away: null },
    },
  };
}

function mapTeam(value: unknown): ApiFootballTeam | null {
  const team = asRecord(value);
  if (team === null) return null;
  const id = asIdentifier(team.id);
  const name = asText(team.name);
  if (id === undefined || name === undefined) return null;
  return { team: { id, name } };
}

function parseMatches(value: unknown): unknown[] {
  const response = asRecord(value);
  if (response === null || !Array.isArray(response.matches)) {
    throw new ProviderDataError("DIAG_PROVIDER_FORMAT source_id=fd field=matches");
  }
  return response.matches;
}

function dateChunks(dateFrom: string, dateTo: string): Array<{ from: string; to: string }> {
  const from = new Date(`${dateFrom}T00:00:00.000Z`);
  const to = new Date(`${dateTo}T00:00:00.000Z`);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) {
    throw new ProviderDataError("invalid provider date range");
  }
  return [{ from: dateFrom, to: dateTo }];
}

export class FootballDataAdapter implements ProviderAdapter {
  readonly sourceId = "fd" as const;
  readonly provider = "football_data" as const;

  constructor(private readonly http: ProviderHttpClient) {}

  async fetchSeasonFixtures(league: ProviderAdapterLeague, options?: ProviderAdapterCallOptions): Promise<readonly ApiFootballFixture[]> {
    await options?.beforeRequest?.();
    const matches = parseMatches(await this.http.getJson(
      `competitions/${encodeURIComponent(league.source_league_ref)}/matches`,
      { season: league.season_ref },
    ));
    return matches.map(mapMatch);
  }

  async fetchFixturesByDateRange(
    league: ProviderAdapterLeague,
    dateFrom: string,
    dateTo: string,
    options?: ProviderAdapterCallOptions,
  ): Promise<readonly ApiFootballFixture[]> {
    const output: ApiFootballFixture[] = [];
    for (const chunk of dateChunks(dateFrom, dateTo)) {
      await options?.beforeRequest?.();
      const matches = parseMatches(await this.http.getJson(
        `competitions/${encodeURIComponent(league.source_league_ref)}/matches`,
        { dateFrom: chunk.from, dateTo: chunk.to },
      ));
      output.push(...matches.map(mapMatch));
    }
    return output;
  }

  async fetchTeams(league: ProviderAdapterLeague, options?: ProviderAdapterCallOptions): Promise<readonly ApiFootballTeam[]> {
    const fixtures = await this.fetchSeasonFixtures(league, options);
    const teams = new Map<string, ApiFootballTeam>();
    for (const fixture of fixtures) {
      for (const side of [fixture.teams?.home, fixture.teams?.away]) {
        const id = asIdentifier(side?.id);
        const name = asText(side?.name);
        if (id !== undefined && name !== undefined) teams.set(String(id), {
          provider: this.provider,
          team: { id, name },
        });
      }
    }
    return [...teams.values()];
  }
}
