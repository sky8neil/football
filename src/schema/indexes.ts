/**
 * 数据库索引定义（规范第 22 节）。
 *
 * 唯一索引与普通查询索引分别按 22.1 / 22.2 冻结。索引建好后对 core 数据禁止物理删除
 * （0.6 仅允许清理运行日志）。
 */

export interface IndexDef {
  collection: string;
  name: string;
  /** 字段数组；元素为 "field" 或 "field:desc"（如 submitted_at DESC） */
  fields: readonly string[];
  unique: boolean;
}

export const UNIQUE_INDEXES: readonly IndexDef[] = [
  { collection: "users", name: "uk_openid", fields: ["openid"], unique: true },
  {
    collection: "user_season_stats",
    name: "uk_user_season",
    fields: ["user_id", "season_id"],
    unique: true,
  },
  {
    collection: "team_provider_mappings",
    name: "uk_provider_team",
    fields: ["provider", "provider_team_id"],
    unique: true,
  },
  {
    collection: "match_provider_mappings",
    name: "uk_provider_match",
    fields: ["provider", "provider_match_id"],
    unique: true,
  },
  {
    collection: "match_results",
    name: "uk_match_result_version",
    fields: ["match_id", "result_version"],
    unique: true,
  },
  {
    collection: "predictions",
    name: "uk_user_match",
    fields: ["user_id", "match_id"],
    unique: true,
  },
  {
    collection: "predictions",
    name: "uk_user_idempotency",
    fields: ["user_id", "idempotency_key"],
    unique: true,
  },
  {
    collection: "rankings",
    name: "uk_period_user",
    fields: ["period_type", "period_key", "user_id"],
    unique: true,
  },
  {
    collection: "settlements",
    name: "uk_match_version_rule",
    fields: ["match_id", "result_version", "rule_version"],
    unique: true,
  },
  {
    collection: "settlement_items",
    name: "uk_settlement_prediction",
    fields: ["settlement_id", "prediction_id"],
    unique: true,
  },
  {
    collection: "unlocks",
    name: "uk_user_unlock_code",
    fields: ["user_id", "unlock_code"],
    unique: true,
  },
  { collection: "admins", name: "uk_admin_openid", fields: ["openid"], unique: true },
  {
    collection: "anomalies",
    name: "uk_anomaly_key",
    fields: ["anomaly_key"],
    unique: true,
  },
  { collection: "job_locks", name: "uk_lock_key", fields: ["lock_key"], unique: true },
  {
    collection: "deleted_openid_mappings",
    name: "uk_deleted_openid",
    fields: ["original_openid"],
    unique: true,
  },
] as const;

export const QUERY_INDEXES: readonly IndexDef[] = [
  {
    collection: "matches",
    name: "ix_matches_league_season_kickoff",
    fields: ["league_id", "season_id", "kickoff_at"],
    unique: false,
  },
  {
    collection: "matches",
    name: "ix_matches_status_kickoff",
    fields: ["match_status", "kickoff_at"],
    unique: false,
  },
  {
    collection: "matches",
    name: "ix_matches_settlement_status_finish",
    fields: ["settlement_status", "finish_detected_at"],
    unique: false,
  },
  {
    collection: "predictions",
    name: "ix_predictions_user_submitted",
    fields: ["user_id", "submitted_at:desc"],
    unique: false,
  },
  {
    collection: "predictions",
    name: "ix_predictions_match",
    fields: ["match_id"],
    unique: false,
  },
  {
    collection: "predictions",
    name: "ix_predictions_user_match",
    fields: ["user_id", "match_id"],
    unique: false,
  },
  {
    collection: "rankings",
    name: "ix_rankings_period_rank",
    fields: ["period_type", "period_key", "global_rank"],
    unique: false,
  },
  {
    collection: "rankings",
    name: "ix_rankings_period_score",
    fields: ["period_type", "period_key", "period_score:desc"],
    unique: false,
  },
  {
    collection: "settlements",
    name: "ix_settlements_match_version",
    fields: ["match_id", "result_version"],
    unique: false,
  },
  {
    collection: "settlements",
    name: "ix_settlements_status_updated",
    fields: ["status", "updated_at"],
    unique: false,
  },
  {
    collection: "settlement_items",
    name: "ix_items_settlement_status",
    fields: ["settlement_id", "status"],
    unique: false,
  },
  {
    collection: "settlement_items",
    name: "ix_items_user_created",
    fields: ["user_id", "created_at"],
    unique: false,
  },
  {
    collection: "level_history",
    name: "ix_level_history_user_changed",
    fields: ["user_id", "changed_at:desc"],
    unique: false,
  },
  {
    collection: "provider_snapshots",
    name: "ix_snapshots_entity",
    fields: ["entity_type", "entity_id", "created_at:desc"],
    unique: false,
  },
  {
    collection: "sync_logs",
    name: "ix_sync_logs_type_started",
    fields: ["job_type", "started_at:desc"],
    unique: false,
  },
  {
    collection: "admin_audit_logs",
    name: "ix_audit_entity",
    fields: ["entity_type", "entity_id", "created_at:desc"],
    unique: false,
  },
  {
    collection: "anomalies",
    name: "ix_anomalies_status_blocking",
    fields: ["status", "blocking", "last_seen_at:desc"],
    unique: false,
  },
  {
    collection: "anomalies",
    name: "ix_anomalies_match",
    fields: ["match_id", "status"],
    unique: false,
  },
  {
    collection: "deleted_openid_mappings",
    name: "idx_deleted_user_id",
    fields: ["deleted_user_id"],
    unique: false,
  },
] as const;
