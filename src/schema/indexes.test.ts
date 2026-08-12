import { describe, expect, it } from "vitest";
import { QUERY_INDEXES, UNIQUE_INDEXES, type IndexDef } from "./indexes.js";

function keyOf(index: IndexDef): string {
  return `${index.collection}|${index.name}|${index.fields.join(",")}|${index.unique ? "u" : "q"}`;
}

describe("第 22 节数据库索引定义", () => {
  it("唯一索引完整覆盖规范 22.1 冻结集合", () => {
    const expected: Array<Omit<IndexDef, never>> = [
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
    ];

    const actualKeys = new Set(UNIQUE_INDEXES.map(keyOf));
    for (const item of expected) {
      expect(actualKeys.has(keyOf(item))).toBe(true);
    }
    expect(UNIQUE_INDEXES.every((item) => item.unique)).toBe(true);
  });

  it("普通查询索引至少覆盖规范 22.2 冻结集合", () => {
    const expected: IndexDef[] = [
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
    ];

    const actualKeys = new Set(QUERY_INDEXES.map(keyOf));
    for (const item of expected) {
      expect(actualKeys.has(keyOf(item))).toBe(true);
    }
    expect(QUERY_INDEXES.every((item) => item.unique === false)).toBe(true);
  });
});
