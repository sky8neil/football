import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { SCHEMA_VERSION, UserStatus } from "../domain/enums.js";
import { defaultLevelState, type User } from "../domain/types.js";
import {
  createPostgresAppRepository,
  createPostgresDocumentDbFromPool,
} from "../gateway/repository-factory.js";
import { createPostgresAuthSessionStore } from "../infrastructure/postgres-auth-sessions.js";
import { createPostgresQueryFn } from "../infrastructure/postgres-document-db.js";
import {
  AUTH_SESSIONS_TABLE,
  buildPostgresSchemaPlan,
  postgresSchemaStatements,
  qualifiedTable,
  quoteIdent,
} from "../infrastructure/postgres-schema.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";
import { ProfileMutationService } from "./profile-mutation.js";
import { SessionService } from "./session.js";

const DATABASE_URL = process.env.FOOTBALL_TEST_DATABASE_URL ?? "";
const ENABLED = DATABASE_URL.length > 0;
const SCHEMA = "football_slice3_delete_session_race";
const NAMESPACE = "s3dsr";
const NOW = new Date("2026-08-09T12:00:00.000Z");
const LATER = new Date(NOW.getTime() + 1000);
const USER_ID = "00000000-0000-4000-8000-0000000003a1";
const OPENID = "wx-openid-slice3-race";
const OTHER_USER_ID = "00000000-0000-4000-8000-0000000003a2";
const OTHER_OPENID = "wx-openid-slice3-race-other";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeUser(userId: string, openid: string): User {
  return {
    schema_version: SCHEMA_VERSION,
    user_id: userId,
    openid,
    unionid: null,
    nickname: "Race",
    favorite_team_id: null,
    status: UserStatus.Active,
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_last_scoring_match_at: null,
    career_level: 1,
    career_best_level: 1,
    career_level_state: defaultLevelState(),
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

interface PausedDelete {
  repo: AppRepository;
  sessionsDeleted: Promise<void>;
  release: () => void;
}

function pauseAfterSessionDeletion(repo: AppRepository): PausedDelete {
  let markSessionsDeleted!: () => void;
  let release!: () => void;
  const sessionsDeleted = new Promise<void>((resolve) => {
    markSessionsDeleted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrappedRepo = new Proxy(repo, {
    get(target, property, receiver) {
      if (property !== "withTransaction") {
        return Reflect.get(target, property, receiver);
      }
      return async <T>(work: (tx: UnitOfWork) => Promise<T>): Promise<T> =>
        target.withTransaction(async (tx) => {
          const revoker = tx.authSessions;
          if (revoker === undefined) return work(tx);
          const wrappedTx = new Proxy(tx, {
            get(txTarget, txProperty, txReceiver) {
              if (txProperty !== "authSessions") {
                return Reflect.get(txTarget, txProperty, txReceiver);
              }
              return {
                deleteByOpenid: async (openid: string) => {
                  const removed = await revoker.deleteByOpenid(openid);
                  markSessionsDeleted();
                  await gate;
                  return removed;
                },
              };
            },
          });
          return work(wrappedTx);
        });
    },
  });
  return { repo: wrappedRepo, sessionsDeleted, release };
}

async function activeSessionCount(pool: pg.Pool, openid: string): Promise<number> {
  const result = await pool.query(
    `SELECT count(*)::int AS count FROM ${qualifiedTable(SCHEMA, AUTH_SESSIONS_TABLE)} WHERE openid = $1`,
    [openid],
  );
  return Number(result.rows[0]?.count ?? 0);
}

describe.skipIf(!ENABLED)("注销与微信会话签发竞态 PostgreSQL", () => {
  let pool!: pg.Pool;
  let repo!: AppRepository;
  let sessions!: ReturnType<typeof createPostgresAuthSessionStore>;

  beforeAll(async () => {
    const database = new URL(DATABASE_URL).pathname.replace(/^\//, "");
    if (database !== "football_test") {
      throw new Error(`refusing database ${database}`);
    }
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      max: 4,
      connectionTimeoutMillis: 500,
    });
    const current = await pool.query("SELECT current_database() AS name");
    if (current.rows[0]?.name !== "football_test") {
      throw new Error(`connected to ${String(current.rows[0]?.name)}`);
    }
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(SCHEMA)} CASCADE`);
    const plan = buildPostgresSchemaPlan(NAMESPACE, SCHEMA);
    for (const statement of postgresSchemaStatements(plan)) {
      await pool.query(statement);
    }
    const postgres = {
      database_url: DATABASE_URL,
      database_schema: SCHEMA,
      resource_namespace: NAMESPACE,
    };
    repo = createPostgresAppRepository(
      pool,
      postgres,
      createPostgresDocumentDbFromPool(pool, postgres),
    );
    sessions = createPostgresAuthSessionStore(createPostgresQueryFn(pool), SCHEMA);
  });

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(SCHEMA)} CASCADE`);
    await pool.end();
  });

  it("注销删除会话后、提交前，独立 create 必须等待；提交后允许微信重登录并重注册", async () => {
    const user = makeUser(USER_ID, OPENID);
    await repo.users.insert(user);
    const oldSession = await sessions.create({ openid: OPENID, now: NOW, ttlSeconds: 60 });

    const paused = pauseAfterSessionDeletion(repo);
    const deletion = new ProfileMutationService(paused.repo).deleteMyProfile(USER_ID, NOW);
    await paused.sessionsDeleted;

    const creating = sessions.create({ openid: OPENID, now: NOW, ttlSeconds: 60 });
    let createSettled = false;
    void creating.finally(() => {
      createSettled = true;
    }).catch(() => undefined);

    try {
      await delay(200);
      expect(createSettled).toBe(false);
      expect(await activeSessionCount(pool, OPENID)).toBe(1);
    } finally {
      paused.release();
      await deletion.catch(() => undefined);
    }
    await expect(deletion).resolves.toEqual({ user_id: USER_ID, deleted: true });
    const issued = await creating;

    await expect(
      sessions.findActiveByToken({ token: oldSession.token, now: NOW }),
    ).resolves.toBeNull();
    await expect(
      sessions.findActiveByToken({ token: issued.token, now: NOW }),
    ).resolves.toMatchObject({ openid: OPENID });

    const reregistered = await new SessionService(repo).init(
      { openid: OPENID, nickname: "Reregistered" },
      LATER,
    );
    expect(reregistered.created).toBe(true);
    expect(reregistered.user.user_id).not.toBe(USER_ID);
    expect(reregistered.user.status).toBe(UserStatus.Active);
    await expect(repo.users.findByOpenid(OPENID)).resolves.toMatchObject({
      user_id: reregistered.user.user_id,
      status: UserStatus.Active,
    });
  });

  it("独立 create 先持有 openid 锁时，注销会话删除等待其提交后再清除该会话", async () => {
    const user = makeUser(OTHER_USER_ID, OTHER_OPENID);
    await repo.users.insert(user);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const txSessions = createPostgresAuthSessionStore(createPostgresQueryFn(client), SCHEMA);
      const created = await txSessions.create({
        openid: OTHER_OPENID,
        now: NOW,
        ttlSeconds: 60,
      });

      const deletion = new ProfileMutationService(repo).deleteMyProfile(OTHER_USER_ID, NOW);
      let deletionSettled = false;
      void deletion.finally(() => {
        deletionSettled = true;
      }).catch(() => undefined);

      await delay(200);
      expect(deletionSettled).toBe(false);

      await client.query("COMMIT");
      await expect(deletion).resolves.toEqual({ user_id: OTHER_USER_ID, deleted: true });
      await expect(
        sessions.findActiveByToken({ token: created.token, now: NOW }),
      ).resolves.toBeNull();
    } finally {
      client.release();
    }
  });
});
