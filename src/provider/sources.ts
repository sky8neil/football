import { Provider } from "../domain/enums.js";
import { SUPPORTED_LEAGUES, type SupportedLeagueId } from "../domain/config.js";
import { ProviderDataError } from "./http.js";

export type ProviderSourceId = "fd" | "bsd" | "5d" | "of" | "sp";
export type ProviderAdapterId = "football_data" | "bsd" | "fivedollar" | "openfoot" | "sportapi";
export type ProviderAuthScheme = "raw" | "token" | "bearer";
export type ProviderRole = "primary" | "secondary" | "fallback" | "reconcile" | "historical" | "disabled";

export interface ProviderSourceKey {
  key_id: string;
  api_key: string;
  env_name: string;
  max_per_minute: number;
}

export interface ProviderSourceLeague {
  league_id: SupportedLeagueId;
  source_league_ref: string;
  season_ref: string;
  roles: {
    schedule: ProviderRole;
    kickoff: ProviderRole;
    live: ProviderRole;
    result: ProviderRole;
    reconcile: ProviderRole;
  };
}

export interface ProviderSource {
  source_id: ProviderSourceId;
  provider: typeof Provider.FootballData | typeof Provider.Bsd | typeof Provider.FiveDollar | typeof Provider.OpenFoot | typeof Provider.SportApi;
  adapter: ProviderAdapterId;
  base_url: string;
  api_key: string;
  api_keys: ProviderSourceKey[];
  auth: { header: string; scheme: ProviderAuthScheme };
  max_per_minute: number;
  daily_cap: number;
  hourly_cap: number | null;
  monthly_cap: number | null;
  day_boundary: "utc" | "local";
  pool_strategy: "least_used" | "failover";
  leagues: ProviderSourceLeague[];
}

export interface ProviderSourcesConfig {
  sources: ProviderSource[];
  sync_profile: "test" | "prod";
  sync_leagues: Set<SupportedLeagueId>;
}

type SourceDefinition = Omit<ProviderSource, "api_key" | "api_keys" | "max_per_minute" | "daily_cap" | "hourly_cap" | "monthly_cap" | "pool_strategy" | "leagues"> & {
  key_envs: readonly string[];
  url_env: string;
  per_minute: number;
  daily_test: number;
  daily_prod: number;
  hourly_test?: number;
  hourly_prod?: number;
  monthly_test?: number;
  monthly_prod?: number;
  day_boundary: "utc" | "local";
  default_leagues: ProviderSourceLeague[];
};

const disabled = "disabled" as const;

