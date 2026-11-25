import { afterEach, describe, expect, it, vi } from "vitest";
import { AnomalyStatus, GroupStatus, MatchStatus, Provider, SettlementStatus } from "../domain/enums.js";
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
import { JSONB_UTC_TIMESTAMPTZ_FUNCTION, postgresDocumentFieldExpr } from "./postgres-schema.js";
import {
  POSTGRES_IN_OP,
  POSTGRES_LT_OP,
  POSTGRES_LTE_OP,
  POSTGRES_NE_OP,
  compileAnomalyPage,
  compileLatestRegularBoardSnapshot,
  compilePostgresAdjustCounter,
  compilePostgresDistinctQuery,
  compilePostgresDocumentAdd,
  compilePostgresDocumentDelete,
  compilePostgresDocumentEnsure,
  compilePostgresDocumentGet,
  compilePostgresDocumentPatch,
  compilePostgresDocumentQuery,
  compilePostgresDocumentUpdate,
  compilePostgresReleaseJobLock,
  compilePostgresRenewJobLock,
  compilePostgresReserveCounter,
  compilePredictionHistoryPage,
  compileSettlementFallbackPage,
  createPostgresDocumentDb,
  createPostgresQueryFn,
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
  const canonicalMatchIdentity = overrides.match_id ?? ("m1");
  return {
    schema_version: 1,
    match_id: canonicalMatchIdentity,
    canonical_match_id: overrides.canonical_match_id ?? canonicalMatchIdentity,
    superseded_by: overrides.superseded_by ?? null,
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
    const finishExpr = postgresDocumentFieldExpr(SCHEMA, "matches", "finish_detected_at");
    expect(query.sql).toBe(
      `SELECT document FROM "${SCHEMA}"."${matches()}" WHERE ${statusExpr} = $1 AND (${finishExpr}) IS NULL AND ${kickoffExpr} <= $2::timestamptz ORDER BY ${kickoffExpr} DESC LIMIT $3 OFFSET $4`,
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

  it("null 过滤改为索引表达式 IS NULL，可命中 ->> 索引并覆盖缺失键", () => {
    const text = compilePostgresDocumentQuery(CONFIG, matches(), { superseded_by: null });
    const textExpr = postgresDocumentFieldExpr(SCHEMA, "matches", "superseded_by");
    expect(text.sql).toContain(`(${textExpr}) IS NULL`);
    expect(text.sql).not.toContain("= 'null'::jsonb");
    expect(text.sql).not.toContain("(document -> 'superseded_by')");
    expect(text.params).toEqual([]);

    const date = compilePostgresDocumentQuery(CONFIG, matches(), { finish_detected_at: null });
    const dateExpr = postgresDocumentFieldExpr(SCHEMA, "matches", "finish_detected_at");
    expect(dateExpr).toContain(JSONB_UTC_TIMESTAMPTZ_FUNCTION);
    expect(date.sql).toContain(`(${dateExpr}) IS NULL`);
    expect(date.params).toEqual([]);

    const numeric = compilePostgresDocumentQuery(
      CONFIG,
      cloudBaseCollectionName(NAMESPACE, "match_results"),
      { result_version: null },
    );
    const numericExpr = postgresDocumentFieldExpr(SCHEMA, "match_results", "result_version");
    expect(numericExpr).toContain("::numeric");
    expect(numeric.sql).toContain(`(${numericExpr}) IS NULL`);

    const flag = compilePostgresDocumentQuery(
      CONFIG,
      cloudBaseCollectionName(NAMESPACE, "anomalies"),
      { blocking: null },
    );
    const flagExpr = postgresDocumentFieldExpr(SCHEMA, "anomalies", "blocking");
    expect(flagExpr).toContain("::boolean");
    expect(flag.sql).toContain(`(${flagExpr}) IS NULL`);
  });

  it("未声明字段的数字/日期/布尔过滤两侧类型对齐", () => {
    const score = compilePostgresDocumentQuery(CONFIG, users(), { extra_score: 3 });
    const scoreExpr = postgresDocumentFieldExpr(SCHEMA, "users", "extra_score");
    expect(scoreExpr).toBe("(document ->> 'extra_score')");
    expect(score.sql).toContain(`(${scoreExpr})::numeric = $1::numeric`);
    expect(score.params).toEqual([3]);

    const at = compilePostgresDocumentQuery(CONFIG, users(), { extra_at: NOW });
    const atExpr = postgresDocumentFieldExpr(SCHEMA, "users", "extra_at");
    expect(at.sql).toContain(
      `"${SCHEMA}"."${JSONB_UTC_TIMESTAMPTZ_FUNCTION}"(${atExpr}) = $1::timestamptz`,
    );
    expect(at.sql).not.toContain(`(document ->> 'extra_at')::timestamptz`);
    expect(at.params).toEqual([NOW.toISOString()]);

    const flag = compilePostgresDocumentQuery(CONFIG, users(), { extra_flag: false });
    const flagExpr = postgresDocumentFieldExpr(SCHEMA, "users", "extra_flag");
    expect(flag.sql).toContain(`(${flagExpr})::boolean = $1::boolean`);
    expect(flag.params).toEqual([false]);

    const upper = compilePostgresDocumentQuery(CONFIG, users(), {
      extra_score: { [POSTGRES_LTE_OP]: 9 },
    });
    expect(upper.sql).toContain(`(${scoreExpr})::numeric <= $1::numeric`);
    expect(upper.params).toEqual([9]);

    const excluded = compilePostgresDocumentQuery(CONFIG, users(), {
      extra_flag: { [POSTGRES_NE_OP]: true },
    });
    expect(excluded.sql).toContain(`(${flagExpr})::boolean IS DISTINCT FROM $1::boolean`);
    expect(excluded.params).toEqual([true]);

    const label = compilePostgresDocumentQuery(CONFIG, users(), { extra_label: "keep" });
    expect(label.sql).toContain(`${postgresDocumentFieldExpr(SCHEMA, "users", "extra_label")} = $1`);
    expect(label.sql).not.toMatch(/extra_label'\)(?:::|\)::)/);
    expect(label.params).toEqual(["keep"]);
  });

  it("distinctQuery 用 SELECT DISTINCT 在数据库内去重，字段与筛选条件均参数化", () => {
    const compiled = compilePostgresDistinctQuery(
      CONFIG,
      matches(),
      ["league_id", "season_id", "round_id"],
      { league_id: "premier_league" },
    );
    expect(compiled.sql).toBe(
      `SELECT DISTINCT document->>'league_id' AS "league_id", document->>'season_id' AS "season_id", document->>'round_id' AS "round_id" FROM "${SCHEMA}"."${matches()}" WHERE ${postgresDocumentFieldExpr(SCHEMA, "matches", "league_id")} = $1`,
    );
    expect(compiled.params).toEqual(["premier_league"]);

    const unfiltered = compilePostgresDistinctQuery(CONFIG, matches(), ["season_id"]);
    expect(unfiltered.sql).toBe(
      `SELECT DISTINCT document->>'season_id' AS "season_id" FROM "${SCHEMA}"."${matches()}" WHERE TRUE`,
    );
    expect(unfiltered.params).toEqual([]);

    expect(() => compilePostgresDistinctQuery(CONFIG, matches(), ["season_id) FROM matches; DROP TABLE matches; --"]))
      .toThrow();
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
    expect(db.neFilter!("level_reeval_status", "completed")).toEqual({
      level_reeval_status: { [POSTGRES_NE_OP]: "completed" },
    });
    expect(parseDocumentFilter(db.neFilter!("level_reeval_status", "completed")!)).toEqual([
      { kind: "ne", field: "level_reeval_status", value: "completed" },
    ]);
    expect(parseDocumentFilter(db.inFilter("event_type", ["discovered", "result_observed"])!)).toEqual([
      { kind: "in", field: "event_type", values: ["discovered", "result_observed"] },
    ]);
    expect(() => parseDocumentFilter({ kickoff_at: { $gt: NOW } })).toThrow("unsupported query operator");
    expect(() => parseDocumentFilter({ "kickoff_at;drop": NOW })).toThrow("invalid query field");
  });

  it("ne 查询编译为 IS DISTINCT FROM，legacy 缺失字段也满足不等于", () => {
    const db = createPostgresDocumentDb(async () => ({ rows: [] }), CONFIG);
    const compiled = compilePostgresDocumentQuery(
      CONFIG,
      users(),
      db.neFilter!("level_reeval_status", "completed")!,
    );
    expect(compiled.sql).toContain("IS DISTINCT FROM $1");
    expect(compiled.params).toEqual(["completed"]);
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

  it("实时窗口上下界同时编译为包含边界的 SQL", () => {
    const db = createPostgresDocumentDb(async () => ({ rows: [] }), CONFIG);
    const lower = new Date(NOW.getTime() - 6 * 60 * 60_000);
    const upper = new Date(NOW.getTime() + 2 * 60 * 60_000);
    const compiled = compilePostgresDocumentQuery(CONFIG, cloudBaseCollectionName(NAMESPACE, "matches"), {
      kickoff_at: { ...db.gteFilter("kickoff_at", lower).kickoff_at as object, ...db.lteFilter("kickoff_at", upper).kickoff_at as object },
    });
    const field = postgresDocumentFieldExpr(SCHEMA, "matches", "kickoff_at");
    expect(compiled.sql).toContain(`${field} >= $1::timestamptz`);
    expect(compiled.sql).toContain(`${field} <= $2::timestamptz`);
    expect(compiled.params).toEqual([lower.toISOString(), upper.toISOString()]);
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

  it("compilePredictionHistoryPage 在数据库内筛选联赛/赛季并 keyset 分页", () => {
    const submittedAt = new Date("2026-08-09T12:00:00.000Z");
    const ts = postgresDocumentFieldExpr(SCHEMA, "predictions", "submitted_at").replace(
      /\bdocument\b/g,
      "p.document",
    );
    const predictionsTable = `"${SCHEMA}"."${predictions()}"`;
    const matchesTable = `"${SCHEMA}"."${matches()}"`;
    const predCanonical = "COALESCE((p.document ->> 'canonical_match_id'), (p.document ->> 'match_id'))";
    const matchCanonical = "COALESCE((m.document ->> 'canonical_match_id'), (m.document ->> 'match_id'))";
    const existsSql = `EXISTS (SELECT 1 FROM ${matchesTable} m WHERE (m.document ->> 'superseded_by') IS NULL AND ${matchCanonical} = ${predCanonical} AND ($2::text IS NULL OR m.document ->> 'league_id' = $2) AND ($3::text IS NULL OR m.document ->> 'season_id' = $3))`;

    const unfiltered = compilePredictionHistoryPage(CONFIG, {
      predictions_collection: predictions(),
      matches_collection: matches(),
      user_id: "user-secret",
      league_id: null,
      season_id: null,
      cursor: null,
      limit: 20,
    });
    expect(unfiltered.sql).toContain("EXISTS");
    expect(unfiltered.sql).toContain("(m.document ->> 'superseded_by') IS NULL");
    expect(unfiltered.sql).not.toContain("= 'null'::jsonb");
    expect(unfiltered.sql).toContain("LIMIT");
    expect(unfiltered.sql).toContain("(p.document ->> 'prediction_id') DESC");
    expect(unfiltered.sql).toContain("$2::text IS NULL OR m.document ->> 'league_id' = $2");
    expect(unfiltered.sql).toContain("$3::text IS NULL OR m.document ->> 'season_id' = $3");
    expect(unfiltered.sql).not.toContain("user-secret");
    expect(unfiltered.sql).toContain(JSONB_UTC_TIMESTAMPTZ_FUNCTION);
    expect(unfiltered.sql).not.toMatch(/p\.document\s*->>\s*'submitted_at'\)::timestamptz/);
    expect(unfiltered.sql).not.toContain("$4::timestamptz");
    expect(unfiltered.sql).not.toContain("(p.document ->> 'prediction_id') <");
    expect(unfiltered.sql).toBe(
      `SELECT p.document FROM ${predictionsTable} p WHERE (p.document ->> 'user_id') = $1 AND ${existsSql} ORDER BY ${ts} DESC, (p.document ->> 'prediction_id') DESC LIMIT $4`,
    );
    expect(unfiltered.params).toEqual(["user-secret", null, null, 20]);

    const filtered = compilePredictionHistoryPage(CONFIG, {
      predictions_collection: predictions(),
      matches_collection: matches(),
      user_id: "user-secret",
      league_id: "premier_league",
      season_id: "2026_2027",
      cursor: { submitted_at: submittedAt, prediction_id: "pred-cursor" },
      limit: 10,
    });
    expect(filtered.sql).toContain(
      `(${ts}, (p.document ->> 'prediction_id')) < ($4::timestamptz, $5)`,
    );
    expect(filtered.sql).toContain(matchCanonical);
    expect(filtered.sql).toContain("(p.document ->> 'prediction_id') DESC");
    expect(filtered.sql).toContain("LIMIT $6");
    expect(filtered.sql).not.toContain("user-secret");
    expect(filtered.sql).not.toContain("premier_league");
    expect(filtered.sql).not.toContain("2026_2027");
    expect(filtered.sql).not.toContain("pred-cursor");
    expect(filtered.sql).not.toContain(submittedAt.toISOString());
    expect(filtered.sql).toContain(JSONB_UTC_TIMESTAMPTZ_FUNCTION);
    expect(filtered.sql).not.toMatch(/\(p\.document ->> 'submitted_at'\)::timestamptz/);
    expect(filtered.params).toEqual([
      "user-secret",
      "premier_league",
      "2026_2027",
      submittedAt.toISOString(),
      "pred-cursor",
      10,
    ]);
  });

  it("compilePredictionHistoryPage 把缺失和 JSON null 的 superseded_by 都当作未替代", () => {
    const compiled = compilePredictionHistoryPage(CONFIG, {
      predictions_collection: predictions(),
      matches_collection: matches(),
      user_id: "u1",
      league_id: null,
      season_id: null,
      cursor: null,
      limit: 20,
    });
    expect(compiled.sql).toContain("(m.document ->> 'superseded_by') IS NULL");
    expect(compiled.sql).not.toContain("= 'null'::jsonb");
    expect(compiled.sql).not.toContain("(m.document -> 'superseded_by')");
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

  it("findPredictionHistoryPage 执行编译 SQL 并把 document 列 decode 为文档", async () => {
    const rec = new RecordingQuery();
    rec.responses.push({
      rows: [{
        document: encodeDocument({
          _id: "p1",
          prediction_id: "p1",
          user_id: "u1",
          match_id: "m1",
          submitted_at: NOW,
        }),
      }],
    });
    const db = createPostgresDocumentDb(rec.query, CONFIG);
    const page = await db.findPredictionHistoryPage({
      predictions_collection: predictions(),
      matches_collection: matches(),
      user_id: "u1",
      league_id: null,
      season_id: null,
      cursor: null,
      limit: 20,
    });
    expect(page.documents).toHaveLength(1);
    expect(page.documents[0]?.submitted_at).toBeInstanceOf(Date);
    expect((page.documents[0]?.submitted_at as Date).getTime()).toBe(NOW.getTime());
    expect(page.exhausted).toBe(true);
    expect(page.resumeCursor).toBeNull();
    expect(rec.statements).toHaveLength(1);
    expect(rec.statements[0]?.sql).toContain("EXISTS");
    expect(rec.statements[0]?.params).toEqual(["u1", null, null, 20]);
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
  rollbackError: unknown = undefined;
  beginError: unknown = undefined;
  commitError: unknown = undefined;
  savepointRollbackError: unknown = undefined;
  savepointReleaseError: unknown = undefined;
  releasedWith: Array<Error | undefined> = [];
  releaseDelay: Promise<void> | undefined;
  releaseImpl: ((err?: Error) => void | Promise<void>) | undefined;

  readonly query: PostgresQueryFn = async (sql, params) => {
    this.statements.push(params === undefined ? { sql } : { sql, params });
    if (/^BEGIN\b/i.test(sql) && this.beginError !== undefined) {
      throw this.beginError;
    }
    if (/^COMMIT\b/i.test(sql) && this.commitError !== undefined) {
      throw this.commitError;
    }
    if (/^ROLLBACK TO SAVEPOINT\b/i.test(sql) && this.savepointRollbackError !== undefined) {
      throw this.savepointRollbackError;
    }
    if (/^RELEASE SAVEPOINT\b/i.test(sql) && this.savepointReleaseError !== undefined) {
      throw this.savepointReleaseError;
    }
    if (/^ROLLBACK\b/i.test(sql) && this.rollbackError !== undefined) {
      throw this.rollbackError;
    }
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
      release: (err?: Error) => {
        this.releasedWith.push(err);
        if (this.releaseImpl !== undefined) return this.releaseImpl(err);
        const finish = () => {
          this.active -= 1;
          this.released += 1;
        };
        if (this.releaseDelay !== undefined) return this.releaseDelay.then(finish);
        finish();
      },
    };
  };
}

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const DEADLOCK_TIMEOUT_MS = 500;

function isDeadlockTimeout(reason: unknown): boolean {
  return reason instanceof Error && reason.message.includes("possible deadlock");
}

function settleWithin<T>(promise: Promise<T>, ms: number): Promise<PromiseSettledResult<T>> {
  const settled = promise.then(
    (value): PromiseSettledResult<T> => ({ status: "fulfilled", value }),
    (reason: unknown): PromiseSettledResult<T> => ({ status: "rejected", reason }),
  );
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({
        status: "rejected",
        reason: new Error(`timed out after ${ms}ms (possible deadlock)`),
      });
    }, ms);
    void settled.then((result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

async function expectQuickReject(promise: Promise<unknown>, ms = DEADLOCK_TIMEOUT_MS): Promise<unknown> {
  const result = await settleWithin(promise, ms);
  if (result.status === "fulfilled") {
    throw new Error("expected rejection, but the operation fulfilled");
  }
  if (isDeadlockTimeout(result.reason)) throw result.reason;
  return result.reason;
}

function holdInsertId(
  sim: PostgresSavepointSimulator,
  id: string,
): { held: ReturnType<typeof defer>; hold: ReturnType<typeof defer> } {
  const held = defer();
  const hold = defer();
  sim.sqlGate = async (sql, params) => {
    if (!/^INSERT\b/i.test(sql) || String(params?.[0]) !== id) return;
    held.resolve();
    await hold.promise;
  };
  return { held, hold };
}

function holdMatchingSql(
  sim: PostgresSavepointSimulator,
  match: (sql: string, params?: unknown[]) => boolean,
): { held: ReturnType<typeof defer>; hold: ReturnType<typeof defer> } {
  const held = defer();
  const hold = defer();
  let blocked = false;
  sim.sqlGate = async (sql, params) => {
    if (blocked) return;
    if (!match(sql, params)) return;
    blocked = true;
    held.resolve();
    await hold.promise;
  };
  return { held, hold };
}

function isReserveUpdateSql(sql: string): boolean {
  return /^UPDATE\b/i.test(sql) && /jsonb_set/i.test(sql);
}

function reserveUpdatesAfterRollback(executed: string[]): string[] {
  const rollbackAt = executed.findIndex((sql) => /^ROLLBACK\b/i.test(sql));
  const after = rollbackAt < 0 ? executed : executed.slice(rollbackAt + 1);
  return after.filter((sql) => isReserveUpdateSql(sql));
}

function ignoreRejection(promise: Promise<unknown>): void {
  void promise.then(() => undefined, () => undefined);
}

function insertsAfterSavepointClose(executed: string[]): string[] {
  const closeAt = executed.findIndex((sql) =>
    /^RELEASE SAVEPOINT\b/i.test(sql) || /^ROLLBACK TO SAVEPOINT\b/i.test(sql),
  );
  const after = closeAt < 0 ? executed : executed.slice(closeAt + 1);
  return after.filter((sql) => /^INSERT\b/i.test(sql));
}

function savepointIdent(sql: string): string {
  const match = /SAVEPOINT\s+"([^"]+)"/i.exec(sql);
  if (match === null) throw new Error(`unparseable savepoint sql: ${sql}`);
  return match[1]!;
}

class PostgresSavepointSimulator {
  statements: string[] = [];
  executed: string[] = [];
  queriesAfterRelease = 0;
  released = 0;
  releasedWith: Array<Error | undefined> = [];
  sqlGate: ((sql: string, params?: unknown[]) => Promise<void>) | undefined;
  private live = new Map<string, unknown>();
  private tx: Map<string, unknown> | undefined;
  private savepoints: Array<{ name: string; snapshot: Map<string, unknown> }> = [];
  private connectionReleased = false;

  seed(id: string, document: unknown): void {
    this.live.set(id, document);
  }

  private store(id: string, document: unknown): void {
    (this.tx ?? this.live).set(id, document);
  }

  private load(id: string): unknown {
    return (this.tx ?? this.live).get(id);
  }

  private exec(sql: string, params?: unknown[]): PostgresQueryResult {
    const trimmed = sql.trim();
    if (/^BEGIN\b/i.test(trimmed)) {
      this.tx = new Map(this.live);
      this.savepoints = [];
      return { rows: [] };
    }
    if (/^COMMIT\b/i.test(trimmed)) {
      if (this.tx !== undefined) this.live = this.tx;
      this.tx = undefined;
      this.savepoints = [];
      return { rows: [], command: "COMMIT" };
    }
    if (/^ROLLBACK TO SAVEPOINT\b/i.test(trimmed)) {
      const name = savepointIdent(trimmed);
      const idx = this.savepoints.reduce((last, item, i) => item.name === name ? i : last, -1);
      if (idx < 0) throw new Error(`no such savepoint: ${name}`);
      this.tx = new Map(this.savepoints[idx]!.snapshot);
      this.savepoints = this.savepoints.slice(0, idx + 1);
      return { rows: [] };
    }
    if (/^RELEASE SAVEPOINT\b/i.test(trimmed)) {
      const name = savepointIdent(trimmed);
      const idx = this.savepoints.reduce((last, item, i) => item.name === name ? i : last, -1);
      if (idx < 0) throw new Error(`no such savepoint: ${name}`);
      this.savepoints = this.savepoints.slice(0, idx);
      return { rows: [] };
    }
    if (/^ROLLBACK\b/i.test(trimmed)) {
      this.tx = undefined;
      this.savepoints = [];
      return { rows: [] };
    }
    if (/^SAVEPOINT\b/i.test(trimmed)) {
      const name = savepointIdent(trimmed);
      this.savepoints.push({ name, snapshot: new Map(this.tx ?? this.live) });
      return { rows: [] };
    }
    if (/^INSERT\b/i.test(trimmed)) {
      this.store(String(params?.[0]), params?.[1]);
      return { rows: [] };
    }
    if (/^SELECT document\b/i.test(trimmed)) {
      const document = this.load(String(params?.[0]));
      return document === undefined ? { rows: [] } : { rows: [{ document }] };
    }
    if (/^UPDATE\b/i.test(trimmed) && /jsonb_set/i.test(trimmed) && / < \$3::numeric/i.test(trimmed)) {
      const id = String(params?.[0]);
      const field = String(params?.[1]);
      const limit = Number(params?.[2]);
      const existing = this.load(id);
      if (existing === undefined || existing === null || typeof existing !== "object") {
        return { rows: [] };
      }
      const document = { ...(existing as Record<string, unknown>) };
      const current = typeof document[field] === "number" ? document[field] as number : 0;
      if (!(current < limit)) return { rows: [] };
      document[field] = current + 1;
      this.store(id, document);
      return { rows: [{ _id: id }] };
    }
    return { rows: [] };
  }

  readonly query: PostgresQueryFn = async (sql, params) => {
    this.statements.push(sql);
    if (this.sqlGate !== undefined) await this.sqlGate(sql, params);
    this.executed.push(sql);
    return this.exec(sql, params);
  };

  readonly connect: PostgresConnectFn = async () => {
    this.connectionReleased = false;
    return {
      query: async (sql, params) => {
        this.statements.push(sql);
        if (this.connectionReleased) {
          this.queriesAfterRelease += 1;
          throw new Error("connection released");
        }
        if (this.sqlGate !== undefined) await this.sqlGate(sql, params);
        this.executed.push(sql);
        return this.exec(sql, params);
      },
      release: (err?: Error) => {
        this.releasedWith.push(err);
        this.connectionReleased = true;
        this.released += 1;
      },
    };
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

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
    expect(rec.releasedWith).toEqual([undefined]);
  });

  it("ROLLBACK 自身失败时销毁连接、保留原始事务异常并记录回滚失败", async () => {
    const rec = new ExclusiveRecordingQuery();
    rec.responses.push({ rows: [] });
    const rollbackError = new Error("rollback failed");
    rec.rollbackError = rollbackError;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
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
    expect(rec.releasedWith).toEqual([rollbackError]);
    expect(rec.released).toBe(1);
    expect(rec.active).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = spy.mock.calls[0]?.[0];
    expect(typeof logged).toBe("string");
    expect(JSON.parse(String(logged))).toEqual({
      event: "pg_rollback_failed",
      message: "rollback failed",
    });
  });

  it("ROLLBACK 抛出非 Error 时仍以 Error 交给 release，并保留原始事务异常", async () => {
    const rec = new ExclusiveRecordingQuery();
    rec.responses.push({ rows: [] });
    rec.rollbackError = "socket hang up";
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = createPostgresDocumentDb(rec.query, CONFIG, { connect: rec.connect });
    await expect(db.transaction(async () => {
      throw new Error("abort");
    })).rejects.toThrow("abort");
    expect(rec.releasedWith).toHaveLength(1);
    expect(rec.releasedWith[0]).toBeInstanceOf(Error);
    expect(rec.releasedWith[0]?.message).toBe("socket hang up");
    expect(JSON.parse(String(spy.mock.calls[0]?.[0]))).toEqual({
      event: "pg_rollback_failed",
      message: "socket hang up",
    });
  });

  it("BEGIN 失败时 release(error) 销毁连接并保留原始异常", async () => {
    const rec = new ExclusiveRecordingQuery();
    const beginError = new Error("begin failed");
    rec.beginError = beginError;
    const db = createPostgresDocumentDb(rec.query, CONFIG, { connect: rec.connect });
    await expect(db.transaction(async () => "ok")).rejects.toBe(beginError);
    expect(rec.statements.map((item) => item.sql)).toEqual(["BEGIN"]);
    expect(rec.releasedWith).toEqual([beginError]);
    expect(rec.released).toBe(1);
    expect(rec.active).toBe(0);
  });

  it("自定义适配器 COMMIT 无 command 时无法判定隐式回滚，保持成功契约", async () => {
    const statements: string[] = [];
    const adapter = {
      query: async (sql: string) => {
        statements.push(sql);
        if (/^BEGIN\b/i.test(sql) || /^COMMIT\b/i.test(sql) || /^ROLLBACK\b/i.test(sql)) {
          return { rows: [] };
        }
        throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
      },
    };
    const releasedWith: Array<Error | undefined> = [];
    const connect: PostgresConnectFn = async () => ({
      query: createPostgresQueryFn(adapter),
      release: (err?: Error) => {
        releasedWith.push(err);
      },
    });
    const db = createPostgresDocumentDb(createPostgresQueryFn(adapter), CONFIG, { connect });
    await expect(db.transaction(async (tx) => {
      try {
        await tx.add(users(), "a", userDoc("a"));
      } catch {
        return "swallowed";
      }
      return "ok";
    })).resolves.toBe("swallowed");
    expect(statements).toContain("COMMIT");
    expect(statements.some((sql) => /^ROLLBACK\b/i.test(sql))).toBe(false);
    expect(releasedWith).toEqual([undefined]);
  });

  it("createPostgresQueryFn 保留 pg command 标签，无 command 的模拟结果仍可用", async () => {
    const withCommand = createPostgresQueryFn({
      query: async () => ({ rows: [{ n: 1 }], command: "SELECT" }),
    });
    await expect(withCommand("SELECT 1")).resolves.toEqual({
      rows: [{ n: 1 }],
      command: "SELECT",
    });
    const withoutCommand = createPostgresQueryFn({
      query: async () => ({ rows: [] }),
    });
    await expect(withoutCommand("SELECT 1")).resolves.toEqual({ rows: [] });
  });

  it("事务内 SQL 异常被回调捕获后 COMMIT 返回 command ROLLBACK 时不能报告成功", async () => {
    const statements: string[] = [];
    const pgClient = {
      query: async (sql: string, _params?: unknown[]) => {
        statements.push(sql);
        if (/^BEGIN\b/i.test(sql)) return { rows: [], command: "BEGIN" };
        if (/^COMMIT\b/i.test(sql)) return { rows: [], command: "ROLLBACK" };
        if (/^ROLLBACK\b/i.test(sql)) return { rows: [], command: "ROLLBACK" };
        throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
      },
    };
    const releasedWith: Array<Error | undefined> = [];
    const queryFn = createPostgresQueryFn(pgClient);
    const connect: PostgresConnectFn = async () => ({
      query: createPostgresQueryFn(pgClient),
      release: (err?: Error) => {
        releasedWith.push(err);
      },
    });
    const db = createPostgresDocumentDb(queryFn, CONFIG, { connect });
    await expect(db.transaction(async (tx) => {
      try {
        await tx.add(users(), "a", userDoc("a"));
      } catch {
        return "swallowed";
      }
      return "ok";
    })).rejects.toThrow(/COMMIT.*ROLLBACK/);
    expect(statements).toContain("COMMIT");
    expect(statements.some((sql) => /^ROLLBACK\b/i.test(sql))).toBe(true);
    expect(releasedWith).toHaveLength(1);
  });

  it("COMMIT 抛错时正常回滚，不假定提交已失败", async () => {
    const rec = new ExclusiveRecordingQuery();
    rec.responses.push({ rows: [] });
    rec.commitError = new Error("commit failed");
    const db = createPostgresDocumentDb(rec.query, CONFIG, { connect: rec.connect });
    await expect(db.transaction(async (tx) => {
      await tx.add(users(), "a", userDoc("a"));
      return "ok";
    })).rejects.toThrow("commit failed");
    expect(rec.statements.map((item) => item.sql)).toEqual([
      "BEGIN",
      `INSERT INTO "${SCHEMA}"."${users()}" (_id, document) VALUES ($1, $2::jsonb)`,
      "COMMIT",
      "ROLLBACK",
    ]);
    expect(rec.releasedWith).toEqual([undefined]);
    expect(rec.released).toBe(1);
    expect(rec.active).toBe(0);
  });

  it("COMMIT 抛错后回滚失败时销毁连接并保留提交异常", async () => {
    const rec = new ExclusiveRecordingQuery();
    rec.responses.push({ rows: [] });
    rec.commitError = new Error("commit failed");
    const rollbackError = new Error("rollback failed");
    rec.rollbackError = rollbackError;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = createPostgresDocumentDb(rec.query, CONFIG, { connect: rec.connect });
    await expect(db.transaction(async (tx) => {
      await tx.add(users(), "a", userDoc("a"));
      return "ok";
    })).rejects.toThrow("commit failed");
    expect(rec.statements.map((item) => item.sql)).toEqual([
      "BEGIN",
      `INSERT INTO "${SCHEMA}"."${users()}" (_id, document) VALUES ($1, $2::jsonb)`,
      "COMMIT",
      "ROLLBACK",
    ]);
    expect(rec.releasedWith).toEqual([rollbackError]);
    expect(rec.released).toBe(1);
    expect(rec.active).toBe(0);
    expect(JSON.parse(String(spy.mock.calls[0]?.[0]))).toEqual({
      event: "pg_rollback_failed",
      message: "rollback failed",
    });
  });

  it("成功提交也 await 异步 release，且不向 release 传入错误", async () => {
    const rec = new ExclusiveRecordingQuery();
    rec.responses.push({ rows: [] });
    let resolveRelease!: () => void;
    rec.releaseDelay = new Promise((resolve) => {
      resolveRelease = resolve;
    });
    const db = createPostgresDocumentDb(rec.query, CONFIG, { connect: rec.connect });
    let settled = false;
    const done = db.transaction(async (tx) => {
      await tx.add(users(), "a", userDoc("a"));
      return "ok";
    }).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(rec.released).toBe(0);
    resolveRelease();
    await expect(done).resolves.toBe("ok");
    expect(rec.released).toBe(1);
    expect(rec.releasedWith).toEqual([undefined]);
  });

  it("异步 release 失败不覆盖原始事务异常", async () => {
    const rec = new ExclusiveRecordingQuery();
    rec.responses.push({ rows: [] });
    rec.releaseImpl = () => {
      rec.active -= 1;
      rec.released += 1;
      return Promise.reject(new Error("release failed"));
    };
    const db = createPostgresDocumentDb(rec.query, CONFIG, { connect: rec.connect });
    await expect(db.transaction(async (tx) => {
      await tx.add(users(), "a", userDoc("a"));
      throw new Error("abort");
    })).rejects.toThrow("abort");
    expect(rec.released).toBe(1);
    expect(rec.releasedWith).toEqual([undefined]);
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

  it("JobLock acquire 与 release 均走单条原子 SQL（复用现有事务且不再额外建 SAVEPOINT）", async () => {
    const rec = new ExclusiveRecordingQuery();
    rec.responses.push({ rows: [{ _id: "lock:round_1" }] }, { rows: [] });
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
      `INSERT INTO "${SCHEMA}"."${jobLocks()}" (_id, document) VALUES ($1, $2::jsonb) ON CONFLICT (_id) DO UPDATE SET document = EXCLUDED.document WHERE "${SCHEMA}"."${JSONB_UTC_TIMESTAMPTZ_FUNCTION}"(("${SCHEMA}"."${jobLocks()}".document ->> 'lease_until')) <= $3::timestamptz RETURNING _id`,
      `UPDATE "${SCHEMA}"."${jobLocks()}" SET document = document || $3::jsonb WHERE _id = $1 AND (document ->> 'owner_id') = $2`,
      "COMMIT",
    ]);
    expect(rec.statements[1]?.params?.[0]).toBe("lock:round_1");
    expect(rec.statements[2]?.params?.slice(0, 2)).toEqual(["lock:round_1", "owner_a"]);
  });

  it("JobLock renew 与 release 编译及返回值严格绑定 owner_id 与未过期条件，防止 READ COMMITTED TOCTOU", async () => {
    const renewSql = compilePostgresRenewJobLock(
      CONFIG,
      jobLocks(),
      "lock:weekly",
      "owner_a",
      new Date("2026-08-09T13:00:00.000Z"),
      NOW,
    );
    expect(renewSql.sql).toBe(
      `UPDATE "${SCHEMA}"."${jobLocks()}" SET document = document || $4::jsonb WHERE _id = $1 AND (document ->> 'owner_id') = $2 AND "${SCHEMA}"."${JSONB_UTC_TIMESTAMPTZ_FUNCTION}"(("${SCHEMA}"."${jobLocks()}".document ->> 'lease_until')) > $3::timestamptz RETURNING _id`,
    );
    expect(renewSql.params[0]).toBe("lock:weekly");
    expect(renewSql.params[1]).toBe("owner_a");
    expect(renewSql.params[2]).toBe(NOW.toISOString());

    const releaseSql = compilePostgresReleaseJobLock(CONFIG, jobLocks(), "lock:weekly", "owner_a", NOW);
    expect(releaseSql.sql).toBe(
      `UPDATE "${SCHEMA}"."${jobLocks()}" SET document = document || $3::jsonb WHERE _id = $1 AND (document ->> 'owner_id') = $2`,
    );

    const rec = new ExclusiveRecordingQuery();
    rec.responses.push({ rows: [{ _id: "lock:weekly" }] }, { rows: [] });
    const db = createPostgresDocumentDb(rec.query, CONFIG, { connect: rec.connect });
    const repo = new CloudBaseAppRepository(REPO_CONFIG, db);
    await expect(repo.jobLocks.renew("lock:weekly", "owner_a", new Date("2026-08-09T13:00:00.000Z"))).resolves.toBe(true);
    await expect(repo.jobLocks.renew("lock:weekly", "owner_a", new Date("2026-08-09T13:00:00.000Z"))).resolves.toBe(false);
  });

  it("acquireJobLock 锁被占用（无 RETURNING 行）时返回 false，不抛异常", async () => {
    const rec = new ExclusiveRecordingQuery();
    rec.responses.push({ rows: [{ _id: "lock:busy" }] }, { rows: [] });
    const db = createPostgresDocumentDb(rec.query, CONFIG, { connect: rec.connect });
    const repo = new CloudBaseAppRepository(REPO_CONFIG, db);
    await expect(repo.jobLocks.acquire("lock:busy", "owner_a", NOW)).resolves.toBe(true);
    await expect(repo.jobLocks.acquire("lock:busy", "owner_b", NOW)).resolves.toBe(false);
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

  it("保存点 ROLLBACK TO 失败且外层未捕获时仍抛业务原异常，不得 COMMIT", async () => {
    const rec = new ExclusiveRecordingQuery();
    rec.responses.push({ rows: [] }, { rows: [] });
    rec.savepointRollbackError = new Error("savepoint rollback failed");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = createPostgresDocumentDb(rec.query, CONFIG, { connect: rec.connect });
    const abort = new Error("savepoint abort");
    await expect(db.transaction(async (outer) => {
      await outer.add(users(), "keep-a", userDoc("keep-a"));
      await outer.transaction(async (inner) => {
        await inner.add(users(), "drop-b", userDoc("drop-b"));
        throw abort;
      });
      await outer.add(users(), "keep-c", userDoc("keep-c"));
    })).rejects.toBe(abort);
    const sql = rec.statements.map((item) => item.sql);
    expect(sql).toContain('ROLLBACK TO SAVEPOINT "vps_sp_1"');
    expect(sql).not.toContain("COMMIT");
    expect(sql).toContain("ROLLBACK");
    expect(JSON.parse(String(spy.mock.calls[0]?.[0]))).toEqual({
      event: "pg_savepoint_recovery_failed",
      message: "savepoint rollback failed",
    });
  });

  it("保存点 ROLLBACK TO 失败时保留业务原异常并不得 COMMIT 部分更改", async () => {
    const rec = new ExclusiveRecordingQuery();
    rec.responses.push({ rows: [] }, { rows: [] });
    rec.savepointRollbackError = new Error("savepoint rollback failed");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = createPostgresDocumentDb(rec.query, CONFIG, { connect: rec.connect });
    const abort = new Error("savepoint abort");
    await expect(db.transaction(async (outer) => {
      await outer.add(users(), "keep-a", userDoc("keep-a"));
      try {
        await outer.transaction(async (inner) => {
          await inner.add(users(), "drop-b", userDoc("drop-b"));
          throw abort;
        });
      } catch (caught) {
        expect(caught).toBe(abort);
        await outer.add(users(), "keep-c", userDoc("keep-c"));
      }
    })).rejects.toBe(abort);
    const sql = rec.statements.map((item) => item.sql);
    expect(sql).toContain('ROLLBACK TO SAVEPOINT "vps_sp_1"');
    expect(sql).not.toContain("COMMIT");
    expect(sql).toContain("ROLLBACK");
    expect(rec.releasedWith).toEqual([undefined]);
    expect(JSON.parse(String(spy.mock.calls[0]?.[0]))).toEqual({
      event: "pg_savepoint_recovery_failed",
      message: "savepoint rollback failed",
    });
  });

  it("保存点 RELEASE 失败时保留业务原异常并不得 COMMIT", async () => {
    const rec = new ExclusiveRecordingQuery();
    rec.responses.push({ rows: [] }, { rows: [] });
    rec.savepointReleaseError = new Error("savepoint release failed");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = createPostgresDocumentDb(rec.query, CONFIG, { connect: rec.connect });
    const abort = new Error("savepoint abort");
    await expect(db.transaction(async (outer) => {
      await outer.add(users(), "keep-a", userDoc("keep-a"));
      try {
        await outer.transaction(async (inner) => {
          await inner.add(users(), "drop-b", userDoc("drop-b"));
          throw abort;
        });
      } catch (caught) {
        expect(caught).toBe(abort);
        await outer.add(users(), "keep-c", userDoc("keep-c"));
      }
    })).rejects.toBe(abort);
    const sql = rec.statements.map((item) => item.sql);
    expect(sql).toContain('ROLLBACK TO SAVEPOINT "vps_sp_1"');
    expect(sql).toContain('RELEASE SAVEPOINT "vps_sp_1"');
    expect(sql).not.toContain("COMMIT");
    expect(sql).toContain("ROLLBACK");
    expect(JSON.parse(String(spy.mock.calls[0]?.[0]))).toEqual({
      event: "pg_savepoint_recovery_failed",
      message: "savepoint release failed",
    });
  });

  it("保存点成功路径 RELEASE 失败也不得 COMMIT，并保留 RELEASE 异常证据", async () => {
    const rec = new ExclusiveRecordingQuery();
    rec.responses.push({ rows: [] }, { rows: [] });
    rec.savepointReleaseError = new Error("savepoint release failed");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = createPostgresDocumentDb(rec.query, CONFIG, { connect: rec.connect });
    await expect(db.transaction(async (outer) => {
      await outer.add(users(), "a", userDoc("a"));
      await outer.transaction(async (inner) => {
        await inner.add(users(), "b", userDoc("b"));
      });
      await outer.add(users(), "c", userDoc("c"));
    })).rejects.toThrow("savepoint release failed");
    const sql = rec.statements.map((item) => item.sql);
    expect(sql).toContain('RELEASE SAVEPOINT "vps_sp_1"');
    expect(sql).not.toContain("COMMIT");
    expect(sql).toContain("ROLLBACK");
    expect(JSON.parse(String(spy.mock.calls[0]?.[0]))).toEqual({
      event: "pg_savepoint_recovery_failed",
      message: "savepoint release failed",
    });
  });

  it("保存点恢复失败后业务抛出新的外层异常时最终显示后者，且不得 COMMIT", async () => {
    const rec = new ExclusiveRecordingQuery();
    rec.responses.push({ rows: [] }, { rows: [] });
    rec.savepointRollbackError = new Error("savepoint rollback failed");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = createPostgresDocumentDb(rec.query, CONFIG, { connect: rec.connect });
    const abort = new Error("savepoint abort");
    const wrapper = new Error("wrapper");
    await expect(db.transaction(async (outer) => {
      try {
        await outer.transaction(async (inner) => {
          await inner.add(users(), "drop-b", userDoc("drop-b"));
          throw abort;
        });
      } catch (caught) {
        expect(caught).toBe(abort);
        throw wrapper;
      }
    })).rejects.toBe(wrapper);
    const sql = rec.statements.map((item) => item.sql);
    expect(sql).toContain('ROLLBACK TO SAVEPOINT "vps_sp_1"');
    expect(sql).not.toContain("COMMIT");
    expect(sql).toContain("ROLLBACK");
    expect(JSON.parse(String(spy.mock.calls[0]?.[0]))).toEqual({
      event: "pg_savepoint_recovery_failed",
      message: "savepoint rollback failed",
    });
  });
});

describe("PostgresSavepointSimulator 同名保存点", () => {
  it("新同名遮蔽旧同名，ROLLBACK TO/RELEASE 找最近项，RELEASE 后较早同名再可见，ROLLBACK TO 保留目标", async () => {
    const sim = new PostgresSavepointSimulator();
    const q = sim.query;
    await q("BEGIN");
    await q("INSERT", ["a", { _id: "a" }]);
    await q('SAVEPOINT "sp"');
    await q("INSERT", ["b", { _id: "b" }]);
    await q('SAVEPOINT "sp"');
    await q("INSERT", ["c", { _id: "c" }]);
    await q('SAVEPOINT "newer"');
    await q("INSERT", ["d", { _id: "d" }]);

    await q('ROLLBACK TO SAVEPOINT "sp"');
    expect((await q("SELECT document", ["a"])).rows).toEqual([{ document: { _id: "a" } }]);
    expect((await q("SELECT document", ["b"])).rows).toEqual([{ document: { _id: "b" } }]);
    expect((await q("SELECT document", ["c"])).rows).toEqual([]);
    expect((await q("SELECT document", ["d"])).rows).toEqual([]);
    await expect(q('ROLLBACK TO SAVEPOINT "newer"')).rejects.toThrow("no such savepoint: newer");

    await q("INSERT", ["e", { _id: "e" }]);
    await q('ROLLBACK TO SAVEPOINT "sp"');
    expect((await q("SELECT document", ["e"])).rows).toEqual([]);
    expect((await q("SELECT document", ["b"])).rows).toEqual([{ document: { _id: "b" } }]);

    await q("INSERT", ["f", { _id: "f" }]);
    await q('RELEASE SAVEPOINT "sp"');
    expect((await q("SELECT document", ["f"])).rows).toEqual([{ document: { _id: "f" } }]);
    await q('ROLLBACK TO SAVEPOINT "sp"');
    expect((await q("SELECT document", ["a"])).rows).toEqual([{ document: { _id: "a" } }]);
    expect((await q("SELECT document", ["b"])).rows).toEqual([]);
    expect((await q("SELECT document", ["f"])).rows).toEqual([]);

    await q('RELEASE SAVEPOINT "sp"');
    await expect(q('ROLLBACK TO SAVEPOINT "sp"')).rejects.toThrow("no such savepoint: sp");
  });
});

describe("PostgresDocumentDb 同级保存点与在途子事务", () => {
  it("同级并发 A 失败 B 成功时，B 的写入不得被 A 的回滚撤销，顶层提交后仅 B 可见", async () => {
    const sim = new PostgresSavepointSimulator();
    const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
    const aHold = defer();
    const aHeld = defer();
    await db.transaction(async (tx) => {
      const a = tx.transaction(async (inner) => {
        await inner.add(users(), "drop-a", userDoc("drop-a"));
        aHeld.resolve();
        await aHold.promise;
        throw new Error("A failed");
      });
      const b = tx.transaction(async (inner) => {
        await inner.add(users(), "keep-b", userDoc("keep-b"));
      });
      await aHeld.promise;
      aHold.resolve();
      const settled = await Promise.allSettled([a, b]);
      expect(settled[0]).toMatchObject({ status: "rejected" });
      expect(settled[1]).toMatchObject({ status: "fulfilled" });
    });
    expect(sim.released).toBe(1);
    expect(sim.statements.some((sql) => /^COMMIT\b/i.test(sql))).toBe(true);
    await expect(db.get(users(), "keep-b")).resolves.toMatchObject({ _id: "keep-b" });
    await expect(db.get(users(), "drop-a")).resolves.toBeNull();
  });

  it("同级并发两个成功分支都提交", async () => {
    const sim = new PostgresSavepointSimulator();
    const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
    await db.transaction(async (tx) => {
      await Promise.all([
        tx.transaction(async (inner) => {
          await inner.add(users(), "keep-a", userDoc("keep-a"));
        }),
        tx.transaction(async (inner) => {
          await inner.add(users(), "keep-b", userDoc("keep-b"));
        }),
      ]);
    });
    await expect(db.get(users(), "keep-a")).resolves.toMatchObject({ _id: "keep-a" });
    await expect(db.get(users(), "keep-b")).resolves.toMatchObject({ _id: "keep-b" });
  });

  it("多层嵌套失败只回滚内层，外层与中间层提交", async () => {
    const sim = new PostgresSavepointSimulator();
    const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
    await db.transaction(async (tx) => {
      await tx.add(users(), "keep-a", userDoc("keep-a"));
      await tx.transaction(async (inner) => {
        await inner.add(users(), "keep-b", userDoc("keep-b"));
        await inner.transaction(async (nested) => {
          await nested.add(users(), "keep-c", userDoc("keep-c"));
        });
        await expect(inner.transaction(async (nested) => {
          await nested.add(users(), "drop-d", userDoc("drop-d"));
          throw new Error("nested fail");
        })).rejects.toThrow("nested fail");
      });
      await tx.add(users(), "keep-e", userDoc("keep-e"));
    });
    await expect(db.get(users(), "keep-a")).resolves.toMatchObject({ _id: "keep-a" });
    await expect(db.get(users(), "keep-b")).resolves.toMatchObject({ _id: "keep-b" });
    await expect(db.get(users(), "keep-c")).resolves.toMatchObject({ _id: "keep-c" });
    await expect(db.get(users(), "drop-d")).resolves.toBeNull();
    await expect(db.get(users(), "keep-e")).resolves.toMatchObject({ _id: "keep-e" });
  });

  it("父对象普通查询与子事务交错不死锁", async () => {
    const sim = new PostgresSavepointSimulator();
    const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
    await db.transaction(async (tx) => {
      await tx.add(users(), "keep-a", userDoc("keep-a"));
      const child = tx.transaction(async (inner) => {
        await inner.add(users(), "keep-b", userDoc("keep-b"));
        return "child";
      });
      await expect(tx.get(users(), "keep-a")).resolves.toMatchObject({ _id: "keep-a" });
      await expect(child).resolves.toBe("child");
    });
    await expect(db.get(users(), "keep-a")).resolves.toMatchObject({ _id: "keep-a" });
    await expect(db.get(users(), "keep-b")).resolves.toMatchObject({ _id: "keep-b" });
  });

  it("子保存点回滚不得撤销父事务并发写入，顶层提交后仅父写入可见", async () => {
    const sim = new PostgresSavepointSimulator();
    const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
    const childHold = defer();
    const childHeld = defer();
    await db.transaction(async (tx) => {
      const child = tx.transaction(async (inner) => {
        await inner.add(users(), "drop-child", userDoc("drop-child"));
        childHeld.resolve();
        await childHold.promise;
        throw new Error("child fail");
      });
      await childHeld.promise;
      const parentWrite = tx.add(users(), "keep-parent", userDoc("keep-parent"));
      childHold.resolve();
      await expect(child).rejects.toThrow("child fail");
      await parentWrite;
    });
    const rollbackAt = sim.statements.findIndex((sql) => /^ROLLBACK TO SAVEPOINT\b/i.test(sql));
    const insertSql = `INSERT INTO "${SCHEMA}"."${users()}" (_id, document) VALUES ($1, $2::jsonb)`;
    const insertsBeforeRollback = rollbackAt < 0
      ? 0
      : sim.statements.slice(0, rollbackAt).filter((sql) => sql === insertSql).length;
    const parentWriteLandedBeforeRollback = insertsBeforeRollback >= 2;
    expect(sim.released).toBe(1);
    expect(sim.statements.some((sql) => /^COMMIT\b/i.test(sql))).toBe(true);
    expect(sim.statements.some((sql) => /^ROLLBACK TO SAVEPOINT\b/i.test(sql))).toBe(true);
    await expect(
      db.get(users(), "keep-parent"),
      parentWriteLandedBeforeRollback
        ? "parent write completed before child savepoint rollback but was not committed"
        : "parent write missing after commit",
    ).resolves.toMatchObject({ _id: "keep-parent" });
    await expect(db.get(users(), "drop-child")).resolves.toBeNull();
  });

  it("外层提前结束时在途子事务不得在 rollback/release 后继续使用连接", async () => {
    const sim = new PostgresSavepointSimulator();
    const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
    const bHold = defer();
    const bStarted = defer();
    let bPromise!: Promise<unknown>;
    const done = db.transaction(async (tx) => {
      bPromise = tx.transaction(async (inner) => {
        bStarted.resolve();
        await bHold.promise;
        await inner.add(users(), "late-b", userDoc("late-b"));
      });
      await bStarted.promise;
      throw new Error("outer abort");
    });
    await expect(done).rejects.toThrow("outer abort");
    expect(sim.released).toBe(1);
    bHold.resolve();
    await expect(bPromise).rejects.toThrow();
    expect(sim.queriesAfterRelease).toBe(0);
    await expect(db.get(users(), "late-b")).resolves.toBeNull();
  });

  it("Promise.all 拒绝时未等待的在途子事务不得在外层结束后写入", async () => {
    const sim = new PostgresSavepointSimulator();
    const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
    const aHold = defer();
    const aHeld = defer();
    let bPromise!: Promise<unknown>;
    const done = db.transaction(async (tx) => {
      const a = tx.transaction(async (inner) => {
        await inner.add(users(), "drop-a", userDoc("drop-a"));
        aHeld.resolve();
        await aHold.promise;
        throw new Error("A failed");
      });
      bPromise = tx.transaction(async (inner) => {
        await inner.add(users(), "late-b", userDoc("late-b"));
      });
      await aHeld.promise;
      aHold.resolve();
      await Promise.all([a, bPromise]);
    });
    await expect(done).rejects.toThrow("A failed");
    expect(sim.released).toBe(1);
    await expect(bPromise).rejects.toThrow();
    expect(sim.queriesAfterRelease).toBe(0);
    await expect(db.get(users(), "drop-a")).resolves.toBeNull();
    await expect(db.get(users(), "late-b")).resolves.toBeNull();
  });

  it("同级子事务失败错误传播到外层并回滚全部写入", async () => {
    const sim = new PostgresSavepointSimulator();
    const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
    await expect(db.transaction(async (tx) => {
      await tx.add(users(), "drop-outer", userDoc("drop-outer"));
      await tx.transaction(async (inner) => {
        await inner.add(users(), "drop-inner", userDoc("drop-inner"));
        throw new Error("inner fail");
      });
    })).rejects.toThrow("inner fail");
    expect(sim.statements.some((sql) => /^COMMIT\b/i.test(sql))).toBe(false);
    expect(sim.statements.some((sql) => /^ROLLBACK\b/i.test(sql) && !/TO SAVEPOINT/i.test(sql))).toBe(true);
    await expect(db.get(users(), "drop-outer")).resolves.toBeNull();
    await expect(db.get(users(), "drop-inner")).resolves.toBeNull();
  });

  it("子事务正常返回后，外层仍运行时以保留的子对象再次 add 应拒绝", async () => {
    const sim = new PostgresSavepointSimulator();
    const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
    let innerDb!: typeof db;
    await db.transaction(async (tx) => {
      await tx.transaction(async (inner) => {
        innerDb = inner as typeof db;
        await inner.add(users(), "keep-inner", userDoc("keep-inner"));
      });
      await expect(innerDb.add(users(), "stale-inner", userDoc("stale-inner"))).rejects.toThrow();
      await expect(tx.get(users(), "stale-inner")).resolves.toBeNull();
    });
    expect(sim.statements.some((sql) => /^COMMIT\b/i.test(sql))).toBe(true);
    await expect(db.get(users(), "keep-inner")).resolves.toMatchObject({ _id: "keep-inner" });
    await expect(db.get(users(), "stale-inner")).resolves.toBeNull();
  });

  it("子事务失败回滚后，外层仍运行时以保留的子对象再次 add 应拒绝", async () => {
    const sim = new PostgresSavepointSimulator();
    const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
    let innerDb!: typeof db;
    await db.transaction(async (tx) => {
      await expect(tx.transaction(async (inner) => {
        innerDb = inner as typeof db;
        await inner.add(users(), "drop-inner", userDoc("drop-inner"));
        throw new Error("inner fail");
      })).rejects.toThrow("inner fail");
      await expect(innerDb.add(users(), "stale-inner", userDoc("stale-inner"))).rejects.toThrow();
      await tx.add(users(), "keep-outer", userDoc("keep-outer"));
      await expect(tx.get(users(), "drop-inner")).resolves.toBeNull();
      await expect(tx.get(users(), "stale-inner")).resolves.toBeNull();
    });
    expect(sim.statements.some((sql) => /^COMMIT\b/i.test(sql))).toBe(true);
    await expect(db.get(users(), "drop-inner")).resolves.toBeNull();
    await expect(db.get(users(), "stale-inner")).resolves.toBeNull();
    await expect(db.get(users(), "keep-outer")).resolves.toMatchObject({ _id: "keep-outer" });
  });

  it("外层成功返回时未等待且卡在门闩的子事务不得被静默提交", async () => {
    const sim = new PostgresSavepointSimulator();
    const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
    const childHold = defer();
    const childHeld = defer();
    let childPromise!: Promise<unknown>;
    const done = db.transaction(async (tx) => {
      childPromise = tx.transaction(async (inner) => {
        await inner.add(users(), "partial-child", userDoc("partial-child"));
        childHeld.resolve();
        await childHold.promise;
        await inner.add(users(), "late-child", userDoc("late-child"));
      });
      await childHeld.promise;
    });
    await childHeld.promise;
    const childObserved = Promise.allSettled([childPromise]);
    const outer = await done.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    childHold.resolve();
    const [child] = await childObserved;
    expect(outer.status).toBe("rejected");
    expect(sim.statements.some((sql) => /^COMMIT\b/i.test(sql))).toBe(false);
    expect(sim.statements.some((sql) => /^ROLLBACK\b/i.test(sql) && !/TO SAVEPOINT/i.test(sql))).toBe(true);
    expect(sim.released).toBe(1);
    expect(child?.status).toBe("rejected");
    expect(sim.queriesAfterRelease).toBe(0);
    await expect(db.get(users(), "partial-child")).resolves.toBeNull();
    await expect(db.get(users(), "late-child")).resolves.toBeNull();
  });

  it("子事务回调 await 外层事务句柄的查询时快速拒绝，不无限死锁", { timeout: 2000 }, async () => {
    const sim = new PostgresSavepointSimulator();
    const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
    await db.transaction(async (tx) => {
      await tx.add(users(), "keep-a", userDoc("keep-a"));
      await expectQuickReject(tx.transaction(async (inner) => {
        await inner.add(users(), "drop-b", userDoc("drop-b"));
        return tx.get(users(), "keep-a");
      }));
      await expect(tx.get(users(), "keep-a")).resolves.toMatchObject({ _id: "keep-a" });
      await expect(tx.get(users(), "drop-b")).resolves.toBeNull();
    });
    expect(sim.released).toBe(1);
    expect(sim.statements.some((sql) => /^COMMIT\b/i.test(sql))).toBe(true);
    await expect(db.get(users(), "keep-a")).resolves.toMatchObject({ _id: "keep-a" });
    await expect(db.get(users(), "drop-b")).resolves.toBeNull();
  });

  it("子事务回调 await 外层事务句柄的 transaction 时快速拒绝，不无限死锁", { timeout: 2000 }, async () => {
    const sim = new PostgresSavepointSimulator();
    const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
    await db.transaction(async (tx) => {
      await tx.add(users(), "keep-a", userDoc("keep-a"));
      await expectQuickReject(tx.transaction(async (inner) => {
        await inner.add(users(), "drop-b", userDoc("drop-b"));
        return tx.transaction(async (sibling) => {
          await sibling.add(users(), "drop-c", userDoc("drop-c"));
        });
      }));
      await expect(tx.get(users(), "keep-a")).resolves.toMatchObject({ _id: "keep-a" });
      await expect(tx.get(users(), "drop-b")).resolves.toBeNull();
      await expect(tx.get(users(), "drop-c")).resolves.toBeNull();
    });
    expect(sim.released).toBe(1);
    expect(sim.statements.some((sql) => /^COMMIT\b/i.test(sql))).toBe(true);
    await expect(db.get(users(), "keep-a")).resolves.toMatchObject({ _id: "keep-a" });
    await expect(db.get(users(), "drop-b")).resolves.toBeNull();
    await expect(db.get(users(), "drop-c")).resolves.toBeNull();
  });

  it("子事务外发起的父查询应等待子事务后正常完成", async () => {
    const sim = new PostgresSavepointSimulator();
    const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
    await db.transaction(async (tx) => {
      await tx.add(users(), "keep-a", userDoc("keep-a"));
      const child = tx.transaction(async (inner) => {
        await inner.add(users(), "keep-b", userDoc("keep-b"));
        return "child";
      });
      await expect(tx.get(users(), "keep-a")).resolves.toMatchObject({ _id: "keep-a" });
      await expect(child).resolves.toBe("child");
    });
    await expect(db.get(users(), "keep-a")).resolves.toMatchObject({ _id: "keep-a" });
    await expect(db.get(users(), "keep-b")).resolves.toMatchObject({ _id: "keep-b" });
  });

  it("父回调经子句柄门闩阻塞查询后，排队孙事务 await child.get 应快速拒绝", { timeout: 2000 }, async () => {
    const sim = new PostgresSavepointSimulator();
    const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
    const queryHeld = defer();
    const queryHold = defer();
    const childReady = defer();
    const queueGrandchild = defer();
    const grandchildQueued = defer();
    sim.sqlGate = async (sql, params) => {
      if (!/^SELECT document\b/i.test(sql) || String(params?.[0]) !== "blocked-child") return;
      queryHeld.resolve();
      await queryHold.promise;
    };
    let childDb!: typeof db;
    let child!: Promise<unknown>;
    let grandchild!: Promise<unknown>;
    let blockedQuery!: Promise<unknown>;
    const outer = db.transaction(async (tx) => {
      await tx.add(users(), "keep-a", userDoc("keep-a"));
      child = tx.transaction(async (inner) => {
        childDb = inner as typeof db;
        childReady.resolve();
        await queueGrandchild.promise;
        grandchild = inner.transaction(async () => childDb.get(users(), "keep-a"));
        ignoreRejection(grandchild);
        grandchildQueued.resolve();
        await expectQuickReject(grandchild);
      });
      ignoreRejection(child);
      await childReady.promise;
      blockedQuery = childDb.get(users(), "blocked-child");
      ignoreRejection(blockedQuery);
      await queryHeld.promise;
      queueGrandchild.resolve();
      await grandchildQueued.promise;
      queryHold.resolve();
      await expectQuickReject(grandchild);
      const childResult = await settleWithin(child, DEADLOCK_TIMEOUT_MS);
      if (childResult.status === "rejected" && isDeadlockTimeout(childResult.reason)) {
        throw childResult.reason;
      }
      await expect(tx.get(users(), "keep-a")).resolves.toMatchObject({ _id: "keep-a" });
    });
    ignoreRejection(outer);
    try {
      const result = await settleWithin(outer, DEADLOCK_TIMEOUT_MS);
      if (result.status === "rejected") {
        if (isDeadlockTimeout(result.reason)) throw result.reason;
        throw result.reason;
      }
      const blocked = await settleWithin(blockedQuery, DEADLOCK_TIMEOUT_MS);
      if (blocked.status === "rejected" && isDeadlockTimeout(blocked.reason)) throw blocked.reason;
      expect(sim.released).toBe(1);
      expect(sim.statements.some((sql) => /^COMMIT\b/i.test(sql))).toBe(true);
      await expect(db.get(users(), "keep-a")).resolves.toMatchObject({ _id: "keep-a" });
    } finally {
      queryHold.resolve();
      queueGrandchild.resolve();
      grandchildQueued.resolve();
      childReady.resolve();
    }
  });

  it("父回调取得运行中子句柄后从父作用域启动孙事务，孙回调 await child.get 应快速拒绝", { timeout: 2000 }, async () => {
    const sim = new PostgresSavepointSimulator();
    const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
    const childHeld = defer();
    const childHold = defer();
    let childDb!: typeof db;
    let child!: Promise<unknown>;
    let grandchild!: Promise<unknown>;
    const outer = db.transaction(async (tx) => {
      await tx.add(users(), "keep-a", userDoc("keep-a"));
      child = tx.transaction(async (inner) => {
        childDb = inner as typeof db;
        childHeld.resolve();
        await childHold.promise;
      });
      ignoreRejection(child);
      await childHeld.promise;
      grandchild = childDb.transaction(async () => childDb.get(users(), "keep-a"));
      ignoreRejection(grandchild);
      await expectQuickReject(grandchild);
      childHold.resolve();
      const childResult = await settleWithin(child, DEADLOCK_TIMEOUT_MS);
      if (childResult.status === "rejected" && isDeadlockTimeout(childResult.reason)) {
        throw childResult.reason;
      }
      await expect(tx.get(users(), "keep-a")).resolves.toMatchObject({ _id: "keep-a" });
    });
    ignoreRejection(outer);
    try {
      const result = await settleWithin(outer, DEADLOCK_TIMEOUT_MS);
      if (result.status === "rejected") {
        if (isDeadlockTimeout(result.reason)) throw result.reason;
        throw result.reason;
      }
      expect(sim.released).toBe(1);
      expect(sim.statements.some((sql) => /^COMMIT\b/i.test(sql))).toBe(true);
      await expect(db.get(users(), "keep-a")).resolves.toMatchObject({ _id: "keep-a" });
    } finally {
      childHold.resolve();
      childHeld.resolve();
    }
  });

  it("事务A子回调启动独立事务B，B回调 await A句柄应快速拒绝且两事务都能结束", { timeout: 2000 }, async () => {
    const clients: Array<{ released: boolean }> = [];
    const connect: PostgresConnectFn = async () => {
      const client = { released: false };
      clients.push(client);
      return {
        query: async (sql: string) => {
          if (client.released) throw new Error("connection released");
          if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT)\b/i.test(sql)) {
            return { rows: [] };
          }
          return { rows: [] };
        },
        release: () => {
          client.released = true;
        },
      };
    };
    const db = createPostgresDocumentDb(async () => ({ rows: [] }), CONFIG, { connect });
    let bPromise!: Promise<unknown>;
    const aPromise = db.transaction(async (txA) => {
      await txA.add(users(), "keep-a", userDoc("keep-a"));
      await txA.transaction(async () => {
        bPromise = db.transaction(async () => txA.get(users(), "keep-a"));
        ignoreRejection(bPromise);
        await expectQuickReject(bPromise);
      });
    });
    ignoreRejection(aPromise);
    try {
      const aResult = await settleWithin(aPromise, DEADLOCK_TIMEOUT_MS);
      const bResult = bPromise === undefined
        ? { status: "rejected" as const, reason: new Error("transaction B was not started") }
        : await settleWithin(bPromise, DEADLOCK_TIMEOUT_MS);
      if (aResult.status === "rejected" && isDeadlockTimeout(aResult.reason)) throw aResult.reason;
      if (bResult.status === "rejected" && isDeadlockTimeout(bResult.reason)) throw bResult.reason;
      expect(bResult.status).toBe("rejected");
      expect(clients.length).toBe(2);
      expect(clients.every((client) => client.released)).toBe(true);
    } finally {
      ignoreRejection(aPromise);
      if (bPromise !== undefined) ignoreRejection(bPromise);
    }
  });

  it("外层事务 A 启动独立事务 B，A 当前队列空闲时 B 回调使用 A 句柄查询应成功", { timeout: 2000 }, async () => {
    const connections: PostgresSavepointSimulator[] = [];
    const connect: PostgresConnectFn = async () => {
      const sim = new PostgresSavepointSimulator();
      connections.push(sim);
      return sim.connect();
    };
    const db = createPostgresDocumentDb(async () => ({ rows: [] }), CONFIG, { connect });
    await db.transaction(async (txA) => {
      await txA.add(users(), "keep-a", userDoc("keep-a"));
      const fromB = await db.transaction(async () => txA.get(users(), "keep-a"));
      expect(fromB).toMatchObject({ _id: "keep-a" });
    });
    expect(connections).toHaveLength(2);
    expect(connections.every((client) => client.released === 1)).toBe(true);
    expect(connections[0]?.executed).toEqual([
      "BEGIN",
      `INSERT INTO "${SCHEMA}"."${users()}" (_id, document) VALUES ($1, $2::jsonb)`,
      `SELECT document FROM "${SCHEMA}"."${users()}" WHERE _id = $1`,
      "COMMIT",
    ]);
    expect(connections[1]?.executed).toEqual([
      "BEGIN",
      "COMMIT",
    ]);
  });

  it("子事务中创建延迟任务，保存点 RELEASE 后外层 COMMIT 前调用父句柄应成功", { timeout: 2000 }, async () => {
    const sim = new PostgresSavepointSimulator();
    const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
    const gate = defer();
    let deferred!: Promise<unknown>;
    await db.transaction(async (tx) => {
      await tx.add(users(), "keep-a", userDoc("keep-a"));
      await tx.transaction(async (inner) => {
        await inner.add(users(), "keep-b", userDoc("keep-b"));
        deferred = gate.promise.then(() => tx.get(users(), "keep-a"));
        ignoreRejection(deferred);
      });
      expect(sim.executed.some((sql) => /^RELEASE SAVEPOINT\b/i.test(sql))).toBe(true);
      expect(sim.executed.some((sql) => /^COMMIT\b/i.test(sql))).toBe(false);
      gate.resolve();
      await expect(deferred).resolves.toMatchObject({ _id: "keep-a" });
    });
    expect(sim.released).toBe(1);
    expect(sim.executed).toEqual([
      "BEGIN",
      `INSERT INTO "${SCHEMA}"."${users()}" (_id, document) VALUES ($1, $2::jsonb)`,
      'SAVEPOINT "vps_sp_1"',
      `INSERT INTO "${SCHEMA}"."${users()}" (_id, document) VALUES ($1, $2::jsonb)`,
      'RELEASE SAVEPOINT "vps_sp_1"',
      `SELECT document FROM "${SCHEMA}"."${users()}" WHERE _id = $1`,
      "COMMIT",
    ]);
    await expect(db.get(users(), "keep-a")).resolves.toMatchObject({ _id: "keep-a" });
    await expect(db.get(users(), "keep-b")).resolves.toMatchObject({ _id: "keep-b" });
  });

  it("query 函数同步抛错时事务回滚并释放连接，保留原异常且不得挂起", { timeout: 2000 }, async () => {
    const boom = new Error("sync query boom");
    const statements: string[] = [];
    let released = 0;
    const connect: PostgresConnectFn = async () => ({
      query: ((sql: string) => {
        statements.push(sql);
        if (/^BEGIN\b/i.test(sql)) return Promise.resolve({ rows: [] });
        if (/^ROLLBACK\b/i.test(sql)) return Promise.resolve({ rows: [] });
        if (/^COMMIT\b/i.test(sql)) return Promise.resolve({ rows: [], command: "COMMIT" });
        throw boom;
      }) as PostgresQueryFn,
      release: () => {
        released += 1;
      },
    });
    const db = createPostgresDocumentDb(async () => ({ rows: [] }), CONFIG, { connect });
    const done = db.transaction(async (tx) => {
      await tx.add(users(), "a", userDoc("a"));
      return "ok";
    });
    ignoreRejection(done);
    const result = await settleWithin(done, DEADLOCK_TIMEOUT_MS);
    if (result.status === "fulfilled") {
      throw new Error("expected rejection, but the operation fulfilled");
    }
    if (isDeadlockTimeout(result.reason)) throw result.reason;
    expect(result.reason).toBe(boom);
    expect(statements.some((sql) => /^ROLLBACK\b/i.test(sql) && !/TO SAVEPOINT/i.test(sql))).toBe(true);
    expect(statements.some((sql) => /^COMMIT\b/i.test(sql))).toBe(false);
    expect(released).toBe(1);
  });

  async function expectUnawaitedChildSqlBlockedAfterScopeEnd(mode: "return" | "throw"): Promise<void> {
    const sim = new PostgresSavepointSimulator();
    const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
    const { held, hold } = holdInsertId(sim, "hung-child");
    const childOps: Array<Promise<unknown>> = [];
    const done = db.transaction(async (tx) => {
      const child = tx.transaction(async (inner) => {
        const first = inner.add(users(), "hung-child", userDoc("hung-child"));
        const second = inner.add(users(), "queued-child", userDoc("queued-child"));
        ignoreRejection(first);
        ignoreRejection(second);
        childOps.push(first, second);
        if (mode === "throw") throw new Error("child callback abort");
      });
      await expectQuickReject(child);
      await expect(tx.get(users(), "hung-child")).resolves.toBeNull();
      await expect(tx.get(users(), "queued-child")).resolves.toBeNull();
    });
    const heldResult = await settleWithin(held.promise, DEADLOCK_TIMEOUT_MS);
    hold.resolve();
    if (heldResult.status === "rejected") {
      if (isDeadlockTimeout(heldResult.reason)) throw heldResult.reason;
      throw heldResult.reason;
    }
    const [first, second, outer] = await Promise.all([
      settleWithin(childOps[0]!, DEADLOCK_TIMEOUT_MS),
      settleWithin(childOps[1]!, DEADLOCK_TIMEOUT_MS),
      settleWithin(done, DEADLOCK_TIMEOUT_MS),
    ]);
    if (first.status === "rejected" && isDeadlockTimeout(first.reason)) throw first.reason;
    if (second.status === "rejected" && isDeadlockTimeout(second.reason)) throw second.reason;
    if (outer.status === "rejected") {
      if (isDeadlockTimeout(outer.reason)) throw outer.reason;
      throw outer.reason;
    }
    expect(second.status).toBe("rejected");
    expect(sim.released).toBe(1);
    expect(sim.executed.some((sql) => /^COMMIT\b/i.test(sql))).toBe(true);
    expect(insertsAfterSavepointClose(sim.executed)).toEqual([]);
    await expect(db.get(users(), "hung-child")).resolves.toBeNull();
    await expect(db.get(users(), "queued-child")).resolves.toBeNull();
  }

  it("子回调发出两条未等待操作，成功提前返回时不得在 RELEASE/ROLLBACK 后执行子 SQL", { timeout: 2000 }, async () => {
    await expectUnawaitedChildSqlBlockedAfterScopeEnd("return");
  });

  it("子回调发出两条未等待操作，抛错路径也不得在 RELEASE/ROLLBACK 后执行子 SQL", { timeout: 2000 }, async () => {
    await expectUnawaitedChildSqlBlockedAfterScopeEnd("throw");
  });

  it("同一事务并发 reserveCounter 与嵌套读取不得观察 ENSURE 与 UPDATE 之间的状态", { timeout: 2000 }, async () => {
    const sim = new PostgresSavepointSimulator();
    const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
    const id = "c-reserve-gap";
    const initial: CloudBaseDocument = { _id: id, request_count: 0 };
    const { held, hold } = holdInsertId(sim, id);
    let nestedDocument: CloudBaseDocument | null | undefined;
    let nestedCount: number | undefined;
    const done = db.transaction(async (tx) => {
      const reserved = tx.reserveCounter!(usage(), id, "request_count", 5, initial);
      ignoreRejection(reserved);
      const heldResult = await settleWithin(held.promise, DEADLOCK_TIMEOUT_MS);
      if (heldResult.status === "rejected") {
        hold.resolve();
        if (isDeadlockTimeout(heldResult.reason)) throw heldResult.reason;
        throw heldResult.reason;
      }
      const nested = tx.transaction(async (inner) => {
        nestedDocument = await inner.get(usage(), id);
        nestedCount = await inner.getCounter!(usage(), id, "request_count");
      });
      hold.resolve();
      await expect(reserved).resolves.toBe(true);
      await nested;
    });
    ignoreRejection(done);
    try {
      const result = await settleWithin(done, DEADLOCK_TIMEOUT_MS);
      if (result.status === "rejected") {
        if (isDeadlockTimeout(result.reason)) throw result.reason;
        throw result.reason;
      }
    } finally {
      hold.resolve();
    }

    const executed = sim.executed;
    const ensureAt = executed.findIndex((sql) => /^INSERT\b/i.test(sql) && /ON CONFLICT/i.test(sql));
    const updateAt = executed.findIndex((sql) => /^UPDATE\b/i.test(sql) && /jsonb_set/i.test(sql));
    const savepointAt = executed.findIndex((sql) => /^SAVEPOINT\b/i.test(sql));
    const selectAt = executed.findIndex((sql) => /^SELECT document\b/i.test(sql));
    const releaseAt = executed.findIndex((sql) => /^RELEASE SAVEPOINT\b/i.test(sql));
    const interleavedEnsureAndUpdate = ensureAt >= 0
      && savepointAt > ensureAt
      && selectAt > savepointAt
      && releaseAt > selectAt
      && updateAt > releaseAt;
    expect(
      interleavedEnsureAndUpdate,
      `SQL 顺序不得为 INSERT→SAVEPOINT→SELECT→RELEASE→UPDATE，实际: ${executed.join(" → ")}`,
    ).toBe(false);

    const completeBefore = nestedDocument === null && nestedCount === 0;
    const completeAfter = nestedDocument?.request_count === 1 && nestedCount === 1;
    expect(nestedDocument?.request_count === 0).toBe(false);
    expect(completeBefore || completeAfter).toBe(true);
    if (selectAt < ensureAt) {
      expect(completeBefore).toBe(true);
    } else {
      expect(updateAt).toBeGreaterThan(-1);
      expect(selectAt).toBeGreaterThan(updateAt);
      expect(completeAfter).toBe(true);
    }
     expect(sim.released).toBe(1);
     expect(executed.some((sql) => /^COMMIT\b/i.test(sql))).toBe(true);
     await expect(db.getCounter!(usage(), id, "request_count")).resolves.toBe(1);
   });

   it("子事务未等待 reserveCounter，ENSURE 阻塞后抛业务异常，外层捕获提交后计数器回滚", { timeout: 2000 }, async () => {
     const sim = new PostgresSavepointSimulator();
     const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
     const id = "c-ensure-abort";
     const initial: CloudBaseDocument = { _id: id, request_count: 0 };
     sim.seed(id, initial);
     await expect(db.getCounter!(usage(), id, "request_count")).resolves.toBe(0);

     const held = defer();
     const hold = defer();
     let blockedFirstEnsure = false;
     sim.sqlGate = async (sql, params) => {
       if (blockedFirstEnsure) return;
       if (!/^INSERT\b/i.test(sql) || !/ON CONFLICT/i.test(sql) || String(params?.[0]) !== id) return;
       blockedFirstEnsure = true;
       held.resolve();
       await hold.promise;
     };

      const abort = new Error("business abort");
      let reserved: Promise<boolean> | undefined;
      let child: Promise<unknown> | undefined;
      let caught: unknown;
      let innerCount: number | undefined;
      const done = db.transaction(async (tx) => {
        child = tx.transaction(async (inner) => {
          reserved = inner.reserveCounter!(usage(), id, "request_count", 5, initial);
          ignoreRejection(reserved);
          await held.promise;
          throw abort;
        });
        ignoreRejection(child);
        const heldResult = await settleWithin(held.promise, DEADLOCK_TIMEOUT_MS);
        if (heldResult.status === "rejected") {
          hold.resolve();
          if (isDeadlockTimeout(heldResult.reason)) throw heldResult.reason;
          throw heldResult.reason;
        }
        hold.resolve();
        const childResult = await settleWithin(child, DEADLOCK_TIMEOUT_MS);
        if (childResult.status === "fulfilled") {
          throw new Error("expected nested transaction to reject");
        }
        if (isDeadlockTimeout(childResult.reason)) throw childResult.reason;
        caught = childResult.reason;
        if (reserved === undefined) throw new Error("reserveCounter was not started");
        const reservedResult = await settleWithin(reserved, DEADLOCK_TIMEOUT_MS);
        if (reservedResult.status === "rejected" && isDeadlockTimeout(reservedResult.reason)) {
          throw reservedResult.reason;
        }
        innerCount = await tx.getCounter!(usage(), id, "request_count");
      });
      ignoreRejection(done);
      try {
        const result = await settleWithin(done, DEADLOCK_TIMEOUT_MS);
        if (result.status === "rejected") {
          if (isDeadlockTimeout(result.reason)) throw result.reason;
          throw result.reason;
        }
      } finally {
        hold.resolve();
        held.resolve();
      }

      const executed = sim.executed;
      const sqlTrace = executed.join(" → ");
      expect(caught, `业务异常未保留, SQL: ${sqlTrace}`).toBe(abort);
      const rollbackAt = executed.findIndex((sql) => /^ROLLBACK TO SAVEPOINT\b/i.test(sql));
      expect(rollbackAt, `missing ROLLBACK TO, SQL: ${sqlTrace}`).toBeGreaterThan(-1);
      const afterRollback = executed.slice(rollbackAt + 1);
      expect(
        afterRollback.filter((sql) => /^UPDATE\b/i.test(sql) && /jsonb_set/i.test(sql)),
        `不得在 ROLLBACK TO 之后发 UPDATE，SQL: ${sqlTrace}`,
      ).toEqual([]);
      expect(sim.queriesAfterRelease, `连接释放后仍发 SQL, SQL: ${sqlTrace}`).toBe(0);
      expect(sim.released).toBe(1);
      expect(executed.some((sql) => /^COMMIT\b/i.test(sql)), `外层未提交, SQL: ${sqlTrace}`).toBe(true);
      expect(innerCount, `子计数器变化未回滚 (tx内=${innerCount}), SQL: ${sqlTrace}`).toBe(0);
      await expect(db.getCounter!(usage(), id, "request_count")).resolves.toBe(0);
   });

   it("子事务未等待 reserveCounter，UPDATE 阻塞后抛业务异常，外层捕获提交后计数器回滚", { timeout: 2000 }, async () => {
     const sim = new PostgresSavepointSimulator();
     const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
     const id = "c-update-abort";
     const initial: CloudBaseDocument = { _id: id, request_count: 0 };
     const { held, hold } = holdMatchingSql(sim, (sql, params) =>
       isReserveUpdateSql(sql) && String(params?.[0]) === id,
     );
     const abort = new Error("business abort");
     let reserved: Promise<boolean> | undefined;
     let caught: unknown;
     let innerCount: number | undefined;
     const done = db.transaction(async (tx) => {
       const child = tx.transaction(async (inner) => {
         reserved = inner.reserveCounter!(usage(), id, "request_count", 5, initial);
         ignoreRejection(reserved);
         await held.promise;
         throw abort;
       });
       ignoreRejection(child);
       const heldResult = await settleWithin(held.promise, DEADLOCK_TIMEOUT_MS);
       if (heldResult.status === "rejected") {
         hold.resolve();
         if (isDeadlockTimeout(heldResult.reason)) throw heldResult.reason;
         throw heldResult.reason;
       }
       hold.resolve();
       const childResult = await settleWithin(child, DEADLOCK_TIMEOUT_MS);
       if (childResult.status === "fulfilled") {
         throw new Error("expected nested transaction to reject");
       }
       if (isDeadlockTimeout(childResult.reason)) throw childResult.reason;
       caught = childResult.reason;
       if (reserved === undefined) throw new Error("reserveCounter was not started");
       const reservedResult = await settleWithin(reserved, DEADLOCK_TIMEOUT_MS);
       if (reservedResult.status === "rejected" && isDeadlockTimeout(reservedResult.reason)) {
         throw reservedResult.reason;
       }
       innerCount = await tx.getCounter!(usage(), id, "request_count");
     });
     ignoreRejection(done);
     try {
       const result = await settleWithin(done, DEADLOCK_TIMEOUT_MS);
       if (result.status === "rejected") {
         if (isDeadlockTimeout(result.reason)) throw result.reason;
         throw result.reason;
       }
     } finally {
       hold.resolve();
       held.resolve();
     }

     const executed = sim.executed;
     const sqlTrace = executed.join(" → ");
     expect(caught, `业务异常未保留, SQL: ${sqlTrace}`).toBe(abort);
     expect(reserveUpdatesAfterRollback(executed), `不得在 ROLLBACK 后发 UPDATE，SQL: ${sqlTrace}`).toEqual([]);
     expect(sim.queriesAfterRelease, `连接释放后仍发 SQL, SQL: ${sqlTrace}`).toBe(0);
     expect(sim.released).toBe(1);
     expect(executed.some((sql) => /^COMMIT\b/i.test(sql)), `外层未提交, SQL: ${sqlTrace}`).toBe(true);
     expect(innerCount, `子计数器变化未回滚 (tx内=${innerCount}), SQL: ${sqlTrace}`).toBe(0);
     await expect(db.getCounter!(usage(), id, "request_count")).resolves.toBe(0);
   });

   it("外层提前返回时未等待 reserveCounter，ENSURE 阻塞后不得在 ROLLBACK 后发 UPDATE", { timeout: 2000 }, async () => {
     const sim = new PostgresSavepointSimulator();
     const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
     const id = "c-outer-return-ensure";
     const initial: CloudBaseDocument = { _id: id, request_count: 0 };
     const { held, hold } = holdMatchingSql(sim, (sql, params) =>
       /^INSERT\b/i.test(sql) && /ON CONFLICT/i.test(sql) && String(params?.[0]) === id,
     );
     let reserved: Promise<boolean> | undefined;
     const done = db.transaction(async (tx) => {
       reserved = tx.reserveCounter!(usage(), id, "request_count", 5, initial);
       ignoreRejection(reserved);
       await held.promise;
     });
     ignoreRejection(done);
     try {
       const heldResult = await settleWithin(held.promise, DEADLOCK_TIMEOUT_MS);
       if (heldResult.status === "rejected") {
         hold.resolve();
         if (isDeadlockTimeout(heldResult.reason)) throw heldResult.reason;
         throw heldResult.reason;
       }
       hold.resolve();
       const result = await settleWithin(done, DEADLOCK_TIMEOUT_MS);
       if (result.status === "rejected" && isDeadlockTimeout(result.reason)) throw result.reason;
       expect(result.status, `外层应拒绝未等待工作, SQL: ${sim.executed.join(" → ")}`).toBe("rejected");
       if (reserved === undefined) throw new Error("reserveCounter was not started");
       const reservedResult = await settleWithin(reserved, DEADLOCK_TIMEOUT_MS);
       if (reservedResult.status === "rejected" && isDeadlockTimeout(reservedResult.reason)) {
         throw reservedResult.reason;
       }
     } finally {
       hold.resolve();
       held.resolve();
     }

     const executed = sim.executed;
     const sqlTrace = executed.join(" → ");
     expect(reserveUpdatesAfterRollback(executed), `不得在 ROLLBACK 后发 UPDATE，SQL: ${sqlTrace}`).toEqual([]);
     expect(sim.queriesAfterRelease, `连接释放后仍发 SQL, SQL: ${sqlTrace}`).toBe(0);
     expect(sim.released).toBe(1);
     expect(executed.some((sql) => /^COMMIT\b/i.test(sql)), `外层不得提交, SQL: ${sqlTrace}`).toBe(false);
     expect(executed.some((sql) => /^ROLLBACK\b/i.test(sql) && !/TO SAVEPOINT/i.test(sql)), `外层未 ROLLBACK, SQL: ${sqlTrace}`).toBe(true);
     await expect(db.getCounter!(usage(), id, "request_count")).resolves.toBe(0);
   });

   it("外层抛错时未等待 reserveCounter，UPDATE 阻塞后不得在 ROLLBACK 后发 UPDATE", { timeout: 2000 }, async () => {
     const sim = new PostgresSavepointSimulator();
     const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
     const id = "c-outer-throw-update";
     const initial: CloudBaseDocument = { _id: id, request_count: 0 };
     const { held, hold } = holdMatchingSql(sim, (sql, params) =>
       isReserveUpdateSql(sql) && String(params?.[0]) === id,
     );
     const abort = new Error("outer abort");
     let reserved: Promise<boolean> | undefined;
     const done = db.transaction(async (tx) => {
       reserved = tx.reserveCounter!(usage(), id, "request_count", 5, initial);
       ignoreRejection(reserved);
       await held.promise;
       throw abort;
     });
     ignoreRejection(done);
     try {
       const heldResult = await settleWithin(held.promise, DEADLOCK_TIMEOUT_MS);
       if (heldResult.status === "rejected") {
         hold.resolve();
         if (isDeadlockTimeout(heldResult.reason)) throw heldResult.reason;
         throw heldResult.reason;
       }
       hold.resolve();
       const result = await settleWithin(done, DEADLOCK_TIMEOUT_MS);
       if (result.status === "fulfilled") {
         throw new Error("expected outer transaction to reject");
       }
       if (isDeadlockTimeout(result.reason)) throw result.reason;
       expect(result.reason).toBe(abort);
       if (reserved === undefined) throw new Error("reserveCounter was not started");
       const reservedResult = await settleWithin(reserved, DEADLOCK_TIMEOUT_MS);
       if (reservedResult.status === "rejected" && isDeadlockTimeout(reservedResult.reason)) {
         throw reservedResult.reason;
       }
     } finally {
       hold.resolve();
       held.resolve();
     }

     const executed = sim.executed;
     const sqlTrace = executed.join(" → ");
     expect(reserveUpdatesAfterRollback(executed), `不得在 ROLLBACK 后发 UPDATE，SQL: ${sqlTrace}`).toEqual([]);
     expect(sim.queriesAfterRelease, `连接释放后仍发 SQL, SQL: ${sqlTrace}`).toBe(0);
     expect(sim.released).toBe(1);
     expect(executed.some((sql) => /^COMMIT\b/i.test(sql)), `外层不得提交, SQL: ${sqlTrace}`).toBe(false);
     expect(executed.some((sql) => /^ROLLBACK\b/i.test(sql) && !/TO SAVEPOINT/i.test(sql)), `外层未 ROLLBACK, SQL: ${sqlTrace}`).toBe(true);
     await expect(db.getCounter!(usage(), id, "request_count")).resolves.toBe(0);
   });

   it("子事务排队中的 reserveCounter 在作用域关闭时取消，不得再发计数器 SQL", { timeout: 2000 }, async () => {
     const sim = new PostgresSavepointSimulator();
     const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
     const id = "c-queued-cancel";
     const initial: CloudBaseDocument = { _id: id, request_count: 0 };
     const { held, hold } = holdInsertId(sim, "hung-child");
     const abort = new Error("child abort");
     let reserved: Promise<boolean> | undefined;
     let caught: unknown;
     const done = db.transaction(async (tx) => {
       const child = tx.transaction(async (inner) => {
         const first = inner.add(users(), "hung-child", userDoc("hung-child"));
         reserved = inner.reserveCounter!(usage(), id, "request_count", 5, initial);
         ignoreRejection(first);
         ignoreRejection(reserved);
         await held.promise;
         throw abort;
       });
       ignoreRejection(child);
       const heldResult = await settleWithin(held.promise, DEADLOCK_TIMEOUT_MS);
       if (heldResult.status === "rejected") {
         hold.resolve();
         if (isDeadlockTimeout(heldResult.reason)) throw heldResult.reason;
         throw heldResult.reason;
       }
       hold.resolve();
       const childResult = await settleWithin(child, DEADLOCK_TIMEOUT_MS);
       if (childResult.status === "fulfilled") {
         throw new Error("expected nested transaction to reject");
       }
       if (isDeadlockTimeout(childResult.reason)) throw childResult.reason;
       caught = childResult.reason;
       if (reserved === undefined) throw new Error("reserveCounter was not started");
       const reservedResult = await settleWithin(reserved, DEADLOCK_TIMEOUT_MS);
       if (reservedResult.status === "fulfilled") {
         throw new Error("expected queued reserveCounter to reject");
       }
       if (isDeadlockTimeout(reservedResult.reason)) throw reservedResult.reason;
     });
     ignoreRejection(done);
     try {
       const result = await settleWithin(done, DEADLOCK_TIMEOUT_MS);
       if (result.status === "rejected") {
         if (isDeadlockTimeout(result.reason)) throw result.reason;
         throw result.reason;
       }
     } finally {
       hold.resolve();
       held.resolve();
     }

     const executed = sim.executed;
     const sqlTrace = executed.join(" → ");
     expect(caught, `业务异常未保留, SQL: ${sqlTrace}`).toBe(abort);
     expect(executed.some((sql) => /^INSERT\b/i.test(sql) && /ON CONFLICT/i.test(sql)), `排队 ENSURE 不应执行, SQL: ${sqlTrace}`).toBe(false);
     expect(executed.some((sql) => isReserveUpdateSql(sql)), `排队 UPDATE 不应执行, SQL: ${sqlTrace}`).toBe(false);
     expect(sim.queriesAfterRelease, `连接释放后仍发 SQL, SQL: ${sqlTrace}`).toBe(0);
     expect(sim.released).toBe(1);
     expect(executed.some((sql) => /^COMMIT\b/i.test(sql)), `外层未提交, SQL: ${sqlTrace}`).toBe(true);
     await expect(db.getCounter!(usage(), id, "request_count")).resolves.toBe(0);
     await expect(db.get(users(), "hung-child")).resolves.toBeNull();
   });

   it("子事务正常 await reserveCounter 后外层提交，计数器自增可见", { timeout: 2000 }, async () => {
     const sim = new PostgresSavepointSimulator();
     const db = createPostgresDocumentDb(sim.query, CONFIG, { connect: sim.connect });
     const id = "c-await-ok";
     const initial: CloudBaseDocument = { _id: id, request_count: 0 };
     await db.transaction(async (tx) => {
       await tx.transaction(async (inner) => {
         await expect(inner.reserveCounter!(usage(), id, "request_count", 5, initial)).resolves.toBe(true);
       });
       await expect(tx.getCounter!(usage(), id, "request_count")).resolves.toBe(1);
     });
     const sqlTrace = sim.executed.join(" → ");
     expect(sim.released).toBe(1);
     expect(sim.executed.some((sql) => /^COMMIT\b/i.test(sql)), `外层未提交, SQL: ${sqlTrace}`).toBe(true);
     expect(sim.executed.some((sql) => /^ROLLBACK TO SAVEPOINT\b/i.test(sql)), `正常路径不应 ROLLBACK TO, SQL: ${sqlTrace}`).toBe(false);
     expect(sim.queriesAfterRelease).toBe(0);
     await expect(db.getCounter!(usage(), id, "request_count")).resolves.toBe(1);
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

  it("stale_recovery 在 Postgres SQL 中下推 superseded_by IS NULL (A-S3-08)", async () => {
    const rec = new RecordingQuery();
    rec.responses = [{ rows: [] }, { rows: [] }];
    const db = createPostgresDocumentDb(rec.query, CONFIG);
    const repo = new CloudBaseAppRepository(REPO_CONFIG, db);
    await repo.matches.findActiveWindow({ jobType: "stale_recovery", now: NOW, limit: 10 });
    const queries = rec.statements.filter((item) => item.sql.includes(`"${matches()}"`));
    expect(queries).toHaveLength(2);
    for (const q of queries) {
      expect(q.sql).toContain(`(${postgresDocumentFieldExpr(SCHEMA, "matches", "superseded_by")}) IS NULL`);
    }
  });

  it("[A-S2-05] crowd count 单条 GROUP BY derived_result 聚合查询，零全量扫描", async () => {
    const rec = new RecordingQuery();
    rec.responses.push({
      rows: [
        { derived_result: "HOME", count: 2 },
        { derived_result: "DRAW", count: 1 },
      ],
    });
    const db = createPostgresDocumentDb(rec.query, CONFIG);
    const repo = new CloudBaseAppRepository(REPO_CONFIG, db);
    await expect(repo.predictions.countByMatchGroupedByResult("match-id")).resolves.toEqual({
      HOME: 2,
      DRAW: 1,
      AWAY: 0,
    });
    expect(rec.statements).toHaveLength(1);
    const canonicalExpr = postgresDocumentFieldExpr(SCHEMA, "predictions", "canonical_match_id");
    const resultExpr = postgresDocumentFieldExpr(SCHEMA, "predictions", "derived_result");
    expect(rec.statements[0]?.sql).toBe(
      `SELECT ${resultExpr} AS derived_result, COUNT(*)::int AS count FROM "${SCHEMA}"."${predictions()}" WHERE ${canonicalExpr} = $1 GROUP BY ${resultExpr}`,
    );
    expect(rec.statements[0]?.params).toEqual(["match-id"]);
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

describe("PostgresDocumentDb.deleteWhere & ltFilter [Slice 5.4]", () => {
  it("compiles DELETE FROM with ltFilter and forwards rowCount via createPostgresQueryFn", async () => {
    const cutoff = new Date("2026-06-01T00:00:00.000Z");
    const compiled = compilePostgresDocumentDelete(CONFIG, "ft_sync_logs", {
      started_at: { [POSTGRES_LT_OP]: cutoff },
    });
    expect(compiled.sql).toBe(
      `DELETE FROM "football_test"."ft_sync_logs" WHERE ${postgresDocumentFieldExpr(CONFIG.schema, "sync_logs", "started_at")} < $1::timestamptz`,
    );
    expect(compiled.params).toEqual([cutoff.toISOString()]);

    const client = {
      query: vi.fn(async () => ({ rows: [], command: "DELETE", rowCount: 7 })),
    };
    const db = createPostgresDocumentDb(createPostgresQueryFn(client), CONFIG);
    const deleted = await db.deleteWhere("ft_sync_logs", db.ltFilter("started_at", cutoff));
    expect(deleted).toBe(7);
    expect(client.query).toHaveBeenCalledWith(compiled.sql, compiled.params);
  });

  it("compiles bounded DELETE FROM with subquery LIMIT when options.limit is set", async () => {
    const cutoff = new Date("2026-06-01T00:00:00.000Z");
    const filter = { started_at: { [POSTGRES_LT_OP]: cutoff } };
    const compiled = compilePostgresDocumentDelete(CONFIG, "ft_sync_logs", filter, { limit: 1000 });
    expect(compiled.sql).toBe(
      `DELETE FROM "football_test"."ft_sync_logs" WHERE _id IN (SELECT _id FROM "football_test"."ft_sync_logs" WHERE ${postgresDocumentFieldExpr(CONFIG.schema, "sync_logs", "started_at")} < $1::timestamptz LIMIT $2)`,
    );
    expect(compiled.params).toEqual([cutoff.toISOString(), 1000]);

    const client = {
      query: vi.fn(async () => ({ rows: [], command: "DELETE", rowCount: 1000 })),
    };
    const db = createPostgresDocumentDb(createPostgresQueryFn(client), CONFIG);
    const deleted = await db.deleteWhere("ft_sync_logs", filter, { limit: 1000 });
    expect(deleted).toBe(1000);
    expect(client.query).toHaveBeenCalledWith(compiled.sql, compiled.params);

    await expect(db.deleteWhere("ft_sync_logs", filter, { limit: 0 })).rejects.toThrow(/positive integer/);
  });

  it("rejects empty filter in deleteWhere to guard against full-table deletion", async () => {
    const rec = new RecordingQuery();
    const db = createPostgresDocumentDb(rec.query, CONFIG);
    await expect(db.deleteWhere("ft_sync_logs", {})).rejects.toThrow(/non-empty filter/);
    expect(rec.statements).toHaveLength(0);
  });
});

describe("PostgresDocumentDb Slice 3.3 SQL pushdowns", () => {
  it("compiles _id inFilter using primary key column _id = ANY(...)", () => {
    const compiled = compilePostgresDocumentQuery(CONFIG, users(), {
      _id: { [POSTGRES_IN_OP]: ["u1", "u2"] },
    });
    expect(compiled.sql).toBe(
      `SELECT document FROM "${SCHEMA}"."${users()}" WHERE _id = ANY($1::text[])`,
    );
    expect(compiled.params).toEqual([["u1", "u2"]]);
  });

  it("compileLatestRegularBoardSnapshot selects latest non-final timestamp in single SQL without offset scan", async () => {
    const boardTable = cloudBaseCollectionName(NAMESPACE, "board_snapshots");
    const ts = postgresDocumentFieldExpr(SCHEMA, "board_snapshots", "snapshot_at");
    const isFinal = postgresDocumentFieldExpr(SCHEMA, "board_snapshots", "is_final");
    const rank = postgresDocumentFieldExpr(SCHEMA, "board_snapshots", "rank");

    const seasonSql = compileLatestRegularBoardSnapshot(CONFIG, {
      collection: boardTable,
      board: "season",
      level_season_id: "2026_2027",
    });
    const expectedWhere = `(document ->> 'board') = $1 AND ${isFinal} = false AND (document ->> 'level_season_id') = $2`;
    expect(seasonSql.sql).toBe(
      `SELECT document FROM "${SCHEMA}"."${boardTable}" WHERE ${expectedWhere} AND ${ts} = (SELECT ${ts} FROM "${SCHEMA}"."${boardTable}" WHERE ${expectedWhere} ORDER BY ${ts} DESC LIMIT 1) ORDER BY ${rank} ASC`,
    );
    expect(seasonSql.sql).not.toContain("COALESCE");
    expect(seasonSql.params).toEqual(["season", "2026_2027"]);

    const rec = new RecordingQuery();
    rec.responses.push({
      rows: [{
        document: encodeDocument({
          _id: "s1",
          schema_version: 1,
          snapshot_id: "s1",
          board: "career",
          snapshot_at: NOW,
          user_id: "u1",
          rank: 1,
          is_final: false,
          created_at: NOW,
        }),
      }],
    });
    const db = createPostgresDocumentDb(rec.query, CONFIG);
    const docs = await db.findLatestRegularBoardSnapshot({ collection: boardTable, board: "career" });
    expect(docs).toHaveLength(1);
    expect(docs[0]?.snapshot_at).toBeInstanceOf(Date);
    expect(rec.statements).toHaveLength(1);
  });

  it("[A-S8-13] compileAnomalyPage pushes status/blocking and (last_seen_at, anomaly_id) keyset desc with limit", async () => {
    const anomaliesTable = cloudBaseCollectionName(NAMESPACE, "anomalies");
    const afterAt = new Date("2026-08-09T11:00:00.000Z");
    const after = {
      last_seen_at: afterAt,
      anomaly_id: "00000000-0000-4000-8000-000000000009",
    };
    const compiled = compileAnomalyPage(CONFIG, {
      collection: anomaliesTable,
      status: AnomalyStatus.Open,
      blocking: true,
      after,
      limit: 21,
    });
    const status = postgresDocumentFieldExpr(SCHEMA, "anomalies", "status");
    const blocking = postgresDocumentFieldExpr(SCHEMA, "anomalies", "blocking");
    const lastSeen = postgresDocumentFieldExpr(SCHEMA, "anomalies", "last_seen_at");
    const anomalyId = postgresDocumentFieldExpr(SCHEMA, "anomalies", "anomaly_id");
    expect(compiled.sql).toBe(
      `SELECT document FROM "${SCHEMA}"."${anomaliesTable}" WHERE ${status} = $1 AND ${blocking} = $2 AND (${lastSeen}, ${anomalyId}) < ($3::timestamptz, $4) ORDER BY ${lastSeen} DESC, ${anomalyId} DESC LIMIT $5`,
    );
    expect(compiled.params).toEqual([
      AnomalyStatus.Open,
      true,
      afterAt.toISOString(),
      after.anomaly_id,
      21,
    ]);

    const unfiltered = compileAnomalyPage(CONFIG, {
      collection: anomaliesTable,
      status: null,
      blocking: null,
      after: null,
      limit: 20,
    });
    expect(unfiltered.sql).toBe(
      `SELECT document FROM "${SCHEMA}"."${anomaliesTable}" WHERE TRUE ORDER BY ${lastSeen} DESC, ${anomalyId} DESC LIMIT $1`,
    );

    const rec = new RecordingQuery();
    rec.responses.push({
      rows: [{
        document: encodeDocument({
          _id: after.anomaly_id,
          schema_version: 1,
          anomaly_id: after.anomaly_id,
          anomaly_key: "match:type",
          match_id: "00000000-0000-4000-8000-000000000010",
          type: "PROVIDER_STATE_CONFLICT",
          blocking: true,
          status: AnomalyStatus.Open,
          first_seen_at: NOW,
          last_seen_at: afterAt,
          occurrence_count: 1,
          details: {},
          resolved_at: null,
          resolution: null,
          created_at: NOW,
          updated_at: NOW,
        }),
      }],
    });
    const db = createPostgresDocumentDb(rec.query, CONFIG);
    const docs = await db.findAnomalyPage({
      collection: anomaliesTable,
      status: AnomalyStatus.Open,
      blocking: true,
      after,
      limit: 21,
    });
    expect(docs).toHaveLength(1);
    expect(docs[0]?.last_seen_at).toBeInstanceOf(Date);
    expect(rec.statements).toHaveLength(1);
    expect(rec.statements[0]?.params).toEqual(compiled.params);
  });

  it("compileSettlementFallbackPage uses (kickoff_at, match_id) keyset cursor and skips voided", async () => {
    const matchesTable = matches();
    const afterAt = new Date("2026-08-05T15:00:00.000Z");
    const compiled = compileSettlementFallbackPage(CONFIG, {
      collection: matchesTable,
      limit: 50,
      after: { kickoff_at: afterAt, match_id: "m-cursor" },
    });
    const kickoff = postgresDocumentFieldExpr(SCHEMA, "matches", "kickoff_at");
    const matchId = postgresDocumentFieldExpr(SCHEMA, "matches", "match_id");
    expect(compiled.sql).toContain("<> $2");
    expect(compiled.sql).toContain(`(${kickoff}, ${matchId}) > ($3::timestamptz, $4)`);
    expect(compiled.sql).toContain(`ORDER BY ${kickoff} ASC, ${matchId} ASC LIMIT $5`);
    expect(compiled.params).toEqual([MatchStatus.Finished, SettlementStatus.Voided, afterAt.toISOString(), "m-cursor", 50]);

    const rec = new RecordingQuery();
    rec.responses.push({ rows: [] });
    const db = createPostgresDocumentDb(rec.query, CONFIG);
    await expect(db.findSettlementFallbackPage({
      collection: matchesTable,
      limit: 50,
      after: { kickoff_at: afterAt, match_id: "m-cursor" },
    })).resolves.toEqual([]);
    expect(rec.statements).toHaveLength(1);
  });
});

function requireGetForUpdate(
  db: { getForUpdate?: (collection: string, id: string) => Promise<CloudBaseDocument | null> },
): (collection: string, id: string) => Promise<CloudBaseDocument | null> {
  if (db.getForUpdate === undefined) throw new Error("getForUpdate is not implemented");
  return db.getForUpdate.bind(db);
}

describe("PostgresDocumentDb 事务内 getForUpdate 与局部 patch [Slice 2]", () => {
  it("patch 只用 jsonb_set 改传入字段，不合并整份文档", () => {
    const compiled = compilePostgresDocumentPatch(CONFIG, users(), "u1", {
      nickname: "Moon",
      career_points: 12,
      updated_at: NOW,
      deleted_at: null,
    });
    expect(compiled.sql).toBe(
      `UPDATE "${SCHEMA}"."${users()}" SET document = jsonb_set(jsonb_set(jsonb_set(jsonb_set(document, ARRAY[$2]::text[], $3::jsonb, true), ARRAY[$4]::text[], $5::jsonb, true), ARRAY[$6]::text[], $7::jsonb, true), ARRAY[$8]::text[], $9::jsonb, true) WHERE _id = $1 RETURNING _id`,
    );
    expect(compiled.params).toEqual([
      "u1",
      "nickname",
      JSON.stringify("Moon"),
      "career_points",
      JSON.stringify(12),
      "updated_at",
      JSON.stringify(NOW.toISOString()),
      "deleted_at",
      "null",
    ]);
    expect(compiled.sql).not.toContain("||");
    expect(() => compilePostgresDocumentPatch(CONFIG, users(), "u1", { "bad-field": 1 }))
      .toThrow(/invalid query field/);
  });

  it("patch 不先读整行，缺失文档抛 CloudBaseDocumentNotFoundError", async () => {
    const missing = new RecordingQuery();
    missing.responses.push({ rows: [] });
    const missingDb = createPostgresDocumentDb(missing.query, CONFIG);
    await expect(missingDb.patch(users(), "missing", { nickname: "x" }))
      .rejects.toBeInstanceOf(CloudBaseDocumentNotFoundError);
    expect(missing.statements).toHaveLength(1);
    expect(missing.statements[0]?.sql).toContain("jsonb_set");
    expect(missing.statements[0]?.sql).not.toContain("SELECT document");

    const rec = new RecordingQuery();
    rec.responses.push({ rows: [{ _id: "u1" }] });
    const db = createPostgresDocumentDb(rec.query, CONFIG);
    await db.patch(users(), "u1", { nickname: "Moon", updated_at: NOW });
    expect(rec.statements).toHaveLength(1);
    expect(rec.statements[0]?.sql).toContain("jsonb_set");
    expect(rec.statements[0]?.params?.[2]).toBe(JSON.stringify("Moon"));
  });

  it("事务外 getForUpdate 拒绝且不发 SQL", async () => {
    const rec = new RecordingQuery();
    const db = createPostgresDocumentDb(rec.query, CONFIG);
    const getForUpdate = requireGetForUpdate(db);
    await expect(getForUpdate(users(), "u1")).rejects.toThrow(/active transaction/);
    expect(rec.statements).toEqual([]);
  });

  it("事务内 getForUpdate 发 SELECT ... FOR UPDATE，解码日期，缺失返回 null", async () => {
    const rec = new ExclusiveRecordingQuery();
    rec.responses.push(
      { rows: [{ document: encodeDocument(userDoc("u1")) }] },
      { rows: [] },
    );
    const db = createPostgresDocumentDb(rec.query, CONFIG, { connect: rec.connect });
    await db.transaction(async (tx) => {
      const getForUpdate = requireGetForUpdate(tx);
      const locked = await getForUpdate(users(), "u1");
      expect(locked?.created_at).toBeInstanceOf(Date);
      expect((locked?.created_at as Date).getTime()).toBe(NOW.getTime());
      expect(locked?.openid).toBe("openid-u1");
      await expect(getForUpdate(users(), "u9")).resolves.toBeNull();
    });
    expect(rec.statements.filter((item) => item.sql.includes("FOR UPDATE"))).toEqual([
      {
        sql: `SELECT document FROM "${SCHEMA}"."${users()}" WHERE _id = $1 FOR UPDATE`,
        params: ["u1"],
      },
      {
        sql: `SELECT document FROM "${SCHEMA}"."${users()}" WHERE _id = $1 FOR UPDATE`,
        params: ["u9"],
      },
    ]);
  });

  it("[CR-16] prefers declared string field type over runtime numeric/boolean inference", () => {
    const compiled = compilePostgresDocumentQuery(CONFIG, users(), {
      openid: 12345 as unknown as string,
    });
    expect(compiled.sql).toBe(
      `SELECT document FROM "${SCHEMA}"."${users()}" WHERE (document ->> 'openid') = $1`,
    );
    expect(compiled.params).toEqual([12345]);
  });
});
