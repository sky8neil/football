import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { AdminRole, AdminStatus, AnomalyStatus, AnomalyType } from "../domain/enums.js";
import type { Admin, Anomaly } from "../domain/types.js";
import { AdminAnomaliesService } from "../application/admin-anomalies.js";
import { createPostgresAppRepository } from "../gateway/repository-factory.js";
import {
  buildPostgresSchemaPlan,
  postgresSchemaStatements,
  quoteIdent,
} from "./postgres-schema.js";
import type { AppRepository } from "./repositories.js";

const DATABASE_URL = process.env.FOOTBALL_TEST_DATABASE_URL ?? "";
const ENABLED = DATABASE_URL.length > 0;
const SCHEMA = "football_admin_anomalies_page";
const NAMESPACE = "anomaly_page";
const CURSOR_SECRET = "admin-anomalies-page-cursor";
const ADMIN_ID = "00000000-0000-4000-8000-0000000000a0";
const ADMIN_OPENID = "admin-anomalies-page-openid";
const SHARED_LAST_SEEN_AT = new Date("2026-08-09T10:00:00.000Z");
const OLDER_LAST_SEEN_AT = new Date("2026-08-09T09:00:00.000Z");
const NEWER_LAST_SEEN_AT = new Date("2026-08-09T11:00:00.000Z");
const RESOLVED_AT = new Date("2026-08-09T12:00:00.000Z");

interface AnomalyFixture {
  anomaly_id: string;
  status: AnomalyStatus;
  blocking: boolean;
  last_seen_at: Date;
}

const SAME_TIMESTAMP_OPEN_BLOCKING_IDS = [
  "00000000-0000-4000-8000-000000000011",
  "00000000-0000-4000-8000-000000000012",
  "00000000-0000-4000-8000-000000000013",
  "00000000-0000-4000-8000-000000000014",
  "00000000-0000-4000-8000-000000000015",
] as const;

const FIXTURES: readonly AnomalyFixture[] = [
  ...SAME_TIMESTAMP_OPEN_BLOCKING_IDS.map((anomalyId) => ({
    anomaly_id: anomalyId,
    status: AnomalyStatus.Open,
    blocking: true,
    last_seen_at: SHARED_LAST_SEEN_AT,
  })),
  {
    anomaly_id: "00000000-0000-4000-8000-000000000016",
    status: AnomalyStatus.Open,
    blocking: true,
    last_seen_at: OLDER_LAST_SEEN_AT,
  },
  {
    anomaly_id: "00000000-0000-4000-8000-000000000021",
    status: AnomalyStatus.Open,
    blocking: false,
    last_seen_at: SHARED_LAST_SEEN_AT,
  },
  {
    anomaly_id: "00000000-0000-4000-8000-000000000022",
    status: AnomalyStatus.Open,
    blocking: false,
    last_seen_at: NEWER_LAST_SEEN_AT,
  },
  {
    anomaly_id: "00000000-0000-4000-8000-000000000023",
    status: AnomalyStatus.Open,
    blocking: false,
    last_seen_at: OLDER_LAST_SEEN_AT,
  },
  {
    anomaly_id: "00000000-0000-4000-8000-000000000031",
    status: AnomalyStatus.Resolved,
    blocking: false,
    last_seen_at: SHARED_LAST_SEEN_AT,
  },
  {
    anomaly_id: "00000000-0000-4000-8000-000000000032",
    status: AnomalyStatus.Resolved,
    blocking: false,
    last_seen_at: OLDER_LAST_SEEN_AT,
  },
  {
    anomaly_id: "00000000-0000-4000-8000-000000000041",
    status: AnomalyStatus.Resolved,
    blocking: true,
    last_seen_at: SHARED_LAST_SEEN_AT,
  },
  {
    anomaly_id: "00000000-0000-4000-8000-000000000042",
    status: AnomalyStatus.Resolved,
    blocking: true,
    last_seen_at: OLDER_LAST_SEEN_AT,
  },
];

function makeAdmin(): Admin {
  return {
    schema_version: 1,
    admin_id: ADMIN_ID,
    openid: ADMIN_OPENID,
    status: AdminStatus.Active,
    role: AdminRole.Admin,
    created_at: RESOLVED_AT,
    updated_at: RESOLVED_AT,
  };
}

