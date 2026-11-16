import { describe, expect, it, vi } from "vitest";
import { GroupStatus, MatchStatus, SettlementStatus } from "../domain/enums.js";
import type { BoardSnapshot, Group, Match, Prediction, ProviderReconcileTodo, User } from "../domain/types.js";
import { defaultLevelState } from "../domain/types.js";
import { GroupsService } from "../application/groups.js";
import { COLLECTION_DEFINITIONS } from "../schema/collections.js";
import { UNIQUE_INDEXES } from "../schema/indexes.js";
import {
  CLOUDBASE_REPOSITORY_ENV_KEYS,
  CLOUDBASE_RUNTIME_COLLECTIONS,
  CloudBaseAppRepository,
  CloudBaseDocumentNotFoundError,
  CloudBaseDuplicateKeyError,
  CloudBaseUserRepository,
  assertCloudBaseRepositoryConfig,
  cloudBaseCollectionName,
  loadCloudBaseRepositoryConfig,
  type CloudBaseDb,
  type CloudBaseDocument,
  type CloudBaseQueryOptions,
  type CloudBaseRepositoryConfig,
} from "./cloudbase-repository.js";
import { InMemoryRepository } from "./repositories.js";
import { createPostgresDocumentDb } from "./postgres-document-db.js";
import type { PostgresQueryFn } from "./postgres-schema.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const CURSOR_SECRET = "test-group-cursor-secret";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID_2 = "00000000-0000-4000-8000-000000000002";
const CONFIG: CloudBaseRepositoryConfig = {
  cloud_environment_id: "cloud-test",
  resource_namespace: "football-test",
};

function cloneValue<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)])) as T;
  }
  return value;
}

function equal(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function isLteOp(value: unknown): value is { __lte: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date) && "__lte" in value;
}

function toMs(value: unknown): number {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : Number.NaN;
  }
  if (typeof value === "string" || typeof value === "number") {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : Number.NaN;
  }
  return Number.NaN;
}

class MemoryCloudBaseDb implements CloudBaseDb {
  private documents = new Map<string, CloudBaseDocument>();
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(private readonly transactionView = false) {}

  async get(collection: string, id: string): Promise<CloudBaseDocument | null> {
    const document = this.documents.get(`${collection}/${id}`);
    return document === undefined ? null : cloneValue(document);
  }

  async add(collection: string, id: string, document: CloudBaseDocument): Promise<void> {
    if (this.documents.has(`${collection}/${id}`)) {
      const def = COLLECTION_DEFINITIONS.find((item) => collection.endsWith(`_${item.collection}`));
      const keyField = def ? Object.keys(def.fields).find((field) => def.fields[field]?.immutable) : undefined;
      throw new CloudBaseDuplicateKeyError(collection, `pk_${def?.collection ?? "document"}`, {
        [keyField ?? "_id"]: keyField ? document[keyField] : id,
      });
    }
    this.assertUnique(collection, document);
    this.documents.set(`${collection}/${id}`, cloneValue({ ...document, _id: id }));
  }

  async update(collection: string, id: string, document: CloudBaseDocument): Promise<void> {
    const storageKey = `${collection}/${id}`;
    if (!this.documents.has(storageKey)) {
      throw new CloudBaseDocumentNotFoundError(collection, id);
    }
    const merged = { ...this.documents.get(storageKey)!, ...document, _id: id };
    this.assertUnique(collection, merged, id);
    this.documents.set(storageKey, cloneValue(merged));
  }

  async query(
    collection: string,
    filter: Record<string, unknown> = {},
    options: CloudBaseQueryOptions = {},
  ): Promise<CloudBaseDocument[]> {
    let result = [...this.documents.entries()]
      .filter(([key]) => key.startsWith(`${collection}/`))
      .map(([, document]) => cloneValue(document))
      .filter((document) => Object.entries(filter).every(([field, value]) => {
        if (isLteOp(value) || (typeof value === "object" && value !== null && "__gte" in value)) {
          const range = value as { __gte?: unknown; __lte?: unknown };
          return (range.__gte === undefined || toMs(document[field]) >= toMs(range.__gte)) &&
            (range.__lte === undefined || toMs(document[field]) <= toMs(range.__lte));
        }
        if (typeof value === "object" && value !== null && "__in" in value) {
          return (value.__in as readonly unknown[]).includes(document[field]);
        }
        return equal(document[field], value);
      }));
    if (options.order_by) {
      const direction = options.direction === "desc" ? -1 : 1;
      const field = options.order_by;
      result = result.sort((a, b) => {
        const left = a[field];
        const right = b[field];
        const compare = left instanceof Date && right instanceof Date
          ? left.getTime() - right.getTime()
          : String(left).localeCompare(String(right));
        return compare * direction;
      });
    }
    const offset = options.offset ?? 0;
    return options.limit === undefined
      ? result.slice(offset)
      : result.slice(offset, offset + options.limit);
  }

