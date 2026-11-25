import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createPostgresQueryFn } from "./postgres-document-db.js";
import {
  applyPostgresSchema,
  buildPostgresSchemaPlan,
  diffPostgresSchema,
  normalizePostgresIndexDef,
  qualifiedTable,
  quoteIdent,
  type PostgresIndexPlan,
  type PostgresSchemaPlan,
} from "./postgres-schema.js";

const DATABASE_URL = process.env.FOOTBALL_TEST_DATABASE_URL ?? "";
const ENABLED = DATABASE_URL.length > 0;
const SCHEMA = "football_schema_apply";
const NAMESPACE = "schema_apply";

function plannedIndexes(plan: PostgresSchemaPlan): PostgresIndexPlan[] {
  return [...plan.indexes, ...plan.authSessions.indexes, ...plan.adminLoginConsumedJtis.indexes];
}

async function indexOids(pool: pg.Pool, names: readonly string[]): Promise<Record<string, string>> {
  const result = await pool.query(
    `SELECT c.relname AS name, c.oid::text AS oid
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind = 'i' AND c.relname = ANY($2::text[])
     ORDER BY c.relname`,
    [SCHEMA, names],
  );
  return Object.fromEntries(result.rows.map((row) => [String(row.name), String(row.oid)]));
}

async function indexDefs(pool: pg.Pool): Promise<Map<string, string>> {
  const result = await pool.query(`SELECT indexname, indexdef FROM pg_catalog.pg_indexes WHERE schemaname = $1`, [
    SCHEMA,
  ]);
  return new Map(result.rows.map((row) => [String(row.indexname), String(row.indexdef)]));
}

