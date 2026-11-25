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
  buildPostgresSchemaPlan,
  postgresSchemaStatements,
  quoteIdent,
} from "../infrastructure/postgres-schema.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { ProfileMutationService } from "./profile-mutation.js";

const DATABASE_URL = process.env.FOOTBALL_TEST_DATABASE_URL ?? "";
const ENABLED = DATABASE_URL.length > 0;
const SCHEMA = "football_profile_mutation_tx";
const NAMESPACE = "pmt";
const NOW = new Date("2026-08-09T12:00:00.000Z");
const USER_ID = "00000000-0000-4000-8000-0000000000a1";
const ROLLBACK_OPENID = "wx-openid-rollback";

function makeUser(): User {
  return {
    schema_version: SCHEMA_VERSION,
    user_id: USER_ID,
    openid: "wx-openid-profile-delete",
    unionid: "unionid-profile-delete",
    nickname: "Sky",
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

describe.skipIf(!ENABLED)("ProfileMutationService PostgreSQL 注销事务", () => {
  let pool!: pg.Pool;
  let repo!: AppRepository;
  let sessions!: ReturnType<typeof createPostgresAuthSessionStore>;

  beforeAll(async () => {
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 500,
    });
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

  it("注销在业务事务同一连接内删除 auth_sessions（pool=1 不死锁）", async () => {
    const user = makeUser();
    await repo.users.insert(user);
    const session = await sessions.create({ openid: user.openid, now: NOW, ttlSeconds: 60 });

    await expect(
      new ProfileMutationService(repo, { authSessions: sessions })
        .deleteMyProfile(user.user_id, NOW),
    ).resolves.toEqual({ user_id: user.user_id, deleted: true });

    await expect(
      sessions.findActiveByToken({ token: session.token, now: NOW }),
    ).resolves.toBeNull();
    await expect(repo.users.findById(user.user_id)).resolves.toMatchObject({
      status: UserStatus.Deleted,
      openid: `deleted:${user.user_id}`,
    });
  });

  it("auth_sessions 删除在业务事务回滚后恢复可见", async () => {
    const session = await sessions.create({
      openid: ROLLBACK_OPENID,
      now: NOW,
      ttlSeconds: 60,
    });

    await expect(repo.withTransaction(async (tx) => {
      if (tx.authSessions === undefined) {
        throw new Error("transaction authSessions port is missing");
      }
      await expect(tx.authSessions.deleteByOpenid(ROLLBACK_OPENID)).resolves.toBe(1);
      throw new Error("abort profile deletion");
    })).rejects.toThrow("abort profile deletion");

    await expect(
      sessions.findActiveByToken({ token: session.token, now: NOW }),
    ).resolves.toMatchObject({ openid: ROLLBACK_OPENID });
  });
});
