import { describe, expect, it } from "vitest";
import {
  AdminAuditAction,
  AdminAuditEntityType,
  AdminRole,
  AdminStatus,
  AnomalyStatus,
  AnomalyType,
} from "../domain/enums.js";
import type { Admin, Anomaly } from "../domain/types.js";
import { InMemoryRepository, type AppRepository, type UnitOfWork } from "../infrastructure/repositories.js";
import { AdminResolveAnomalyService } from "./admin-resolve-anomaly.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const ADMIN_OPENID = "admin-resolve-openid";
const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const ANOMALY_ID = "00000000-0000-4000-8000-000000000101";
const MATCH_ID = "00000000-0000-4000-8000-000000000201";

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

function makeAnomaly(overrides: Partial<Anomaly> = {}): Anomaly {
  const type = overrides.type ?? AnomalyType.UnexpectedProviderStatus;
  const matchId = overrides.match_id ?? MATCH_ID;
  return {
    schema_version: 1,
    anomaly_id: ANOMALY_ID,
    anomaly_key: `${matchId}:${type}`,
    match_id: matchId,
    type,
    blocking: true,
    status: AnomalyStatus.Open,
    first_seen_at: new Date("2026-08-09T10:00:00.000Z"),
    last_seen_at: new Date("2026-08-09T11:00:00.000Z"),
    occurrence_count: 2,
    details: { raw_status: "INT" },
    resolved_at: null,
    resolution: null,
    ...overrides,
  };
}

describe("AdminResolveAnomalyService", () => {
  it("事务内手动解除 open 异常并写入 admin_audit_logs", async () => {
    const repo = new InMemoryRepository();
    await repo.admins.insert(makeAdmin());
    await repo.anomalies.insert(makeAnomaly());

    const outcome = await new AdminResolveAnomalyService(repo).resolve(
      ADMIN_OPENID,
      ANOMALY_ID,
      { reason: "  已人工确认赛果并解除阻塞  " },
      NOW,
    );

    expect(outcome.anomaly).toMatchObject({
      anomaly_id: ANOMALY_ID,
      status: AnomalyStatus.Resolved,
      resolved_at: NOW,
      resolution: "admin_manual_resolve:已人工确认赛果并解除阻塞",
    });
    expect(outcome.audit_log).toMatchObject({
      admin_id: ADMIN_ID,
      action: AdminAuditAction.ResolveAnomaly,
      entity_type: AdminAuditEntityType.Anomaly,
      entity_id: ANOMALY_ID,
      reason: "已人工确认赛果并解除阻塞",
      old_value: expect.objectContaining({ status: "open", resolution: null }),
      new_value: expect.objectContaining({
        status: "resolved",
        resolution: "admin_manual_resolve:已人工确认赛果并解除阻塞",
      }),
    });

    const persisted = await repo.anomalies.findById!(ANOMALY_ID);
    expect(persisted?.status).toBe(AnomalyStatus.Resolved);
    expect(await repo.adminAuditLogs.findByEntity("anomaly", ANOMALY_ID)).toEqual([
      outcome.audit_log,
    ]);
  });

  it("审计写入失败时事务回滚，异常保持 open", async () => {
    const repo = new InMemoryRepository();
    await repo.admins.insert(makeAdmin());
    await repo.anomalies.insert(makeAnomaly());

    const failingRepo = Object.create(repo) as AppRepository;
    Object.defineProperty(failingRepo, "withTransaction", {
      value: <T>(fn: (tx: UnitOfWork) => Promise<T>) =>
        repo.withTransaction((tx) => {
          const brokenTx = Object.create(tx) as UnitOfWork;
          Object.defineProperty(brokenTx, "adminAuditLogs", {
            value: {
              ...tx.adminAuditLogs,
              insert: async () => {
                throw new Error("audit insert failed");
              },
            },
          });
          return fn(brokenTx);
        }),
    });

    await expect(
      new AdminResolveAnomalyService(failingRepo).resolve(
        ADMIN_OPENID,
        ANOMALY_ID,
        { reason: "测试原子回滚" },
        NOW,
      ),
    ).rejects.toThrow("audit insert failed");

    const stillOpen = await repo.anomalies.findById!(ANOMALY_ID);
    expect(stillOpen).toMatchObject({
      status: AnomalyStatus.Open,
      resolved_at: null,
      resolution: null,
    });
    expect(await repo.adminAuditLogs.findByEntity("anomaly", ANOMALY_ID)).toEqual([]);
  });

  it("不存在返回 404 ANOMALY_NOT_FOUND，已解决返回 409 ANOMALY_ALREADY_RESOLVED", async () => {
    const repo = new InMemoryRepository();
    await repo.admins.insert(makeAdmin());
    await repo.anomalies.insert(
      makeAnomaly({
        status: AnomalyStatus.Resolved,
        resolved_at: NOW,
        resolution: "already_done",
      }),
    );
    const service = new AdminResolveAnomalyService(repo);

    await expect(
      service.resolve(
        ADMIN_OPENID,
        "00000000-0000-4000-8000-000000000999",
        { reason: "missing" },
        NOW,
      ),
    ).rejects.toMatchObject({ code: "ANOMALY_NOT_FOUND" });

    await expect(
      service.resolve(ADMIN_OPENID, ANOMALY_ID, { reason: "duplicate" }, NOW),
    ).rejects.toMatchObject({ code: "ANOMALY_ALREADY_RESOLVED" });
  });

  it("拒绝非法 UUID、纯空白 reason 与非活跃管理员", async () => {
    const repo = new InMemoryRepository();
    await repo.admins.insert(makeAdmin({ status: AdminStatus.Disabled }));
    await repo.anomalies.insert(makeAnomaly());
    const service = new AdminResolveAnomalyService(repo);

    await expect(
      service.resolve(ADMIN_OPENID, "bad-id", { reason: "ok" }, NOW),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await expect(
      service.resolve(ADMIN_OPENID, ANOMALY_ID, { reason: "   \n\t  " }, NOW),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await expect(
      service.resolve(null, ANOMALY_ID, { reason: "ok" }, NOW),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });

    await expect(
      service.resolve(ADMIN_OPENID, ANOMALY_ID, { reason: "ok" }, NOW),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
