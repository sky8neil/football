import { describe, expect, it } from "vitest";
import {
  AdminAuditAction,
  AdminAuditEntityType,
  AdminRole,
  AdminStatus,
} from "../domain/enums.js";
import type { Admin, AdminAuditLog } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { AdminAuditLogsService } from "./admin-audit-logs.js";

const SECRET = "audit-log-cursor-secret";
const ADMIN_OPENID = "admin-audit-openid";
const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-09T12:00:00.000Z");

function makeAdmin(overrides: Partial<Admin> = {}): Admin {
  return {
    schema_version: 1,
    admin_id: ADMIN_ID,
    openid: ADMIN_OPENID,
    status: AdminStatus.Active,
    role: AdminRole.Admin,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeLog(overrides: Partial<AdminAuditLog> = {}): AdminAuditLog {
  return {
    schema_version: 1,
    audit_id: "00000000-0000-4000-8000-000000000010",
    admin_id: ADMIN_ID,
    action: AdminAuditAction.ResultCorrection,
    entity_type: AdminAuditEntityType.Match,
    entity_id: "00000000-0000-4000-8000-000000000100",
    old_value: { regular_home_score: 0 },
    new_value: { regular_home_score: 1 },
    reason: "测试审计",
    created_at: NOW,
    ...overrides,
  };
}

describe("AdminAuditLogsService", () => {
  it("按 created_at DESC, audit_id DESC 分页并支持 action/target_type/target_id 过滤", async () => {
    const repo = new InMemoryRepository();
    await repo.admins.insert(makeAdmin());
    const log1 = makeLog({
      audit_id: "00000000-0000-4000-8000-000000000011",
      created_at: new Date("2026-08-09T10:00:00.000Z"),
    });
    const log2 = makeLog({
      audit_id: "00000000-0000-4000-8000-000000000012",
      created_at: new Date("2026-08-09T10:00:00.000Z"),
    });
    const log3 = makeLog({
      audit_id: "00000000-0000-4000-8000-000000000013",
      action: AdminAuditAction.RebuildRankings,
      entity_type: AdminAuditEntityType.RankingPeriod,
      entity_id: "week-2026-W32",
      created_at: new Date("2026-08-09T11:00:00.000Z"),
    });
    await repo.adminAuditLogs.insert(log1);
    await repo.adminAuditLogs.insert(log2);
    await repo.adminAuditLogs.insert(log3);

    const service = new AdminAuditLogsService(repo, SECRET);
    const page1 = await service.list(ADMIN_OPENID, {
      action: null,
      target_type: null,
      target_id: null,
      limit: 2,
      cursor: null,
    });
    expect(page1.items.map((x) => x.audit_id)).toEqual([log3.audit_id, log2.audit_id]);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).toBeTruthy();

    const page2 = await service.list(ADMIN_OPENID, {
      action: null,
      target_type: null,
      target_id: null,
      limit: 2,
      cursor: page1.next_cursor,
    });
    expect(page2.items.map((x) => x.audit_id)).toEqual([log1.audit_id]);
    expect(page2.has_more).toBe(false);
    expect(page2.next_cursor).toBeNull();

    const filtered = await service.list(ADMIN_OPENID, {
      action: AdminAuditAction.RebuildRankings,
      target_type: AdminAuditEntityType.RankingPeriod,
      target_id: "week-2026-W32",
      limit: 20,
      cursor: null,
    });
    expect(filtered.items.map((x) => x.audit_id)).toEqual([log3.audit_id]);

    await expect(
      service.list(ADMIN_OPENID, {
        action: AdminAuditAction.ResolveAnomaly,
        target_type: null,
        target_id: null,
        limit: 2,
        cursor: page1.next_cursor,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("拒绝未授权或已禁用管理员及被篡改的 cursor", async () => {
    const repo = new InMemoryRepository();
    await repo.admins.insert(makeAdmin({ status: AdminStatus.Disabled }));
    const service = new AdminAuditLogsService(repo, SECRET);

    await expect(
      service.list(null, {
        action: null,
        target_type: null,
        target_id: null,
        limit: 20,
        cursor: null,
      }),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });

    await expect(
      service.list(ADMIN_OPENID, {
        action: null,
        target_type: null,
        target_id: null,
        limit: 20,
        cursor: null,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const activeRepo = new InMemoryRepository();
    await activeRepo.admins.insert(makeAdmin());
    await expect(
      new AdminAuditLogsService(activeRepo, SECRET).list(ADMIN_OPENID, {
        action: null,
        target_type: null,
        target_id: null,
        limit: 20,
        cursor: "bad.sig",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
