import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { AdminRole, AdminStatus } from "../domain/enums.js";
import { applyAdminGrant, planAdminGrant } from "../application/admin-grant.js";
import { createPostgresAppRepository } from "../gateway/repository-factory.js";
import { createPostgresQueryFn } from "./postgres-document-db.js";
import {
  AUTH_SESSIONS_TABLE,
  applyPostgresSchema,
  buildPostgresSchemaPlan,
  inspectPostgresSchema,
  quoteIdent,
} from "./postgres-schema.js";
import { COLLECTION_DEFINITIONS } from "../schema/collections.js";
import { QUERY_INDEXES, UNIQUE_INDEXES } from "../schema/indexes.js";

const DATABASE_URL = process.env.FOOTBALL_TEST_DATABASE_URL ?? "";
const ENABLED = DATABASE_URL.length > 0;
const SCHEMA = "football_vps08_init";
const NAMESPACE = "ft";
const OPENID = "wx-vps08-admin";
const NOW = new Date("2026-08-09T12:00:00.000Z");
const LATER = new Date("2026-08-10T12:00:00.000Z");

describe.skipIf(!ENABLED)("VPS08 isolated postgres init", () => {
  let pool!: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(SCHEMA)} CASCADE`);
  });

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(SCHEMA)} CASCADE`);
    await pool.end();
  });

  it("applies schema twice without destroying extras and grants admin idempotently", async () => {
    const query = createPostgresQueryFn(pool);
    const plan = buildPostgresSchemaPlan(NAMESPACE, SCHEMA);
    const first = await applyPostgresSchema(query, plan);
    expect(first.created.schema).toBe(true);
    expect(first.created.tables).toHaveLength(COLLECTION_DEFINITIONS.length + 1);
    expect(first.created.tables).toContain(AUTH_SESSIONS_TABLE);
    expect(first.created.indexes).toHaveLength(UNIQUE_INDEXES.length + QUERY_INDEXES.length + 2);

    const extraTable = "vps08_keep_me";
    await pool.query(`CREATE TABLE ${quoteIdent(SCHEMA)}.${quoteIdent(extraTable)} (id int)`);

    const second = await applyPostgresSchema(query, plan);
    expect(second.created).toEqual({ schema: false, tables: [], indexes: [], functions: [] });
    expect(second.existing.tables).toContain(extraTable);

    const after = await inspectPostgresSchema(query, plan);
    expect(after.schemaExists).toBe(true);
    expect(after.tables).toEqual(expect.arrayContaining(first.expected.tables));
    expect(after.tables).toContain(extraTable);
    expect(after.indexes).toEqual(expect.arrayContaining(first.expected.indexes));

    const repo = createPostgresAppRepository(pool, {
      database_url: DATABASE_URL,
      database_schema: SCHEMA,
      resource_namespace: NAMESPACE,
    });
    if (repo.admins === undefined) throw new Error("postgres repository must expose admins");
    const dryRun = await planAdminGrant(repo, { openid: OPENID, now: NOW });
    expect(dryRun.action).toBe("create");
    await expect(repo.admins.findByOpenid(OPENID)).resolves.toBeNull();

    const created = await applyAdminGrant(repo, { openid: OPENID, now: NOW });
    expect(created.action).toBe("create");
    expect(created.status).toBe(AdminStatus.Active);
    expect(created.role).toBe(AdminRole.Admin);
    await expect(repo.admins.findByOpenid(OPENID)).resolves.toMatchObject({
      admin_id: created.admin_id,
      openid: OPENID,
      status: AdminStatus.Active,
      created_at: NOW,
      updated_at: NOW,
    });

    const repeat = await applyAdminGrant(repo, { openid: OPENID, now: LATER });
    expect(repeat).toMatchObject({
      action: "unchanged",
      admin_id: created.admin_id,
    });
    await expect(repo.admins.findByOpenid(OPENID)).resolves.toMatchObject({ updated_at: NOW });
  });
});
