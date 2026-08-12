import { describe, expect, it } from "vitest";
import { AdminRole, AdminStatus, AnomalyStatus, AnomalyType } from "../../domain/enums.js";
import type { Admin, Anomaly } from "../../domain/types.js";
import { DomainError } from "../../domain/errors.js";
import { newUuid } from "../../domain/ids.js";
import { InMemoryRepository } from "../../infrastructure/repositories.js";
import { AdminAnomaliesService } from "../../application/admin-anomalies.js";
import {
  getAdminAnomalies,
  validateAdminAnomaliesQuery,
} from "./admin-anomalies.js";
import { InMemoryRateLimiter } from "./rate-limit.js";

const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const MATCH_ID = "00000000-0000-4000-8000-000000000010";
const NOW = new Date("2026-08-09T00:00:00.000Z");
const CURSOR_SECRET = "test-anomaly-cursor-secret";

function makeAdmin(): Admin {
  return {
    schema_version: 1,
    admin_id: ADMIN_ID,
    openid: "trusted-admin-openid",
    status: AdminStatus.Active,
    role: AdminRole.Admin,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeAnomaly(overrides: Partial<Anomaly> = {}): Anomaly {
  const anomalyId = overrides.anomaly_id ?? newUuid();
  const lastSeenAt = overrides.last_seen_at ?? NOW;
  return {
    schema_version: 1,
    anomaly_id: anomalyId,
    anomaly_key: overrides.anomaly_key ?? `${MATCH_ID}:LIVE_SYNC_STALE:${anomalyId}`,
    match_id: MATCH_ID,
    type: AnomalyType.LiveSyncStale,
    blocking: false,
    status: AnomalyStatus.Open,
    first_seen_at: overrides.first_seen_at ?? lastSeenAt,
    last_seen_at: lastSeenAt,
    occurrence_count: 1,
    details: { source: "test" },
    resolved_at: null,
    resolution: null,
    ...overrides,
  };
}

describe("GET /v1/admin/anomalies query", () => {
  it("解析可选筛选和 limit，未传筛选绑定为 null", () => {
    expect(
      validateAdminAnomaliesQuery({ status: "open", blocking: "true", limit: "2" }),
    ).toEqual({ status: AnomalyStatus.Open, blocking: true, limit: 2, cursor: null });
    expect(validateAdminAnomaliesQuery({})).toEqual({
      status: null,
      blocking: null,
      limit: 20,
      cursor: null,
    });
  });

  it("拒绝未定义参数和非法筛选值", () => {
    for (const query of [
      { status: "pending" },
      { blocking: "1" },
      { limit: "0" },
      { limit: "101" },
      { cursor: "not-a-cursor" },
      { extra: "x" },
    ]) {
      expect(() => validateAdminAnomaliesQuery(query)).toThrowError(
        expect.objectContaining({ code: "VALIDATION_ERROR" }),
      );
    }
  });
});

describe("AdminAnomaliesService", () => {
  it("按 last_seen_at DESC、anomaly_id DESC 分页，并绑定筛选条件到 cursor", async () => {
    const repo = new InMemoryRepository();
    await repo.admins.insert(makeAdmin());
    await repo.anomalies.insert(makeAnomaly({
      anomaly_id: "00000000-0000-4000-8000-000000000003",
      last_seen_at: new Date("2026-08-09T00:00:00.000Z"),
    }));
    await repo.anomalies.insert(makeAnomaly({
      anomaly_id: "00000000-0000-4000-8000-000000000002",
      last_seen_at: new Date("2026-08-08T23:59:00.000Z"),
    }));
    await repo.anomalies.insert(makeAnomaly({
      anomaly_id: "00000000-0000-4000-8000-000000000001",
      last_seen_at: new Date("2026-08-08T23:58:00.000Z"),
    }));

    const service = new AdminAnomaliesService(repo, CURSOR_SECRET);
    const first = await service.list("trusted-admin-openid", {
      status: AnomalyStatus.Open,
      blocking: false,
      limit: 2,
      cursor: null,
    });

    expect(first.items.map((item) => item.anomaly_id)).toEqual([
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000002",
    ]);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toEqual(expect.any(String));

    const second = await service.list("trusted-admin-openid", {
      status: AnomalyStatus.Open,
      blocking: false,
      limit: 2,
      cursor: first.next_cursor,
    });
    expect(second.items.map((item) => item.anomaly_id)).toEqual([
      "00000000-0000-4000-8000-000000000001",
    ]);
    expect(second.has_more).toBe(false);

    await expect(
      service.list("trusted-admin-openid", {
        status: AnomalyStatus.Resolved,
        blocking: false,
        limit: 2,
        cursor: first.next_cursor,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("拒绝无效 cursor 和非管理员身份", async () => {
    const repo = new InMemoryRepository();
    await repo.admins.insert(makeAdmin());
    const service = new AdminAnomaliesService(repo, CURSOR_SECRET);

    await expect(
      service.list("trusted-admin-openid", {
        status: null,
        blocking: null,
        limit: 20,
        cursor: "tampered",
      }),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(
      service.list("unknown-openid", {
        status: null,
        blocking: null,
        limit: 20,
        cursor: null,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("admin anomalies API", () => {
  it("返回 snake_case UTC 时间和分页成功 envelope", async () => {
    const repo = new InMemoryRepository();
    await repo.admins.insert(makeAdmin());
    await repo.anomalies.insert(makeAnomaly({
      anomaly_id: "00000000-0000-4000-8000-000000000004",
      first_seen_at: new Date("2026-08-08T23:00:00.000Z"),
      last_seen_at: new Date("2026-08-09T00:00:00.000Z"),
      resolved_at: null,
    }));

    const response = await getAdminAnomalies(new AdminAnomaliesService(repo, CURSOR_SECRET), {
      trusted_openid: "trusted-admin-openid",
      query: { status: "open", blocking: "false", limit: "20" },
      server_now: NOW,
      request_id: "request-anomalies-1",
    });

    expect(response.status).toBe(200);
    expect(response.body.request_id).toBe("request-anomalies-1");
    expect(response.body.data.items[0]).toEqual(expect.objectContaining({
      anomaly_id: "00000000-0000-4000-8000-000000000004",
      status: "open",
      blocking: false,
      first_seen_at: "2026-08-08T23:00:00.000Z",
      last_seen_at: "2026-08-09T00:00:00.000Z",
      resolved_at: null,
    }));
    expect(response.body.data.page).toEqual({ next_cursor: null, has_more: false });
  });

  it("cursor 翻页省略筛选参数时继承 cursor 绑定的筛选", async () => {
    const repo = new InMemoryRepository();
    await repo.admins.insert(makeAdmin());
    await repo.anomalies.insert(makeAnomaly({
      anomaly_id: "00000000-0000-4000-8000-000000000005",
      last_seen_at: new Date("2026-08-09T00:01:00.000Z"),
    }));
    await repo.anomalies.insert(makeAnomaly({
      anomaly_id: "00000000-0000-4000-8000-000000000006",
      last_seen_at: new Date("2026-08-09T00:00:00.000Z"),
    }));

    const service = new AdminAnomaliesService(repo, CURSOR_SECRET);
    const first = await getAdminAnomalies(service, {
      trusted_openid: "trusted-admin-openid",
      query: { status: "open", blocking: "false", limit: "1" },
      server_now: NOW,
      request_id: "request-anomalies-cursor-1",
    });
    const cursor = first.body.data.page.next_cursor;
    expect(cursor).toEqual(expect.any(String));

    const second = await getAdminAnomalies(service, {
      trusted_openid: "trusted-admin-openid",
      query: { cursor, limit: "1" },
      server_now: NOW,
      request_id: "request-anomalies-cursor-2",
    });

    expect(second.body.data.items.map((item) => item.anomaly_id)).toEqual([
      "00000000-0000-4000-8000-000000000006",
    ]);
  });

  it("按管理员每分钟限制为 60 次读取", async () => {
    const repo = new InMemoryRepository();
    await repo.admins.insert(makeAdmin());
    const service = new AdminAnomaliesService(repo, CURSOR_SECRET);
    const rateLimiter = new InMemoryRateLimiter();
    const input = {
      trusted_openid: "trusted-admin-openid",
      query: {},
      server_now: NOW,
      request_id: "request-anomalies-rate-limit",
      rate_limiter: rateLimiter,
    } as never;

    for (let attempt = 0; attempt < 60; attempt += 1) {
      await expect(getAdminAnomalies(service, input)).resolves.toBeDefined();
    }

    await expect(getAdminAnomalies(service, input)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });
});
