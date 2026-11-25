import { describe, expect, it } from "vitest";
import { main as vpsAdminMain, resolveIssueLoginSecret } from "./vps-admin.mjs";

const OPENID = "wx-admin-openid";

describe("vps-admin argument parsing", () => {
  it("rejects unknown flags, positionals and dash-prefixed values", async () => {
    await expect(vpsAdminMain(["--statu", "disabled"], {})).rejects.toThrow(/Unknown option/);
    await expect(vpsAdminMain(["unexpected-positional"], {})).rejects.toThrow(/Unexpected argument/);
    await expect(vpsAdminMain(["--openid", "--apply"], {})).rejects.toThrow();
    await expect(vpsAdminMain(["--openid", "--namespace", "ft"], {})).rejects.toThrow();
    await expect(vpsAdminMain(["--openid=--apply"], {})).rejects.toThrow(/不能以 - 开头/);
    await expect(vpsAdminMain(["--status=-x"], {})).rejects.toThrow(/不能以 - 开头/);
  });

  it("requires openid and database settings before connecting", async () => {
    await expect(vpsAdminMain([], {})).rejects.toThrow("Provide --openid or FOOTBALL_ADMIN_OPENID");
    await expect(vpsAdminMain(["--openid", OPENID], {})).rejects.toThrow("Provide --namespace or FOOTBALL_RESOURCE_NAMESPACE");
    await expect(vpsAdminMain(["--openid", OPENID, "--namespace", "ft"], {})).rejects.toThrow(
      "Provide --schema or FOOTBALL_DATABASE_SCHEMA",
    );
    await expect(vpsAdminMain(["--apply", "--dry-run", "--openid", OPENID, "--namespace", "ft", "--schema", "s"], {})).rejects.toThrow(
      "Use either --dry-run or --apply, not both",
    );
    await expect(vpsAdminMain(["--issue-login", "--apply", "--openid", OPENID, "--namespace", "ft", "--schema", "s"], {})).rejects.toThrow(
      "Use --issue-login separately from --apply/--dry-run/--plan",
    );
  });

  it("[CR-28] --issue-login 对空字符串 secret/env 自动回退到非空密钥并拒绝全空配置", () => {
    expect(
      resolveIssueLoginSecret(
        { secret: "   " },
        { FOOTBALL_ADMIN_LOGIN_SECRET: "", FOOTBALL_MATCH_CURSOR_SECRET: "fallback-secret-123" },
      ),
    ).toBe("fallback-secret-123");

    expect(
      resolveIssueLoginSecret(
        {},
        { FOOTBALL_ADMIN_LOGIN_SECRET: "admin-secret-456", FOOTBALL_MATCH_CURSOR_SECRET: "fallback" },
      ),
    ).toBe("admin-secret-456");

    expect(() =>
      resolveIssueLoginSecret(
        { secret: "" },
        { FOOTBALL_ADMIN_LOGIN_SECRET: "  ", FOOTBALL_MATCH_CURSOR_SECRET: "" },
      ),
    ).toThrow("Provide --secret, FOOTBALL_ADMIN_LOGIN_SECRET, or FOOTBALL_MATCH_CURSOR_SECRET");
  });
});

const DATABASE_URL = process.env.FOOTBALL_TEST_DATABASE_URL ?? "";

describe.skipIf(DATABASE_URL.length === 0)("vps-admin CLI isolated postgres", () => {
  it("dry-run does not write; apply then repeat is unchanged", async () => {
    const schema = "football_vps08_admin_cli";
    const namespace = "ft";
    const { applyPostgresSchema, buildPostgresSchemaPlan, quoteIdent } = await import(
      "../dist/infrastructure/postgres-schema.js"
    );
    const { createPostgresQueryFn } = await import("../dist/infrastructure/postgres-document-db.js");
    const pg = await import("pg");
    const Pg = pg.default ?? pg;
    const pool = new Pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    const logs = [];
    const original = console.log;
    console.log = (...args) => logs.push(args.map(String).join(" "));
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
      await applyPostgresSchema(createPostgresQueryFn(pool), buildPostgresSchemaPlan(namespace, schema));
      logs.length = 0;
      await vpsAdminMain([
        "--dry-run", "--openid", OPENID, "--namespace", namespace, "--schema", schema, "--database-url", DATABASE_URL,
      ], {});
      expect(JSON.parse(logs[0])).toMatchObject({ mode: "dry-run", action: "create", openid: OPENID });
      logs.length = 0;
      await vpsAdminMain([
        "--apply", "--openid", OPENID, "--namespace", namespace, "--schema", schema, "--database-url", DATABASE_URL,
      ], {});
      const created = JSON.parse(logs[0]);
      expect(created.mode).toBe("apply");
      expect(created.action).toBe("create");
      logs.length = 0;
      await vpsAdminMain([
        "--apply", "--openid", OPENID, "--namespace", namespace, "--schema", schema, "--database-url", DATABASE_URL,
      ], {});
      expect(JSON.parse(logs[0])).toMatchObject({
        mode: "apply",
        action: "unchanged",
        admin_id: created.admin_id,
      });
    } finally {
      console.log = original;
      await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
      await pool.end();
    }
  });
});
