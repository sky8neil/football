/**
 * 领域实体类型（内部 camelCase）。
 *
 * 对应规范第 21 节 Collection schema；对外序列化为 snake_case 时通过显式 mapper 转换
 * （规范 2.1）。所有核心文档均携带 schema_version = 1（规范 2.5）。
 */
import type {
  AdminRole,
  AdminAuditAction,
  AdminAuditEntityType,
  AdminStatus,
  AnomalyStatus,
  AnomalyType,
  LevelHistoryReason,
  LevelScope,
  MatchScoreValue,
  MatchStatus,
  PeriodType,
  Provider,
  Result,
  ResultSource,
  ScoringRuleVersion,
  SettlementDocStatus,
  SettlementItemStatus,
  SettlementPhase,
  SettlementStatus,
  SyncJobStatus,
  SyncJobType,
  TeamStatus,
  UserStatus,
} from "./enums.js";

export interface BaseDoc {
  schema_version: number;
}

/**
 * 注销身份映射（D-P1 方案 B，§4.5.1）。
 *
 * original_openid 全局唯一；只供可信 runtime openid 的 deleted 解析，不是登录凭证。
 * 同 openid 重注册后再注销时通过 upsert 指向新的 deleted_user_id。
 */
export interface DeletedOpenidMapping extends BaseDoc {
  original_openid: string;
  deleted_user_id: string;
  deleted_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface User extends BaseDoc {
  user_id: string;
  openid: string;
  unionid: string | null;
  nickname: string | null;
  favorite_team_id: string | null;
  status: UserStatus;
  career_points: number;
  career_valid_predictions: number;
  career_wdl_hits: number;
  career_exact_hits: number;
  career_level: number;
  career_best_level: number;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface UserSeasonStats extends BaseDoc {
  user_id: string;
  season_id: string;
  points: number;
  valid_predictions: number;
  wdl_hits: number;
  exact_hits: number;
  level: number;
  best_level: number;
  created_at: Date;
  updated_at: Date;
}

export interface Team extends BaseDoc {
  team_id: string;
  name: string;
  short_name: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  status: TeamStatus;
  created_at: Date;
  updated_at: Date;
}

export interface TeamProviderMapping extends BaseDoc {
  team_id: string;
  provider: Provider;
  provider_team_id: string;
  created_at: Date;
  updated_at: Date;
}

export interface Match extends BaseDoc {
  match_id: string;
  league_id: string;
  season_id: string;
  round_id: string;
  home_team_id: string;
  away_team_id: string;
  kickoff_at: Date;
  kickoff_confirmed: boolean;
  prediction_deadline_at: Date | null;
  prediction_closed_at: Date | null;
  period_anchor_at: Date | null;
  match_status: MatchStatus;
  settlement_status: SettlementStatus;
  regular_home_score: number | null;
  regular_away_score: number | null;
  extra_home_score: number | null;
  extra_away_score: number | null;
  penalty_home_score: number | null;
  penalty_away_score: number | null;
  result_version: number;
  settled_result_version: number;
  result_source: ResultSource | null;
  scoring_rule_version: ScoringRuleVersion;
  finish_detected_at: Date | null;
  settled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface MatchProviderMapping extends BaseDoc {
  match_id: string;
  provider: Provider;
  provider_match_id: string;
  created_at: Date;
  updated_at: Date;
}

export interface MatchResult extends BaseDoc {
  match_id: string;
  result_version: number;
  regular_home_score: number;
  regular_away_score: number;
  source: ResultSource;
  provider_status: string | null;
  admin_id: string | null;
  reason: string | null;
  created_at: Date;
}

export interface Prediction extends BaseDoc {
  prediction_id: string;
  user_id: string;
  match_id: string;
  idempotency_key: string;
  pred_home_score: number;
  pred_away_score: number;
  derived_result: Result;
  submitted_at: Date;
  scoring_rule_version: ScoringRuleVersion;
  match_score: MatchScoreValue | null;
  wdl_hit: boolean | null;
  exact_hit: boolean | null;
  applied_result_version: number;
  created_at: Date;
  updated_at: Date;
}

export interface RankingEntry extends BaseDoc {
  period_type: PeriodType;
  period_key: string;
  user_id: string;
  period_score: number;
  valid_predictions: number;
  wdl_hits: number;
  exact_hits: number;
  last_scoring_match_at: Date | null;
  global_rank: number | null;
  is_final: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface SettlementDoc extends BaseDoc {
  settlement_id: string;
  match_id: string;
  result_version: number;
  rule_version: string;
  status: SettlementDocStatus;
  phase: SettlementPhase;
  is_correction: boolean;
  started_at: Date | null;
  settled_at: Date | null;
  attempt_count: number;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface SettlementItem extends BaseDoc {
  settlement_id: string;
  prediction_id: string;
  user_id: string;
  old_score: MatchScoreValue;
  new_score: MatchScoreValue;
  score_delta: number;
  old_wdl_hit: boolean;
  new_wdl_hit: boolean;
  old_exact_hit: boolean;
  new_exact_hit: boolean;
  valid_prediction_delta: number;
  source_result_version: number;
  status: SettlementItemStatus;
  applied_at: Date | null;
  attempt_count: number;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Unlock extends BaseDoc {
  unlock_id: string;
  user_id: string;
  unlock_code: string;
  threshold_points: number;
  source_version: string;
  unlocked_at: Date;
}

export interface LevelHistoryEntry extends BaseDoc {
  level_history_id: string;
  user_id: string;
  scope: LevelScope;
  season_id: string | null;
  from_level: number;
  to_level: number;
  wdl_hits: number;
  valid_predictions: number;
  reason: LevelHistoryReason;
  changed_at: Date;
}

export interface AdminAuditLog extends BaseDoc {
  audit_id: string;
  admin_id: string;
  action: AdminAuditAction;
  entity_type: AdminAuditEntityType;
  entity_id: string;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  reason: string;
  created_at: Date;
}

export interface Admin extends BaseDoc {
  admin_id: string;
  openid: string;
  status: AdminStatus;
  role: AdminRole;
  created_at: Date;
  updated_at: Date;
}

export interface ProviderSnapshot extends BaseDoc {
  snapshot_id: string;
  provider: Provider;
  entity_type: "match" | "team";
  entity_id: string | null;
  provider_entity_id: string;
  event_type:
    | "discovered"
    | "kickoff_changed"
    | "status_changed"
    | "result_observed"
    | "result_changed"
    | "provider_error"
    | "provider_conflict"
    | "admin_conflict";
  payload: Record<string, unknown>;
  created_at: Date;
}

export interface SyncLog extends BaseDoc {
  sync_job_id: string;
  job_type: SyncJobType;
  status: SyncJobStatus;
  started_at: Date;
  finished_at: Date | null;
  attempt_count: number;
  items_read: number;
  items_changed: number;
  items_failed: number;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: Date;
}

export interface Anomaly extends BaseDoc {
  anomaly_id: string;
  anomaly_key: string;
  match_id: string;
  type: AnomalyType;
  blocking: boolean;
  status: AnomalyStatus;
  first_seen_at: Date;
  last_seen_at: Date;
  occurrence_count: number;
  details: Record<string, unknown>;
  resolved_at: Date | null;
  resolution: string | null;
}

export interface JobLock extends BaseDoc {
  lock_key: string;
  owner_id: string;
  lease_until: Date;
  updated_at: Date;
}
