/**
 * API-Football adapter / client contract（阶段 3，规范 31.1）。
 *
 * - Provider 只允许读取：赛程（fixtures）、球队（teams）、round（fixtures/rounds）、status。
 * - 禁止 odds / bookmaker / bet 等任何博彩市场接口（31.1），未知端点一律 fail-closed。
 * - HTTP 客户端可注入（ProviderHttpClient），不直接访问真实 API；默认 base URL 仅作约定。
 * - quota 超限（errors.quota / HTTP 429）抛 ProviderQuotaExceededError，调用方停止高频自动重试（32.8）。
 */
import type {
  ApiFootballEnvelope,
  ApiFootballFixture,
  ApiFootballStatusResult,
  ApiFootballTeam,
} from "./types.js";

export const API_FOOTBALL_BASE_URL = "https://v3.football.api-sports.io";

export const READ_ONLY_ENDPOINTS: readonly string[] = [
  "fixtures",
  "teams",
  "fixtures/rounds",
  "status",
];

const FORBIDDEN_PATH_PATTERN = /(odds|bookmaker|bet)/i;

export class ProviderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
  }
}

export class ProviderHttpError extends ProviderError {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`PROVIDER_HTTP_${status}`, message);
    this.name = "ProviderHttpError";
    this.status = status;
  }
}

export class ProviderQuotaExceededError extends ProviderError {
  readonly resetAt: Date | null;
  constructor(resetAt: Date | null) {
    super("PROVIDER_QUOTA_EXCEEDED", "Provider quota exceeded");
    this.name = "ProviderQuotaExceededError";
    this.resetAt = resetAt;
  }
}

export class ProviderDataError extends ProviderError {
  constructor(message: string) {
    super("PROVIDER_DATA_ERROR", message);
    this.name = "ProviderDataError";
  }
}

/** 只读端点白名单（31.1）。非白名单或含 odds/bookmaker/bet 一律拒绝。 */
export function assertReadOnlyEndpoint(path: string): void {
  if (!READ_ONLY_ENDPOINTS.includes(path) || FORBIDDEN_PATH_PATTERN.test(path)) {
    throw new ProviderDataError(`forbidden or unknown provider endpoint: ${path}`);
  }
}

export interface ProviderHttpClient {
  getJson(path: string, query: Record<string, string>): Promise<unknown>;
}

export interface ApiFootballFixturesQuery {
  dateFrom: string;
  dateTo: string;
  leagueId: string;
  season: string;
  round?: string;
}

export interface ApiFootballSeasonFixturesQuery {
  leagueId: string;
  season: string;
}

export interface ApiFootballTeamQuery {
  leagueId: string;
  season: string;
}

function decodeEnvelope<T>(json: unknown): ApiFootballEnvelope<T> {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new ProviderDataError("invalid provider envelope");
  }
  const env = json as Partial<ApiFootballEnvelope<T>>;
  const errors = env.errors;
  if (Array.isArray(errors)) {
    if (errors.length > 0) {
      throw new ProviderDataError(`provider errors: ${JSON.stringify(errors)}`);
    }
  } else if (typeof errors === "object" && errors !== null) {
    const keys = Object.keys(errors);
    if (keys.length > 0) {
      if ("quota" in errors) {
        throw new ProviderQuotaExceededError(null);
      }
      throw new ProviderDataError(`provider errors: ${JSON.stringify(errors)}`);
    }
  }
  if (!Array.isArray(env.response)) {
    throw new ProviderDataError("provider envelope missing response array");
  }
  return env as ApiFootballEnvelope<T>;
}

function isStatusResult(value: unknown): value is ApiFootballStatusResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const account = (value as Record<string, unknown>).account;
  return typeof account === "object" && account !== null && !Array.isArray(account);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isProviderSeason(value: unknown): boolean {
  return (
    typeof value === "string" && value.length > 0 ||
    typeof value === "number" && Number.isInteger(value) && value > 0
  );
}

