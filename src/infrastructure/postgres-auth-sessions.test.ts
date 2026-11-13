import { describe, expect, it, vi } from "vitest";
import {
  createPostgresAuthSessionStore,
  type AuthSessionRecord,
} from "./postgres-auth-sessions.js";
import { AUTH_SESSIONS_TABLE, qualifiedTable, type PostgresQueryFn } from "./postgres-schema.js";

const SCHEMA = "football_vps04_auth";
const OPENID = "wx-openid-alice";
const NOW = new Date("2026-08-09T12:00:00.000Z");
const TTL_SECONDS = 604800;
const TOKEN_A = Buffer.alloc(32, 1).toString("base64url");
const TOKEN_B = Buffer.alloc(32, 2).toString("base64url");

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
        sql: `INSERT INTO ${qualifiedTable(SCHEMA, AUTH_SESSIONS_TABLE)} (token, openid, expires_at) VALUES ($1, $2, $3)`,
        params: [TOKEN_A, OPENID, session.expires_at],
      },
    ]);
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
    const { query } = makeQuery((_sql, params) => {
      if (params[0] === TOKEN_A && params[1] === NOW) {
        return { rows: [{ token: record.token, openid: record.openid, expires_at: record.expires_at }] };
      }
      return { rows: [] };
    });
    const store = createPostgresAuthSessionStore(query, SCHEMA);

    await expect(store.findActiveByToken({ token: TOKEN_A, now: NOW })).resolves.toEqual(record);
    await expect(store.findActiveByToken({ token: TOKEN_A, now: record.expires_at })).resolves.toBeNull();
    await expect(store.findActiveByToken({ token: "missing", now: NOW })).resolves.toBeNull();
    await expect(store.findActiveByToken({ token: "   ", now: NOW })).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(3);
  });
});
