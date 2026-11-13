import { describe, expect, it } from "vitest";
import { GroupStatus, MatchStatus, Provider, SettlementStatus } from "../domain/enums.js";
import { defaultLevelState } from "../domain/types.js";
import type { Match, MatchProviderMapping, ProviderSnapshot } from "../domain/types.js";
import { CloudBaseAppRepository } from "./cloudbase-app-repository.js";
import {
  CloudBaseDocumentNotFoundError,
  CloudBaseDuplicateKeyError,
  cloudBaseCollectionName,
  type CloudBaseDocument,
  type CloudBaseRepositoryConfig,
} from "./cloudbase-db.js";
import { UniqueConstraintError } from "./repositories.js";
import { postgresDocumentFieldExpr } from "./postgres-schema.js";
import {
  POSTGRES_IN_OP,
  POSTGRES_LTE_OP,
  compilePostgresAdjustCounter,
  compilePostgresDocumentAdd,
  compilePostgresDocumentEnsure,
  compilePostgresDocumentGet,
  compilePostgresDocumentQuery,
  compilePostgresDocumentUpdate,
  compilePostgresReserveCounter,
  createPostgresDocumentDb,
  parseDocumentFilter,
  type PostgresConnectFn,
} from "./postgres-document-db.js";
import { encodeDocument } from "./document-codec.js";
import type { PostgresQueryFn, PostgresQueryResult } from "./postgres-schema.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const SCHEMA = "football_test";
const NAMESPACE = "ft";
const CONFIG = { schema: SCHEMA, namespace: NAMESPACE };
const REPO_CONFIG: CloudBaseRepositoryConfig = {
  cloud_environment_id: "unused",
  resource_namespace: NAMESPACE,
};

function users(): string {
  return cloudBaseCollectionName(NAMESPACE, "users");
}

function matches(): string {
  return cloudBaseCollectionName(NAMESPACE, "matches");
}

function predictions(): string {
  return cloudBaseCollectionName(NAMESPACE, "predictions");
}

function mappings(): string {
  return cloudBaseCollectionName(NAMESPACE, "match_provider_mappings");
}

function snapshots(): string {
  return cloudBaseCollectionName(NAMESPACE, "provider_snapshots");
}

function usage(): string {
  return cloudBaseCollectionName(NAMESPACE, "provider_usage");
}

function jobLocks(): string {
  return cloudBaseCollectionName(NAMESPACE, "job_locks");
}

function groups(): string {
  return cloudBaseCollectionName(NAMESPACE, "groups");
}

function uniqueViolation(constraint: string) {
  return Object.assign(new Error("duplicate key"), { code: "23505", constraint });
}

function userDoc(id = "u1"): CloudBaseDocument {
  return {
    _id: id,
    user_id: id,
    openid: `openid-${id}`,
    unionid: null,
    nickname: "Sky",
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

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    schema_version: 1,
    match_id: "m1",
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: "home",
    away_team_id: "away",
    kickoff_at: NOW,
    kickoff_confirmed: true,
    prediction_deadline_at: NOW,
    prediction_closed_at: null,
    period_anchor_at: null,
    match_status: MatchStatus.Scheduled,
    settlement_status: SettlementStatus.Pending,
    regular_home_score: null,
    regular_away_score: null,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 0,
    settled_result_version: 0,
    result_source: null,
    scoring_rule_version: "scoring_v1",
    finish_detected_at: null,
    settled_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  } as Match;
}

