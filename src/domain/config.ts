/**
 * 固定配置 v1（规范第 3 节）。
 *
 * 所有业务语义配置在此冻结。影响历史结果的配置（计分、等级、解锁）变更必须新建版本；
 * 仅运维/频率类配置允许通过配置中心改变。
 */
import { ScoringRuleVersion, UnlockConfigVersion } from "./enums.js";

/**
 * 开发占位周，取当前仓库最早的排行榜开发样例周。
 * 上线前必须改为真实上线周；上线后只追加，不回改。
 */
export const RANKING_FIRST_PERIOD_KEY = "2026-W31";
export const SUMMARY_UPCOMING_WINDOW_DAYS = 14;

export const FIXED_CONFIG_V1 = {
  schema_version: 1,

  PREDICTION_LOCK_MINUTES: 10,
  PREDICTION_SCORE_MIN: 0,
  PREDICTION_SCORE_MAX: 20,

  FINAL_SCORE_MIN: 0,
  FINAL_SCORE_MAX: 99,

  SETTLEMENT_WAIT_MINUTES: 10,

  SCORING_RULE_VERSION: ScoringRuleVersion.ScoringV1,
  WDL_HIT_SCORE: 3,
  EXACT_HIT_SCORE: 12,

  RANKING_UI_LIMIT: 20,
  API_DEFAULT_LIMIT: 20,
  API_MAX_LIMIT: 100,

  CROWD_MIN_PREDICTIONS: 20,
  CROWD_GRANULARITY_PERCENT: 5,

  SYNC_FUTURE_DAYS: 30,
  SYNC_NORMAL_INTERVAL_HOURS: 6,
  SYNC_NEAR_24H_TO_2H_INTERVAL_MINUTES: 30,
  SYNC_NEAR_2H_TO_FINISH_INTERVAL_MINUTES: 3,

  SYNC_RETRY_DELAYS_MINUTES: [1, 2, 5, 10, 30],
  SYNC_MAX_RETRIES: 5,
  SYNC_RETRY_JITTER_PERCENT: 20,

  LIVE_SYNC_FAILURE_ALERT_MINUTES: 10,
  LIVE_TOO_LONG_AFTER_KICKOFF_MINUTES: 150,
  FINISHED_NO_SCORE_ALERT_MINUTES: 20,

  JOB_LEASE_MINUTES: 10,
  SYNC_LOG_RETENTION_DAYS: 30,

  LEVEL_RULE_VERSION: "level_v3.0",
  LEVEL_MIN: 1,
  LEVEL_MAX: 6,
  LEVEL_RATED_MIN_VALID: 20,
  LEVEL_PRIOR_WEIGHT_K: 40,
  LEVEL_PRIOR_MEAN_X100: 170,
  LEVEL_WINDOW_MAX_N: 300,
  LEVEL_WINDOW_MAX_DAYS: 730,
  LEVEL_PROMOTE_X100: { 3: 180, 4: 195, 5: 215, 6: 235 },
  LEVEL_HOLD_X100: { 3: 170, 4: 185, 5: 205, 6: 225 },
  LEVEL_B_POINTS: { 3: 80, 4: 170, 5: 380, 6: 630 },
  LEVEL_DEMOTE_CONSECUTIVE: 2,
  LEVEL_MAX_STEP_PER_WEEK: 1,
  LEVEL_EVAL_START_DELAY_MINUTES: 10,
  LEVEL_FIRST_EVAL_AS_OF: null,
  LEVEL_PROTECTION_EVALS: 13,
  LEVEL_SEASON_BOUNDARY: "07-01 00:00 Asia/Shanghai",

  RANKING_BOARDS: ["week", "career", "strength", "season"],
  WEEK_BOARD_MIN_VALID: 1,
  SEASON_BOARD_MIN_VALID: 1,
  SEASON_BOARD_MIN_SEASONS: 2,
  STRENGTH_BOARD_MIN_WINDOW_N: 50,
  RANKING_TOP_LIMIT: 20,
  RANKING_PAGE_SIZE: 10,
  RANKING_WEEK_WINDOW: 4,
  RANKING_ABSOLUTE_RANK_MAX: 20,
  RANKING_TOP_PERCENT_CLAMP: [1, 99],
  CAREER_BOARD_SNAPSHOT_MINUTES: 60,
  SEASON_BOARD_SNAPSHOT_MINUTES: 60,
  GROUP_MAX_MEMBERS: 500,
  USER_MAX_GROUPS_JOINED: 20,
  USER_MAX_GROUPS_OWNED: 5,
  GROUP_INVITE_CODE_LENGTH: 8,
  GROUP_INVITE_CODE_ALPHABET: "ABCDEFGHJKLMNPQRSTUVWXYZ23456789",
} as const;