const DEFINITIONS: Record<ProviderSourceId, SourceDefinition> = {
  fd: {
    source_id: "fd", provider: Provider.FootballData, adapter: "football_data",
    base_url: "https://api.football-data.org/v4", key_envs: ["FOOTBALL_PROVIDER_KEY_FD_1", "FOOTBALL_PROVIDER_KEY_FD_2"],
    url_env: "FOOTBALL_PROVIDER_URL_FD", auth: { header: "X-Auth-Token", scheme: "raw" },
    per_minute: 6, daily_test: 600, daily_prod: 3000, day_boundary: "local",
    default_leagues: [
      league("fd", "premier_league", "primary", "primary", "secondary", "primary", "reconcile"),
      league("fd", "la_liga", "primary", "primary", "secondary", "primary", "reconcile"),
      league("fd", "serie_a", "primary", "primary", "secondary", "primary", "reconcile"),
      league("fd", "bundesliga", "primary", "primary", "secondary", "primary", "reconcile"),
      league("fd", "ligue_1", "primary", "primary", "secondary", "primary", "reconcile"),
    ],
  },
  bsd: {
    source_id: "bsd", provider: Provider.Bsd, adapter: "bsd",
    base_url: "https://sports.bzzoiro.com/api/v2", key_envs: ["FOOTBALL_PROVIDER_KEY_BSD"],
    url_env: "FOOTBALL_PROVIDER_URL_BSD", auth: { header: "Authorization", scheme: "token" },
    per_minute: 30, daily_test: 1500, daily_prod: 5000, day_boundary: "utc",
    default_leagues: [league("bsd", "chinese_super_league", "primary", "primary", "primary", "primary", "disabled")],
  },
  "5d": {
    source_id: "5d", provider: Provider.FiveDollar, adapter: "fivedollar",
    base_url: "https://api.5dollarfootballapi.com/v1", key_envs: ["FOOTBALL_PROVIDER_KEY_5D"],
    url_env: "FOOTBALL_PROVIDER_URL_5D", auth: { header: "Authorization", scheme: "bearer" },
    per_minute: 4, daily_test: 0, daily_prod: 0, hourly_test: 12, hourly_prod: 40, day_boundary: "utc",
    default_leagues: [
      league("5d", "premier_league", "disabled", "disabled", "primary", "secondary", "disabled"),
      league("5d", "la_liga", "disabled", "disabled", "primary", "secondary", "disabled"),
      league("5d", "serie_a", "disabled", "disabled", "primary", "secondary", "disabled"),
      league("5d", "bundesliga", "disabled", "disabled", "primary", "secondary", "disabled"),
      league("5d", "ligue_1", "disabled", "disabled", "primary", "secondary", "disabled"),
    ],
  },
  of: {
    source_id: "of", provider: Provider.OpenFoot, adapter: "openfoot",
    base_url: "https://openfootapi.com/v1", key_envs: ["FOOTBALL_PROVIDER_KEY_OF"],
    url_env: "FOOTBALL_PROVIDER_URL_OF", auth: { header: "Authorization", scheme: "bearer" },
    per_minute: 60, daily_test: 40, daily_prod: 120, monthly_test: 1000, monthly_prod: 4000, day_boundary: "utc",
    default_leagues: [
      league("of", "premier_league", "disabled", "disabled", "disabled", "fallback", "reconcile"),
      league("of", "la_liga", "disabled", "disabled", "disabled", "fallback", "reconcile"),
      league("of", "serie_a", "disabled", "disabled", "disabled", "fallback", "reconcile"),
      league("of", "bundesliga", "disabled", "disabled", "disabled", "fallback", "reconcile"),
      league("of", "ligue_1", "disabled", "disabled", "disabled", "fallback", "reconcile"),
      league("of", "chinese_super_league", "historical", "disabled", "disabled", "disabled", "historical"),
    ],
  },
  sp: {
    source_id: "sp", provider: Provider.SportApi, adapter: "sportapi",
    base_url: "https://sportapi.ai/api", key_envs: ["FOOTBALL_PROVIDER_KEY_SP"],
    url_env: "FOOTBALL_PROVIDER_URL_SP", auth: { header: "X-Api-Key", scheme: "raw" },
    per_minute: 10, daily_test: 100, daily_prod: 400, day_boundary: "utc",
    default_leagues: [league("sp", "chinese_super_league", "disabled", "disabled", "fallback", "fallback", "reconcile")],
  },
};

function league(
  sourceId: ProviderSourceId,
  league_id: SupportedLeagueId,
  schedule: ProviderRole,
  kickoff: ProviderRole,
  live: ProviderRole,
  result: ProviderRole,
  reconcile: ProviderRole,
): ProviderSourceLeague {
  const supported = SUPPORTED_LEAGUES.find((entry) => entry.league_id === league_id);
  return {
    league_id,
    source_league_ref: supported?.provider_refs[sourceId] ?? "",
    season_ref: supported?.source_season_ref ?? supported?.api_football_season ?? "2026",
    roles: { schedule, kickoff, live, result, reconcile },
  };
}