function makeAnomaly(fixture: AnomalyFixture): Anomaly {
  const resolved = fixture.status === AnomalyStatus.Resolved;
  return {
    schema_version: 1,
    anomaly_id: fixture.anomaly_id,
    anomaly_key: `${fixture.anomaly_id}:${AnomalyType.LiveSyncStale}`,
    match_id: fixture.anomaly_id,
    type: AnomalyType.LiveSyncStale,
    blocking: fixture.blocking,
    status: fixture.status,
    first_seen_at: fixture.last_seen_at,
    last_seen_at: fixture.last_seen_at,
    occurrence_count: resolved ? 2 : 1,
    details: { source: "pg-admin-anomalies-page" },
    resolved_at: resolved ? RESOLVED_AT : null,
    resolution: resolved ? "resolved_in_pg_test" : null,
  };
}

function expectedAnomalyIds(
  status: AnomalyStatus | null,
  blocking: boolean | null,
): string[] {
  return FIXTURES
    .filter((fixture) => status === null || fixture.status === status)
    .filter((fixture) => blocking === null || fixture.blocking === blocking)
    .slice()
    .sort((left, right) => {
      const byLastSeen = right.last_seen_at.getTime() - left.last_seen_at.getTime();
      if (byLastSeen !== 0) return byLastSeen;
      if (left.anomaly_id === right.anomaly_id) return 0;
      return left.anomaly_id < right.anomaly_id ? 1 : -1;
    })
    .map((fixture) => fixture.anomaly_id);
}

describe.skipIf(!ENABLED)("切片 3 管理端异常分页 PostgreSQL", () => {
  let pool!: pg.Pool;
  let repo!: AppRepository;
  let service!: AdminAnomaliesService;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(SCHEMA)} CASCADE`);
    const plan = buildPostgresSchemaPlan(NAMESPACE, SCHEMA);
    for (const statement of postgresSchemaStatements(plan)) {
      await pool.query(statement);
    }
    repo = createPostgresAppRepository(pool, {
      database_url: DATABASE_URL,
      database_schema: SCHEMA,
      resource_namespace: NAMESPACE,
    });
    const admins = repo.admins;
    const anomalies = repo.anomalies;
    if (admins === undefined || anomalies === undefined) {
      throw new Error("admin/anomaly repositories are not configured");
    }
    await admins.insert(makeAdmin());
    for (const fixture of FIXTURES) {
      await anomalies.insert(makeAnomaly(fixture));
    }
    service = new AdminAnomaliesService(repo, CURSOR_SECRET);
  });

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(SCHEMA)} CASCADE`);
    await pool.end();
  });

  it("status/blocking 下推真实 PostgreSQL 并保持固定排序", async () => {
    for (const status of [null, AnomalyStatus.Open, AnomalyStatus.Resolved] as const) {
      for (const blocking of [null, true, false] as const) {
        const page = await service.list(ADMIN_OPENID, {
          status,
          blocking,
          limit: FIXTURES.length,
          cursor: null,
        });
        const label = `status=${String(status)} blocking=${String(blocking)}`;
        expect(page.items.map((item) => item.anomaly_id), label).toEqual(
          expectedAnomalyIds(status, blocking),
        );
        expect(page.has_more, label).toBe(false);
        expect(page.next_cursor, label).toBeNull();
        for (const item of page.items) {
          if (status !== null) expect(item.status, label).toBe(status);
          if (blocking !== null) expect(item.blocking, label).toBe(blocking);
        }
      }
    }
  });

  it("相同 last_seen_at 的游标跨页顺序稳定且无重复遗漏", async () => {
    const expected = expectedAnomalyIds(AnomalyStatus.Open, true);
    const pages: string[][] = [];
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let attempt = 0; attempt < FIXTURES.length; attempt += 1) {
      const page = await service.list(ADMIN_OPENID, {
        status: AnomalyStatus.Open,
        blocking: true,
        limit: 2,
        cursor,
      });
      const pageIds = page.items.map((item) => item.anomaly_id);
      expect(pageIds.length, `page ${pages.length + 1}`).toBeGreaterThan(0);
      pages.push(pageIds);
      seen.push(...pageIds);
      if (!page.has_more) {
        expect(page.next_cursor).toBeNull();
        break;
      }
      expect(page.next_cursor).toEqual(expect.any(String));
      cursor = page.next_cursor;
    }

    expect(expected.slice(0, SAME_TIMESTAMP_OPEN_BLOCKING_IDS.length)).toEqual(
      [...SAME_TIMESTAMP_OPEN_BLOCKING_IDS].reverse(),
    );
    expect(expected.slice(SAME_TIMESTAMP_OPEN_BLOCKING_IDS.length)).toEqual([
      "00000000-0000-4000-8000-000000000016",
    ]);
    expect(pages).toEqual([
      expected.slice(0, 2),
      expected.slice(2, 4),
      expected.slice(4, 6),
    ]);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(expected.length);
  });
});