export const SUPPORTED_LEAGUES = [
  {
    league_id: "premier_league",
    name: "英超",
    provider: "football_data",
    api_football_league_id: "39",
    api_football_season: "2026",
    provider_source_id: "fd",
    source_league_ref: "PL",
    source_season_ref: "2026",
    provider_refs: {
      fd: "PL",
      bsd: null,
      "5d": "4160026622",
      of: "comp_premier_league_eng",
      sp: null,
    },
    provider_season_refs: {
      fd: null,
      bsd: null,
      "5d": null,
      of: "2026/27",
      sp: null,
    },
    season_id: "2026_2027",
    round_max: 38,
  },
  {
    league_id: "la_liga",
    name: "西甲",
    provider: "football_data",
    api_football_league_id: "140",
    api_football_season: "2026",
    provider_source_id: "fd",
    source_league_ref: "PD",
    source_season_ref: "2026",
    provider_refs: {
      fd: "PD",
      bsd: null,
      "5d": "4212821298",
      of: "comp_laliga_es",
      sp: null,
    },
    provider_season_refs: {
      fd: null,
      bsd: null,
      "5d": null,
      of: "2026/27",
      sp: null,
    },
    season_id: "2026_2027",
    round_max: 38,
  },
  {
    league_id: "serie_a",
    name: "意甲",
    provider: "football_data",
    api_football_league_id: "135",
    api_football_season: "2026",
    provider_source_id: "fd",
    source_league_ref: "SA",
    source_season_ref: "2026",
    provider_refs: {
      fd: "SA",
      bsd: null,
      "5d": "3405541143",
      of: "comp_serie_a_it",
      sp: null,
    },
    provider_season_refs: {
      fd: null,
      bsd: null,
      "5d": null,
      of: "2026/27",
      sp: null,
    },
    season_id: "2026_2027",
    round_max: 38,
  },
  {
    league_id: "bundesliga",
    name: "德甲",
    provider: "football_data",
    api_football_league_id: "78",
    api_football_season: "2026",
    provider_source_id: "fd",
    source_league_ref: "BL1",
    source_season_ref: "2026",
    provider_refs: {
      fd: "BL1",
      bsd: null,
      "5d": "686337048",
      of: "comp_bundesliga_de",
      sp: null,
    },
    provider_season_refs: {
      fd: null,
      bsd: null,
      "5d": null,
      of: "2026/27",
      sp: null,
    },
    season_id: "2026_2027",
    round_max: 34,
  },
  {
    league_id: "ligue_1",
    name: "法甲",
    provider: "football_data",
    api_football_league_id: "61",
    api_football_season: "2026",
    provider_source_id: "fd",
    source_league_ref: "FL1",
    source_season_ref: "2026",
    provider_refs: {
      fd: "FL1",
      bsd: null,
      "5d": "3614399544",
      of: "comp_ligue_1_fr",
      sp: null,
    },
    provider_season_refs: {
      fd: null,
      bsd: null,
      "5d": null,
      of: "2026/27",
      sp: null,
    },
    season_id: "2026_2027",
    round_max: 34,
  },
  {
    league_id: "chinese_super_league",
    name: "中超",
    provider: "bsd",
    api_football_league_id: "169",
    api_football_season: "2026",
    provider_source_id: "bsd",
    source_league_ref: "52",
    source_season_ref: "2026",
    provider_refs: {
      fd: null,
      bsd: "52",
      "5d": null,
      of: "comp_chinese_super_league_chn",
      sp: "85",
    },
    provider_season_refs: {
      fd: null,
      bsd: null,
      "5d": null,
      of: "2026",
      sp: null,
    },
    season_id: "2026",
    round_max: 30,
  },
] as const;

