import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { PeriodType, SCHEMA_VERSION } from "../domain/enums.js";
import { calculatePeriodKey } from "../domain/time.js";
import { defaultLevelState } from "../domain/types.js";
import { renewSettlementLockForFinalize } from "../application/first-settlement-service.js";
import {
  rankingPeriodLockKey,
  rebuildSettlementWeekRanks,
} from "../application/settlement-item-application-service.js";
import type { AppRepository, UnitOfWork } from "./repositories.js";
import { CloudBaseAppRepository } from "./cloudbase-app-repository.js";
import {
  cloudBaseCollectionName,
  type CloudBaseDb,
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
import {
  JSONB_UTC_TIMESTAMPTZ_FUNCTION,
  buildPostgresSchemaPlan,
  qualifiedTable,
  quoteIdent,
} from "./postgres-schema.js";
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

function matches(): string {
  return cloudBaseCollectionName(NAMESPACE, "matches");
}

function rankings(): string {
  return cloudBaseCollectionName(NAMESPACE, "rankings");
}

function predictions(): string {
  return cloudBaseCollectionName(NAMESPACE, "predictions");
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
        release: (err?: Error) => client.release(err),
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
        release: (err?: Error) => client.release(err),
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
        release: (err?: Error) => client.release(err),
      };
    };
    db = createPostgresDocumentDb(queryFn, lockConfig, { connect });
    repo = new CloudBaseAppRepository(REPO_CONFIG, db);
    const lockPlan = buildPostgresSchemaPlan(NAMESPACE, LOCK_SCHEMA);
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(LOCK_SCHEMA)}`);
    for (const fn of lockPlan.functions) {
      await pool.query(fn.sql);
    }
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
    await repo.jobLocks.release("lock:round_1", "owner_a");
    await expect(repo.jobLocks.isHeldBy("lock:round_1", "owner_b", asOf())).resolves.toBe(true);
  });

  it("事务内 renew 持行锁到提交，期间 B acquire 阻塞且提交后返回 false", async () => {
    await pool.query(`TRUNCATE ${qualifiedTable(LOCK_SCHEMA, jobLocks())}`);
    const lockKey = "lock:row_fence";
    await expect(repo.jobLocks.acquire(lockKey, "owner_a", future())).resolves.toBe(true);

    let markRenewed!: () => void;
    const renewed = new Promise<void>((resolve) => {
      markRenewed = resolve;
    });
    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const holder = repo.withTransaction(async (tx) => {
      await expect(tx.jobLocks!.renew(lockKey, "owner_a", future())).resolves.toBe(true);
      markRenewed();
      await hold;
    });
    await renewed;

    let acquireSettled = false;
    const acquireByB = repo.jobLocks.acquire(lockKey, "owner_b", future()).then((value) => {
      acquireSettled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(acquireSettled).toBe(false);

    releaseHold();
    await holder;
    await expect(acquireByB).resolves.toBe(false);
  });

  it("Finalize 围栏拒绝已被接管的 owner，合法 owner 可在事务内续租", async () => {
    await pool.query(`TRUNCATE ${qualifiedTable(LOCK_SCHEMA, jobLocks())}`);
    const lockKey = "lock:finalize_fence";
    await expect(repo.jobLocks.acquire(lockKey, "owner_b", future())).resolves.toBe(true);
    await expect(repo.withTransaction((tx) =>
      renewSettlementLockForFinalize(tx, lockKey, "owner_a"),
    )).rejects.toMatchObject({ code: "SETTLEMENT_ALREADY_RUNNING" });
    await expect(repo.withTransaction((tx) =>
      renewSettlementLockForFinalize(tx, lockKey, "owner_b"),
    )).resolves.toBeUndefined();
  });
});

describe.skipIf(!ENABLED)("PostgresDocumentDb 预测历史分页 superseded_by 语义", () => {
  const HIST_SCHEMA = "football_vps03_pred_hist";
  const histConfig = { schema: HIST_SCHEMA, namespace: NAMESPACE };
  let pool!: pg.Pool;
  let db!: PostgresDocumentDb;

  function matchDoc(id: string, extra: Record<string, unknown> = {}): CloudBaseDocument {
    return {
      _id: id,
      match_id: id,
      canonical_match_id: id,
      league_id: "premier_league",
      season_id: "2026_2027",
      ...extra,
    };
  }

  function predictionDoc(id: string, matchId: string): CloudBaseDocument {
    return {
      _id: id,
      prediction_id: id,
      user_id: "u-hist",
      match_id: matchId,
      canonical_match_id: matchId,
      submitted_at: NOW,
    };
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
    const queryFn = createPostgresQueryFn(pool);
    const connect: PostgresConnectFn = async () => {
      const client = await pool.connect();
      return {
        query: createPostgresQueryFn(client),
        release: (err?: Error) => client.release(err),
      };
    };
    db = createPostgresDocumentDb(queryFn, histConfig, { connect });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(HIST_SCHEMA)}`);
    await pool.query(
      `CREATE OR REPLACE FUNCTION ${qualifiedTable(HIST_SCHEMA, JSONB_UTC_TIMESTAMPTZ_FUNCTION)}(value text) RETURNS timestamptz LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET timezone TO 'UTC' AS $jsonb_utc_timestamptz$ SELECT $1::timestamptz $jsonb_utc_timestamptz$`,
    );
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable(HIST_SCHEMA, matches())} (_id text PRIMARY KEY, document jsonb NOT NULL)`,
    );
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable(HIST_SCHEMA, predictions())} (_id text PRIMARY KEY, document jsonb NOT NULL)`,
    );
  });

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(HIST_SCHEMA)} CASCADE`);
    await pool.end();
  });

  it("缺少或 JSON null 的 superseded_by 查出预测，字符串 id 排除", async () => {
    await pool.query(`TRUNCATE ${qualifiedTable(HIST_SCHEMA, matches())}`);
    await pool.query(`TRUNCATE ${qualifiedTable(HIST_SCHEMA, predictions())}`);

    const missing = matchDoc("m-missing");
    expect("superseded_by" in missing).toBe(false);
    await db.add(matches(), "m-missing", missing);
    await db.add(matches(), "m-null", matchDoc("m-null", { superseded_by: null }));
    await db.add(matches(), "m-superseded", matchDoc("m-superseded", { superseded_by: "m-other" }));
    await db.add(predictions(), "p-missing", predictionDoc("p-missing", "m-missing"));
    await db.add(predictions(), "p-null", predictionDoc("p-null", "m-null"));
    await db.add(predictions(), "p-superseded", predictionDoc("p-superseded", "m-superseded"));

    const storedMissing = await pool.query(
      `SELECT document FROM ${qualifiedTable(HIST_SCHEMA, matches())} WHERE _id = $1`,
      ["m-missing"],
    );
    expect(storedMissing.rows[0]?.document).not.toHaveProperty("superseded_by");

    const rows = await db.findPredictionHistoryPage({
      predictions_collection: predictions(),
      matches_collection: matches(),
      user_id: "u-hist",
      league_id: null,
      season_id: null,
      cursor: null,
      limit: 20,
    });
    expect(rows.documents.map((row) => row.prediction_id).sort()).toEqual(["p-missing", "p-null"]);
  });
});

describe.skipIf(!ENABLED)("Postgres ranking global_rank 原子局部更新 Slice 1", () => {
  const RANK_SCHEMA = "football_vps03_ranking";
  const rankConfig = { schema: RANK_SCHEMA, namespace: NAMESPACE };
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
        release: (err?: Error) => client.release(err),
      };
    };
    db = createPostgresDocumentDb(queryFn, rankConfig, { connect });
    repo = new CloudBaseAppRepository(REPO_CONFIG, db);
    const rankPlan = buildPostgresSchemaPlan(NAMESPACE, RANK_SCHEMA);
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(RANK_SCHEMA)}`);
    for (const fn of rankPlan.functions) {
      await pool.query(fn.sql);
    }
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable(RANK_SCHEMA, rankings())} (_id text PRIMARY KEY, document jsonb NOT NULL)`,
    );
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${qualifiedTable(RANK_SCHEMA, jobLocks())} (_id text PRIMARY KEY, document jsonb NOT NULL)`,
    );
    await pool.query(`TRUNCATE ${qualifiedTable(RANK_SCHEMA, rankings())}`);
    await pool.query(`TRUNCATE ${qualifiedTable(RANK_SCHEMA, jobLocks())}`);
  });

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(RANK_SCHEMA)} CASCADE`);
    await pool.end();
  });

  it("updateGlobalRank 只改 global_rank/updated_at，保留积分、有效场次与命中", async () => {
    await pool.query(`TRUNCATE ${qualifiedTable(RANK_SCHEMA, rankings())}`);
    await repo.rankings.insert({
      schema_version: 1,
      period_type: "week",
      period_key: "2026-W32",
      user_id: "u1",
      period_score: 12,
      valid_predictions: 3,
      wdl_hits: 2,
      exact_hits: 1,
      last_scoring_match_at: NOW,
      global_rank: null,
      is_final: false,
      created_at: NOW,
      updated_at: NOW,
    });
    const updatedAt = new Date(NOW.getTime() + 60_000);
    await repo.rankings.updateGlobalRank!("week", "2026-W32", "u1", 2, updatedAt);

    const after = await repo.rankings.findByPeriodAndUser("week", "2026-W32", "u1");
    expect(after).toMatchObject({
      period_score: 12,
      valid_predictions: 3,
      wdl_hits: 2,
      exact_hits: 1,
      global_rank: 2,
    });
    expect(after?.last_scoring_match_at).toBeInstanceOf(Date);
    expect(after?.last_scoring_match_at?.getTime()).toBe(NOW.getTime());
    expect(after?.updated_at.getTime()).toBe(updatedAt.getTime());

    await repo.rankings.updateGlobalRank!("week", "2026-W32", "u1", null, updatedAt);
    const cleared = await repo.rankings.findByPeriodAndUser("week", "2026-W32", "u1");
    expect(cleared).toMatchObject({
      period_score: 12,
      valid_predictions: 3,
      wdl_hits: 2,
      exact_hits: 1,
      global_rank: null,
    });
  });

  it("并发应用先写入积分后，rank 局部 patch 不覆盖积分/有效场次/精确命中", async () => {
    await pool.query(`TRUNCATE ${qualifiedTable(RANK_SCHEMA, rankings())}`);
    await repo.rankings.insert({
      schema_version: 1,
      period_type: "week",
      period_key: "2026-W32",
      user_id: "concurrent",
      period_score: 12,
      valid_predictions: 3,
      wdl_hits: 2,
      exact_hits: 1,
      last_scoring_match_at: NOW,
      global_rank: null,
      is_final: false,
      created_at: NOW,
      updated_at: NOW,
    });
    const stored = (await db.query(rankings(), {
      period_type: "week",
      period_key: "2026-W32",
      user_id: "concurrent",
    }))[0]!;
    const id = String(stored._id);
    const appliedAt = new Date(NOW.getTime() + 30_000);
    const rankAt = new Date(NOW.getTime() + 60_000);

    let markApplied!: () => void;
    const applied = new Promise<void>((resolve) => {
      markApplied = resolve;
    });
    let releaseTransaction!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    const transactionA = db.transaction(async (tx) => {
      await tx.patch!(rankings(), id, {
        period_score: 24,
        valid_predictions: 4,
        wdl_hits: 3,
        exact_hits: 2,
        last_scoring_match_at: appliedAt,
      });
      markApplied();
      await hold;
    });

    let transactionBSettled = false;
    let transactionB: Promise<void> | undefined;
    try {
      await applied;
      // B 在独立连接发起，只写排名；A 未提交前应被行锁阻塞。
      transactionB = repo.rankings.updateGlobalRank!(
        "week",
        "2026-W32",
        "concurrent",
        1,
        rankAt,
      ).then(() => {
        transactionBSettled = true;
      });
      const earlyOutcome = await Promise.race([
        transactionB.then(() => "settled" as const),
        new Promise<"pending">((resolve) => {
          setTimeout(() => resolve("pending"), 150);
        }),
      ]);
      expect(earlyOutcome).toBe("pending");
      expect(transactionBSettled).toBe(false);
    } finally {
      releaseTransaction();
      await transactionA.catch(() => undefined);
      if (transactionB !== undefined) {
        await transactionB.catch(() => undefined);
      }
    }
    await transactionB!;

    const after = await repo.rankings.findByPeriodAndUser("week", "2026-W32", "concurrent");
    expect(after).toMatchObject({
      period_score: 24,
      valid_predictions: 4,
      wdl_hits: 3,
      exact_hits: 2,
      global_rank: 1,
    });
    expect(after?.last_scoring_match_at?.getTime()).toBe(appliedAt.getTime());
    expect(after?.updated_at.getTime()).toBe(rankAt.getTime());
  });

  it("rank 事务 ABORTED 后不触发 25P02 掩盖原始错误，且锁在事务外释放", async () => {
    await pool.query(`TRUNCATE ${qualifiedTable(RANK_SCHEMA, rankings())}`);
    await pool.query(`TRUNCATE ${qualifiedTable(RANK_SCHEMA, jobLocks())}`);
    await repo.rankings.insert({
      schema_version: 1,
      period_type: "week",
      period_key: "2026-W32",
      user_id: "abort",
      period_score: 12,
      valid_predictions: 3,
      wdl_hits: 2,
      exact_hits: 1,
      last_scoring_match_at: NOW,
      global_rank: null,
      is_final: false,
      created_at: NOW,
      updated_at: NOW,
    });
    const anchor = new Date("2026-08-08T14:00:00.000Z");
    const periodKey = calculatePeriodKey(PeriodType.Week, anchor);
    const expectedLockKey = rankingPeriodLockKey(PeriodType.Week, periodKey);
    const rankBoom = new Error("rank original boom");
    const wrapped = Object.create(repo) as AppRepository;
    Object.defineProperty(wrapped, "withTransaction", {
      value: (fn: (tx: UnitOfWork) => Promise<unknown>) =>
        repo.withTransaction((tx) => {
          const failingTx = new Proxy(tx, {
            get(txTarget, txProp, txReceiver) {
              if (txProp === "rankings") {
                return {
                  ...Reflect.get(txTarget, txProp, txReceiver),
                  updateGlobalRank: async () => {
                    const txDb = (tx as unknown as { db: CloudBaseDb }).db;
                    try {
                      await txDb.query("missing_rank_table");
                      throw new Error("expected missing collection query to fail");
                    } catch (error) {
                      expect((error as { code?: string }).code).toBe("42P01");
                    }
                    throw rankBoom;
                  },
                };
              }
              return Reflect.get(txTarget, txProp, txReceiver);
            },
          });
          return fn(failingTx);
        }),
    });

    await expect(
      rebuildSettlementWeekRanks(wrapped, anchor, new Date()),
    ).rejects.toBe(rankBoom);
    await expect(repo.jobLocks.isHeld(expectedLockKey, new Date())).resolves.toBe(false);

    // 连接未停留在 aborted 状态。
    const probeId = "week|2026-W32|healthy-probe";
    await db.transaction(async (tx) => {
      await tx.add(rankings(), probeId, {
        _id: probeId,
        schema_version: 1,
        period_type: "week",
        period_key: "2026-W32",
        user_id: "healthy-probe",
        period_score: 0,
        valid_predictions: 0,
        wdl_hits: 0,
        exact_hits: 0,
        last_scoring_match_at: null,
        global_rank: null,
        is_final: false,
        created_at: NOW,
        updated_at: NOW,
      });
    });
    await expect(db.get(rankings(), probeId)).resolves.toMatchObject({ _id: probeId });
  });
});
