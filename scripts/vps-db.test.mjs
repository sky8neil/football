import { describe, expect, it } from "vitest";
import {
  ADMIN_LOGIN_CONSUMED_JTIS_TABLE,
  AUTH_SESSIONS_TABLE,
  buildPostgresSchemaPlan,
  diffPostgresSchema,
} from "../dist/infrastructure/postgres-schema.js";
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
    expect(report.counts.expected_tables).toBe(COLLECTION_DEFINITIONS.length + 2);
    expect(report.counts.expected_indexes).toBe(UNIQUE_INDEXES.length + QUERY_INDEXES.length + 3);
    expect(report.driftedIndexes).toEqual([]);
    expect(report.counts.drifted_indexes).toBe(0);
    expect(report.expected.tables).toContain(AUTH_SESSIONS_TABLE);
    expect(report.expected.tables).toContain(ADMIN_LOGIN_CONSUMED_JTIS_TABLE);
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

  it("refuses --apply against a production target unless --allow-prod is set, and does not connect", async () => {
    const prodUrl = "postgres://football:must-not-leak@127.0.0.1:1/football";
    await expect(
      vpsDbMain(
        ["--apply", "--namespace", "football_prod", "--schema", "football_prod", "--database-url", prodUrl],
        { FOOTBALL_ENVIRONMENT: "prod" },
      ),
    ).rejects.toThrow("Refusing to --apply a production database target without --allow-prod");
    await expect(
      vpsDbMain(
        ["--apply", "--namespace", "ft", "--schema", "Football_PROD", "--database-url", prodUrl],
        {},
      ),
    ).rejects.toThrow("Refusing to --apply a production database target without --allow-prod");
    await expect(
      vpsDbMain(
        ["--apply", "--namespace", "football_app", "--schema", "football_app"],
        { FOOTBALL_ENVIRONMENT: "prod" },
      ),
    ).rejects.toThrow("Refusing to --apply a production database target without --allow-prod");
    await expect(
      vpsDbMain(
        ["--apply", "--allow-prod", "--namespace", "football_prod", "--schema", "football_prod"],
        { FOOTBALL_ENVIRONMENT: "prod" },
      ),
    ).rejects.toThrow("FOOTBALL_DATABASE_URL or --database-url is required for --apply");
  });

  it("rejects cross-environment schema or namespace even when --allow-prod is set", async () => {
    await expect(
      vpsDbMain(
        ["--apply", "--allow-prod", "--namespace", "football_dev", "--schema", "football_prod"],
        { FOOTBALL_ENVIRONMENT: "dev" },
      ),
    ).rejects.toThrow("FOOTBALL_DATABASE_SCHEMA must not contain prod when FOOTBALL_ENVIRONMENT=dev");
    await expect(
      vpsDbMain(
        ["--namespace", "football_dev", "--schema", "football_test"],
        { FOOTBALL_ENVIRONMENT: "dev" },
      ),
    ).rejects.toThrow("FOOTBALL_DATABASE_SCHEMA must not contain test when FOOTBALL_ENVIRONMENT=dev");
    await expect(
      vpsDbMain(
        ["--namespace", "football_dev", "--schema", "football_test"],
        { FOOTBALL_ENVIRONMENT: "test" },
      ),
    ).rejects.toThrow("FOOTBALL_RESOURCE_NAMESPACE must not contain dev when FOOTBALL_ENVIRONMENT=test");
    await expect(
      vpsDbMain(
        ["--namespace", "football_test", "--schema", "football_prod"],
        { FOOTBALL_ENVIRONMENT: "prod" },
      ),
    ).rejects.toThrow("FOOTBALL_RESOURCE_NAMESPACE must not contain test when FOOTBALL_ENVIRONMENT=prod");
    await expect(
      vpsDbMain(
        ["--namespace", "football_test", "--schema", "football_test"],
        { FOOTBALL_ENVIRONMENT: "staging" },
      ),
    ).rejects.toThrow("FOOTBALL_ENVIRONMENT must be one of: dev, test, prod");
  });

  it("rejects a non-postgres URL or illegal identifier before connecting", async () => {
    const secret = "must-not-leak-db-password";
    try {
      await vpsDbMain(
        [
          "--apply",
          "--namespace",
          "football_test",
          "--schema",
          "football_test",
          "--database-url",
          `mysql://football:${secret}@127.0.0.1:3306/football`,
        ],
        {},
      );
      throw new Error("expected Fail Closed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toBe("FOOTBALL_DATABASE_URL must use the postgres or postgresql protocol");
      expect(message).not.toContain(secret);
    }
    await expect(
      vpsDbMain(["--namespace", "football_test", "--schema", "football test"], {}),
    ).rejects.toThrow("FOOTBALL_DATABASE_SCHEMA must be a valid SQL identifier");
  });

  it("allows a matching dev schema plan without --allow-prod", async () => {
    const logs = [];
    const original = console.log;
    console.log = (...args) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await vpsDbMain(
        ["--namespace", "football_dev", "--schema", "football_dev"],
        { FOOTBALL_ENVIRONMENT: "dev" },
      );
    } finally {
      console.log = original;
    }
    expect(JSON.parse(logs[0]).inspected).toBe(false);
    expect(JSON.parse(logs[0]).schema).toBe("football_dev");
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
