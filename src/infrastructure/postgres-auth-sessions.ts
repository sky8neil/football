import { randomBytes as nodeRandomBytes } from "node:crypto";
import {
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

export function createPostgresAuthSessionStore(
  query: PostgresQueryFn,
  schema: string,
  options: PostgresAuthSessionStoreOptions = {},
): AuthSessionStore {
  const generate = options.randomBytes ?? nodeRandomBytes;
  const table = qualifiedTable(schema, AUTH_SESSIONS_TABLE);
  const insertSql = `INSERT INTO ${table} (token, openid, expires_at) VALUES ($1, $2, $3)`;
  const selectSql =
    `SELECT token, openid, expires_at FROM ${table} WHERE token = $1 AND expires_at > $2`;

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
          await query(insertSql, [token, input.openid, expiresAt]);
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
      const result = await query(selectSql, [input.token, input.now]);
      const row = result.rows[0];
      if (row === undefined) return null;
      const token = row.token;
      const openid = row.openid;
      const expiresAt = asDate(row.expires_at);
      if (!isNonEmptyString(token) || !isNonEmptyString(openid) || expiresAt === null) {
        return null;
      }
      return { token, openid, expires_at: expiresAt };
    },
  };
}
