import {
  AdminAuditAction,
  ADMIN_AUDIT_ENTITY_TYPE_BY_ACTION,
  AnomalyStatus,
  SCHEMA_VERSION,
} from "../domain/enums.js";
import { conflictError, internalError, notFoundError, validationError } from "../domain/errors.js";
import { isValidUuid, newUuid } from "../domain/ids.js";
import type { AdminAuditLog, Anomaly } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { AdminAuthorizationService, type AdminWriteAuthorizer } from "./admin.js";
import { assertValidServerNow } from "./period-finalize.js";

export const ADMIN_RESOLVE_ANOMALY_AUDIT_ACTION = AdminAuditAction.ResolveAnomaly;

export interface AdminResolveAnomalyInput {
  reason: string;
}

export interface AdminResolveAnomalyOutcome {
  admin_id: string;
  anomaly: Anomaly;
  audit_log: AdminAuditLog;
}

export interface AdminResolveAnomalyCommand extends AdminWriteAuthorizer {
  resolve(
    trustedOpenid: string | null | undefined,
    anomalyId: string,
    input: AdminResolveAnomalyInput,
    serverNow: Date,
  ): Promise<AdminResolveAnomalyOutcome>;
}

function normalizeResolveReason(input: AdminResolveAnomalyInput): string {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.reason !== "string" ||
    input.reason.trim().length < 1 ||
    input.reason.length > 500
  ) {
    throw validationError("reason 长度必须为 1..500", { field: "reason" });
  }
  return input.reason.trim();
}

function anomalyAuditSnapshot(anomaly: Anomaly): Record<string, unknown> {
  return {
    anomaly_id: anomaly.anomaly_id,
    anomaly_key: anomaly.anomaly_key,
    match_id: anomaly.match_id,
    type: anomaly.type,
    blocking: anomaly.blocking,
    status: anomaly.status,
    resolved_at: anomaly.resolved_at?.toISOString() ?? null,
    resolution: anomaly.resolution,
  };
}

export class AdminResolveAnomalyService implements AdminResolveAnomalyCommand {
  private readonly authorization = new AdminAuthorizationService();

  constructor(private readonly repo: AppRepository) {}

  authorizeAdmin(trustedOpenid: string): Promise<void> {
    return this.authorization.authorizeAdmin(this.repo, trustedOpenid);
  }

  async resolve(
    trustedOpenid: string | null | undefined,
    anomalyId: string,
    input: AdminResolveAnomalyInput,
    serverNow: Date,
  ): Promise<AdminResolveAnomalyOutcome> {
    if (typeof anomalyId !== "string" || !isValidUuid(anomalyId)) {
      throw validationError("anomaly_id 必须为 UUID v4", { field: "anomaly_id" });
    }
    const reason = normalizeResolveReason(input);
    assertValidServerNow(serverNow);

    return this.repo.withTransaction(async (tx) => {
      const admin = await this.authorization.requireActiveAdmin(tx, trustedOpenid);
      if (tx.anomalies === undefined) {
        throw internalError("anomalies repository port 未配置");
      }
      if (tx.adminAuditLogs === undefined) {
        throw internalError("admin_audit_logs repository port 未配置");
      }
      const existing = tx.anomalies.findByIdForUpdate !== undefined
        ? await tx.anomalies.findByIdForUpdate(anomalyId)
        : tx.anomalies.findById !== undefined
          ? await tx.anomalies.findById(anomalyId)
          : null;
      if (existing === null) {
        throw notFoundError("ANOMALY");
      }
      if (existing.status === AnomalyStatus.Resolved) {
        throw conflictError("ANOMALY_ALREADY_RESOLVED", "异常已解决，无需重复解除", {
          anomaly_id: anomalyId,
          resolved_at: existing.resolved_at?.toISOString() ?? null,
          resolution: existing.resolution,
        });
      }

      const resolution = `admin_manual_resolve:${reason}`;
      const resolved: Anomaly = {
        ...existing,
        status: AnomalyStatus.Resolved,
        resolved_at: serverNow,
        resolution,
      };
      await tx.anomalies.update(resolved);

      const auditLog: AdminAuditLog = {
        schema_version: SCHEMA_VERSION,
        audit_id: newUuid(),
        admin_id: admin.admin_id,
        action: ADMIN_RESOLVE_ANOMALY_AUDIT_ACTION,
        entity_type: ADMIN_AUDIT_ENTITY_TYPE_BY_ACTION[ADMIN_RESOLVE_ANOMALY_AUDIT_ACTION],
        entity_id: anomalyId,
        old_value: anomalyAuditSnapshot(existing),
        new_value: anomalyAuditSnapshot(resolved),
        reason,
        created_at: serverNow,
      };
      await tx.adminAuditLogs.insert(auditLog);

      return {
        admin_id: admin.admin_id,
        anomaly: resolved,
        audit_log: auditLog,
      };
    });
  }
}