describe.skipIf(!ENABLED)("postgres schema apply on real postgres", () => {
  let pool!: pg.Pool;
  const plan = buildPostgresSchemaPlan(NAMESPACE, SCHEMA);

  beforeAll(async () => {
    const database = new URL(DATABASE_URL).pathname.replace(/^\//, "");
    if (database !== "football_test") throw new Error(`refusing database ${database}`);
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
    const current = await pool.query("SELECT current_database() AS name");
    if (current.rows[0]?.name !== "football_test") {
      throw new Error(`connected to ${String(current.rows[0]?.name)}`);
    }
  });

  beforeEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(SCHEMA)} CASCADE`);
  });

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(SCHEMA)} CASCADE`);
    await pool.end();
  });

  it("applies concurrently, then stays idempotent without rebuilding indexes", async () => {
    const query = createPostgresQueryFn(pool);
    const results = await Promise.all([
      applyPostgresSchema(query, plan),
      applyPostgresSchema(query, plan),
      applyPostgresSchema(query, plan),
      applyPostgresSchema(query, plan),
    ]);
    expect(results).toHaveLength(4);
    const creators = results.filter((item) => item.created.schema);
    expect(creators).toHaveLength(1);
    const expected = diffPostgresSchema(plan, null).expected;
    expect([...creators[0]!.created.tables].sort()).toEqual([...expected.tables].sort());
    expect([...creators[0]!.created.indexes].sort()).toEqual([...expected.indexes].sort());
    expect(creators[0]!.created.functions).toEqual(expected.functions);
    const waiters = results.filter((item) => !item.created.schema);
    expect(waiters).toHaveLength(3);
    for (const waiter of waiters) {
      expect(waiter.created).toEqual({ schema: false, tables: [], indexes: [], functions: [] });
    }

    const defs = await indexDefs(pool);
    for (const index of plannedIndexes(plan)) {
      const actual = defs.get(index.name);
      expect(actual, index.name).toBeDefined();
      expect(normalizePostgresIndexDef(actual ?? "", SCHEMA), index.name).toBe(
        normalizePostgresIndexDef(index.sql, SCHEMA),
      );
    }
    const names = plannedIndexes(plan).map((index) => index.name);
    const before = await indexOids(pool, names);
    const again = await applyPostgresSchema(query, plan);
    expect(again.created).toEqual({ schema: false, tables: [], indexes: [], functions: [] });
    expect(await indexOids(pool, names)).toEqual(before);
  }, 30000);

  it("reports a drifted index without rebuilding it or claiming it was fixed", async () => {
    const query = createPostgresQueryFn(pool);
    await applyPostgresSchema(query, plan);
    const index = plan.indexes.find((item) => item.name === "uk_openid");
    if (index === undefined) throw new Error("missing uk_openid");
    const names = plannedIndexes(plan).map((item) => item.name);
    await pool.query(`DROP INDEX ${qualifiedTable(SCHEMA, index.name)}`);
    await pool.query(
      `CREATE UNIQUE INDEX ${quoteIdent(index.name)} ON ${qualifiedTable(SCHEMA, index.table)} (((document ->> 'stale')))`,
    );
    const staleOids = await indexOids(pool, names);

    const reported = await applyPostgresSchema(query, plan);
    expect(reported.created.indexes).not.toContain(index.name);
    expect(reported.driftedIndexes.map((item) => item.name)).toContain(index.name);
    const defs = await indexDefs(pool);
    expect(defs.get(index.name)).toContain("'stale'");
    expect(defs.get(index.name)).not.toContain("'openid'");
    expect(normalizePostgresIndexDef(defs.get(index.name) ?? "", SCHEMA)).not.toBe(
      normalizePostgresIndexDef(index.sql, SCHEMA),
    );
    expect(await indexOids(pool, names)).toEqual(staleOids);

    const again = await applyPostgresSchema(query, plan);
    expect(again.created.indexes).not.toContain(index.name);
    expect(again.driftedIndexes.map((item) => item.name)).toContain(index.name);
    expect(await indexOids(pool, names)).toEqual(staleOids);
  }, 30000);

  it("does not report a wrong index created during the lock wait as fixed", async () => {
    const query = createPostgresQueryFn(pool);
    await applyPostgresSchema(query, plan);
    const index = plan.indexes.find((item) => item.name === "uk_openid");
    if (index === undefined) throw new Error("missing uk_openid");
    await pool.query(`DROP INDEX ${qualifiedTable(SCHEMA, index.name)}`);

    const holder = await pool.connect();
    const lockSql = "SELECT pg_advisory_lock(hashtext('football_postgres_schema'), hashtext($1))";
    const unlockSql = "SELECT pg_advisory_unlock(hashtext('football_postgres_schema'), hashtext($1))";
    const lockKey = `${SCHEMA}:${NAMESPACE}`;
    let applyTask: Promise<Awaited<ReturnType<typeof applyPostgresSchema>>> | undefined;
    try {
      await holder.query(lockSql, [lockKey]);
      applyTask = applyPostgresSchema(query, plan);
      const deadline = Date.now() + 8000;
      let waiting = false;
      while (Date.now() < deadline) {
        const found = await holder.query(
          `SELECT 1
           FROM pg_stat_activity
           WHERE datname = current_database()
              AND wait_event = 'advisory'
              AND query LIKE '%pg_advisory_xact_lock%'
              AND strpos(query, $1) > 0
           LIMIT 1`,
          [SCHEMA],
        );
        if ((found.rowCount ?? 0) > 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      expect(waiting).toBe(true);
      await holder.query(
        `CREATE UNIQUE INDEX ${quoteIdent(index.name)} ON ${qualifiedTable(SCHEMA, index.table)} (((document ->> 'stale')))`,
      );
      await holder.query(unlockSql, [lockKey]);
      const reported = await applyTask;
      applyTask = undefined;
      expect(reported.created.indexes).not.toContain(index.name);
      expect(reported.driftedIndexes.map((item) => item.name)).toContain(index.name);
    } finally {
      await holder.query(unlockSql, [lockKey]).catch(() => undefined);
      holder.release();
      await applyTask?.catch(() => undefined);
    }

    const defs = await indexDefs(pool);
    expect(defs.get(index.name)).toContain("'stale'");
    expect(defs.get(index.name)).not.toContain("'openid'");
  }, 30000);

  it("keeps parentheses that still distinguish postgres index definitions", async () => {
    await pool.query(`CREATE SCHEMA ${quoteIdent(SCHEMA)}`);
    await pool.query(`CREATE TABLE ${qualifiedTable(SCHEMA, "docs")} (_id text PRIMARY KEY, document jsonb NOT NULL)`);
    await pool.query(
      `CREATE INDEX ix_expr_sum_product ON ${qualifiedTable(SCHEMA, "docs")} ((((document ->> 'a')::numeric + (document ->> 'b')::numeric) * (document ->> 'c')::numeric))`,
    );
    await pool.query(
      `CREATE INDEX ix_expr_product_sum ON ${qualifiedTable(SCHEMA, "docs")} (((document ->> 'a')::numeric + ((document ->> 'b')::numeric * (document ->> 'c')::numeric)))`,
    );
    const defs = await indexDefs(pool);
    expect(normalizePostgresIndexDef(defs.get("ix_expr_sum_product") ?? "", SCHEMA)).not.toBe(
      normalizePostgresIndexDef(defs.get("ix_expr_product_sum") ?? "", SCHEMA),
    );
  }, 30000);

  it("detects ASC/DESC non-default NULLS FIRST/LAST drift on real postgres without rebuilding", async () => {
    const query = createPostgresQueryFn(pool);
    const initial = await applyPostgresSchema(query, plan);
    expect(initial.driftedIndexes).toEqual([]);

    const seasonLevelIndex = plan.indexes.find((item) => item.name === "ix_user_season_level");
    if (seasonLevelIndex === undefined) throw new Error("missing ix_user_season_level");
    const names = plannedIndexes(plan).map((item) => item.name);

    // 将默认 DESC (NULLS FIRST) 篡改为非默认 DESC NULLS LAST，并把 ASC 改为 ASC NULLS FIRST
    await pool.query(`DROP INDEX ${qualifiedTable(SCHEMA, seasonLevelIndex.name)}`);
    await pool.query(
      `CREATE INDEX ${quoteIdent(seasonLevelIndex.name)} ON ${qualifiedTable(SCHEMA, seasonLevelIndex.table)} ` +
        `((document ->> 'level_season_id') ASC NULLS FIRST, ((document ->> 'level')::numeric) DESC NULLS LAST)`,
    );
    const driftedOids = await indexOids(pool, names);

    const reported = await applyPostgresSchema(query, plan);
    expect(reported.created.indexes).not.toContain(seasonLevelIndex.name);
    expect(reported.driftedIndexes.map((item) => item.name)).toContain(seasonLevelIndex.name);
    // 只报告，不自动 DROP/重建（OID 保持不变）
    expect(await indexOids(pool, names)).toEqual(driftedOids);
  }, 30000);
});
