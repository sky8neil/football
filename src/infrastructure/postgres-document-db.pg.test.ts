import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { SCHEMA_VERSION } from "../domain/enums.js";
import { defaultLevelState } from "../domain/types.js";
import { CloudBaseAppRepository } from "./cloudbase-app-repository.js";
import {
  cloudBaseCollectionName,
  type CloudBaseDocument,
  type CloudBaseRepositoryConfig,
} from "./cloudbase-db.js";
import { CloudBaseProviderUsageStore } from "./cloudbase-provider-usage.js";
import {
  createPostgresDocumentDb,
  createPostgresQueryFn,
  type PostgresConnectFn,
  type PostgresDocumentDb,
} from "./postgres-document-db.js";
import { qualifiedTable, quoteIdent } from "./postgres-schema.js";
import { usageBucketId, type ProviderUsageBucket } from "../provider/budget.js";

const DATABASE_URL = process.env.FOOTBALL_TEST_DATABASE_URL ?? "";
const ENABLED = DATABASE_URL.length > 0;
const SCHEMA = "football_vps03_tx";
const NAMESPACE = "ft";
const CONFIG = { schema: SCHEMA, namespace: NAMESPACE };
const REPO_CONFIG: CloudBaseRepositoryConfig = {
  cloud_environment_id: "unused",
  resource_namespace: NAMESPACE,
};
const NOW = new Date("2026-08-09T12:00:00.000Z");

function users(): string {
  return cloudBaseCollectionName(NAMESPACE, "users");
}

function usage(): string {
  return cloudBaseCollectionName(NAMESPACE, "provider_usage");
}

function jobLocks(): string {
  return cloudBaseCollectionName(NAMESPACE, "job_locks");
}

function userDoc(id: string): CloudBaseDocument {
  return {
    _id: id,
    user_id: id,
    openid: `openid-${id}`,
    unionid: null,
    nickname: id,
    favorite_team_id: null,
    status: "active",
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_last_scoring_match_at: null,
    career_level: 1,
    career_best_level: 1,
    career_level_state: { ...defaultLevelState(), week_base_as_of: NOW },
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    schema_version: 1,
  };
}

describe.skipIf(!ENABLED)("PostgresDocumentDb 真实事务与保存点 §6.2", () => {
  let pool!: pg.Pool;
  let db!: PostgresDocumentDb;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
    const queryFn = createPostgresQueryFn(pool);
    const connect: PostgresConnectFn = async () => {
      const client = await pool.connect();
      return {
        query: createPostgresQueryFn(client),
        release: () => client.release(),
      };
    };
    db = createPostgresDocumentDb(queryFn, CONFIG, { connect });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(SCHEMA)}`);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable(SCHEMA, users())} (_id text PRIMARY KEY, document jsonb NOT NULL)`,
    );
    await pool.query(`TRUNCATE ${qualifiedTable(SCHEMA, users())}`);
  });

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(SCHEMA)} CASCADE`);
    await pool.end();
  });

  it("正常事务提交后外层可见", async () => {
    await pool.query(`TRUNCATE ${qualifiedTable(SCHEMA, users())}`);
    await db.transaction(async (tx) => {
      await tx.add(users(), "commit-a", userDoc("commit-a"));
      await expect(tx.get(users(), "commit-a")).resolves.toMatchObject({ _id: "commit-a" });
    });
    await expect(db.get(users(), "commit-a")).resolves.toMatchObject({ _id: "commit-a" });
  });

  it("业务异常回滚后写入不存在", async () => {
    await pool.query(`TRUNCATE ${qualifiedTable(SCHEMA, users())}`);
    await expect(db.transaction(async (tx) => {
      await tx.add(users(), "rollback-a", userDoc("rollback-a"));
      throw new Error("abort");
    })).rejects.toThrow("abort");
    await expect(db.get(users(), "rollback-a")).resolves.toBeNull();
  });

  it("保存点局部回滚：外层 A/C 保留，内层 B 不存在", async () => {
    await pool.query(`TRUNCATE ${qualifiedTable(SCHEMA, users())}`);
    await db.transaction(async (outer) => {
      await outer.add(users(), "keep-a", userDoc("keep-a"));
      await expect(outer.transaction(async (inner) => {
        await inner.add(users(), "drop-b", userDoc("drop-b"));
        await expect(inner.get(users(), "drop-b")).resolves.toMatchObject({ _id: "drop-b" });
        throw new Error("savepoint abort");
      })).rejects.toThrow("savepoint abort");
      await expect(outer.get(users(), "drop-b")).resolves.toBeNull();
      await outer.add(users(), "keep-c", userDoc("keep-c"));
    });
    await expect(db.get(users(), "keep-a")).resolves.toMatchObject({ _id: "keep-a" });
    await expect(db.get(users(), "drop-b")).resolves.toBeNull();
    await expect(db.get(users(), "keep-c")).resolves.toMatchObject({ _id: "keep-c" });
  });
});

describe.skipIf(!ENABLED)("PostgresDocumentDb 额度计数 §6.2", () => {
  const QUOTA_SCHEMA = "football_vps03_quota";
  const quotaConfig = { schema: QUOTA_SCHEMA, namespace: NAMESPACE };
  let pool!: pg.Pool;
  let db!: PostgresDocumentDb;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
    const queryFn = createPostgresQueryFn(pool);
    const connect: PostgresConnectFn = async () => {
      const client = await pool.connect();
      return {
        query: createPostgresQueryFn(client),
        release: () => client.release(),
      };
    };
    db = createPostgresDocumentDb(queryFn, quotaConfig, { connect });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(QUOTA_SCHEMA)}`);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable(QUOTA_SCHEMA, usage())} (_id text PRIMARY KEY, document jsonb NOT NULL)`,
    );
    await pool.query(`TRUNCATE ${qualifiedTable(QUOTA_SCHEMA, usage())}`);
  });

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(QUOTA_SCHEMA)} CASCADE`);
    await pool.end();
  });

  it("reserveCounter 达上限返回 false，adjustCounter/getCounter 按配额 store 规则扣减", async () => {
    await pool.query(`TRUNCATE ${qualifiedTable(QUOTA_SCHEMA, usage())}`);
    const store = new CloudBaseProviderUsageStore(db, NAMESPACE);
    const bucket: ProviderUsageBucket = {
      source_id: "fd",
      bucket_type: "day",
      bucket_key: "2026-08-09",
      bucket_start: new Date("2026-08-09T00:00:00.000Z"),
      key_id: "fd#1",
    };
    await expect(store.reserve(bucket, 2, NOW)).resolves.toBe(true);
    await expect(store.reserve(bucket, 2, NOW)).resolves.toBe(true);
    await expect(store.reserve(bucket, 2, NOW)).resolves.toBe(false);
    await expect(store.read(bucket)).resolves.toBe(2);
    await store.release(bucket);
    await expect(store.read(bucket)).resolves.toBe(1);
    const id = usageBucketId(bucket);
    const document = await db.get(usage(), id);
    expect(document).toMatchObject({
      _id: id,
      source_id: "fd",
      request_count: 1,
      schema_version: SCHEMA_VERSION,
    });
    expect(document?.created_at).toBeInstanceOf(Date);
  });

  it("事务内 reserveCounter 失败后回滚额度", async () => {
    await pool.query(`TRUNCATE ${qualifiedTable(QUOTA_SCHEMA, usage())}`);
    const initial: CloudBaseDocument = {
      _id: "quota-tx",
      request_count: 0,
      created_at: NOW,
      updated_at: NOW,
      schema_version: 1,
    };
    await expect(db.transaction(async (tx) => {
      await expect(tx.reserveCounter?.(usage(), "quota-tx", "request_count", 5, initial)).resolves.toBe(true);
      throw new Error("abort quota");
    })).rejects.toThrow("abort quota");
    await expect(db.getCounter(usage(), "quota-tx", "request_count")).resolves.toBe(0);
  });
});

