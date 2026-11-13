import { describe, expect, it } from "vitest";
import { AdminRole, AdminStatus } from "../domain/enums.js";
import type { Admin } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { applyAdminGrant, planAdminGrant } from "./admin-grant.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const LATER = new Date("2026-08-10T12:00:00.000Z");
const OPENID = "wx-admin-openid";

function makeAdmin(overrides: Partial<Admin> = {}): Admin {
  return {
    schema_version: 1,
    admin_id: "00000000-0000-4000-8000-0000000000aa",
    openid: OPENID,
    status: AdminStatus.Active,
    role: AdminRole.Admin,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe("admin grant provision", () => {
  it("plans a create for a missing openid and apply writes one active admin", async () => {
    const repo = new InMemoryRepository();
    const planned = await planAdminGrant(repo, { openid: OPENID, now: NOW });
    expect(planned).toMatchObject({
      action: "create",
      openid: OPENID,
      admin_id: null,
      existing: false,
      status: AdminStatus.Active,
      role: AdminRole.Admin,
    });

    const applied = await applyAdminGrant(repo, { openid: OPENID, now: NOW });
    expect(applied.action).toBe("create");
    await expect(repo.admins.findByOpenid(OPENID)).resolves.toMatchObject({
      admin_id: applied.admin_id,
      openid: OPENID,
      status: AdminStatus.Active,
      role: AdminRole.Admin,
      created_at: NOW,
      updated_at: NOW,
    });
  });

  it("is idempotent: a second apply does not rewrite an identical admin", async () => {
    const repo = new InMemoryRepository();
    const first = await applyAdminGrant(repo, { openid: OPENID, now: NOW });
    const second = await applyAdminGrant(repo, { openid: ` ${OPENID} `, now: LATER });
    expect(second).toEqual({
      action: "unchanged",
      openid: OPENID,
      admin_id: first.admin_id,
      status: AdminStatus.Active,
      role: AdminRole.Admin,
      existing: true,
    });
    await expect(repo.admins.findByOpenid(OPENID)).resolves.toMatchObject({
      admin_id: first.admin_id,
      updated_at: NOW,
    });
  });

  it("reactivates a disabled admin without changing admin_id", async () => {
    const repo = new InMemoryRepository();
    const existing = makeAdmin({ status: AdminStatus.Disabled });
    await repo.admins.insert(existing);
    const plan = await applyAdminGrant(repo, { openid: OPENID, now: LATER });
    expect(plan).toEqual({
      action: "update",
      openid: OPENID,
      admin_id: existing.admin_id,
      status: AdminStatus.Active,
      role: AdminRole.Admin,
      existing: true,
    });
    await expect(repo.admins.findByOpenid(OPENID)).resolves.toMatchObject({
      admin_id: existing.admin_id,
      status: AdminStatus.Active,
      created_at: NOW,
      updated_at: LATER,
    });
  });

  it("rejects an empty openid and does not insert", async () => {
    const repo = new InMemoryRepository();
    await expect(planAdminGrant(repo, { openid: "  ", now: NOW })).rejects.toThrow("admin openid is required");
    await expect(applyAdminGrant(repo, { openid: "", now: NOW })).rejects.toThrow("admin openid is required");
    await expect(repo.admins.findByOpenid("")).resolves.toBeNull();
  });

  it("fails closed when admins repository is missing", async () => {
    await expect(planAdminGrant({}, { openid: OPENID, now: NOW })).rejects.toThrow("admins repository is required");
  });
});
