import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import {
  ADMIN_LOGIN_CONSUMED_JTIS_TABLE,
  AUTH_SESSIONS_TABLE,
  qualifiedTable,
  type PostgresQueryFn,
} from "./postgres-schema.js";

const TOKEN_BYTE_LENGTH = 32;
const CREATE_ATTEMPTS = 3;

export interface AuthSessionRecord {
  token: string;
  openid: string;
  expires_at: Date;
}

export interface CreateAuthSessionInput {
  openid: string;
  now: Date;
  ttlSeconds: number;
}

export interface FindAuthSessionInput {
  token: string;
  now: Date;
}

export interface AuthSessionStore {
  create(input: CreateAuthSessionInput): Promise<AuthSessionRecord>;
  findActiveByToken(input: FindAuthSessionInput): Promise<AuthSessionRecord | null>;
  deleteByOpenid(openid: string): Promise<number>;
  deleteByToken?(token: string): Promise<number>;
  deleteExpiredBefore?(cutoff: Date, options?: { limit?: number }): Promise<number>;
}

export interface PostgresAuthSessionStoreOptions {
  randomBytes?: (size: number) => Buffer;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    String((error as { code?: unknown }).code ?? "") === "23505";
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function generateOpaqueToken(generate: (size: number) => Buffer): string {
  return generate(TOKEN_BYTE_LENGTH).toString("base64url");
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function openidLockKey(schema: string, openid: string): string {
  return `football.auth_sessions:${schema}:${openid}`;
}

export function createPostgresAuthSessionStore(
  query: PostgresQueryFn,
  schema: string,
  options: PostgresAuthSessionStoreOptions = {},
): AuthSessionStore {
  const generate = options.randomBytes ?? nodeRandomBytes;
  const table = qualifiedTable(schema, AUTH_SESSIONS_TABLE);
  const insertSql =
    `INSERT INTO ${table} (token, openid, expires_at) ` +
    `SELECT $2, $3, $4 FROM (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) AS openid_lock`;
  const lockOpenidSql = `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`;
  const selectSql =
    `SELECT token, openid, expires_at FROM ${table} WHERE token = $1 AND expires_at > $2`;
  const deleteByOpenidSql = `DELETE FROM ${table} WHERE openid = $1`;
  const deleteByTokenSql = `DELETE FROM ${table} WHERE token = $1`;
  const deleteExpiredSql = `DELETE FROM ${table} WHERE expires_at < $1`;
  const deleteExpiredLimitedSql =
    `DELETE FROM ${table} WHERE token IN (SELECT token FROM ${table} WHERE expires_at < $1 LIMIT $2)`;

  return {
    async create(input) {
      if (!isNonEmptyString(input.openid) || input.openid.trim() !== input.openid) {
        throw new Error("openid is required");
      }
      if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
        throw new Error("ttlSeconds must be a positive integer");
      }
      const expiresAt = new Date(input.now.getTime() + input.ttlSeconds * 1000);
      let lastError: unknown = new Error("failed to allocate session token");
      for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
        const token = generateOpaqueToken(generate);
        try {
          await query(insertSql, [
            openidLockKey(schema, input.openid),
            tokenDigest(token),
            input.openid,
            expiresAt,
          ]);
          return { token, openid: input.openid, expires_at: expiresAt };
        } catch (error) {
          lastError = error;
          if (isUniqueViolation(error)) continue;
          throw error;
        }
      }
      throw lastError;
    },

    async findActiveByToken(input) {
      if (!isNonEmptyString(input.token)) return null;
      const result = await query(selectSql, [tokenDigest(input.token), input.now]);
      const row = result.rows[0];
      if (row === undefined) return null;
      const openid = row.openid;
      const expiresAt = asDate(row.expires_at);
      if (!isNonEmptyString(row.token) || !isNonEmptyString(openid) || expiresAt === null) {
        return null;
      }
      return { token: input.token, openid, expires_at: expiresAt };
    },

    async deleteByOpenid(openid) {
      if (!isNonEmptyString(openid) || openid.trim() !== openid) {
        throw new Error("openid is required");
      }
      await query(lockOpenidSql, [openidLockKey(schema, openid)]);
      const result = await query(deleteByOpenidSql, [openid]);
      return typeof result.rowCount === "number" ? result.rowCount : result.rows.length;
    },

    async deleteByToken(token) {
      if (!isNonEmptyString(token)) return 0;
      const result = await query(deleteByTokenSql, [tokenDigest(token)]);
      return typeof result.rowCount === "number" ? result.rowCount : result.rows.length;
    },

    async deleteExpiredBefore(cutoff, options) {
      if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime())) {
        throw new Error("cutoff must be a valid Date");
      }
      const limit = options?.limit;
      const limited = typeof limit === "number" && Number.isInteger(limit) && limit > 0;
      const result = limited
        ? await query(deleteExpiredLimitedSql, [cutoff, limit])
        : await query(deleteExpiredSql, [cutoff]);
      return typeof result.rowCount === "number" ? result.rowCount : result.rows.length;
    },
  };
}