  async count(collection: string, filter: Record<string, unknown> = {}): Promise<number> {
    return (await this.query(collection, filter)).length;
  }

  inFilter(field: string, values: readonly string[]): Record<string, unknown> {
    return { [field]: { __in: values } };
  }

  async reserveCounter(collection: string, id: string, field: string, limit: number, initial: CloudBaseDocument): Promise<boolean> {
    const key = `${collection}/${id}`;
    const current: CloudBaseDocument = this.documents.get(key) ?? cloneValue({ ...initial, _id: id });
    const value = typeof current[field] === "number" ? current[field] as number : 0;
    if (value >= limit) return false;
    current[field] = value + 1;
    this.documents.set(key, cloneValue(current));
    return true;
  }

  async adjustCounter(collection: string, id: string, field: string, delta: number): Promise<void> {
    const key = `${collection}/${id}`;
    const current = this.documents.get(key);
    if (!current) return;
    current[field] = (typeof current[field] === "number" ? current[field] as number : 0) + delta;
    this.documents.set(key, cloneValue(current));
  }

  async getCounter(collection: string, id: string, field: string): Promise<number> {
    const current = await this.get(collection, id);
    return typeof current?.[field] === "number" ? current[field] as number : 0;
  }

  async transaction<T>(work: (transactionDb: CloudBaseDb) => Promise<T>): Promise<T> {
    if (this.transactionView) return this.runTransaction(work);
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.runTransaction(work);
    } finally {
      release();
    }
  }

  private async runTransaction<T>(work: (transactionDb: CloudBaseDb) => Promise<T>): Promise<T> {
    const transaction = new MemoryCloudBaseDb(true);
    transaction.documents = new Map([...this.documents].map(([key, value]) => [key, cloneValue(value)]));
    const result = await work(transaction);
    this.documents = transaction.documents;
    return result;
  }

  private assertUnique(collection: string, document: CloudBaseDocument, excludeId?: string): void {
    const definition = COLLECTION_DEFINITIONS.find((item) => collection.endsWith(`_${item.collection}`));
    if (!definition) return;
    for (const index of UNIQUE_INDEXES.filter((item) => item.collection === definition.collection)) {
      const conflict = [...this.documents.entries()].some(([storageKey, existing]) => {
        if (!storageKey.startsWith(`${collection}/`) || storageKey === `${collection}/${excludeId ?? ""}`) return false;
        return index.fields.every((field) => equal(existing[field], document[field]));
      });
      if (conflict) {
        throw new CloudBaseDuplicateKeyError(
          collection,
          index.name,
          Object.fromEntries(index.fields.map((field) => [field, document[field]])),
        );
      }
    }
  }
}

