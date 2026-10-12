import type { ApiFootballFixture, ApiFootballTeam } from "./types.js";
import type { ProviderBudgetJob } from "./budget.js";

export interface ProviderAdapterCallOptions {
  jobType: ProviderBudgetJob;
  serverNow: Date;
  beforeRequest?: () => Promise<void>;
}

export interface ProviderAdapterLeague {
  league_id: string;
  source_league_ref: string;
  season_ref: string;
}

export interface ProviderHttpResponse {
  data: unknown;
  status: number;
  headers: Headers;
}

export interface ProviderAdapter {
  readonly sourceId: "fd" | "bsd" | "5d" | "of" | "sp";
  readonly provider: "football_data" | "bsd" | "5dollar" | "openfoot" | "sportapi";
  fetchSeasonFixtures(league: ProviderAdapterLeague, options?: ProviderAdapterCallOptions): Promise<readonly ApiFootballFixture[]>;
  fetchFixturesByDateRange(
    league: ProviderAdapterLeague,
    dateFrom: string,
    dateTo: string,
    options?: ProviderAdapterCallOptions,
  ): Promise<readonly ApiFootballFixture[]>;
  fetchTeams(league: ProviderAdapterLeague, options?: ProviderAdapterCallOptions): Promise<readonly ApiFootballTeam[]>;
}

export interface ProviderHttpClient {
  getJson(path: string, query: Record<string, string>): Promise<unknown>;
  getJsonResponse?(path: string, query: Record<string, string>, headers?: Record<string, string>): Promise<ProviderHttpResponse>;
}

export async function getProviderResponse(
  http: ProviderHttpClient,
  path: string,
  query: Record<string, string>,
  headers?: Record<string, string>,
): Promise<ProviderHttpResponse> {
  if (http.getJsonResponse) return http.getJsonResponse(path, query, headers);
  return { data: await http.getJson(path, query), status: 200, headers: new Headers() };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];

}

export function asIdentifier(value: unknown): string | number | undefined {
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value))
    ? value
    : undefined;
}

export function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function utcDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}