function makeMapping(index: number): MatchProviderMapping {
  return {
    schema_version: 1,
    match_id: `match-${index}`,
    provider: Provider.ApiFootball,
    provider_match_id: `ext-${index}`,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeSnapshot(snapshotId: string, eventType: ProviderSnapshot["event_type"], createdAt: Date): ProviderSnapshot {
  return {
    schema_version: 1,
    snapshot_id: snapshotId,
    provider: Provider.ApiFootball,
    entity_type: "match",
    entity_id: "m-1",
    provider_entity_id: "123",
    event_type: eventType,
    payload: {},
    created_at: createdAt,
  };
}

class RecordingQuery {
  statements: Array<{ sql: string; params?: unknown[] }> = [];
  responses: PostgresQueryResult[] = [];
  failWith: unknown = undefined;

  readonly query: PostgresQueryFn = async (sql, params) => {
    this.statements.push(params === undefined ? { sql } : { sql, params });
    if (this.failWith !== undefined) throw this.failWith;
    return this.responses.shift() ?? { rows: [] };
  };
}

describe("postgres document SQL compilation §6.2", () => {
  it("get/add/update 使用参数化主键读写，update 做 JSONB 字段合并", () => {
    const document = userDoc();
    expect(compilePostgresDocumentGet(CONFIG, users(), "u1")).toEqual({
      sql: `SELECT document FROM "${SCHEMA}"."${users()}" WHERE _id = $1`,
      params: ["u1"],
    });
    const added = compilePostgresDocumentAdd(CONFIG, users(), "u1", document);
    expect(added.sql).toBe(
      `INSERT INTO "${SCHEMA}"."${users()}" (_id, document) VALUES ($1, $2::jsonb)`,
    );
    expect(added.params[0]).toBe("u1");
    expect((added.params[1] as CloudBaseDocument).created_at).toBe(NOW.toISOString());
    expect((added.params[1] as CloudBaseDocument).career_last_scoring_match_at).toBeNull();

    const updated = compilePostgresDocumentUpdate(CONFIG, users(), "u1", {
      _id: "u1",
      nickname: "Moon",
      updated_at: NOW,
    });
    expect(updated.sql).toBe(
      `UPDATE "${SCHEMA}"."${users()}" SET document = document || $2::jsonb WHERE _id = $1 RETURNING _id`,
    );
    expect(updated.params[0]).toBe("u1");
    expect(updated.params[1]).toEqual({ nickname: "Moon", updated_at: NOW.toISOString() });
    expect((updated.params[1] as Record<string, unknown>)._id).toBeUndefined();
  });

  it("query 覆盖等值、null、Date、in、lte、排序和 limit/offset；count 走 COUNT", () => {
    const bound = new Date("2026-08-10T12:00:00.000Z");
    const query = compilePostgresDocumentQuery(
      CONFIG,
      matches(),
      {
        match_status: MatchStatus.Scheduled,
        finish_detected_at: null,
        ...{ kickoff_at: { [POSTGRES_LTE_OP]: bound } },
      },
      { order_by: "kickoff_at", direction: "desc", limit: 50, offset: 3 },
    );
    const kickoffExpr = postgresDocumentFieldExpr(SCHEMA, "matches", "kickoff_at");
    const statusExpr = postgresDocumentFieldExpr(SCHEMA, "matches", "match_status");
    expect(query.sql).toBe(
      `SELECT document FROM "${SCHEMA}"."${matches()}" WHERE ${statusExpr} = $1 AND (document -> 'finish_detected_at') = 'null'::jsonb AND ${kickoffExpr} <= $2::timestamptz ORDER BY ${kickoffExpr} DESC LIMIT $3 OFFSET $4`,
    );
    expect(query.params).toEqual([MatchStatus.Scheduled, bound.toISOString(), 50, 3]);

    const counted = compilePostgresDocumentQuery(
      CONFIG,
      predictions(),
      { match_id: "m1", derived_result: "HOME" },
      {},
      "count",
    );
    expect(counted.sql).toBe(
      `SELECT COUNT(*)::int AS count FROM "${SCHEMA}"."${predictions()}" WHERE ${postgresDocumentFieldExpr(SCHEMA, "predictions", "match_id")} = $1 AND ${postgresDocumentFieldExpr(SCHEMA, "predictions", "derived_result")} = $2`,
    );
    expect(counted.params).toEqual(["m1", "HOME"]);
    expect(counted.sql).not.toContain("SELECT document");
  });

  it("inFilter/lteFilter 返回中立描述，拒绝任意操作符", () => {
    const db = createPostgresDocumentDb(async () => ({ rows: [] }), CONFIG);
    expect(db.inFilter("provider_match_id", ["ext-1", "ext-2"])).toEqual({
      provider_match_id: { [POSTGRES_IN_OP]: ["ext-1", "ext-2"] },
    });
    expect(db.inFilter("provider_match_id", [])).toBeUndefined();
    expect(db.lteFilter("kickoff_at", NOW)).toEqual({
      kickoff_at: { [POSTGRES_LTE_OP]: NOW },
    });
    expect(parseDocumentFilter(db.inFilter("event_type", ["discovered", "result_observed"])!)).toEqual([
      { kind: "in", field: "event_type", values: ["discovered", "result_observed"] },
    ]);
    expect(() => parseDocumentFilter({ kickoff_at: { $gt: NOW } })).toThrow("unsupported query operator");
    expect(() => parseDocumentFilter({ "kickoff_at;drop": NOW })).toThrow("invalid query field");
  });

  it("in 查询编译为参数化 ANY，不拼接客户端 SQL", () => {
    const db = createPostgresDocumentDb(async () => ({ rows: [] }), CONFIG);
    const compiled = compilePostgresDocumentQuery(
      CONFIG,
      mappings(),
      { provider: Provider.ApiFootball, ...db.inFilter("provider_match_id", ["ext-1", "ext-2"])! },
    );
    expect(compiled.sql).toBe(
      `SELECT document FROM "${SCHEMA}"."${mappings()}" WHERE ${postgresDocumentFieldExpr(SCHEMA, "match_provider_mappings", "provider")} = $1 AND ${postgresDocumentFieldExpr(SCHEMA, "match_provider_mappings", "provider_match_id")} = ANY($2::text[])`,
    );
    expect(compiled.params).toEqual([Provider.ApiFootball, ["ext-1", "ext-2"]]);
    expect(compiled.sql).not.toContain("ext-1");
  });

  it("Date/int/bool 等值比较使用一致类型，不按文本排序", () => {
    const snapshot = compilePostgresDocumentQuery(
      CONFIG,
      cloudBaseCollectionName(NAMESPACE, "board_snapshots"),
      { board: "season", snapshot_at: NOW, is_final: true },
    );
    expect(snapshot.sql).toContain(
      `${postgresDocumentFieldExpr(SCHEMA, "board_snapshots", "snapshot_at")} = $2::timestamptz`,
    );
    expect(snapshot.sql).toContain(
      `${postgresDocumentFieldExpr(SCHEMA, "board_snapshots", "is_final")} = $3::boolean`,
    );
    expect(snapshot.params).toEqual(["season", NOW.toISOString(), true]);

    const settlement = compilePostgresDocumentQuery(
      CONFIG,
      cloudBaseCollectionName(NAMESPACE, "settlements"),
      { match_id: "m1", result_version: 2, rule_version: "scoring_v1" },
    );
    expect(settlement.sql).toContain(
      `${postgresDocumentFieldExpr(SCHEMA, "settlements", "result_version")} = $2::numeric`,
    );
    expect(settlement.params).toEqual(["m1", 2, "scoring_v1"]);
  });

  it("reserve/adjust counter 使用参数化 jsonb_set，字段名不拼接进 SQL 标识符", () => {
    const initial: CloudBaseDocument = { _id: "c1", request_count: 0 };
    const ensured = compilePostgresDocumentEnsure(CONFIG, usage(), "c1", initial);
    expect(ensured.sql).toBe(
      `INSERT INTO "${SCHEMA}"."${usage()}" (_id, document) VALUES ($1, $2::jsonb) ON CONFLICT (_id) DO NOTHING`,
    );
    expect(ensured.params[0]).toBe("c1");
    expect((ensured.params[1] as CloudBaseDocument).request_count).toBe(0);

    const reserved = compilePostgresReserveCounter(CONFIG, usage(), "c1", "request_count", 3);
    expect(reserved.sql).toBe(
      `UPDATE "${SCHEMA}"."${usage()}" SET document = jsonb_set(document, ARRAY[$2]::text[], to_jsonb(COALESCE((document ->> $2)::numeric, 0) + 1)) WHERE _id = $1 AND COALESCE((document ->> $2)::numeric, 0) < $3::numeric RETURNING _id`,
    );
    expect(reserved.params).toEqual(["c1", "request_count", 3]);

    const adjusted = compilePostgresAdjustCounter(CONFIG, usage(), "c1", "request_count", -1);
    expect(adjusted.sql).toBe(
      `UPDATE "${SCHEMA}"."${usage()}" SET document = jsonb_set(document, ARRAY[$2]::text[], to_jsonb(COALESCE((document ->> $2)::numeric, 0) + $3::numeric)) WHERE _id = $1 RETURNING _id`,
    );
    expect(adjusted.params).toEqual(["c1", "request_count", -1]);
    expect(() => compilePostgresReserveCounter(CONFIG, usage(), "c1", "request_count;drop", 1)).toThrow("invalid query field");
  });
});

describe("PostgresDocumentDb CRUD", () => {
  it("get 不存在返回 null，并把 schema date 恢复为 Date", async () => {
    const rec = new RecordingQuery();
    rec.responses.push({ rows: [] });
    rec.responses.push({ rows: [{ document: encodeDocument(userDoc()) }] });
    const db = createPostgresDocumentDb(rec.query, CONFIG);
    await expect(db.get(users(), "missing")).resolves.toBeNull();
    const loaded = await db.get(users(), "u1");
    expect(loaded?.created_at).toBeInstanceOf(Date);
    expect((loaded?.created_at as Date).getTime()).toBe(NOW.getTime());
    expect(loaded?.openid).toBe("openid-u1");
    expect(loaded?.career_last_scoring_match_at).toBeNull();
  });

  it("update 不存在抛 CloudBaseDocumentNotFoundError，主键冲突映射 DuplicateKey", async () => {
    const missing = new RecordingQuery();
    missing.responses.push({ rows: [] });
    const db = createPostgresDocumentDb(missing.query, CONFIG);
    await expect(db.update(users(), "missing", { _id: "missing", nickname: "x" }))
      .rejects.toBeInstanceOf(CloudBaseDocumentNotFoundError);

    const dup = new RecordingQuery();
    dup.failWith = uniqueViolation(`${users()}_pkey`);
    const dupDb = createPostgresDocumentDb(dup.query, CONFIG);
    await expect(dupDb.add(users(), "u1", userDoc())).rejects.toMatchObject({
      name: "CloudBaseDuplicateKeyError",
      collection: users(),
      indexName: "pk_document",
      key: { _id: "u1" },
    });
  });

  it("业务唯一索引冲突保留索引名，供仓储映射 UniqueConstraintError", async () => {
    const rec = new RecordingQuery();
    rec.failWith = uniqueViolation("uk_invite_code");
    const db = createPostgresDocumentDb(rec.query, CONFIG);
    const repo = new CloudBaseAppRepository(REPO_CONFIG, db);
    await expect(repo.groups.insert({
      schema_version: 1,
      group_id: "g2",
      owner_user_id: "u1",
      invite_code: "ABCDEFGH",
      status: GroupStatus.Active,
      member_count: 1,
      created_at: NOW,
      updated_at: NOW,
    })).rejects.toMatchObject({
      name: "UniqueConstraintError",
      collection: "groups",
      indexName: "uk_invite_code",
    });
    expect(rec.statements[0]?.sql).toContain(`INSERT INTO "${SCHEMA}"."${groups()}"`);
  });

  it("count 使用数据库 COUNT，不先取回全部文档", async () => {
    const rec = new RecordingQuery();
    rec.responses.push({ rows: [{ count: 3 }] });
    const db = createPostgresDocumentDb(rec.query, CONFIG);
    await expect(db.count(predictions(), { match_id: "m1", derived_result: "HOME" })).resolves.toBe(3);
    expect(rec.statements).toHaveLength(1);
    expect(rec.statements[0]?.sql.startsWith("SELECT COUNT(*)::int AS count")).toBe(true);
    expect(rec.statements[0]?.sql).not.toContain("SELECT document");
  });

  it("外层事务缺少独占连接工厂时拒绝启动", async () => {
    const db = createPostgresDocumentDb(async () => ({ rows: [] }), CONFIG);
    await expect(db.transaction(async () => undefined)).rejects.toThrow("exclusive connection factory");
  });
});

class ExclusiveRecordingQuery {
  statements: Array<{ sql: string; params?: unknown[] }> = [];
  responses: PostgresQueryResult[] = [];
  clients = 0;
  released = 0;
  active = 0;
  peak = 0;

  readonly query: PostgresQueryFn = async (sql, params) => {
    this.statements.push(params === undefined ? { sql } : { sql, params });
    if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT)\b/i.test(sql)) {
      return { rows: [] };
    }
    return this.responses.shift() ?? { rows: [] };
  };

  readonly connect: PostgresConnectFn = async () => {
    this.clients += 1;
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    const query: PostgresQueryFn = async (sql, params) => {
      expect(this.active).toBe(1);
      return this.query(sql, params);
    };
    return {
      query,
      release: () => {
        this.active -= 1;
        this.released += 1;
      },
    };
  };
}

