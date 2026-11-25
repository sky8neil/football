import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createInMemoryAdminConsumedJtiStore,
  createPostgresAdminConsumedJtiStore,
  createPostgresAuthSessionStore,
  type AuthSessionRecord,
} from "./postgres-auth-sessions.js";
import {
  ADMIN_LOGIN_CONSUMED_JTIS_TABLE,
  AUTH_SESSIONS_TABLE,
  qualifiedTable,
  type PostgresQueryFn,
} from "./postgres-schema.js";

const SCHEMA = "football_vps04_auth";
const OPENID = "wx-openid-alice";
const NOW = new Date("2026-08-09T12:00:00.000Z");
const TTL_SECONDS = 604800;
const TOKEN_A = Buffer.alloc(32, 1).toString("base64url");
const TOKEN_B = Buffer.alloc(32, 2).toString("base64url");

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function uniqueViolation(): Error {
  return Object.assign(new Error("duplicate key"), { code: "23505" });
}

function makeQuery(
  handler: (sql: string, params: unknown[]) => unknown | Promise<unknown> = () => ({ rows: [] }),
): { query: PostgresQueryFn; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    query: vi.fn(async (sql, params = []) => {
      calls.push({ sql, params });
      const result = await handler(sql, params);
      if (result !== undefined && typeof result === "object" && result !== null && "rows" in result) {
        return result as { rows: Array<Record<string, unknown>> };
      }
      return { rows: [] };
    }),
  };
}

function bytes(...values: number[]) {
  let index = 0;
  return (size: number) => {
    const fill = values[Math.min(index, values.length - 1)] ?? 1;
    index += 1;
    return Buffer.alloc(size, fill);
  };
}

