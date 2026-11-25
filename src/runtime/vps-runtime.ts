import {
  createPostgresAdminConsumedJtiStore,
  createPostgresAuthSessionStore,
  type AdminConsumedJtiStore,
  type AuthSessionStore,
} from "../infrastructure/postgres-auth-sessions.js";
import type { CloudBaseDb } from "../infrastructure/cloudbase-db.js";
import { createPostgresQueryFn } from "../infrastructure/postgres-document-db.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import type { PostgresRepositoryConfig } from "../gateway/config.js";
import {
  createPostgresAppRepository,
  createPostgresDocumentDbFromPool,
  createPostgresPool,
} from "../gateway/repository-factory.js";
import { createWechatCode2SessionHttp } from "../gateway/wechat-http.js";
import type { WechatCode2SessionHttp } from "../gateway/wechat-login.js";

export interface VpsRuntime {
  db: CloudBaseDb;
  repo: AppRepository;
  sessions: AuthSessionStore;
  adminConsumedJtis: AdminConsumedJtiStore;
  wechatHttp: WechatCode2SessionHttp;
  healthCheck(): Promise<boolean>;
  close(): Promise<void>;
}

export interface CreateVpsRuntimeInput {
  postgres: PostgresRepositoryConfig;
  wechatHttp?: WechatCode2SessionHttp;
  env?: Record<string, string | undefined>;
}

const HEALTH_CHECK_TTL_MS = 1_500;

export function createVpsRuntime(input: CreateVpsRuntimeInput): VpsRuntime {
  const pool = createPostgresPool(input.postgres.database_url, input.env);
  const query = createPostgresQueryFn(pool);
  const db = createPostgresDocumentDbFromPool(pool, input.postgres);
  const repo = createPostgresAppRepository(pool, input.postgres, db);
  const sessions = createPostgresAuthSessionStore(query, input.postgres.database_schema);
  const adminConsumedJtis = createPostgresAdminConsumedJtiStore(
    query,
    input.postgres.database_schema,
  );
  const wechatHttp = input.wechatHttp ?? createWechatCode2SessionHttp();
  let closed = false;
  let healthCache: { ok: boolean; expiresAt: number } | null = null;
  let healthInflight: Promise<boolean> | null = null;

  const readHealth = async (): Promise<boolean> => {
    let ok = false;
    try {
      await pool.query("SELECT 1");
      ok = true;
    } catch {
      ok = false;
    }
    if (closed) return false;
    healthCache = { ok, expiresAt: Date.now() + HEALTH_CHECK_TTL_MS };
    return ok;
  };

  return {
    db,
    repo,
    sessions,
    adminConsumedJtis,
    wechatHttp,
    healthCheck() {
      if (closed) return Promise.resolve(false);
      const now = Date.now();
      if (healthCache !== null && now < healthCache.expiresAt) {
        return Promise.resolve(healthCache.ok);
      }
      if (healthInflight !== null) return healthInflight;
      const pending = readHealth();
      healthInflight = pending;
      void pending.finally(() => {
        if (healthInflight === pending) healthInflight = null;
      }).catch(() => undefined);
      return pending;
    },
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}
