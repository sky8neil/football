import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { issueWechatSession, resolveBearerOpenid } from "../gateway/auth.js";
import type { WechatCode2SessionHttp } from "../gateway/wechat-login.js";
import { createPostgresAuthSessionStore } from "./postgres-auth-sessions.js";
import {
  AUTH_SESSIONS_TABLE,
  qualifiedTable,
  quoteIdent,
} from "./postgres-schema.js";
import { createPostgresQueryFn } from "./postgres-document-db.js";

const DATABASE_URL = process.env.FOOTBALL_TEST_DATABASE_URL ?? "";
const ENABLED = DATABASE_URL.length > 0;
const SCHEMA = "football_vps04_auth";
const OPENID = "wx-openid-alice";
const OTHER_OPENID = "wx-openid-bob";
const NOW = new Date("2026-08-09T12:00:00.000Z");
const AUTH = {
  wechat_app_id: "wx-test-appid",
  wechat_app_secret: "wx-test-secret-must-not-leak",
  session_ttl_seconds: 60,
};

describe.skipIf(!ENABLED)("Postgres auth sessions 创建/读取/过期重登", () => {
  let pool!: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(SCHEMA)}`);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable(SCHEMA, AUTH_SESSIONS_TABLE)} (token text PRIMARY KEY, openid text NOT NULL, expires_at timestamptz NOT NULL)`,
    );
    await pool.query(`TRUNCATE ${qualifiedTable(SCHEMA, AUTH_SESSIONS_TABLE)}`);
  });

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(SCHEMA)} CASCADE`);
    await pool.end();
  });

  it("creates, reads, expires, and re-logins without HTTP routes", async () => {
    const query = createPostgresQueryFn(pool);
    const sessions = createPostgresAuthSessionStore(query, SCHEMA);
    const http: WechatCode2SessionHttp = {
      getJson: async () => ({ openid: OPENID, session_key: "wx-session-key-must-not-leave" }),
    };

    const created = await sessions.create({ openid: OPENID, now: NOW, ttlSeconds: 60 });
    expect(created.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(created.token).not.toContain(".");
    expect(created.openid).toBe(OPENID);
    expect(created.expires_at.toISOString()).toBe("2026-08-09T12:01:00.000Z");

    await expect(sessions.findActiveByToken({ token: created.token, now: NOW })).resolves.toMatchObject({
      token: created.token,
      openid: OPENID,
    });
    await expect(sessions.findActiveByToken({
      token: created.token,
      now: created.expires_at,
    })).resolves.toBeNull();

    const issued = await issueWechatSession({
      code: "wx-one-time-code",
      auth: AUTH,
      http,
      sessions,
      now: created.expires_at,
    });
    expect(issued.access_token).not.toBe(created.token);
    expect(issued.token_type).toBe("Bearer");
    expect(issued.expires_at).toBe("2026-08-09T12:02:00.000Z");
    await expect(resolveBearerOpenid({
      authorization: `Bearer ${issued.access_token}`,
      sessions,
      now: created.expires_at,
    })).resolves.toBe(OPENID);
    await expect(resolveBearerOpenid({
      authorization: `Bearer ${created.token}`,
      sessions,
      now: created.expires_at,
    })).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const other = await sessions.create({ openid: OTHER_OPENID, now: NOW, ttlSeconds: 60 });
    await expect(sessions.findActiveByToken({ token: other.token, now: NOW })).resolves.toMatchObject({
      openid: OTHER_OPENID,
    });
    const stored = await pool.query(
      `SELECT token, openid FROM ${qualifiedTable(SCHEMA, AUTH_SESSIONS_TABLE)} ORDER BY token`,
    );
    expect(stored.rows).toEqual(
      [
        { token: created.token, openid: OPENID },
        { token: issued.access_token, openid: OPENID },
        { token: other.token, openid: OTHER_OPENID },
      ].sort((a, b) => a.token.localeCompare(b.token)),
    );
  });
});