describe("createPostgresAuthSessionStore", () => {
  it("inserts an opaque random token with configured ttl", async () => {
    const { query, calls } = makeQuery();
    const store = createPostgresAuthSessionStore(query, SCHEMA, { randomBytes: bytes(1) });

    const session = await store.create({ openid: OPENID, now: NOW, ttlSeconds: TTL_SECONDS });

    expect(session).toEqual({
      token: TOKEN_A,
      openid: OPENID,
      expires_at: new Date(NOW.getTime() + TTL_SECONDS * 1000),
    });
    expect(session.token).not.toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(calls).toEqual([
      {
        sql:
          `INSERT INTO ${qualifiedTable(SCHEMA, AUTH_SESSIONS_TABLE)} (token, openid, expires_at) ` +
          `SELECT $2, $3, $4 FROM (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) AS openid_lock`,
        params: [
          `football.auth_sessions:${SCHEMA}:${OPENID}`,
          tokenDigest(TOKEN_A),
          OPENID,
          session.expires_at,
        ],
      },
    ]);
    expect(calls[0]?.params[1]).not.toBe(TOKEN_A);
  });

  it("retries token allocation on unique collision then succeeds", async () => {
    let inserts = 0;
    const { query } = makeQuery((sql) => {
      if (sql.startsWith("INSERT")) {
        inserts += 1;
        if (inserts === 1) throw uniqueViolation();
      }
      return { rows: [] };
    });
    const store = createPostgresAuthSessionStore(query, SCHEMA, { randomBytes: bytes(1, 2) });

    await expect(store.create({ openid: OPENID, now: NOW, ttlSeconds: 60 })).resolves.toMatchObject({
      token: TOKEN_B,
      openid: OPENID,
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("reads an unexpired session and ignores expired or missing tokens", async () => {
    const record: AuthSessionRecord = {
      token: TOKEN_A,
      openid: OPENID,
      expires_at: new Date(NOW.getTime() + 1000),
    };
    const digest = tokenDigest(TOKEN_A);
    const { query, calls } = makeQuery((_sql, params) => {
      if (params[0] === digest && params[1] === NOW) {
        return { rows: [{ token: digest, openid: record.openid, expires_at: record.expires_at }] };
      }
      return { rows: [] };
    });
    const store = createPostgresAuthSessionStore(query, SCHEMA);

    await expect(store.findActiveByToken({ token: TOKEN_A, now: NOW })).resolves.toEqual(record);
    await expect(store.findActiveByToken({ token: TOKEN_A, now: record.expires_at })).resolves.toBeNull();
    await expect(store.findActiveByToken({ token: "missing", now: NOW })).resolves.toBeNull();
    await expect(store.findActiveByToken({ token: "   ", now: NOW })).resolves.toBeNull();
    await expect(store.findActiveByToken({ token: digest, now: NOW })).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(4);
    expect(calls.map((call) => call.params[0])).toEqual([
      digest,
      digest,
      tokenDigest("missing"),
      tokenDigest(digest),
    ]);
    expect(calls.some((call) => call.params.includes(TOKEN_A))).toBe(false);
  });

  it("deletes every session for an openid and leaves other openids untouched", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const query: PostgresQueryFn = vi.fn(async (sql, params = []) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: params[0] === OPENID ? 2 : 0 };
    });
    const store = createPostgresAuthSessionStore(query, SCHEMA);

    await expect(store.deleteByOpenid(OPENID)).resolves.toBe(2);
    await expect(store.deleteByOpenid("wx-openid-bob")).resolves.toBe(0);
    expect(calls).toEqual([
      {
        sql: `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        params: [`football.auth_sessions:${SCHEMA}:${OPENID}`],
      },
      {
        sql: `DELETE FROM ${qualifiedTable(SCHEMA, AUTH_SESSIONS_TABLE)} WHERE openid = $1`,
        params: [OPENID],
      },
      {
        sql: `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        params: [`football.auth_sessions:${SCHEMA}:wx-openid-bob`],
      },
      {
        sql: `DELETE FROM ${qualifiedTable(SCHEMA, AUTH_SESSIONS_TABLE)} WHERE openid = $1`,
        params: ["wx-openid-bob"],
      },
    ]);
    expect(calls.some((call) => /expires_at/.test(call.sql))).toBe(false);
  });

  it("rejects a blank or padded openid without querying", async () => {
    const { query } = makeQuery();
    const store = createPostgresAuthSessionStore(query, SCHEMA);

    await expect(store.deleteByOpenid("")).rejects.toThrow(/openid is required/);
    await expect(store.deleteByOpenid("   ")).rejects.toThrow(/openid is required/);
    await expect(store.deleteByOpenid(` ${OPENID}`)).rejects.toThrow(/openid is required/);
    expect(query).not.toHaveBeenCalled();
  });

  it("deletes expired sessions before cutoff and returns rowCount [Slice 5.4]", async () => {
    const cutoff = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
    const calls: { sql: string; params: unknown[] }[] = [];
    const query: PostgresQueryFn = vi.fn(async (sql, params = []) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 12 };
    });
    const store = createPostgresAuthSessionStore(query, SCHEMA);

    const deleted = await store.deleteExpiredBefore!(cutoff);
    expect(deleted).toBe(12);
    expect(calls).toEqual([
      {
        sql: `DELETE FROM ${qualifiedTable(SCHEMA, AUTH_SESSIONS_TABLE)} WHERE expires_at < $1`,
        params: [cutoff],
      },
    ]);
    await expect(store.deleteExpiredBefore!(new Date("invalid"))).rejects.toThrow(/valid Date/);
  });

  it("[Slice 2] deletes expired sessions with a bounded LIMIT subquery", async () => {
    const cutoff = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
    const calls: { sql: string; params: unknown[] }[] = [];
    const query: PostgresQueryFn = vi.fn(async (sql, params = []) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 500 };
    });
    const store = createPostgresAuthSessionStore(query, SCHEMA);
    const table = qualifiedTable(SCHEMA, AUTH_SESSIONS_TABLE);

    const deleted = await store.deleteExpiredBefore!(cutoff, { limit: 500 });

    expect(deleted).toBe(500);
    expect(calls).toEqual([
      {
        sql: `DELETE FROM ${table} WHERE token IN (SELECT token FROM ${table} WHERE expires_at < $1 LIMIT $2)`,
        params: [cutoff, 500],
      },
    ]);
  });

  it("[CR-12] postgres admin_login_consumed_jtis 原子消费 jti 并拒绝未过期重放", async () => {
    const table = qualifiedTable(SCHEMA, ADMIN_LOGIN_CONSUMED_JTIS_TABLE);
    const seen = new Map<string, Date>();
    const query: PostgresQueryFn = vi.fn(async (sql, params = []) => {
      expect(sql).toContain(`INSERT INTO ${table} (jti, expires_at)`);
      const [jti, expiresAt, now] = params as [string, Date, Date];
      const existing = seen.get(jti);
      if (existing === undefined || existing.getTime() <= now.getTime()) {
        seen.set(jti, expiresAt);
        return { rows: [{ jti }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const store = createPostgresAdminConsumedJtiStore(query, SCHEMA);
    const exp = new Date(NOW.getTime() + 300_000);
    expect(await store.consume({ jti: "jti-1", expiresAt: exp, now: NOW })).toBe(true);
    expect(await store.consume({ jti: "jti-1", expiresAt: exp, now: NOW })).toBe(false);

    const memStore = createInMemoryAdminConsumedJtiStore();
    expect(await memStore.consume({ jti: "jti-2", expiresAt: exp, now: NOW })).toBe(true);
    expect(await memStore.consume({ jti: "jti-2", expiresAt: exp, now: NOW })).toBe(false);
    // 过期后允许复用或被清理
    expect(
      await memStore.consume({
        jti: "jti-2",
        expiresAt: new Date(exp.getTime() + 600_000),
        now: new Date(exp.getTime() + 1_000),
      }),
    ).toBe(true);
  });
});