function isApiFootballFixture(value: unknown): value is ApiFootballFixture {
  if (!isRecord(value)) {
    return false;
  }
  const fixture = value.fixture;
  const league = value.league;
  const teams = value.teams;
  if (!isRecord(fixture) || !isRecord(league) || !isRecord(teams)) {
    return false;
  }

  const status = fixture.status;
  const home = teams.home;
  const away = teams.away;
  return (
    isPositiveInteger(fixture.id) &&
    typeof fixture.date === "string" &&
    fixture.date.length > 0 &&
    typeof fixture.timestamp === "number" &&
    Number.isFinite(fixture.timestamp) &&
    isRecord(status) &&
    typeof status.short === "string" &&
    status.short.length > 0 &&
    isPositiveInteger(league.id) &&
    isProviderSeason(league.season) &&
    typeof league.round === "string" &&
    league.round.length > 0 &&
    isRecord(home) &&
    isRecord(away) &&
    isPositiveInteger(home.id) &&
    isPositiveInteger(away.id)
  );
}

function isApiFootballTeam(value: unknown): value is ApiFootballTeam {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const team = (value as Record<string, unknown>).team;
  if (typeof team !== "object" || team === null || Array.isArray(team)) {
    return false;
  }
  const fields = team as Record<string, unknown>;
  return (
    typeof fields.id === "number" &&
    Number.isInteger(fields.id) &&
    fields.id > 0 &&
    typeof fields.name === "string" &&
    fields.name.length > 0
  );
}

function isApiFootballRound(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export class ApiFootballClient {
  constructor(
    private readonly http: ProviderHttpClient,
    private readonly baseUrl: string = API_FOOTBALL_BASE_URL,
  ) {}

  private async request<T>(
    endpoint: string,
    query: Record<string, string>,
  ): Promise<ApiFootballEnvelope<T>> {
    assertReadOnlyEndpoint(endpoint);
    let json: unknown;
    try {
      json = await this.http.getJson(`${this.baseUrl}/${endpoint}`, query);
    } catch (err) {
      if (err instanceof ProviderHttpError && err.status === 429) {
        throw new ProviderQuotaExceededError(null);
      }
      throw err;
    }
    return decodeEnvelope<T>(json);
  }

  async getFixtures(query: ApiFootballFixturesQuery): Promise<ApiFootballFixture[]> {
    const env = await this.request<ApiFootballFixture>("fixtures", {
      from: query.dateFrom,
      to: query.dateTo,
      league: query.leagueId,
      season: query.season,
      timezone: "UTC",
      ...(query.round !== undefined ? { round: query.round } : {}),
    });
    if (!env.response.every(isApiFootballFixture)) {
      throw new ProviderDataError("provider fixtures response missing fixture fields");
    }
    return env.response;
  }

  async getSeasonFixtures(
    query: ApiFootballSeasonFixturesQuery,
  ): Promise<ApiFootballFixture[]> {
    const env = await this.request<ApiFootballFixture>("fixtures", {
      league: query.leagueId,
      season: query.season,
      timezone: "UTC",
    });
    if (!env.response.every(isApiFootballFixture)) {
      throw new ProviderDataError("provider fixtures response missing fixture fields");
    }
    return env.response;
  }

  async getTeams(query: ApiFootballTeamQuery): Promise<ApiFootballTeam[]> {
    const env = await this.request<ApiFootballTeam>("teams", {
      league: query.leagueId,
      season: query.season,
    });
    if (!env.response.every(isApiFootballTeam)) {
      throw new ProviderDataError("provider teams response missing team fields");
    }
    return env.response;
  }

  async getFixtureRounds(query: ApiFootballTeamQuery): Promise<string[]> {
    const env = await this.request<string>("fixtures/rounds", {
      league: query.leagueId,
      season: query.season,
    });
    if (!env.response.every(isApiFootballRound)) {
      throw new ProviderDataError("provider rounds response contains invalid round");
    }
    return env.response;
  }

  async getStatus(): Promise<ApiFootballStatusResult> {
    const env = await this.request<ApiFootballStatusResult>("status", {});
    const status = env.response[0];
    if (!isStatusResult(status)) {
      throw new ProviderDataError("provider status response missing account");
    }
    return status;
  }
}
