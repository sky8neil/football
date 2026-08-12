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

  GLOBAL_WEEK_MIN_PREDICTIONS: 3,
  GLOBAL_MONTH_MIN_PREDICTIONS: 3,

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
} as const;

export const MVP_SEASON = {
  league_id: "premier_league",
  season_id: "2026_2027",
  provider: "api_football",
  api_football_league_id: "39",
  api_football_season: "2026",
} as const;

export const MIN_RANK_PREDICTIONS = 3;

/** MVP 解锁配置（规范 18.2）。 */
export const UNLOCK_CONFIG_V1 = {
  source_version: UnlockConfigVersion.UnlockV1,
  thresholds: [
    { threshold_points: 30, unlock_code: "profile_card_style_1" },
    { threshold_points: 100, unlock_code: "favorite_team_name_accent" },
    { threshold_points: 200, unlock_code: "favorite_team_avatar_frame_1" },
  ] as const,
} as const;
