import {
  AdminAuditAction,
  AdminAuditEntityType,
  AdminRole,
  AdminStatus,
  SCHEMA_VERSION,
} from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { Admin, AdminAuditLog } from "../domain/types.js";
import type {
  AdminAuditLogRepository,
  AdminRepository,
} from "../infrastructure/repositories.js";

export const ADMIN_GRANT_AUDIT_ACTION = AdminAuditAction.GrantAdmin;
const DEFAULT_GRANT_REASON = "vps-admin provision";

export interface AdminGrantInput {
  openid: string;
  now: Date;
  status?: AdminStatus;
  reason?: string;
}

export type AdminGrantAction = "create" | "unchanged" | "update";

export interface AdminGrantPlan {
  action: AdminGrantAction;
  openid: string;
  admin_id: string | null;
  status: AdminStatus;
  role: typeof AdminRole.Admin;
  existing: boolean;
}

export interface AdminGrantStore {
  admins?: AdminRepository;
  adminAuditLogs?: AdminAuditLogRepository;
  withTransaction?<T>(fn: (tx: AdminGrantStore) => Promise<T>): Promise<T>;
}

function requiredAdmins(store: AdminGrantStore): AdminRepository {
  if (store.admins === undefined) throw new Error("admins repository is required");
  return store.admins;
}

function requiredOpenid(value: string): string {
  const openid = value.trim();
  if (openid.length === 0) throw new Error("admin openid is required");
  return openid;
}

function grantStatus(input: AdminGrantInput): AdminStatus {
  return input.status ?? AdminStatus.Active;
}

function grantReason(input: AdminGrantInput): string {
  const reason = (input.reason ?? DEFAULT_GRANT_REASON).trim();
  if (reason.length < 1 || reason.length > 500) {
    throw new Error("admin grant reason must be 1..500 characters");
  }
  return reason;
}

function requiredAuditLogs(store: AdminGrantStore): AdminAuditLogRepository {
  if (store.adminAuditLogs === undefined) throw new Error("admin_audit_logs repository is required");
  return store.adminAuditLogs;
}

function auditFromGrant(
  document: Admin,
  existing: Admin | null,
  now: Date,
  reason: string,
): AdminAuditLog {
  return {
    schema_version: SCHEMA_VERSION,
    audit_id: newUuid(),
    admin_id: document.admin_id,
    action: ADMIN_GRANT_AUDIT_ACTION,
    entity_type: AdminAuditEntityType.Admin,
    entity_id: document.admin_id,
    old_value: existing === null
      ? null
      : {
          openid: existing.openid,
          status: existing.status,
          role: existing.role,
        },
    new_value: {
      openid: document.openid,
      status: document.status,
      role: document.role,
    },
    reason,
    created_at: now,
  };
}

export function planFromExisting(existing: Admin | null, input: AdminGrantInput): AdminGrantPlan {
  const openid = requiredOpenid(input.openid);
  const status = grantStatus(input);
  if (existing === null) {
    return {
      action: "create",
      openid,
      admin_id: null,
      status,
      role: AdminRole.Admin,
      existing: false,
    };
  }
  const unchanged = existing.status === status && existing.role === AdminRole.Admin && existing.openid === openid;
  return {
    action: unchanged ? "unchanged" : "update",
    openid,
    admin_id: existing.admin_id,
    status,
    role: AdminRole.Admin,
    existing: true,
  };
}

export function adminDocumentFromPlan(plan: AdminGrantPlan, now: Date, existing: Admin | null): Admin {
  const adminId = plan.admin_id ?? newUuid();
  return {
    schema_version: SCHEMA_VERSION,
    admin_id: adminId,
    openid: plan.openid,
    status: plan.status,
    role: plan.role,
    created_at: existing?.created_at ?? now,
    updated_at: plan.action === "unchanged" && existing !== null ? existing.updated_at : now,
  };
}

export async function planAdminGrant(store: AdminGrantStore, input: AdminGrantInput): Promise<AdminGrantPlan> {
  const openid = requiredOpenid(input.openid);
  const existing = await requiredAdmins(store).findByOpenid(openid);
  return planFromExisting(existing, { ...input, openid });
}

export async function applyAdminGrant(store: AdminGrantStore, input: AdminGrantInput): Promise<AdminGrantPlan> {
  const openid = requiredOpenid(input.openid);
  const reason = grantReason(input);
  if (store.withTransaction === undefined) throw new Error("transaction support is required");
  return store.withTransaction(async (tx) => {
    const admins = requiredAdmins(tx);
    const existing = await admins.findByOpenid(openid);
    const plan = planFromExisting(existing, { ...input, openid });
    if (plan.action === "unchanged") return plan;
    const auditLogs = requiredAuditLogs(tx);
    const document = adminDocumentFromPlan(plan, input.now, existing);
    if (plan.action === "create") await admins.insert(document);
    else await admins.update(document);
    await auditLogs.insert(auditFromGrant(document, existing, input.now, reason));
    return { ...plan, admin_id: document.admin_id };
  });
}