describe("PostgresDocumentDb 事务与保存点 SQL", () => {
  it("外层事务 BEGIN/COMMIT 并释放同一连接，读写不换连接", async () => {
    const rec = new ExclusiveRecordingQuery();
    rec.responses.push({ rows: [] }, { rows: [{ document: encodeDocument(userDoc("a")) }] });
    const db = createPostgresDocumentDb(rec.query, CONFIG, { connect: rec.connect });
    await db.transaction(async (tx) => {
      await tx.add(users(), "a", userDoc("a"));
      await expect(tx.get(users(), "a")).resolves.toMatchObject({ _id: "a" });
      return "ok";
    });
    expect(rec.clients).toBe(1);
    expect(rec.released).toBe(1);
    expect(rec.peak).toBe(1);
    expect(rec.active).toBe(0);
    expect(rec.statements.map((item) => item.sql)).toEqual([
      "BEGIN",
      `INSERT INTO "${SCHEMA}"."${users()}" (_id, document) VALUES ($1, $2::jsonb)`,
      `SELECT document FROM "${SCHEMA}"."${users()}" WHERE _id = $1`,
      "COMMIT",
    ]);
  });

  it("业务异常 ROLLBACK 并释放连接", async () => {
    const rec = new ExclusiveRecordingQuery();
    rec.responses.push({ rows: [] });
    const db = createPostgresDocumentDb(rec.query, CONFIG, { connect: rec.connect });
    await expect(db.transaction(async (tx) => {
      await tx.add(users(), "a", userDoc("a"));
      throw new Error("abort");
    })).rejects.toThrow("abort");
    expect(rec.statements.map((item) => item.sql)).toEqual([
      "BEGIN",
      `INSERT INTO "${SCHEMA}"."${users()}" (_id, document) VALUES ($1, $2::jsonb)`,
      "ROLLBACK",
    ]);
    expect(rec.released).toBe(1);
    expect(rec.active).toBe(0);
  });

  it("嵌套 transaction 走同一连接 SAVEPOINT/ROLLBACK TO/RELEASE，不 BEGIN 第二次", async () => {
    const rec = new ExclusiveRecordingQuery();
    rec.responses.push({ rows: [] }, { rows: [] }, { rows: [] });
    const db = createPostgresDocumentDb(rec.query, CONFIG, { connect: rec.connect });
    await db.transaction(async (outer) => {
      await outer.add(users(), "a", userDoc("a"));
      await expect(outer.transaction(async (inner) => {
        await inner.add(users(), "b", userDoc("b"));
        throw new Error("savepoint abort");
      })).rejects.toThrow("savepoint abort");
      await outer.add(users(), "c", userDoc("c"));
    });
    expect(rec.clients).toBe(1);
    expect(rec.released).toBe(1);
    expect(rec.statements.map((item) => item.sql)).toEqual([
      "BEGIN",
      `INSERT INTO "${SCHEMA}"."${users()}" (_id, document) VALUES ($1, $2::jsonb)`,
      'SAVEPOINT "vps_sp_1"',
      `INSERT INTO "${SCHEMA}"."${users()}" (_id, document) VALUES ($1, $2::jsonb)`,
      'ROLLBACK TO SAVEPOINT "vps_sp_1"',
      'RELEASE SAVEPOINT "vps_sp_1"',
      `INSERT INTO "${SCHEMA}"."${users()}" (_id, document) VALUES ($1, $2::jsonb)`,
      "COMMIT",
    ]);
  });

  it("外层 reserveCounter 在同一事务内 ensure+条件自增，达上限返回 false", async () => {
    const rec = new ExclusiveRecordingQuery();
    rec.responses.push({ rows: [] }, { rows: [{ _id: "c1" }] }, { rows: [] }, { rows: [] });
    const db = createPostgresDocumentDb(rec.query, CONFIG, { connect: rec.connect });
    const initial: CloudBaseDocument = { _id: "c1", request_count: 0 };
    await expect(db.reserveCounter(usage(), "c1", "request_count", 1, initial)).resolves.toBe(true);
    await expect(db.reserveCounter(usage(), "c1", "request_count", 1, initial)).resolves.toBe(false);
    expect(rec.clients).toBe(2);
    expect(rec.released).toBe(2);
    expect(rec.statements.map((item) => item.sql)).toEqual([
      "BEGIN",
      `INSERT INTO "${SCHEMA}"."${usage()}" (_id, document) VALUES ($1, $2::jsonb) ON CONFLICT (_id) DO NOTHING`,
      `UPDATE "${SCHEMA}"."${usage()}" SET document = jsonb_set(document, ARRAY[$2]::text[], to_jsonb(COALESCE((document ->> $2)::numeric, 0) + 1)) WHERE _id = $1 AND COALESCE((document ->> $2)::numeric, 0) < $3::numeric RETURNING _id`,
      "COMMIT",
      "BEGIN",
      `INSERT INTO "${SCHEMA}"."${usage()}" (_id, document) VALUES ($1, $2::jsonb) ON CONFLICT (_id) DO NOTHING`,
      `UPDATE "${SCHEMA}"."${usage()}" SET document = jsonb_set(document, ARRAY[$2]::text[], to_jsonb(COALESCE((document ->> $2)::numeric, 0) + 1)) WHERE _id = $1 AND COALESCE((document ->> $2)::numeric, 0) < $3::numeric RETURNING _id`,
      "COMMIT",
    ]);
    expect(rec.statements[2]?.params).toEqual(["c1", "request_count", 1]);
  });

  it("事务内 getCounter/adjustCounter 复用同一连接", async () => {
    const rec = new ExclusiveRecordingQuery();
    rec.responses.push(
      { rows: [{ document: encodeDocument({ _id: "c1", request_count: 2 }) }] },
      { rows: [{ _id: "c1" }] },
      { rows: [{ document: encodeDocument({ _id: "c1", request_count: 1 }) }] },
    );
    const db = createPostgresDocumentDb(rec.query, CONFIG, { connect: rec.connect });
    await db.transaction(async (tx) => {
      await expect(tx.getCounter?.(usage(), "c1", "request_count")).resolves.toBe(2);
      await tx.adjustCounter?.(usage(), "c1", "request_count", -1);
      await expect(tx.getCounter?.(usage(), "c1", "request_count")).resolves.toBe(1);
    });
    expect(rec.clients).toBe(1);
    expect(rec.released).toBe(1);
    expect(rec.statements.map((item) => item.sql)).toEqual([
      "BEGIN",
      `SELECT document FROM "${SCHEMA}"."${usage()}" WHERE _id = $1`,
      `UPDATE "${SCHEMA}"."${usage()}" SET document = jsonb_set(document, ARRAY[$2]::text[], to_jsonb(COALESCE((document ->> $2)::numeric, 0) + $3::numeric)) WHERE _id = $1 RETURNING _id`,
      `SELECT document FROM "${SCHEMA}"."${usage()}" WHERE _id = $1`,
      "COMMIT",
    ]);
    expect(rec.statements[2]?.params).toEqual(["c1", "request_count", -1]);
  });

  it("JobLock acquire/release 复用现有事务：外层 BEGIN 后走 SAVEPOINT", async () => {
    const rec = new ExclusiveRecordingQuery();
    rec.responses.push({ rows: [] }, { rows: [] }, { rows: [{ document: encodeDocument({
      _id: "lock:round_1",
      schema_version: 1,
      lock_key: "lock:round_1",
      owner_id: "owner_a",
      lease_until: NOW,
      updated_at: NOW,
    }) }] }, { rows: [{ _id: "lock:round_1" }] });
    const db = createPostgresDocumentDb(rec.query, CONFIG, { connect: rec.connect });
    await db.transaction(async (tx) => {
      const txRepo = new CloudBaseAppRepository(REPO_CONFIG, tx);
      await expect(txRepo.jobLocks.acquire("lock:round_1", "owner_a", NOW)).resolves.toBe(true);
      await txRepo.jobLocks.release("lock:round_1", "owner_a");
    });
    expect(rec.clients).toBe(1);
    expect(rec.released).toBe(1);
    expect(rec.statements.map((item) => item.sql)).toEqual([
      "BEGIN",
      'SAVEPOINT "vps_sp_1"',
      `SELECT document FROM "${SCHEMA}"."${jobLocks()}" WHERE _id = $1`,
      `INSERT INTO "${SCHEMA}"."${jobLocks()}" (_id, document) VALUES ($1, $2::jsonb)`,
      'RELEASE SAVEPOINT "vps_sp_1"',
      'SAVEPOINT "vps_sp_1"',
      `SELECT document FROM "${SCHEMA}"."${jobLocks()}" WHERE _id = $1`,
      `UPDATE "${SCHEMA}"."${jobLocks()}" SET document = document || $2::jsonb WHERE _id = $1 RETURNING _id`,
      'RELEASE SAVEPOINT "vps_sp_1"',
      "COMMIT",
    ]);
    expect(rec.statements[2]?.params).toEqual(["lock:round_1"]);
  });

  it("保存点成功 RELEASE，不 ROLLBACK TO", async () => {
    const rec = new ExclusiveRecordingQuery();
    rec.responses.push({ rows: [] }, { rows: [] });
    const db = createPostgresDocumentDb(rec.query, CONFIG, { connect: rec.connect });
    await db.transaction(async (outer) => {
      await outer.add(users(), "a", userDoc("a"));
      await outer.transaction(async (inner) => {
        await inner.add(users(), "b", userDoc("b"));
      });
    });
    expect(rec.statements.map((item) => item.sql)).toEqual([
      "BEGIN",
      `INSERT INTO "${SCHEMA}"."${users()}" (_id, document) VALUES ($1, $2::jsonb)`,
      'SAVEPOINT "vps_sp_1"',
      `INSERT INTO "${SCHEMA}"."${users()}" (_id, document) VALUES ($1, $2::jsonb)`,
      'RELEASE SAVEPOINT "vps_sp_1"',
      "COMMIT",
    ]);
  });
});