export const LEVEL_ELIGIBLE_LEAGUES = SUPPORTED_LEAGUES;

export type SupportedLeague = (typeof SUPPORTED_LEAGUES)[number];
export type SupportedLeagueId = SupportedLeague["league_id"];
export type ProviderLeagueSourceId = "fd" | "bsd" | "5d" | "of" | "sp";
export type ProviderSeasonRefs = Readonly<Record<ProviderLeagueSourceId, string | null>>;

export interface LeagueSeasonRefs {
  season_id: string;
  api_football_season: string;
  source_season_ref: string;
  provider_season_refs: ProviderSeasonRefs;
}

export interface ConfiguredProviderLeagueRef {
  source_id: ProviderLeagueSourceId;
  source_league_ref: string;
  league_id: SupportedLeagueId;
}

export type ProviderLeagueRefs = Readonly<Record<string, Readonly<Record<string, SupportedLeagueId>>>>;

/** 解析单个 runtime 的源联赛映射；默认静态配置仍作为未覆盖引用的回退。 */
export function buildProviderLeagueRefs(
  entries: readonly ConfiguredProviderLeagueRef[],
): ProviderLeagueRefs {
  const next: Record<string, Record<string, SupportedLeagueId>> = {};
  for (const entry of entries) {
    const byRef = next[entry.source_id] ?? (next[entry.source_id] = {});
    const existing = byRef[entry.source_league_ref];
    if (existing !== undefined && existing !== entry.league_id) {
      throw new Error(
        `DIAG_PROVIDER_LEAGUE_REF_CONFLICT source_id=${entry.source_id} source_league_ref=${entry.source_league_ref} league_ids=${existing},${entry.league_id}`,
      );
    }
    byRef[entry.source_league_ref] = entry.league_id;
  }
  return next;
}

export function findSupportedLeagueByProviderId(
  providerLeagueId: string,
  provider: "api_football" | "football_data" | "bsd" | "5dollar" | "openfoot" | "sportapi" = "api_football",
  providerLeagueRefs?: ProviderLeagueRefs,
): SupportedLeague | undefined {
  if (provider === "api_football") {
    return SUPPORTED_LEAGUES.find((row) => row.api_football_league_id === providerLeagueId);
  }
  const sourceId = provider === "football_data" ? "fd"
    : provider === "bsd" ? "bsd"
    : provider === "5dollar" ? "5d"
    : provider === "openfoot" ? "of"
    : provider === "sportapi" ? "sp"
    : null;
  if (sourceId === null) return undefined;
  const configuredLeagueId = providerLeagueRefs?.[sourceId]?.[providerLeagueId];
  if (configuredLeagueId !== undefined) {
    return SUPPORTED_LEAGUES.find((row) => row.league_id === configuredLeagueId);
  }
  return SUPPORTED_LEAGUES.find((row) => row.provider_refs[sourceId] === providerLeagueId);
}

export function providerForLeague(
  leagueId: string,
): "api_football" | "football_data" | "bsd" | "5dollar" | "openfoot" | "sportapi" | undefined {
  return findSupportedLeagueById(leagueId)?.provider;
}

export function findSupportedLeagueById(leagueId: string): SupportedLeague | undefined {
  return SUPPORTED_LEAGUES.find((row) => row.league_id === leagueId);
}

export function providerSeasonRef(
  league: SupportedLeague,
  sourceId: ProviderLeagueSourceId,
): string {
  return league.provider_season_refs[sourceId] ?? league.source_season_ref;
}

/** 解析赛季标识的起始年；无法解析返回 null。 */
export function seasonStartYear(seasonId: string): number | null {
  const crossYear = /^(\d{4})_(\d{4})$/.exec(seasonId);
  if (crossYear) return Number(crossYear[1]);

  const naturalYear = /^(\d{4})(?:\/\d{2})?$/.exec(seasonId);
  return naturalYear ? Number(naturalYear[1]) : null;
}