function makeUser(userId = USER_ID): User {
  return {
    schema_version: 1,
    user_id: userId,
    openid: `openid-${userId}`,
    unionid: null,
    nickname: `user-${userId.slice(-1)}`,
    favorite_team_id: null,
    status: "active",
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

function makeGroup(groupId: string, inviteCode: string, ownerId = USER_ID): Group {
  return {
    schema_version: 1,
    group_id: groupId,
    owner_user_id: ownerId,
    invite_code: inviteCode,
    status: GroupStatus.Active,
    member_count: 1,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeSeasonSnapshot(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    schema_version: 1,
    snapshot_id: `snapshot-${Math.random()}`,
    board: "season",
    snapshot_at: NOW,
    level_season_id: "2026_2027",
    is_final: false,
    user_id: USER_ID,
    rank: 1,
    career_points: null,
    career_exact_hits: null,
    career_valid_predictions: null,
    career_last_scoring_match_at: null,
    window_score_sum: null,
    window_n: null,
    season_points: 12,
    season_exact_hits: 1,
    season_valid_predictions: 4,
    season_last_scoring_match_at: NOW,
    created_at: NOW,
    ...overrides,
  };
}

function createCloudBaseRepository(db = new MemoryCloudBaseDb()): CloudBaseAppRepository {
  return new CloudBaseAppRepository(CONFIG, db);
}

function createPostgresRepository(): CloudBaseAppRepository {
  const rows = new Map<string, CloudBaseDocument>();
  const query: PostgresQueryFn = async (sql, params = []) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
    if (sql.startsWith("INSERT")) {
      rows.set(String(params[0]), structuredClone(params[1] as CloudBaseDocument));
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE")) {
      const id = String(params[0]);
      const existing = rows.get(id);
      if (!existing) return { rows: [] };
      rows.set(id, { ...existing, ...structuredClone(params[1] as CloudBaseDocument) });
      return { rows: [{ _id: id }] };
    }
    if (sql.includes("WHERE _id = $1")) {
      const row = rows.get(String(params[0]));
      return { rows: row ? [{ document: structuredClone(row) }] : [] };
    }
    const filters = [...sql.matchAll(/document ->> '([^']+)'\)\)?(?:::numeric)? = \$(\d+)/g)];
    let documents = [...rows.values()].filter((row) => filters.every((match) => row[match[1]!] === params[Number(match[2]) - 1]));
    if (sql.includes("ORDER BY")) documents = documents.sort((left, right) => String(left.kickoff_at).localeCompare(String(right.kickoff_at)));
    const limit = /LIMIT \$(\d+)/.exec(sql);
    const offset = /OFFSET \$(\d+)/.exec(sql);
    const start = offset ? Number(params[Number(offset[1]) - 1]) : 0;
    documents = documents.slice(start, limit ? start + Number(params[Number(limit[1]) - 1]) : undefined);
    return { rows: documents.map((document) => ({ document: structuredClone(document) })) };
  };
  const db = createPostgresDocumentDb(query, { schema: "football_test", namespace: CONFIG.resource_namespace }, {
    connect: async () => ({ query, release: () => {} }),
  });
  return new CloudBaseAppRepository(CONFIG, db);
}

describe.each([
  ["memory", () => new InMemoryRepository()],
  ["document", () => createCloudBaseRepository()],
  ["postgres", () => createPostgresRepository()],
])("provider reconcile todos: %s", (_name, createRepo) => {
  it("upserts by match/source/version, sorts, retains attempts, and completes individually", async () => {
    const repo = createRepo();
    const todo: ProviderReconcileTodo = {
      todo_id: "first", match_id: "match", canonical_match_id: "canonical", league_id: "premier_league",
      season_id: "2026_2027", source_id: "of", target_result_version: 1, kickoff_at: NOW,
      status: "pending", attempts: 0, last_error_code: null, last_attempt_at: null,
      completed_at: null, created_at: NOW, updated_at: NOW, schema_version: 1,
    };
    await repo.providerReconcileTodos.upsert(todo);
    await repo.providerReconcileTodos.recordFailure(todo.todo_id, "MISSING", NOW);
    await repo.providerReconcileTodos.upsert({ ...todo, todo_id: "duplicate" });
    await repo.providerReconcileTodos.upsert({ ...todo, todo_id: "earlier", match_id: "other", kickoff_at: new Date(NOW.getTime() - 1000) });
    const pending = await repo.providerReconcileTodos.findPending(1);
    expect(pending.map((row) => row.todo_id)).toEqual(["earlier"]);
    await repo.providerReconcileTodos.markDone("earlier", NOW);
    expect(await repo.providerReconcileTodos.findPending(10)).toEqual([{ ...todo, attempts: 1, last_error_code: "MISSING", last_attempt_at: NOW }]);
    await repo.providerReconcileTodos.markDone("first", NOW);
    expect(await repo.providerReconcileTodos.findPending(10)).toEqual([]);
    await repo.providerReconcileTodos.upsert({ ...todo, todo_id: "duplicate-again" });
    expect(await repo.providerReconcileTodos.findPending(10)).toEqual([]);
    await repo.providerReconcileTodos.upsert({ ...todo, todo_id: "version-two", target_result_version: 2 });
    await repo.providerReconcileTodos.upsert({ ...todo, todo_id: "other-source", source_id: "sp" });
    expect((await repo.providerReconcileTodos.findPending(10)).map((row) => row.todo_id).sort()).toEqual(["other-source", "version-two"]);
  });
});

class RangeAwareMemoryCloudBaseDb extends MemoryCloudBaseDb {
  gteFilter(field: string, value: unknown): Record<string, unknown> {
    return { [field]: { __gte: value } };
  }
  lteFilter(field: string, value: unknown): Record<string, unknown> {
    return { [field]: { __lte: value } };
  }
}

function makeWindowMatch(overrides: Partial<Match> = {}): Match {
  const matchId = overrides.match_id ?? "m1";
  return {
    schema_version: 1,
    match_id: matchId,
    canonical_match_id: matchId,
    superseded_by: null,
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

describe("CloudBase repository configuration", () => {
  it("loads only the repository environment keys and trims values", () => {
    expect(loadCloudBaseRepositoryConfig({
      FOOTBALL_CLOUD_ENVIRONMENT_ID: " cloud-test ",
      FOOTBALL_RESOURCE_NAMESPACE: " football-test ",
      FOOTBALL_OTHER_SECRET: "unused",
    })).toEqual(CONFIG);
    expect(CLOUDBASE_REPOSITORY_ENV_KEYS).toEqual({
      cloud_environment_id: "FOOTBALL_CLOUD_ENVIRONMENT_ID",
      resource_namespace: "FOOTBALL_RESOURCE_NAMESPACE",
    });
    expect(cloudBaseCollectionName("football-test", "users")).toBe("football-test_users");
    expect(CLOUDBASE_RUNTIME_COLLECTIONS).toEqual(["diag", "rate_limits"]);
    expect(cloudBaseCollectionName("football-test", "diag")).toBe("football-test_diag");
    expect(cloudBaseCollectionName("football-test", "rate_limits")).toBe("football-test_rate_limits");
  });

  it("requires both values", () => {
    expect(() => assertCloudBaseRepositoryConfig({
      cloud_environment_id: undefined,
      resource_namespace: "football",
    })).toThrow("FOOTBALL_CLOUD_ENVIRONMENT_ID is required");
    expect(() => assertCloudBaseRepositoryConfig({
      cloud_environment_id: "cloud",
      resource_namespace: " ",
    })).toThrow("FOOTBALL_RESOURCE_NAMESPACE is required");
  });
});

describe("CloudBaseAppRepository", () => {
  it("round-trips users using `_id = user_id` and exposes the full AppRepository ports", async () => {
    const db = new MemoryCloudBaseDb();
    const repo = createCloudBaseRepository(db);
    const user = makeUser();
    await repo.users.insert(user);
    await expect(repo.users.findById(USER_ID)).resolves.toEqual(user);
    await expect(repo.users.findByOpenid(user.openid)).resolves.toEqual(user);
    expect(Object.keys(repo).sort()).toEqual([
      "adminAuditLogs", "admins", "anomalies", "boardSnapshots", "config", "db", "deletedOpenidMappings",
      "groupMembers", "groups", "jobLocks", "levelHistory", "matchProviderMappings",
      "matchResults", "matches", "predictions", "providerReconcileTodos", "providerSnapshots", "rankings",
      "settlementItems", "settlements", "syncLogs", "teamProviderMappings", "teams",
      "unlocks", "userSeasonStats", "users",
    ].sort());
  });

  it("reads legacy match and prediction documents with logical identity defaults", async () => {
    const db = new MemoryCloudBaseDb();
    const repo = createCloudBaseRepository(db);
    await db.add(cloudBaseCollectionName(CONFIG.resource_namespace, "matches"), "old-match", {
      _id: "old-match",
      match_id: "old-match",
    });
    await db.add(cloudBaseCollectionName(CONFIG.resource_namespace, "predictions"), "old-prediction", {
      _id: "old-prediction",
      match_id: "old-match",
    });

    await expect(repo.matches.findById("old-match")).resolves.toMatchObject({
      canonical_match_id: "old-match",
      superseded_by: null,
    });
    await expect(repo.predictions.findById("old-prediction")).resolves.toMatchObject({
      canonical_match_id: "old-match",
    });
  });

  it("inserts grouped matches and queries legacy identities with one prediction query", async () => {
    const db = new MemoryCloudBaseDb();
    const repo = createCloudBaseRepository(db);
    await db.add(cloudBaseCollectionName(CONFIG.resource_namespace, "matches"), "legacy", {
      _id: "legacy", match_id: "legacy",
    });
    await repo.matches.insert(makeWindowMatch({ match_id: "current", canonical_match_id: "legacy" }));
    await expect(repo.matches.insert(makeWindowMatch({ match_id: "superseded", superseded_by: "current" })))
      .rejects.toThrow(/superseded_by=null/);
    await db.add(cloudBaseCollectionName(CONFIG.resource_namespace, "predictions"), "prediction", {
      _id: "prediction", prediction_id: "prediction", user_id: USER_ID, match_id: "legacy",
    });
    const query = vi.spyOn(db, "query");
    const ids = await repo.matches.findIdsByCanonicalMatchId("legacy");
    expect(ids).toEqual(expect.arrayContaining(["legacy", "current"]));
    expect(ids).toHaveLength(2);
    expect(query).toHaveBeenCalledTimes(2);
    query.mockClear();
    const predictions = await repo.predictions.findByUserAndMatchIds(USER_ID, ids);
    expect(predictions).toHaveLength(1);
    expect(predictions[0]).toMatchObject({ prediction_id: "prediction", match_id: "legacy" });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.any(String), {
      user_id: USER_ID, match_id: { __in: ids },
    }, undefined);
    query.mockClear();
    expect(await repo.predictions.findByUserAndMatchIds(USER_ID, [])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(await repo.matches.findIdsByCanonicalMatchId("missing")).toEqual([]);
  });

  it("finds a legacy prediction by its defaulted canonical match id", async () => {
    const db = new MemoryCloudBaseDb();
    const repo = createCloudBaseRepository(db);
    await db.add(cloudBaseCollectionName(CONFIG.resource_namespace, "predictions"), "old-prediction", {
      _id: "old-prediction",
      prediction_id: "old-prediction",
      user_id: USER_ID,
      match_id: "old-match",
    });

    await expect(repo.predictions.findByUserAndCanonicalMatch(USER_ID, "old-match"))
      .resolves.toMatchObject({ prediction_id: "old-prediction", canonical_match_id: "old-match" });
  });

  it("rejects duplicate predictions by user and canonical match", async () => {
    const repo = createCloudBaseRepository();
    const prediction: Prediction = {
      schema_version: 1,
      prediction_id: "prediction-1",
      user_id: USER_ID,
      match_id: "match-1",
      canonical_match_id: "logical-match",
      idempotency_key: "key-1",
      pred_home_score: 1,
      pred_away_score: 0,
      derived_result: "HOME",
      submitted_at: NOW,
      scoring_rule_version: "scoring_v1",
      match_score: null,
      wdl_hit: null,
      exact_hit: null,
      applied_result_version: 0,
      created_at: NOW,
      updated_at: NOW,
    };
    await repo.predictions.insert(prediction);

    await expect(repo.predictions.insert({
      ...prediction,
      prediction_id: "prediction-2",
      match_id: "match-2",
      idempotency_key: "key-2",
    })).rejects.toMatchObject({
      name: "UniqueConstraintError",
      collection: "predictions",
      indexName: "uk_user_canonical_match",
    });
  });

  it("rejects match identity changes that would create a supersession chain", async () => {
    const repo = createCloudBaseRepository();
    const old = makeWindowMatch({ match_id: "old-match" });
    const current = makeWindowMatch({ match_id: "current-match" });
    const next = makeWindowMatch({ match_id: "next-match" });
    await repo.matches.insert(old);
    await repo.matches.insert(current);
    await repo.matches.insert(next);

    await repo.matches.update({ ...old, canonical_match_id: current.match_id });
    await repo.matches.update({ ...next, canonical_match_id: current.match_id });
    await repo.matches.update({
      ...old,
      canonical_match_id: current.match_id,
      superseded_by: current.match_id,
    });

    await expect(repo.matches.update({
      ...current,
      superseded_by: next.match_id,
    })).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: expect.stringMatching(/链式关系/),
    });
  });

  it("keeps a prediction canonical match id immutable", async () => {
    const repo = createCloudBaseRepository();
    const prediction: Prediction = {
      schema_version: 1,
      prediction_id: "prediction-immutable",
      user_id: USER_ID,
      match_id: "match-immutable",
      canonical_match_id: "logical-match-before",
      idempotency_key: "key-immutable",
      pred_home_score: 1,
      pred_away_score: 0,
      derived_result: "HOME",
      submitted_at: NOW,
      scoring_rule_version: "scoring_v1",
      match_score: null,
      wdl_hit: null,
      exact_hit: null,
      applied_result_version: 0,
      created_at: NOW,
      updated_at: NOW,
    };
    await repo.predictions.insert(prediction);

    await expect(repo.predictions.update({
      ...prediction,
      canonical_match_id: "logical-match-after",
    })).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: expect.stringMatching(/不可修改/),
    });
  });

  it("counts grouped crowd results with database count operations", async () => {
    const repo = createCloudBaseRepository();
    await expect(repo.predictions.countByMatchGroupedByResult("match-id"))
      .resolves.toEqual({ HOME: 0, DRAW: 0, AWAY: 0 });
  });

  it("retains soft-deleted users so identity resolution sees the tombstone", async () => {
    const memory = new InMemoryRepository();
    const cloudbase = createCloudBaseRepository();
    const deleted = {
      ...makeUser(USER_ID_2),
      status: "deleted" as const,
      nickname: null,
      deleted_at: NOW,
    };
    await memory.users.insert(deleted);
    await cloudbase.users.insert(deleted);
    await expect(memory.users.findByOpenid(deleted.openid)).resolves.toMatchObject({ status: "deleted" });
    await expect(cloudbase.users.findByOpenid(deleted.openid)).resolves.toMatchObject({ status: "deleted" });
  });

  it("maps native unique index conflicts to the repository contract without prechecking", async () => {
    const repo = createCloudBaseRepository();
    await repo.groups.insert(makeGroup("group-1", "ABCDEFGH"));
    await expect(repo.groups.insert(makeGroup("group-2", "ABCDEFGH"))).rejects.toMatchObject({
      name: "UniqueConstraintError",
      collection: "groups",
      indexName: "uk_invite_code",
    });
  });

  it("keeps latest regular season snapshots separate from final snapshots", async () => {
    const repo = createCloudBaseRepository();
    const regular = makeSeasonSnapshot();
    const final = makeSeasonSnapshot({
      snapshot_id: "final-snapshot",
      snapshot_at: new Date(NOW.getTime() + 1000),
      is_final: true,
      season_points: 15,
    });
    await repo.boardSnapshots.insert(regular);
    await repo.boardSnapshots.insert(final);
    await expect(repo.boardSnapshots.findLatestBySeason("2026_2027")).resolves.toEqual([regular]);
    await expect(repo.boardSnapshots.findFinalBySeason("2026_2027")).resolves.toEqual([final]);
    await expect(repo.boardSnapshots.listFinalSeasonIds()).resolves.toEqual(["2026_2027"]);
  });

  it("rejects a final snapshot colliding with a regular snapshot at the same unique key", async () => {
    const repo = createCloudBaseRepository();
    await repo.boardSnapshots.insert(makeSeasonSnapshot());
    await expect(repo.boardSnapshots.insert(makeSeasonSnapshot({
      snapshot_id: "same-time-final",
      is_final: true,
    }))).rejects.toMatchObject({
      name: "UniqueConstraintError",
      collection: "board_snapshots",
      indexName: "uk_board_snapshot_user",
    });
    await expect(repo.boardSnapshots.findByBoardAndSnapshotAt("season", NOW)).resolves.toHaveLength(1);
  });

  it("rolls back a failed transaction and keeps unique-key writes atomic", async () => {
    const repo = createCloudBaseRepository();
    const group = makeGroup("group-tx", "ABCDEFGH");
    await expect(repo.withTransaction(async (tx) => {
      await tx.groups!.insert(group);
      throw new Error("abort");
    })).rejects.toThrow("abort");
    await expect(repo.groups.findById(group.group_id)).resolves.toBeNull();
  });

  it("supports transaction-scoped savepoints", async () => {
    const repo = createCloudBaseRepository();
    await repo.withTransaction(async (tx) => {
      await tx.groups!.insert(makeGroup("group-kept", "ABCDEFGH"));
      await expect(tx.savepoint(async (inner) => {
        await inner.groups!.insert(makeGroup("group-rolled-back", "JKLMNPQR"));
        throw new Error("savepoint abort");
      })).rejects.toThrow("savepoint abort");
      expect(await tx.groups!.findById("group-rolled-back")).toBeNull();
    });
    expect(await repo.groups.findById("group-kept")).not.toBeNull();
  });

  it("matches InMemory group creation, soft membership filtering and cursor pages", async () => {
    async function exercise(repo: InMemoryRepository | CloudBaseAppRepository) {
      await repo.users.insert(makeUser());
      const codes = ["ABCDEFGH", "JKLMNPQR", "STUVWXYZ"];
      const service = new GroupsService(repo, {
        cursorSecret: CURSOR_SECRET,
        inviteCodeFactory: () => codes.shift()!,
      });
      await service.createGroup(USER_ID, NOW);
      await service.createGroup(USER_ID, NOW);
      await service.createGroup(USER_ID, NOW);
      const first = await service.listMyGroups(USER_ID, { limit: 2, cursor: null });
      const second = await service.listMyGroups(USER_ID, { limit: 2, cursor: first.next_cursor });
      return { first, second };
    }

    const memory = await exercise(new InMemoryRepository());
    const cloudbase = await exercise(createCloudBaseRepository());
    for (const result of [memory, cloudbase]) {
      expect(result.first.items).toHaveLength(2);
      expect(result.first.has_more).toBe(true);
      expect(result.second.items).toHaveLength(1);
      expect(result.second.has_more).toBe(false);
    }
  });

  it("counts members from active membership rows, matching the groups service contract", async () => {
    const db = new MemoryCloudBaseDb();
    const repo = createCloudBaseRepository(db);
    await repo.users.insert(makeUser());
    await repo.users.insert(makeUser(USER_ID_2));
    const service = new GroupsService(repo, { cursorSecret: CURSOR_SECRET, inviteCodeFactory: () => "ABCDEFGH" });
    const created = await service.createGroup(USER_ID, NOW);
    await service.joinGroup(USER_ID_2, created.invite_code, NOW);
    await expect(service.getGroup(USER_ID, created.group_id)).resolves.toMatchObject({ member_count: 2 });
    expect(await repo.groupMembers.findByGroup(created.group_id)).toHaveLength(2);
    expect(await db.count("football-test_groups")).toBe(1);
  });
});

