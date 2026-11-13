import pg from "pg";
import {
  createPostgresAuthSessionStore,
  type AuthSessionStore,
} from "../infrastructure/postgres-auth-sessions.js";
import type { CloudBaseDb } from "../infrastructure/cloudbase-db.js";
import { createPostgresQueryFn } from "../infrastructure/postgres-document-db.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import type { PostgresRepositoryConfig } from "../gateway/config.js";
import {
  createPostgresAppRepository,
  createPostgresDocumentDbFromPool,
} from "../gateway/repository-factory.js";
import { createWechatCode2SessionHttp } from "../gateway/wechat-http.js";
import type { WechatCode2SessionHttp } from "../gateway/wechat-login.js";

export interface VpsRuntime {
  db: CloudBaseDb;
  repo: AppRepository;
  sessions: AuthSessionStore;
  wechatHttp: WechatCode2SessionHttp;
  healthCheck(): Promise<boolean>;
  close(): Promise<void>;
}

export interface CreateVpsRuntimeInput {
  postgres: PostgresRepositoryConfig;
  wechatHttp?: WechatCode2SessionHttp;
}

export function createVpsRuntime(input: CreateVpsRuntimeInput): VpsRuntime {
  const pool = new pg.Pool({ connectionString: input.postgres.database_url });
  const query = createPostgresQueryFn(pool);
  const db = createPostgresDocumentDbFromPool(pool, input.postgres);
  const repo = createPostgresAppRepository(pool, input.postgres, db);
  const sessions = createPostgresAuthSessionStore(query, input.postgres.database_schema);
  const wechatHttp = input.wechatHttp ?? createWechatCode2SessionHttp();
  let closed = false;

  return {
    db,
    repo,
    sessions,
    wechatHttp,
    async healthCheck() {
      if (closed) return false;
      try {
        await pool.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}