export function targetProviderSeasonRef(league: SupportedLeague, sourceId: ProviderLeagueSourceId, seasonId: string): string {
  const year = seasonStartYear(seasonId);
  if (year === null) throw new Error(`invalid season_id: ${seasonId}`);
  if (seasonId === league.season_id) return league.provider_season_refs[sourceId] ?? league.source_season_ref;
  if (/^\d{4}_\d{4}$/.test(seasonId) && sourceId === "of" && league.provider_season_refs.of !== null) {
    return `${year}/${String(year + 1).slice(-2)}`;
  }
  return String(year);
}

/** 按 UTC 时间推导该联赛当前赛季标识；无法解析联赛形态时返回 league.season_id。 */
export function deriveSeasonId(league: SupportedLeague, now: Date): string {
  if (!Number.isFinite(now.getTime())) return league.season_id;

  const crossYear = /^\d{4}_\d{4}$/.test(league.season_id);
  if (crossYear) {
    const currentYear = now.getUTCFullYear();
    const startYear = now.getUTCMonth() >= 6 ? currentYear : currentYear - 1;
    return `${startYear}_${startYear + 1}`;
  }

  if (/^\d{4}$/.test(league.season_id)) {
    return String(now.getUTCFullYear());
  }

  return league.season_id;
}

function deriveProviderSeasonRefs(
  league: SupportedLeague,
  year: number,
  crossYear: boolean,
): ProviderSeasonRefs {
  const refs = {} as Record<ProviderLeagueSourceId, string | null>;
  for (const sourceId of Object.keys(league.provider_season_refs) as ProviderLeagueSourceId[]) {
    const existingRef = league.provider_season_refs[sourceId];
    if (existingRef === null) {
      refs[sourceId] = null;
    } else if (crossYear && sourceId === "of") {
      refs[sourceId] = `${year}/${String(year + 1).slice(-2)}`;
    } else if (crossYear) {
      refs[sourceId] = existingRef;
    } else {
      refs[sourceId] = String(year);
    }
  }
  return refs;
}

/** 按 UTC 时间推导该联赛当前赛季的全部赛季参数。 */
export function activeLeagueSeason(league: SupportedLeague, now: Date): LeagueSeasonRefs {
  const crossYear = /^\d{4}_\d{4}$/.test(league.season_id);
  const naturalYear = /^\d{4}$/.test(league.season_id);
  if ((!crossYear && !naturalYear) || !Number.isFinite(now.getTime())) {
    return {
      season_id: league.season_id,
      api_football_season: league.api_football_season,
      source_season_ref: league.source_season_ref,
      provider_season_refs: { ...league.provider_season_refs },
    };
  }

  const currentYear = now.getUTCFullYear();
  const year = crossYear && now.getUTCMonth() < 6 ? currentYear - 1 : currentYear;
  const seasonId = crossYear ? `${year}_${year + 1}` : String(year);
  return {
    season_id: seasonId,
    api_football_season: String(year),
    source_season_ref: String(year),
    provider_season_refs: deriveProviderSeasonRefs(league, year, crossYear),
  };
}

/** 下一赛季的 season_id；无法解析联赛赛季形态时返回 null。 */
export function nextLeagueSeasonId(league: SupportedLeague, now: Date): string | null {
  const seasonId = activeLeagueSeason(league, now).season_id;
  const startYear = seasonStartYear(seasonId);
  if (startYear === null) return null;

  if (/^\d{4}_\d{4}$/.test(seasonId)) {
    return `${startYear + 1}_${startYear + 2}`;
  }
  if (/^\d{4}$/.test(seasonId)) {
    return String(startYear + 1);
  }
  return null;
}

/** 上一赛季的 season_id；无法解析联赛赛季形态时返回 null。 */
export function previousLeagueSeasonId(league: SupportedLeague, now: Date): string | null {
  const seasonId = activeLeagueSeason(league, now).season_id;
  const startYear = seasonStartYear(seasonId);
  if (startYear === null) return null;

  if (/^\d{4}_\d{4}$/.test(seasonId)) {
    return `${startYear - 1}_${startYear}`;
  }
  if (/^\d{4}$/.test(seasonId)) {
    return String(startYear - 1);
  }
  return null;
}