function numberSetting(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const parsed = Number(env[key]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function providerBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new ProviderDataError("provider base_url must use https");
  return value.replace(/\/$/, "");
}

function configuredRefs(
  raw: string | undefined,
  defaults: readonly ProviderSourceLeague[],
): ProviderSourceLeague[] {
  if (!raw?.trim()) return defaults.map((value) => ({ ...value, roles: { ...value.roles } }));
  const refs = JSON.parse(raw) as Record<string, string>;
  return defaults.map((value) => ({
    ...value,
    source_league_ref: refs[value.league_id] ?? value.source_league_ref,
    roles: { ...value.roles },
  }));
}

export function loadProviderSources(env: Record<string, string | undefined>): ProviderSourcesConfig {
  const enabled = (env.FOOTBALL_PROVIDER_SOURCES ?? "")
    .split(",").map((value) => value.trim().toLowerCase())
    .filter((value): value is ProviderSourceId => value in DEFINITIONS);
  const syncProfile = env.FOOTBALL_SYNC_PROFILE === "prod" ? "prod" : "test";
  const requestedLeagueIds = new Set<SupportedLeagueId>(
    (env.FOOTBALL_SYNC_LEAGUES ?? "premier_league,la_liga,serie_a,bundesliga,ligue_1,chinese_super_league")
      .split(",").map((value) => value.trim())
      .filter((value): value is SupportedLeagueId => [
        "premier_league", "la_liga", "serie_a", "bundesliga", "ligue_1", "chinese_super_league",
      ].includes(value)),
  );

  const sources = enabled.map((sourceId): ProviderSource => {
    const defaults = DEFINITIONS[sourceId];
    const envNames = sourceId === "fd"
      ? ["FOOTBALL_PROVIDER_KEY_FD_1", "FOOTBALL_PROVIDER_KEY_FD_2"]
      : [...defaults.key_envs];
    const legacyFdKey = sourceId === "fd" ? env.FOOTBALL_PROVIDER_KEY_FD?.trim() : undefined;
    const keys = envNames.flatMap((envName, index) => {
      const apiKey = env[envName]?.trim() || (index === 0 ? legacyFdKey : undefined) || "";
      return apiKey ? [{ key_id: `${sourceId}#${index + 1}`, api_key: apiKey, env_name: envName, max_per_minute: numberSetting(env, `FOOTBALL_PROVIDER_PERMIN_${sourceId.toUpperCase()}_${index + 1}`, defaults.per_minute) }] : [];
    });
    if (keys.length === 0) {
      throw new ProviderDataError(`DIAG_PROVIDER_KEY_MISSING source_id=${sourceId} variable=${envNames[0]}`);
    }
    if (sourceId !== "fd" && keys.length !== 1) {
      throw new ProviderDataError(`DIAG_PROVIDER_POOL_NOT_ALLOWED source_id=${sourceId}`);
    }
    const leagueEnv = sourceId === "5d" ? "FOOTBALL_PROVIDER_LEAGUE_REF_5D"
      : sourceId === "of" ? "FOOTBALL_PROVIDER_LEAGUE_REF_OF" : undefined;
    const configuredLeagues = configuredRefs(leagueEnv ? env[leagueEnv] : undefined, defaults.default_leagues)
      .filter((value) => requestedLeagueIds.has(value.league_id));
    const maxPerMinute = sourceId === "fd"
      ? keys.reduce((sum, key) => sum + key.max_per_minute, 0)
      : numberSetting(env, `FOOTBALL_PROVIDER_PERMIN_${sourceId.toUpperCase()}`, defaults.per_minute);
    const dailyDefault = syncProfile === "test" ? defaults.daily_test : defaults.daily_prod;
    const dailyCap = sourceId === "5d" ? 0 : numberSetting(env, `FOOTBALL_PROVIDER_DAILY_${sourceId.toUpperCase()}`, dailyDefault);
    const hourlyDefault = syncProfile === "test" ? defaults.hourly_test : defaults.hourly_prod;
    const monthlyDefault = syncProfile === "test" ? defaults.monthly_test : defaults.monthly_prod;
    const hourlyCap = hourlyDefault ? numberSetting(env, "FOOTBALL_PROVIDER_PERHOUR_5D", hourlyDefault) : null;
    const monthlyCap = monthlyDefault ? numberSetting(env, `FOOTBALL_PROVIDER_MONTHLY_${sourceId.toUpperCase()}`, monthlyDefault) : null;
    const baseUrl = providerBaseUrl(env[defaults.url_env]?.trim() || defaults.base_url);
    return {
      ...defaults,
      base_url: baseUrl,
      api_key: keys[0]!.api_key,
      api_keys: keys,
      max_per_minute: maxPerMinute,
      daily_cap: dailyCap,
      hourly_cap: hourlyCap,
      monthly_cap: monthlyCap,
      pool_strategy: env.FOOTBALL_PROVIDER_POOL_FD === "failover" ? "failover" : "least_used",
      leagues: configuredLeagues,
    };
  });

  const enabledLeagues = new Set(sources.flatMap((source) => source.leagues
    .filter((league) => league.roles.schedule === "primary")
    .map((league) => league.league_id)));
  return {
    sources,
    sync_profile: syncProfile,
    sync_leagues: new Set([...requestedLeagueIds].filter((id) => enabledLeagues.has(id))),
  };
}