describe("PostgresDocumentDb 业务调用组合", () => {
  it("仓储批量映射把 inFilter 下推为一次 IN 查询", async () => {
    const rec = new RecordingQuery();
    rec.responses.push({ rows: [] }, { rows: [] });
    const db = createPostgresDocumentDb(rec.query, CONFIG);
    const repo = new CloudBaseAppRepository(REPO_CONFIG, db);
    await repo.matchProviderMappings.insert(makeMapping(0));
    await repo.matchProviderMappings.insert(makeMapping(1));
    rec.statements = [];
    rec.responses = [{
      rows: [
        { document: encodeDocument({ ...makeMapping(0), _id: "m0" }) },
        { document: encodeDocument({ ...makeMapping(1), _id: "m1" }) },
      ],
    }];
    const found = await repo.matchProviderMappings.findByProviderAndExternalIds(
      Provider.ApiFootball,
      ["ext-0", "ext-1"],
    );
    expect(found.size).toBe(2);
    expect(rec.statements).toHaveLength(1);
    expect(rec.statements[0]?.sql).toContain("= ANY($2::text[])");
    expect(rec.statements[0]?.params).toEqual([Provider.ApiFootball, ["ext-0", "ext-1"]]);
  });

  it("最近成功快照带 event_type IN、created_at DESC、limit 1", async () => {
    const rec = new RecordingQuery();
    rec.responses.push({ rows: [] });
    const db = createPostgresDocumentDb(rec.query, CONFIG);
    const repo = new CloudBaseAppRepository(REPO_CONFIG, db);
    await repo.providerSnapshots.insert(makeSnapshot("s-new", "result_observed", NOW));
    rec.statements = [];
    rec.responses = [{
      rows: [{ document: encodeDocument({ ...makeSnapshot("s-new", "result_observed", NOW), _id: "s-new" }) }],
    }];
    const latest = await repo.providerSnapshots.findLatestSuccessByEntity("match", "m-1");
    expect(latest?.snapshot_id).toBe("s-new");
    expect(rec.statements).toHaveLength(1);
    const statement = rec.statements[0]!;
    expect(statement.sql).toContain(`"${snapshots()}"`);
    expect(statement.sql).toContain("= ANY($3::text[])");
    expect(statement.sql).toContain(
      `ORDER BY ${postgresDocumentFieldExpr(SCHEMA, "provider_snapshots", "created_at")} DESC LIMIT $4`,
    );
    expect(statement.params?.slice(0, 2)).toEqual(["match", "m-1"]);
    expect(statement.params?.[3]).toBe(1);
  });

  it("候选窗口查询带 kickoff_at lte 与 typed date 比较", async () => {
    const rec = new RecordingQuery();
    rec.responses.push({ rows: [] });
    const db = createPostgresDocumentDb(rec.query, CONFIG);
    const repo = new CloudBaseAppRepository(REPO_CONFIG, db);
    await repo.matches.insert(makeMatch({
      match_id: "sched-12h",
      kickoff_at: new Date(NOW.getTime() + 12 * 60 * 60 * 1000),
    }));
    rec.statements = [];
    rec.responses = [{ rows: [] }];
    await repo.matches.findActiveWindow({ jobType: "near_match", now: NOW, limit: 50 });
    expect(rec.statements.length).toBeGreaterThan(0);
    const statement = rec.statements.find((item) => item.sql.includes(`"${matches()}"`));
    expect(statement?.sql).toContain(
      `${postgresDocumentFieldExpr(SCHEMA, "matches", "kickoff_at")} <= $2::timestamptz`,
    );
    expect(statement?.sql).toContain(
      `ORDER BY ${postgresDocumentFieldExpr(SCHEMA, "matches", "kickoff_at")} DESC LIMIT $3`,
    );
    expect(statement?.params?.[0]).toBe(MatchStatus.Scheduled);
    expect(statement?.params?.[1]).toBe(new Date(NOW.getTime() + 24 * 60 * 60 * 1000).toISOString());
    expect(statement?.params?.[2]).toBe(50);
  });

  it("crowd count 三次等值 COUNT，int 比较走 numeric", async () => {
    const rec = new RecordingQuery();
    rec.responses.push({ rows: [{ count: 2 }] }, { rows: [{ count: 1 }] }, { rows: [{ count: 0 }] });
    const db = createPostgresDocumentDb(rec.query, CONFIG);
    const repo = new CloudBaseAppRepository(REPO_CONFIG, db);
    await expect(repo.predictions.countByMatchGroupedByResult("match-id")).resolves.toEqual({
      HOME: 2,
      DRAW: 1,
      AWAY: 0,
    });
    expect(rec.statements).toHaveLength(3);
    expect(rec.statements.every((item) => item.sql.startsWith("SELECT COUNT(*)::int AS count"))).toBe(true);
    expect(rec.statements.map((item) => item.params)).toEqual([
      ["match-id", "HOME"],
      ["match-id", "DRAW"],
      ["match-id", "AWAY"],
    ]);
  });
});

describe("CloudBaseDuplicateKeyError still maps through existing repository", () => {
  it("pk 冲突保持 CloudBaseDuplicateKeyError 形状", () => {
    const error = new CloudBaseDuplicateKeyError(users(), "pk_document", { _id: "u1" });
    expect(error).toBeInstanceOf(CloudBaseDuplicateKeyError);
    expect(error.indexName).toBe("pk_document");
  });

  it("UniqueConstraintError 仍由仓储从 DuplicateKey 构造", () => {
    const error = new UniqueConstraintError("groups", "uk_invite_code", { invite_code: "ABCDEFGH" });
    expect(error.collection).toBe("groups");
    expect(error.indexName).toBe("uk_invite_code");
  });
});
