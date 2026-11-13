import { AdminRole, AdminStatus, SCHEMA_VERSION } from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { Admin } from "../domain/types.js";
import type { AdminRepository } from "../infrastructure/repositories.js";

export interface AdminGrantInput {
  openid: string;
  now: Date;
  status?: AdminStatus;
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
  const admins = requiredAdmins(store);
  const openid = requiredOpenid(input.openid);
  const existing = await admins.findByOpenid(openid);
  const plan = planFromExisting(existing, { ...input, openid });
  if (plan.action === "unchanged") return plan;
  const document = adminDocumentFromPlan(plan, input.now, existing);
  if (plan.action === "create") await admins.insert(document);
  else await admins.update(document);
  return { ...plan, admin_id: document.admin_id };
}