describe("CloudBaseAppRepository.findActiveWindow", () => {
  const hour = 60 * 60_000;
  const minute = 60_000;
  const windowMatches: Match[] = [
    makeWindowMatch({ match_id: "sched-3d", kickoff_at: new Date(NOW.getTime() + 3 * 24 * hour) }),
    makeWindowMatch({ match_id: "sched-12h", kickoff_at: new Date(NOW.getTime() + 12 * hour) }),
    makeWindowMatch({ match_id: "sched-3h", kickoff_at: new Date(NOW.getTime() + 3 * hour) }),
    makeWindowMatch({ match_id: "sched-1h", kickoff_at: new Date(NOW.getTime() + hour) }),
    makeWindowMatch({ match_id: "sched-106m-ago", kickoff_at: new Date(NOW.getTime() - 106 * minute) }),
    makeWindowMatch({ match_id: "live-now", match_status: MatchStatus.Live, kickoff_at: NOW }),
    makeWindowMatch({
      match_id: "fin-pending",
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Pending,
      kickoff_at: new Date(NOW.getTime() - 12 * hour),
      finish_detected_at: new Date(NOW.getTime() - 10 * hour),
    }),
    makeWindowMatch({
      match_id: "fin-waiting",
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Waiting,
      kickoff_at: new Date(NOW.getTime() - 6 * hour),
      finish_detected_at: new Date(NOW.getTime() - 4 * hour),
    }),
    makeWindowMatch({
      match_id: "fin-settled",
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Settled,
      kickoff_at: new Date(NOW.getTime() - 12 * hour),
      finish_detected_at: new Date(NOW.getTime() - 10 * hour),
    }),
  ];

  async function seed(repo: InMemoryRepository | CloudBaseAppRepository): Promise<void> {
    for (const match of windowMatches) await repo.matches.insert(match);
  }

  async function expectSameAsMemory(db: MemoryCloudBaseDb): Promise<void> {
    const memory = new InMemoryRepository();
    const cloud = createCloudBaseRepository(db);
    await seed(memory);
    await seed(cloud);
    for (const jobType of ["near_match", "live_match", "post_finish_verify"] as const) {
      const query = { jobType, now: NOW, limit: 50 };
      const memoryIds = (await memory.matches.findActiveWindow(query)).map((row) => row.match_id);
      const cloudIds = (await cloud.matches.findActiveWindow(query)).map((row) => row.match_id);
      expect(cloudIds).toEqual(memoryIds);
    }
  }

  it("filters superseded rows when both records fit in the active window page", async () => {
    const repo = createCloudBaseRepository();
    const effective = makeWindowMatch({ match_id: "effective", kickoff_at: NOW });
    const old = makeWindowMatch({ match_id: "old", kickoff_at: new Date(NOW.getTime() + hour) });
    await repo.matches.insert(effective);
    await repo.matches.insert(old);
    await repo.matches.update({ ...old, canonical_match_id: effective.match_id, superseded_by: effective.match_id });
    const result = await repo.matches.findActiveWindow({ jobType: "live_match", now: NOW, limit: 2 });
    expect(result.map((match) => match.match_id)).toEqual(["effective"]);
  });

  it("reads only one bounded page for each window filter", async () => {
    const db = new MemoryCloudBaseDb();
    const repo = createCloudBaseRepository(db);
    const effective = makeWindowMatch({ match_id: "effective", kickoff_at: NOW });
    const old = makeWindowMatch({ match_id: "old", kickoff_at: new Date(NOW.getTime() + hour) });
    await repo.matches.insert(effective);
    await repo.matches.insert(old);
    await repo.matches.update({ ...old, canonical_match_id: effective.match_id, superseded_by: effective.match_id });
    const query = vi.spyOn(db, "query");
    expect(await repo.matches.findActiveWindow({ jobType: "live_match", now: NOW, limit: 1 })).toEqual([]);
    expect(query).toHaveBeenCalledTimes(2);
    for (const call of query.mock.calls) {
      expect(call[2]).toEqual({ order_by: "kickoff_at", direction: "desc", limit: 1 });
    }
  });

  it("不支持范围查询时退化为等值条件 + 内存筛选，结果与内存仓储一致", async () => {
    await expectSameAsMemory(new MemoryCloudBaseDb());
  });

  it("支持 lteFilter 时结果仍与内存仓储一致", async () => {
    await expectSameAsMemory(new RangeAwareMemoryCloudBaseDb());
  });

  it("live_match 的两个查询都携带开球时间上下界", async () => {
    const db = new RangeAwareMemoryCloudBaseDb();
    const repo = createCloudBaseRepository(db);
    for (const status of [MatchStatus.Live, MatchStatus.Scheduled]) {
      for (const offset of [-6 * hour - 1, -6 * hour, 2 * hour, 2 * hour + 1]) {
        await repo.matches.insert(makeWindowMatch({
          match_id: `${status}-${offset}`,
          match_status: status,
          kickoff_at: new Date(NOW.getTime() + offset),
        }));
      }
    }
    const querySpy = vi.spyOn(db, "query");
    const result = await repo.matches.findActiveWindow({ jobType: "live_match", now: NOW, limit: 50 });
    expect(result.map((match) => match.match_id).sort()).toEqual([
      `live-${-6 * hour}`, `live-${2 * hour}`,
      `scheduled-${-6 * hour}`, `scheduled-${2 * hour}`,
    ].sort());
    expect(querySpy).toHaveBeenCalledTimes(2);
    for (const call of querySpy.mock.calls) {
      expect(call[1]).toMatchObject({ kickoff_at: {
        __gte: new Date(NOW.getTime() - 6 * hour),
        __lte: new Date(NOW.getTime() + 2 * hour),
      } });
    }
    for (const result of querySpy.mock.results) {
      expect(await result.value).toHaveLength(2);
    }
  });

  it("组合 SDK 范围条件时保留 and 操作", async () => {
    const db = new RangeAwareMemoryCloudBaseDb();
    const and = vi.fn(() => ({ __gte: new Date(NOW.getTime() - 6 * hour), __lte: new Date(NOW.getTime() + 2 * hour) }));
    vi.spyOn(db, "gteFilter").mockReturnValue({ kickoff_at: { and } });
    await createCloudBaseRepository(db).matches.findActiveWindow({ jobType: "live_match", now: NOW, limit: 50 });
    expect(and).toHaveBeenCalledTimes(2);
    expect(and).toHaveBeenCalledWith({ __lte: new Date(NOW.getTime() + 2 * hour) });
  });
});

describe("CloudBaseUserRepository", () => {
  it("retains the standalone wrapper over the same CloudBaseDb port", async () => {
    const db = new MemoryCloudBaseDb();
    const users = new CloudBaseUserRepository(CONFIG, db);
    expect(users.collectionName).toBe("football-test_users");
    expect(users.cloudEnvironmentId).toBe("cloud-test");
    await users.insert(makeUser());
    await expect(users.findByOpenid(makeUser().openid)).resolves.toMatchObject({ user_id: USER_ID });
  });
});