describe.skipIf(!ENABLED)("Postgres JobLock 获取/释放 §6.3", () => {
  const LOCK_SCHEMA = "football_vps03_lock";
  const lockConfig = { schema: LOCK_SCHEMA, namespace: NAMESPACE };
  const future = () => new Date(Date.now() + 60_000);
  const past = () => new Date(Date.now() - 60_000);
  const asOf = () => new Date();
  let pool!: pg.Pool;
  let db!: PostgresDocumentDb;
  let repo!: CloudBaseAppRepository;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
    const queryFn = createPostgresQueryFn(pool);
    const connect: PostgresConnectFn = async () => {
      const client = await pool.connect();
      return {
        query: createPostgresQueryFn(client),
        release: () => client.release(),
      };
    };
    db = createPostgresDocumentDb(queryFn, lockConfig, { connect });
    repo = new CloudBaseAppRepository(REPO_CONFIG, db);
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(LOCK_SCHEMA)}`);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable(LOCK_SCHEMA, jobLocks())} (_id text PRIMARY KEY, document jsonb NOT NULL)`,
    );
    await pool.query(`TRUNCATE ${qualifiedTable(LOCK_SCHEMA, jobLocks())}`);
  });

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(LOCK_SCHEMA)} CASCADE`);
    await pool.end();
  });

  it("acquire 成功后持锁期间再 acquire 失败，owner 释放后可再获取", async () => {
    await pool.query(`TRUNCATE ${qualifiedTable(LOCK_SCHEMA, jobLocks())}`);
    await expect(repo.jobLocks.acquire("lock:round_1", "owner_a", future())).resolves.toBe(true);
    await expect(repo.jobLocks.acquire("lock:round_1", "owner_b", future())).resolves.toBe(false);
    await expect(repo.jobLocks.isHeld("lock:round_1", asOf())).resolves.toBe(true);
    await expect(repo.jobLocks.isHeldBy("lock:round_1", "owner_a", asOf())).resolves.toBe(true);
    await repo.jobLocks.release("lock:round_1", "owner_b");
    await expect(repo.jobLocks.acquire("lock:round_1", "owner_c", future())).resolves.toBe(false);
    await repo.jobLocks.release("lock:round_1", "owner_a");
    await expect(repo.jobLocks.isHeld("lock:round_1", asOf())).resolves.toBe(false);
    await expect(repo.jobLocks.acquire("lock:round_1", "owner_b", future())).resolves.toBe(true);
  });

  it("lease 过期可被接管；仅 owner 且未过期可 renew", async () => {
    await pool.query(`TRUNCATE ${qualifiedTable(LOCK_SCHEMA, jobLocks())}`);
    await expect(repo.jobLocks.acquire("lock:round_1", "owner_a", past())).resolves.toBe(true);
    await expect(repo.jobLocks.renew("lock:round_1", "owner_a", future())).resolves.toBe(false);
    await expect(repo.jobLocks.acquire("lock:round_1", "owner_b", future())).resolves.toBe(true);
    await expect(repo.jobLocks.renew("lock:round_1", "owner_b", future())).resolves.toBe(true);
    await expect(repo.jobLocks.renew("lock:round_1", "owner_a", future())).resolves.toBe(false);
  });
});
