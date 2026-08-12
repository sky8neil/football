import { describe, expect, it } from "vitest";
import { AdminRole, AdminStatus, AnomalyStatus, AnomalyType } from "../domain/enums.js";
import type { Admin, AdminAuditLog, Anomaly } from "../domain/types.js";
import { InMemoryRepository, UniqueConstraintError } from "./repositories.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");

function makeAdmin(overrides: Partial<Admin> = {}): Admin {
  return {
    schema_version: 1,
    admin_id: "00000000-0000-4000-8000-000000000001",
    openid: "admin-openid",
    status: AdminStatus.Active,
    role: AdminRole.Admin,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeAudit(overrides: Partial<AdminAuditLog> = {}): AdminAuditLog {
  return {
    schema_version: 1,
    audit_id: "00000000-0000-4000-8000-000000000002",
    admin_id: "00000000-0000-4000-8000-000000000001",
    action: "result_correction",
    entity_type: "match",
    entity_id: "00000000-0000-4000-8000-000000000010",
    old_value: null,
    new_value: null,
    reason: "test",
    created_at: NOW,
    ...overrides,
  };
}

function makeAnomaly(overrides: Partial<Anomaly> = {}): Anomaly {
  const anomalyId = overrides.anomaly_id ?? "00000000-0000-4000-8000-000000000010";
  const lastSeenAt = overrides.last_seen_at ?? NOW;
  return {
    schema_version: 1,
    anomaly_id: anomalyId,
    anomaly_key: overrides.anomaly_key ?? `${anomalyId}:LIVE_SYNC_STALE`,
    match_id: "00000000-0000-4000-8000-000000000011",
    type: AnomalyType.LiveSyncStale,
    blocking: false,
    status: AnomalyStatus.Open,
    first_seen_at: lastSeenAt,
    last_seen_at: lastSeenAt,
    occurrence_count: 1,
    details: {},
    resolved_at: null,
    resolution: null,
    ...overrides,
  };
}

describe("InMemoryRepository - admins and admin_audit_logs", () => {
  it("按 trusted openid 读取管理员并保持 openid 唯一", async () => {
    const repo = new InMemoryRepository();
    await repo.admins.insert(makeAdmin());

    expect(await repo.admins.findByOpenid("admin-openid")).toMatchObject({
      admin_id: "00000000-0000-4000-8000-000000000001",
    });
    await expect(repo.admins.insert(makeAdmin({ admin_id: "another-admin" }))).rejects.toMatchObject({
      collection: "admins",
      indexName: "uk_admin_openid",
    } satisfies Partial<UniqueConstraintError>);
  });

  it("审计日志只追加并可按实体读取", async () => {
    const repo = new InMemoryRepository();
    const first = makeAudit();
    const second = makeAudit({
      audit_id: "00000000-0000-4000-8000-000000000003",
      reason: "second",
    });
    await repo.adminAuditLogs.insert(first);
    await repo.adminAuditLogs.insert(second);

    expect(await repo.adminAuditLogs.findByEntity("match", first.entity_id)).toEqual([
      first,
      second,
    ]);
    expect("update" in repo.adminAuditLogs).toBe(false);
  });

  it("管理员和审计写入参与共享事务回滚", async () => {
    const repo = new InMemoryRepository();
    const admin = makeAdmin();
    const audit = makeAudit();

    await expect(
      repo.withTransaction(async (tx) => {
        await tx.admins?.insert(admin);
        await tx.adminAuditLogs?.insert(audit);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    expect(await repo.admins.findByOpenid(admin.openid)).toBeNull();
    expect(await repo.adminAuditLogs.findByEntity(audit.entity_type, audit.entity_id)).toEqual([]);
  });
});

describe("InMemoryRepository - anomalies", () => {
  it("可以按 anomaly_key 读取既有记录", async () => {
    const repo = new InMemoryRepository();
    const anomaly = makeAnomaly();
    await repo.anomalies.insert(anomaly);

    expect(await repo.anomalies.findByKey(anomaly.anomaly_key)).toBe(anomaly);
    expect(await repo.anomalies.findByKey("missing-key")).toBeNull();
  });

  it("只返回指定比赛的 open blocking anomaly", async () => {
    const repo = new InMemoryRepository();
    const matchId = "00000000-0000-4000-8000-000000000011";
    const blocking = makeAnomaly({
      anomaly_id: "00000000-0000-4000-8000-000000000021",
      match_id: matchId,
      blocking: true,
    });
    const resolved = makeAnomaly({
      anomaly_id: "00000000-0000-4000-8000-000000000022",
      match_id: matchId,
      blocking: true,
      status: AnomalyStatus.Resolved,
    });
    const other = makeAnomaly({
      anomaly_id: "00000000-0000-4000-8000-000000000023",
      match_id: "00000000-0000-4000-8000-000000000012",
      blocking: true,
    });
    await repo.anomalies.insert(blocking);
    await repo.anomalies.insert(resolved);
    await repo.anomalies.insert(other);

    expect(await repo.anomalies.findOpenBlockingByMatch(matchId)).toEqual([blocking]);
    expect(await repo.anomalies.findOpenBlockingByMatch("missing-match")).toEqual([]);
  });

  it("按冻结排序和 keyset 条件返回异常页，并保持 anomaly_key 唯一", async () => {
    const repo = new InMemoryRepository();
    const first = makeAnomaly({
      anomaly_id: "00000000-0000-4000-8000-000000000001",
      last_seen_at: new Date("2026-08-09T00:00:00.000Z"),
    });
    const second = makeAnomaly({
      anomaly_id: "00000000-0000-4000-8000-000000000002",
      last_seen_at: new Date("2026-08-08T23:00:00.000Z"),
    });
    await repo.anomalies.insert(first);
    await repo.anomalies.insert(second);

    const page = await repo.anomalies.findPage({
      status: AnomalyStatus.Open,
      blocking: false,
      after: null,
      limit: 1,
    });
    expect(page).toEqual({ items: [first], has_more: true });
    expect(
      await repo.anomalies.findPage({
        status: AnomalyStatus.Open,
        blocking: false,
        after: { last_seen_at: first.last_seen_at, anomaly_id: first.anomaly_id },
        limit: 1,
      }),
    ).toEqual({ items: [second], has_more: false });

    await expect(repo.anomalies.insert(makeAnomaly({
      anomaly_id: "00000000-0000-4000-8000-000000000003",
      anomaly_key: first.anomaly_key,
    }))).rejects.toMatchObject({ indexName: "uk_anomaly_key" });
  });

  it("异常写入参与事务回滚", async () => {
    const repo = new InMemoryRepository();
    const anomaly = makeAnomaly();
    await expect(
      repo.withTransaction(async (tx) => {
        await tx.anomalies?.insert(anomaly);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(
      await repo.anomalies.findPage({
        status: null,
        blocking: null,
        after: null,
        limit: 20,
      }),
    ).toEqual({ items: [], has_more: false });
  });
});