/** 内存版会话存储（沿用 SHA-256 摘要落表语义），供非 PG 本地开发与测试使用。 */
export function createInMemoryAuthSessionStore(
  options: PostgresAuthSessionStoreOptions = {},
): AuthSessionStore {
  const generate = options.randomBytes ?? nodeRandomBytes;
  const records = new Map<string, { digest: string; openid: string; expires_at: Date }>();

  return {
    async create(input) {
      if (!isNonEmptyString(input.openid) || input.openid.trim() !== input.openid) {
        throw new Error("openid is required");
      }
      if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
        throw new Error("ttlSeconds must be a positive integer");
      }
      const expiresAt = new Date(input.now.getTime() + input.ttlSeconds * 1000);
      for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
        const token = generateOpaqueToken(generate);
        const digest = tokenDigest(token);
        if (records.has(digest)) continue;
        records.set(digest, { digest, openid: input.openid, expires_at: expiresAt });
        return { token, openid: input.openid, expires_at: expiresAt };
      }
      throw new Error("failed to allocate session token");
    },

    async findActiveByToken(input) {
      if (!isNonEmptyString(input.token)) return null;
      const digest = tokenDigest(input.token);
      const found = records.get(digest);
      if (found === undefined || found.expires_at.getTime() <= input.now.getTime()) {
        return null;
      }
      return { token: input.token, openid: found.openid, expires_at: found.expires_at };
    },

    async deleteByOpenid(openid) {
      if (!isNonEmptyString(openid) || openid.trim() !== openid) {
        throw new Error("openid is required");
      }
      let deleted = 0;
      for (const [digest, record] of records.entries()) {
        if (record.openid === openid) {
          records.delete(digest);
          deleted += 1;
        }
      }
      return deleted;
    },

    async deleteByToken(token) {
      if (!isNonEmptyString(token)) return 0;
      return records.delete(tokenDigest(token)) ? 1 : 0;
    },

    async deleteExpiredBefore(cutoff, options) {
      if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime())) {
        throw new Error("cutoff must be a valid Date");
      }
      const limit = options?.limit;
      const limited = typeof limit === "number" && Number.isInteger(limit) && limit > 0;
      let deleted = 0;
      for (const [digest, record] of records.entries()) {
        if (record.expires_at.getTime() < cutoff.getTime()) {
          records.delete(digest);
          deleted += 1;
          if (limited && deleted >= limit) break;
        }
      }
      return deleted;
    },
  };
}

export interface ConsumeAdminJtiInput {
  jti: string;
  expiresAt: Date;
  now: Date;
}

export interface AdminConsumedJtiStore {
  consume(input: ConsumeAdminJtiInput): Promise<boolean>;
  deleteExpiredBefore?(cutoff: Date, options?: { limit?: number }): Promise<number>;
}

const MAX_IN_MEMORY_CONSUMED_JTIS = 10_000;

export function createPostgresAdminConsumedJtiStore(
  query: PostgresQueryFn,
  schema: string,
): AdminConsumedJtiStore {
  const table = qualifiedTable(schema, ADMIN_LOGIN_CONSUMED_JTIS_TABLE);
  const consumeSql =
    `INSERT INTO ${table} (jti, expires_at) VALUES ($1, $2) ` +
    `ON CONFLICT (jti) DO UPDATE SET expires_at = EXCLUDED.expires_at ` +
    `WHERE ${table}.expires_at <= $3 RETURNING jti`;
  const deleteExpiredSql = `DELETE FROM ${table} WHERE expires_at < $1`;
  const deleteExpiredLimitedSql =
    `DELETE FROM ${table} WHERE jti IN (SELECT jti FROM ${table} WHERE expires_at < $1 LIMIT $2)`;

  return {
    async consume(input) {
      if (!isNonEmptyString(input.jti) || input.jti.trim() !== input.jti) {
        throw new Error("jti is required");
      }
      if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime())) {
        throw new Error("expiresAt must be a valid Date");
      }
      if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
        throw new Error("now must be a valid Date");
      }
      const result = await query(consumeSql, [input.jti, input.expiresAt, input.now]);
      return result.rows.length > 0;
    },

    async deleteExpiredBefore(cutoff, options) {
      if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime())) {
        throw new Error("cutoff must be a valid Date");
      }
      const limit = options?.limit;
      const limited = typeof limit === "number" && Number.isInteger(limit) && limit > 0;
      const result = limited
        ? await query(deleteExpiredLimitedSql, [cutoff, limit])
        : await query(deleteExpiredSql, [cutoff]);
      return typeof result.rowCount === "number" ? result.rowCount : result.rows.length;
    },
  };
}

export function createInMemoryAdminConsumedJtiStore(): AdminConsumedJtiStore {
  const consumed = new Map<string, Date>();

  return {
    async consume(input) {
      if (!isNonEmptyString(input.jti) || input.jti.trim() !== input.jti) {
        throw new Error("jti is required");
      }
      if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime())) {
        throw new Error("expiresAt must be a valid Date");
      }
      if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
        throw new Error("now must be a valid Date");
      }
      const nowMs = input.now.getTime();
      const existing = consumed.get(input.jti);
      if (existing !== undefined && existing.getTime() > nowMs) {
        return false;
      }
      if (consumed.size >= MAX_IN_MEMORY_CONSUMED_JTIS) {
        for (const [key, exp] of consumed.entries()) {
          if (exp.getTime() <= nowMs) {
            consumed.delete(key);
          }
        }
        if (consumed.size >= MAX_IN_MEMORY_CONSUMED_JTIS) {
          const oldestKey = consumed.keys().next().value;
          if (oldestKey !== undefined) consumed.delete(oldestKey);
        }
      }
      consumed.set(input.jti, input.expiresAt);
      return true;
    },

    async deleteExpiredBefore(cutoff, options) {
      if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime())) {
        throw new Error("cutoff must be a valid Date");
      }
      const limit = options?.limit;
      const limited = typeof limit === "number" && Number.isInteger(limit) && limit > 0;
      let deleted = 0;
      for (const [jti, exp] of consumed.entries()) {
        if (exp.getTime() < cutoff.getTime()) {
          consumed.delete(jti);
          deleted += 1;
          if (limited && deleted >= limit) break;
        }
      }
      return deleted;
    },
  };
}
