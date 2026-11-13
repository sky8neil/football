import { describe, expect, it } from "vitest";
import { AUTH_SESSIONS_TABLE, buildPostgresSchemaPlan, diffPostgresSchema } from "../dist/infrastructure/postgres-schema.js";
import { COLLECTION_DEFINITIONS } from "../dist/schema/collections.js";
import { QUERY_INDEXES, UNIQUE_INDEXES } from "../dist/schema/indexes.js";
import { main as vpsDbMain } from "./vps-db.mjs";

const NAMESPACE = "football_test";
const SCHEMA = "football_test";

describe("vps-db CLI plan", () => {
  it("prints expected vs pending objects without connecting when URL is absent", async () => {
    const logs = [];
    const original = console.log;
    console.log = (...args) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await vpsDbMain(["--namespace", NAMESPACE, "--schema", SCHEMA], {});
    } finally {
      console.log = original;
    }
    const report = JSON.parse(logs[0]);
    const plan = buildPostgresSchemaPlan(NAMESPACE, SCHEMA);
    const expected = diffPostgresSchema(plan, null).expected;
    expect(report.inspected).toBe(false);
    expect(report.expected.tables).toEqual(expected.tables);
    expect(report.expected.indexes).toEqual(expected.indexes);
    expect(report.pending.tables).toEqual(expected.tables);
    expect(report.counts.expected_tables).toBe(COLLECTION_DEFINITIONS.length + 1);
    expect(report.counts.expected_indexes).toBe(UNIQUE_INDEXES.length + QUERY_INDEXES.length + 2);
    expect(report.expected.tables).toContain(AUTH_SESSIONS_TABLE);
    expect(logs.some((line) => line.startsWith("pending_sql:"))).toBe(true);
    expect(logs.join("\n")).toContain("CREATE SCHEMA IF NOT EXISTS");
  });

  it("requires apply credentials and does not invent migration tools", async () => {
    await expect(vpsDbMain(["--namespace", NAMESPACE, "--schema", SCHEMA, "--apply"], {})).rejects.toThrow(
      "FOOTBALL_DATABASE_URL or --database-url is required for --apply",
    );
  });

  it("rejects combining plan and apply", async () => {
    await expect(vpsDbMain(["--plan", "--apply", "--namespace", NAMESPACE, "--schema", SCHEMA], {})).rejects.toThrow(
      "Use either --plan/--dry-run or --apply, not both",
    );
  });
});

const DATABASE_URL = process.env.FOOTBALL_TEST_DATABASE_URL ?? "";

describe.skipIf(DATABASE_URL.length === 0)("vps-db CLI isolated postgres", () => {
  it("plan then apply twice leaves extra objects and reports no pending SQL", async () => {
    const schema = "football_vps08_cli";
    const namespace = "ft";
    const { quoteIdent } = await import("../dist/infrastructure/postgres-schema.js");
    const pg = await import("pg");
    const Pg = pg.default ?? pg;
    const pool = new Pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    const logs = [];
    const original = console.log;
    console.log = (...args) => logs.push(args.map(String).join(" "));
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
      logs.length = 0;
      await vpsDbMain(["--plan", "--namespace", namespace, "--schema", schema, "--database-url", DATABASE_URL], {});
      expect(JSON.parse(logs[0]).pending.schema).toBe(true);
      logs.length = 0;
      await vpsDbMain(["--apply", "--namespace", namespace, "--schema", schema, "--database-url", DATABASE_URL], {});
      const first = JSON.parse(logs[0]);
      expect(first.created.schema).toBe(true);
      await pool.query(`CREATE TABLE ${quoteIdent(schema)}.${quoteIdent("keep_me")} (id int)`);
      logs.length = 0;
      await vpsDbMain(["--apply", "--namespace", namespace, "--schema", schema, "--database-url", DATABASE_URL], {});
      const second = JSON.parse(logs[0]);
      expect(second.created).toEqual({ schema: false, tables: [], indexes: [], functions: [] });
      expect(second.existing.tables).toContain("keep_me");
      logs.length = 0;
      await vpsDbMain(["--plan", "--namespace", namespace, "--schema", schema, "--database-url", DATABASE_URL], {});
      expect(logs.at(-1)).toBe("pending_sql: none");
    } finally {
      console.log = original;
      await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
      await pool.end();
    }
  });
});
