/**
 * 固定配置 v1（规范第 3 节）。
 *
 * 所有业务语义配置在此冻结。影响历史结果的配置（计分、等级、解锁）变更必须新建版本；
 * 仅运维/频率类配置允许通过配置中心改变。
 */
import { ScoringRuleVersion, UnlockConfigVersion } from "./enums.js";

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

  RANKING_BOARDS: ["week", "career", "strength"],
  WEEK_BOARD_MIN_VALID: 1,
  STRENGTH_BOARD_MIN_WINDOW_N: 50,
  RANKING_TOP_LIMIT: 20,
  RANKING_PAGE_SIZE: 10,
  RANKING_ABSOLUTE_RANK_MAX: 20,
  RANKING_TOP_PERCENT_CLAMP: [1, 99],
  CAREER_BOARD_SNAPSHOT_MINUTES: 60,
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
    api_football_league_id: "39",
    api_football_season: "2026",
    season_id: "2026_2027",
    round_max: 38,
  },
  {
    league_id: "la_liga",
    name: "西甲",
    api_football_league_id: "140",
    api_football_season: "2026",
    season_id: "2026_2027",
    round_max: 38,
  },
  {
    league_id: "serie_a",
    name: "意甲",
    api_football_league_id: "135",
    api_football_season: "2026",
    season_id: "2026_2027",
    round_max: 38,
  },
  {
    league_id: "bundesliga",
    name: "德甲",
    api_football_league_id: "78",
    api_football_season: "2026",
    season_id: "2026_2027",
    round_max: 34,
  },
  {
    league_id: "ligue_1",
    name: "法甲",
    api_football_league_id: "61",
    api_football_season: "2026",
    season_id: "2026_2027",
    round_max: 34,
  },
  {
    league_id: "chinese_super_league",
    name: "中超",
    api_football_league_id: "169",
    api_football_season: "2026",
    season_id: "2026",
    round_max: 30,
  },
] as const;

export const LEVEL_ELIGIBLE_LEAGUES = SUPPORTED_LEAGUES;

export type SupportedLeague = (typeof SUPPORTED_LEAGUES)[number];
export type SupportedLeagueId = SupportedLeague["league_id"];

export function findSupportedLeagueByProviderId(
  providerLeagueId: string,
): SupportedLeague | undefined {
  return SUPPORTED_LEAGUES.find((row) => row.api_football_league_id === providerLeagueId);
}

export function findSupportedLeagueById(leagueId: string): SupportedLeague | undefined {
  return SUPPORTED_LEAGUES.find((row) => row.league_id === leagueId);
}

export function isSupportedLeagueId(value: string): value is SupportedLeagueId {
  return findSupportedLeagueById(value) !== undefined;
}

export const MVP_SEASON = {
  league_id: SUPPORTED_LEAGUES[0].league_id,
  season_id: SUPPORTED_LEAGUES[0].season_id,
  provider: "api_football",
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
