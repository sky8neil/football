import { describe, expect, it } from "vitest";
import {
  AdminAuditAction,
  AdminAuditEntityType,
  ADMIN_AUDIT_ENTITY_TYPE_BY_ACTION,
} from "../domain/enums.js";
import { COLLECTION_DEFINITIONS } from "./collections.js";

describe("admin_audit_logs contract", () => {
  it("exposes the frozen action/entity enums and mapping", () => {
    expect(AdminAuditAction).toEqual({
      ResultCorrection: "result_correction",
      RetrySettlement: "retry_settlement",
      RebuildUserStats: "rebuild_user_stats",
      RebuildRankings: "rebuild_rankings",
      GrantAdmin: "grant_admin",
      ResolveAnomaly: "resolve_anomaly",
      UpdateTeam: "update_team",
      UpsertTeamMapping: "upsert_team_mapping",
    });
    expect(AdminAuditEntityType).toEqual({
      Match: "match",
      Settlement: "settlement",
      User: "user",
      RankingPeriod: "ranking_period",
      Admin: "admin",
      Anomaly: "anomaly",
      Team: "team",
      TeamProviderMapping: "team_provider_mapping",
    });
    expect(ADMIN_AUDIT_ENTITY_TYPE_BY_ACTION).toEqual({
      result_correction: "match",
      retry_settlement: "settlement",
      rebuild_user_stats: "user",
      rebuild_rankings: "ranking_period",
      grant_admin: "admin",
      resolve_anomaly: "anomaly",
      update_team: "team",
      upsert_team_mapping: "team_provider_mapping",
    });
  });

  it("publishes the same enums in the admin_audit_logs schema", () => {
    const definition = COLLECTION_DEFINITIONS.find(
      (item) => item.collection === "admin_audit_logs",
    );
    expect(definition).toBeDefined();
    const fields = definition!.fields;

    expect(fields.action?.enum).toEqual([
      "result_correction",
      "retry_settlement",
      "rebuild_user_stats",
      "rebuild_rankings",
      "grant_admin",
      "resolve_anomaly",
      "update_team",
      "upsert_team_mapping",
    ]);
    expect(fields.entity_type?.enum).toEqual([
      "match",
      "settlement",
      "user",
      "ranking_period",
      "admin",
      "anomaly",
      "team",
      "team_provider_mapping",
    ]);
  });
});