/** 换季过渡期需要读取的赛季集合：[当前赛季, 上一赛季]（去重，顺序固定）。 */
export function activeSeasonIds(league: SupportedLeague, now: Date): readonly string[] {
  const currentSeasonId = activeLeagueSeason(league, now).season_id;
  const previousSeasonId = previousLeagueSeasonId(league, now);
  return [...new Set(
    previousSeasonId === null
      ? [currentSeasonId]
      : [currentSeasonId, previousSeasonId],
  )];
}

/** 覆盖 [from, to) 查询窗口内可能命中的全部赛季（兼顾跨年/自然年换季过渡与前置赛季）。 */
export function windowSeasonIds(
  league: SupportedLeague,
  from: Date,
  to: Date,
): readonly string[] {
  const crossYear = /^\d{4}_\d{4}$/.test(league.season_id);
  const naturalYear = /^\d{4}$/.test(league.season_id);
  if (
    (!crossYear && !naturalYear) ||
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime())
  ) {
    return [league.season_id];
  }
  const effectiveEnd = to.getTime() > from.getTime() ? new Date(to.getTime() - 1) : from;
  const startSeason = activeLeagueSeason(league, from).season_id;
  const endSeason = activeLeagueSeason(league, effectiveEnd).season_id;
  const startYear = seasonStartYear(startSeason);
  const endYear = seasonStartYear(endSeason);
  if (startYear === null || endYear === null || endYear < startYear) {
    return activeSeasonIds(league, from);
  }
  const ids = new Set<string>();
  const prev = previousLeagueSeasonId(league, from);
  if (prev !== null) {
    ids.add(prev);
  }
  for (let year = startYear; year <= endYear; year += 1) {
    ids.add(crossYear ? `${year}_${year + 1}` : String(year));
  }
  return [...ids];
}

/** 按 UTC 时间取该联赛在指定 provider 下的赛季引用；缺省回退到推导出的 source_season_ref。 */
export function activeProviderSeasonRef(
  league: SupportedLeague,
  sourceId: ProviderLeagueSourceId,
  now: Date,
): string {
  const active = activeLeagueSeason(league, now);
  return active.provider_season_refs[sourceId] ?? active.source_season_ref;
}

/** 按赛季标识推导起止窗口（[start, end) UTC）。 */
export function seasonBounds(seasonId: string): { start: Date; end: Date } | null {
  const crossYear = /^(\d{4})_(\d{4})$/.exec(seasonId);
  if (crossYear) {
    return {
      start: new Date(Date.UTC(Number(crossYear[1]), 6, 1)),
      end: new Date(Date.UTC(Number(crossYear[2]), 6, 1)),
    };
  }
  const naturalYear = /^(\d{4})$/.exec(seasonId);
  if (naturalYear) {
    const year = Number(naturalYear[1]);
    return {
      start: new Date(Date.UTC(year, 0, 1)),
      end: new Date(Date.UTC(year + 1, 0, 1)),
    };
  }
  return null;
}

/** 返回联赛已登记赛季的起止时间窗口（[start, end) UTC）；无法解析时返回 null。 */
export function leagueSeasonBounds(league: SupportedLeague): { start: Date; end: Date } | null {
  return seasonBounds(league.season_id);
}

/** 按 UTC 时间推导该联赛当前赛季的起止窗口。 */
export function activeLeagueSeasonBounds(
  league: SupportedLeague,
  now: Date,
): { start: Date; end: Date } | null {
  return seasonBounds(activeLeagueSeason(league, now).season_id);
}

export function isSupportedLeagueId(value: string): value is SupportedLeagueId {
  return findSupportedLeagueById(value) !== undefined;
}

export const MVP_SEASON = {
  league_id: SUPPORTED_LEAGUES[0].league_id,
  season_id: SUPPORTED_LEAGUES[0].season_id,
  provider: "football_data",
  api_football_league_id: SUPPORTED_LEAGUES[0].api_football_league_id,
  api_football_season: SUPPORTED_LEAGUES[0].api_football_season,
} as const;

export const UNLOCK_CONFIG_V1 = {
  source_version: UnlockConfigVersion.UnlockV1,
  thresholds: [
    { threshold_points: 30, unlock_code: "profile_card_style_1" },
    { threshold_points: 100, unlock_code: "favorite_team_name_accent" },
    { threshold_points: 200, unlock_code: "favorite_team_avatar_frame_1" },
  ] as const,
} as const;
