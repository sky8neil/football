import { describe, expect, it, vi } from "vitest";
import {
  AnomalyStatus,
  AnomalyType,
  GroupStatus,
  MatchScoreValue,
  MatchStatus,
  SettlementDocStatus,
  SettlementItemStatus,
  SettlementPhase,
  SettlementStatus,
  UserStatus,
} from "../domain/enums.js";
import type { Anomaly, BoardSnapshot, Group, LeagueSeason, Match, Prediction, ProviderReconcileTodo, SeasonTeam, SettlementDoc, User } from "../domain/types.js";
import { defaultLevelState } from "../domain/types.js";
import { GroupsService } from "../application/groups.js";
import { PersonalLeagueSummaryService } from "../application/personal-league-summary-service.js";
import { RebuildUserStatsService } from "../application/stats-rebuild-service.js";
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
import { DocumentNotFoundError, InMemoryRepository, UniqueConstraintError } from "./repositories.js";
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

  async getForUpdate(collection: string, id: string): Promise<CloudBaseDocument | null> {
    if (!this.transactionView) throw new Error("getForUpdate requires an active transaction");
    return this.get(collection, id);
  }

  seed(collection: string, id: string, document: CloudBaseDocument): void {
    this.documents.set(`${collection}/${id}`, cloneValue({ ...document, _id: id }));
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

  async delete(collection: string, id: string): Promise<void> {
    this.documents.delete(`${collection}/${id}`);
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
        if (typeof value === "object" && value !== null && "__ne" in value) {
          return !equal(document[field], (value as { __ne?: unknown }).__ne);
        }
        if (isLteOp(value) || (typeof value === "object" && value !== null && "__gte" in value)) {
          const range = value as { __gte?: unknown; __lte?: unknown };
          const compare = (left: unknown, right: unknown): number =>
            typeof left === "string" && typeof right === "string"
              ? left.localeCompare(right)
              : toMs(left) - toMs(right);
          return (range.__gte === undefined || compare(document[field], range.__gte) >= 0) &&
            (range.__lte === undefined || compare(document[field], range.__lte) <= 0);
        }
        if (typeof value === "object" && value !== null && "__in" in value) {
          return (value.__in as readonly unknown[]).includes(document[field]);
        }
        return equal(document[field], value);
      }));
    const orders = options.order_bys?.length
      ? options.order_bys
      : options.order_by === undefined
        ? []
        : [{ field: options.order_by, direction: options.direction ?? "asc" }];
    if (orders.length > 0) {
      result = result.sort((a, b) => {
        for (const order of orders) {
          const left = a[order.field];
          const right = b[order.field];
          const compare = left instanceof Date && right instanceof Date
            ? left.getTime() - right.getTime()
            : String(left).localeCompare(String(right));
          if (compare !== 0) return compare * (order.direction === "desc" ? -1 : 1);
        }
        return 0;
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
  neFilter(field: string, value: unknown): Record<string, unknown> {
    return { [field]: { __ne: value } };
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
      if (rows.has(String(params[0]))) throw { code: "23505", constraint: "pk_document" };
      rows.set(String(params[0]), structuredClone(params[1] as CloudBaseDocument));
      return { rows: [] };
    }
    if (sql.startsWith("DELETE")) {
      rows.delete(String(params[0]));
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
    const inFilters = [...sql.matchAll(/document ->> '([^']+)'\)\)? = ANY\(\$(\d+)::text\[\]\)/g)];
    let documents = [...rows.values()].filter((row) => filters.every((match) => row[match[1]!] === params[Number(match[2]) - 1])
      && inFilters.every((match) => (params[Number(match[2]) - 1] as unknown[]).includes(row[match[1]!])));
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
])("league seasons and season teams: %s", (_name, createRepo) => {
  const season: LeagueSeason = {
    schema_version: 1, league_id: "league", season_id: "2026", format: { kind: "double_round_robin", team_count: 20, round_count: 38 },
    schedule_status: "locked", completion_status: "open", completion_confirmed_at: null, reopened_at: null, reopen_count: 0,
    ended_at: null, manual_override: { confirmed_by: "admin", confirmed_at: NOW, evidence: "evidence" }, created_at: NOW, updated_at: NOW,
  };
  const team: SeasonTeam = {
    schema_version: 1, league_id: "league", season_id: "2026", team_id: "team", provider: "football_data",
    provider_team_id: "provider-team", source: "schedule", created_at: NOW, updated_at: NOW,
  };

  it("reads all league season matches including superseded records with isolation", async () => {
    const repo = createRepo();
    const current = makeWindowMatch({ match_id: "current" });
    const old = makeWindowMatch({ match_id: "old", canonical_match_id: "current" });
    await repo.matches.insert(current);
    await repo.matches.insert(old);
    await repo.matches.update({ ...old, superseded_by: "current" });
    await repo.matches.insert(makeWindowMatch({ match_id: "other-league", league_id: "la_liga" }));
    await repo.matches.insert(makeWindowMatch({ match_id: "other-season", season_id: "2025_2026" }));
    const extraIds = Array.from({ length: 105 }, (_, index) => `extra-${index}`);
    for (const id of extraIds) await repo.matches.insert(makeWindowMatch({ match_id: id }));
    expect((await repo.matches.findByLeagueSeason("premier_league", "2026_2027")).map((match) => match.match_id).sort())
      .toEqual(["current", "old", ...extraIds].sort());
  });

  it("reads canonical predictions across batches, pages and users", async () => {
    const repo = createRepo();
    const ids = Array.from({ length: 105 }, (_, index) => `match-${index}`);
    for (const id of ids) {
      await repo.predictions.insert({
        schema_version: 1, prediction_id: id, user_id: USER_ID, match_id: id, canonical_match_id: id,
        idempotency_key: id, pred_home_score: 1, pred_away_score: 0, derived_result: "HOME", submitted_at: NOW,
        scoring_rule_version: "scoring_v1", match_score: null, wdl_hit: null, exact_hit: null,
        applied_result_version: 0, created_at: NOW, updated_at: NOW,
      });
    }
    await repo.predictions.insert({
      schema_version: 1, prediction_id: "other", user_id: USER_ID_2, match_id: ids[0]!, canonical_match_id: ids[0]!,
      idempotency_key: "other", pred_home_score: 1, pred_away_score: 0, derived_result: "HOME", submitted_at: NOW,
      scoring_rule_version: "scoring_v1", match_score: null, wdl_hit: null, exact_hit: null,
      applied_result_version: 0, created_at: NOW, updated_at: NOW,
    });
    expect(await repo.predictions.findByUserAndCanonicalMatchIds(USER_ID, [])).toEqual([]);
    const rows = await repo.predictions.findByUserAndCanonicalMatchIds(USER_ID, [...ids, ids[0]!]);
    expect(rows.map((row) => row.canonical_match_id).sort()).toEqual([...ids].sort());
  });

  it("reads inserted seasons by key and rejects duplicate inserts and missing updates", async () => {
    const repo = createRepo();
    await repo.leagueSeasons.insert(season);
    expect(await repo.leagueSeasons.findByKey("league", "2026")).toEqual(season);
    expect(await repo.leagueSeasons.findByKey("league", "missing")).toBeNull();
    await expect(repo.leagueSeasons.insert(season)).rejects.toBeInstanceOf(UniqueConstraintError);
    await expect(repo.leagueSeasons.update({ ...season, season_id: "missing" })).rejects.toBeInstanceOf(DocumentNotFoundError);
  });

  it("lists seasons by league after updates", async () => {
    const repo = createRepo();
    const other = { ...season, season_id: "2025" };
    const otherLeague = { ...season, league_id: "other" };
    await repo.leagueSeasons.insert(season);
    await repo.leagueSeasons.insert(other);
    await repo.leagueSeasons.insert(otherLeague);
    const completed = { ...season, completion_status: "completed" as const, completion_confirmed_at: NOW, manual_override: null };
    await repo.leagueSeasons.update(completed);
    expect((await repo.leagueSeasons.findByLeague("league")).map((row) => row.season_id).sort()).toEqual(["2025", "2026"]);
    expect(await repo.leagueSeasons.findByLeague("league")).toContainEqual(completed);
    expect((await repo.leagueSeasons.findByLeague("other")).map((row) => row.season_id)).toEqual(["2026"]);
  });

  it("upserts teams idempotently per league season", async () => {
    const repo = createRepo();
    const otherSeason = { ...team, season_id: "2025" };
    const otherLeague = { ...team, league_id: "other" };
    await repo.seasonTeams.upsertMany([team, otherSeason, otherLeague]);
    const updated = { ...team, source: "manual" as const, provider: null, provider_team_id: null, created_at: new Date(NOW.getTime() + 60_000), updated_at: new Date(NOW.getTime() + 60_000) };
    await repo.seasonTeams.upsertMany([updated, updated]);
    expect(await repo.seasonTeams.findByLeagueSeason("league", "2026")).toEqual([{ ...updated, created_at: team.created_at }]);
    expect(await repo.seasonTeams.findByLeagueSeason("league", "2025")).toEqual([otherSeason]);
    expect(await repo.seasonTeams.findByLeagueSeason("other", "2026")).toEqual([otherLeague]);
  });
});

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

  it("selects settled matches by finish day and falls back to kickoff day", async () => {
    const repo = createRepo();
    const settled = { match_status: MatchStatus.Finished, settlement_status: SettlementStatus.Settled };
    await repo.matches.insert(makeWindowMatch({
      ...settled, match_id: "finished-yesterday",
      kickoff_at: new Date(NOW.getTime() - 5 * 86_400_000), finish_detected_at: new Date(NOW.getTime() - 86_400_000),
    }));
    await repo.matches.insert(makeWindowMatch({
      ...settled, match_id: "finished-no-detection",
      kickoff_at: new Date(NOW.getTime() - 86_400_000), finish_detected_at: null,
    }));
    await repo.matches.insert(makeWindowMatch({
      ...settled, match_id: "finished-older",
      kickoff_at: new Date(NOW.getTime() - 3 * 86_400_000), finish_detected_at: new Date(NOW.getTime() - 3 * 86_400_000),
    }));
    const day = new Date(NOW.getTime() - 86_400_000).toISOString().slice(0, 10);
    const rows = await repo.matches.findFinishedSettledOnDay(day);
    expect(rows.map((row) => row.match_id).sort()).toEqual(["finished-no-detection", "finished-yesterday"]);
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

async function insertExactHitFacts(
  repo: CloudBaseAppRepository,
  userId: string,
  count: number,
  prefix: string,
): Promise<Date> {
  const base = new Date("2026-08-01T02:00:00.000Z");
  let latest = base;
  for (let index = 0; index < count; index += 1) {
    const anchor = new Date(base.getTime() + index * 60_000);
    latest = anchor;
    const matchId = `${prefix}-m${index}`;
    const predictionId = `${prefix}-p${index}`;
    const settlementId = `${prefix}-s${index}`;
    await repo.matches.insert(makeWindowMatch({
      match_id: matchId,
      canonical_match_id: matchId,
      period_anchor_at: anchor,
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Settled,
      regular_home_score: 1,
      regular_away_score: 0,
      result_version: 1,
      settled_result_version: 1,
      finish_detected_at: NOW,
      settled_at: NOW,
      prediction_closed_at: NOW,
    }));
    await repo.predictions.insert(makeHistoryPrediction({
      prediction_id: predictionId,
      user_id: userId,
      match_id: matchId,
      canonical_match_id: matchId,
      idempotency_key: `${prefix}-key-${index}`,
      pred_home_score: 1,
      pred_away_score: 0,
    }));
    await repo.matchResults.insert({
      schema_version: 1,
      match_id: matchId,
      result_version: 1,
      regular_home_score: 1,
      regular_away_score: 0,
      source: "provider",
      provider_status: "FT",
      admin_id: null,
      reason: null,
      created_at: NOW,
    });
    await repo.settlements.insert({
      schema_version: 1,
      settlement_id: settlementId,
      match_id: matchId,
      result_version: 1,
      rule_version: "scoring_v1",
      status: SettlementDocStatus.Settled,
      phase: SettlementPhase.Done,
      is_correction: false,
      started_at: NOW,
      settled_at: NOW,
      attempt_count: 1,
      last_error_code: null,
      last_error_message: null,
      created_at: NOW,
      updated_at: NOW,
    });
    await repo.settlementItems.insert({
      schema_version: 1,
      settlement_id: settlementId,
      prediction_id: predictionId,
      user_id: userId,
      old_score: MatchScoreValue.Miss,
      new_score: MatchScoreValue.ExactHit,
      score_delta: 12,
      old_wdl_hit: false,
      new_wdl_hit: true,
      old_exact_hit: false,
      new_exact_hit: true,
      valid_prediction_delta: 1,
      source_result_version: 1,
      status: SettlementItemStatus.Applied,
      applied_at: NOW,
      attempt_count: 1,
      last_error_code: null,
      last_error_message: null,
      created_at: NOW,
      updated_at: NOW,
    });
  }
  return latest;
}

function makeHistoryPrediction(overrides: Partial<Prediction> = {}): Prediction {
  const matchId = overrides.match_id ?? "m1";
  return {
    schema_version: 1,
    prediction_id: "pred-1",
    user_id: USER_ID,
    match_id: matchId,
    canonical_match_id: overrides.canonical_match_id ?? matchId,
    idempotency_key: overrides.idempotency_key ?? "key-1",
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
    ...overrides,
  };
}

function makeAnomaly(overrides: Partial<Anomaly> = {}): Anomaly {
  const anomalyId = overrides.anomaly_id ?? "00000000-0000-4000-8000-000000000010";
  const lastSeenAt = overrides.last_seen_at ?? NOW;
  return {
    schema_version: 1,
    anomaly_id: anomalyId,
    anomaly_key: overrides.anomaly_key ?? `${anomalyId}:LIVE_SYNC_STALE`,
    match_id: "00000000-0000-4000-8000-000000000011",
    type: AnomalyType.LiveSyncStale,
    blocking: false,
    status: AnomalyStatus.Open,
    first_seen_at: lastSeenAt,
    last_seen_at: lastSeenAt,
    occurrence_count: 1,
    details: {},
    resolved_at: null,
    resolution: null,
    ...overrides,
  };
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
      "adminAuditLogs", "admins", "anomalies", "authSessions", "boardSnapshots", "config", "db", "deletedOpenidMappings",
      "groupMembers", "groups", "jobLocks", "leagueSeasons", "levelHistory", "matchProviderMappings",
      "matchResults", "matches", "predictions", "providerReconcileTodos", "providerSnapshots", "rankings",
      "seasonTeams", "settlementItems", "settlements", "syncLogs", "teamProviderMappings", "teams",
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
    await expect(repo.predictions.findByCanonicalMatch("old-match"))
      .resolves.toEqual([
        expect.objectContaining({ prediction_id: "old-prediction", canonical_match_id: "old-match" }),
      ]);
  });

  it("findByUserAndCanonicalMatchIds includes legacy match_id-only rows and matches single-lookup semantics", async () => {
    const db = new MemoryCloudBaseDb();
    const repo = createCloudBaseRepository(db);
    const col = cloudBaseCollectionName(CONFIG.resource_namespace, "predictions");
    const addRaw = async (prediction: Prediction, omitCanonical = false) => {
      const doc = omitCanonical
        ? (({ canonical_match_id: _ignored, ...fields }) => fields)(prediction)
        : prediction;
      const payload = { ...doc, _id: prediction.prediction_id };
      if (omitCanonical) db.seed(col, prediction.prediction_id, payload);
      else await db.add(col, prediction.prediction_id, payload);
    };
    await addRaw(makeHistoryPrediction({
      prediction_id: "p-legacy", user_id: USER_ID, match_id: "m-legacy", idempotency_key: "k-legacy",
    }), true);
    await addRaw(makeHistoryPrediction({
      prediction_id: "p-new", user_id: USER_ID, match_id: "m-new-row", canonical_match_id: "m-new",
      idempotency_key: "k-new",
    }));
    await addRaw(makeHistoryPrediction({
      prediction_id: "p-both", user_id: USER_ID, match_id: "m-both", canonical_match_id: "m-both",
      idempotency_key: "k-both",
    }));
    await addRaw(makeHistoryPrediction({
      prediction_id: "p-other-user", user_id: USER_ID_2, match_id: "m-legacy", idempotency_key: "k-other-user",
    }), true);
    await addRaw(makeHistoryPrediction({
      prediction_id: "p-other-match", user_id: USER_ID, match_id: "m-other", idempotency_key: "k-other-match",
    }), true);
    await addRaw(makeHistoryPrediction({
      prediction_id: "p-wrong-canonical", user_id: USER_ID, match_id: "m-wrong",
      canonical_match_id: "m-elsewhere", idempotency_key: "k-wrong",
    }));

    const requested = ["m-legacy", "m-new", "m-both", "m-wrong", "m-missing", "m-legacy"];
    const query = vi.spyOn(db, "query");
    const rows = await repo.predictions.findByUserAndCanonicalMatchIds(USER_ID, requested);
    expect(rows.map((row) => row.prediction_id).sort()).toEqual(["p-both", "p-legacy", "p-new"]);
    expect(new Set(rows.map((row) => row.prediction_id)).size).toBe(rows.length);
    expect(query.mock.calls.length).toBeLessThan(new Set(requested).size);
    query.mockRestore();

    for (const canonicalMatchId of [...new Set(requested)]) {
      const single = await repo.predictions.findByUserAndCanonicalMatch(USER_ID, canonicalMatchId);
      const batch = rows.filter((row) => row.canonical_match_id === canonicalMatchId);
      if (single === null) {
        expect(batch).toEqual([]);
      } else {
        expect(batch.map((row) => row.prediction_id)).toEqual([single.prediction_id]);
      }
    }
  });

  it("findByUserAndCanonicalMatchIds prefers canonical_match_id rows over legacy match_id rows", async () => {
    const db = new MemoryCloudBaseDb();
    const repo = createCloudBaseRepository(db);
    const col = cloudBaseCollectionName(CONFIG.resource_namespace, "predictions");
    await db.add(col, "p-canonical", {
      ...makeHistoryPrediction({
        prediction_id: "p-canonical", user_id: USER_ID, match_id: "m-row", canonical_match_id: "m1",
        idempotency_key: "k-canonical",
      }),
      _id: "p-canonical",
    });
    const { canonical_match_id: _ignored, ...legacy } = makeHistoryPrediction({
      prediction_id: "p-legacy", user_id: USER_ID, match_id: "m1", idempotency_key: "k-legacy",
    });
    db.seed(col, "p-legacy", { ...legacy, _id: "p-legacy" });

    const single = await repo.predictions.findByUserAndCanonicalMatch(USER_ID, "m1");
    const batch = await repo.predictions.findByUserAndCanonicalMatchIds(USER_ID, ["m1"]);
    expect(single?.prediction_id).toBe("p-canonical");
    expect(batch.map((row) => row.prediction_id)).toEqual(["p-canonical"]);
  });

  it("findByUserAndCanonicalMatchIds loads legacy rows across inFilter chunks without N+1", async () => {
    const db = new MemoryCloudBaseDb();
    const repo = createCloudBaseRepository(db);
    const col = cloudBaseCollectionName(CONFIG.resource_namespace, "predictions");
    const ids = Array.from({ length: 51 }, (_, index) => `legacy-${index}`);
    for (const id of ids) {
      const { canonical_match_id: _ignored, ...fields } = makeHistoryPrediction({
        prediction_id: id, user_id: USER_ID, match_id: id, idempotency_key: id,
      });
      db.seed(col, id, { ...fields, _id: id });
    }
    const query = vi.spyOn(db, "query");
    const rows = await repo.predictions.findByUserAndCanonicalMatchIds(USER_ID, [...ids, ids[0]!]);
    expect(rows.map((row) => row.canonical_match_id).sort()).toEqual([...ids].sort());
    expect(new Set(rows.map((row) => row.prediction_id)).size).toBe(ids.length);
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls.every((call) => call[1] && !("prediction_id" in (call[1] as object)))).toBe(true);
  });

  it("[A-S7-04] findByUserAndCanonicalMatchIds indexes by prediction_id and preserves duplicate predictions for PersonalLeagueSummary data_conflict", async () => {
    const db = new MemoryCloudBaseDb();
    const repo = createCloudBaseRepository(db);
    const predCol = cloudBaseCollectionName(CONFIG.resource_namespace, "predictions");
    const matchId = "00000000-0000-4000-8000-000000000701";

    // Case 1: two canonical-indexed duplicate dirty predictions under same (user_id, canonical_match_id)
    await db.add(predCol, "dup-1", {
      ...makeHistoryPrediction({
        prediction_id: "dup-1",
        user_id: USER_ID,
        match_id: "old-m1",
        canonical_match_id: matchId,
        idempotency_key: "k-dup-1",
      }),
      _id: "dup-1",
    });
    db.seed(predCol, "dup-2", {
      ...makeHistoryPrediction({
        prediction_id: "dup-2",
        user_id: USER_ID,
        match_id: matchId,
        canonical_match_id: matchId,
        idempotency_key: "k-dup-2",
      }),
      _id: "dup-2",
    });

    const dupCanonical = await repo.predictions.findByUserAndCanonicalMatchIds(USER_ID, [matchId]);
    expect(dupCanonical.map((row) => row.prediction_id).sort()).toEqual(["dup-1", "dup-2"]);

    // Case 2: two legacy duplicate predictions lacking canonical_match_id field
    const legacyMatchId = "00000000-0000-4000-8000-000000000702";
    const { canonical_match_id: _c1, ...legacyOne } = makeHistoryPrediction({
      prediction_id: "leg-1",
      user_id: USER_ID,
      match_id: legacyMatchId,
      idempotency_key: "k-leg-1",
    });
    const { canonical_match_id: _c2, ...legacyTwo } = makeHistoryPrediction({
      prediction_id: "leg-2",
      user_id: USER_ID,
      match_id: legacyMatchId,
      idempotency_key: "k-leg-2",
    });
    db.seed(predCol, "leg-1", { ...legacyOne, _id: "leg-1" });
    db.seed(predCol, "leg-2", { ...legacyTwo, _id: "leg-2" });

    const dupLegacy = await repo.predictions.findByUserAndCanonicalMatchIds(USER_ID, [legacyMatchId]);
    expect(dupLegacy.map((row) => row.prediction_id).sort()).toEqual(["leg-1", "leg-2"]);

    // Case 3: End-to-end summarizePersonalLeague sees duplicate rows -> reason: "data_conflict"
    await repo.users.insert(makeUser(USER_ID));
    await repo.leagueSeasons.insert({
      schema_version: 1,
      league_id: "premier_league",
      season_id: "2025_2026",
      format: { kind: "double_round_robin", team_count: 20, round_count: 38 },
      schedule_status: "locked",
      completion_status: "completed",
      completion_confirmed_at: NOW,
      reopened_at: null,
      reopen_count: 0,
      ended_at: NOW,
      manual_override: null,
      created_at: NOW,
      updated_at: NOW,
    });
    await repo.matches.insert(makeWindowMatch({
      match_id: matchId,
      canonical_match_id: matchId,
      league_id: "premier_league",
      season_id: "2025_2026",
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Settled,
      regular_home_score: 2,
      regular_away_score: 1,
    }));

    const summary = await new PersonalLeagueSummaryService(repo).get(USER_ID, "premier_league", "2025_2026", NOW);
    expect(summary).toMatchObject({
      availability: "not_available",
      reason: "data_conflict",
      summary: null,
    });
  });

  it("[Q-PLAN-2] teams backward-decodes legacy documents without name_zh/logo_url and supports patchFields/update", async () => {
    const db = new MemoryCloudBaseDb();
    const repo = createCloudBaseRepository(db);
    const teamCol = cloudBaseCollectionName(CONFIG.resource_namespace, "teams");
    db.seed(teamCol, "t-legacy", {
      _id: "t-legacy",
      schema_version: 1,
      team_id: "t-legacy",
      league_id: "premier_league",
      name: "Legacy Promoted FC",
      short_name: null,
      primary_color: null,
      secondary_color: null,
      status: "active",
      created_at: NOW,
      updated_at: NOW,
    });
    expect(await repo.teams.findById("t-legacy")).toMatchObject({
      team_id: "t-legacy",
      name: "Legacy Promoted FC",
      name_zh: null,
      logo_url: null,
    });

    await repo.teams.patchFields!("t-legacy", {
      name_zh: "升班马联",
      logo_url: "https://cdn.example.com/t-legacy.png",
      updated_at: NOW,
    });
    expect(await repo.teams.findById("t-legacy")).toMatchObject({
      team_id: "t-legacy",
      name_zh: "升班马联",
      logo_url: "https://cdn.example.com/t-legacy.png",
    });
  });

  it("findByCanonicalMatch merges backfilled and legacy predictions and deduplicates by prediction_id", async () => {
    const db = new MemoryCloudBaseDb();
    const repo = createCloudBaseRepository(db);
    const col = cloudBaseCollectionName(CONFIG.resource_namespace, "predictions");
    // Legacy doc with match_id === canonicalId and no canonical_match_id field
    await db.add(col, "p-legacy", {
      _id: "p-legacy",
      prediction_id: "p-legacy",
      user_id: USER_ID,
      match_id: "canon-1",
    });
    // Backfilled doc with both match_id === canonicalId and canonical_match_id === canonicalId (would match both queries)
    await db.add(col, "p-both", {
      _id: "p-both",
      prediction_id: "p-both",
      user_id: "u2",
      match_id: "canon-1",
      canonical_match_id: "canon-1",
    });
    // Doc submitted on superseded match with canonical_match_id === canonicalId
    await db.add(col, "p-remapped", {
      _id: "p-remapped",
      prediction_id: "p-remapped",
      user_id: "u3",
      match_id: "m-new",
      canonical_match_id: "canon-1",
    });
    // Doc whose match_id === canonicalId but canonical_match_id points elsewhere (must be excluded)
    await db.add(col, "p-other", {
      _id: "p-other",
      prediction_id: "p-other",
      user_id: "u4",
      match_id: "canon-1",
      canonical_match_id: "canon-other",
    });

    const rows = await repo.predictions.findByCanonicalMatch("canon-1");
    expect(rows.map((p) => p.prediction_id).sort()).toEqual(["p-both", "p-legacy", "p-remapped"]);
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

  it("counts grouped crowd results for canonical-only predictions", async () => {
    const repo = createCloudBaseRepository();
    await repo.predictions.insert(makeHistoryPrediction({
      prediction_id: "p-home-1", user_id: "u-home-1", match_id: "match-id",
      canonical_match_id: "match-id", idempotency_key: "k-home-1", derived_result: "HOME",
    }));
    await repo.predictions.insert(makeHistoryPrediction({
      prediction_id: "p-home-2", user_id: "u-home-2", match_id: "match-id",
      canonical_match_id: "match-id", idempotency_key: "k-home-2", derived_result: "HOME",
    }));
    await repo.predictions.insert(makeHistoryPrediction({
      prediction_id: "p-draw-1", user_id: "u-draw-1", match_id: "match-id",
      canonical_match_id: "match-id", idempotency_key: "k-draw-1", derived_result: "DRAW",
    }));
    await repo.predictions.insert(makeHistoryPrediction({
      prediction_id: "p-away-1", user_id: "u-away-1", match_id: "other-match",
      canonical_match_id: "other-match", idempotency_key: "k-away-1", derived_result: "AWAY",
    }));
    await expect(repo.predictions.countByMatchGroupedByResult("match-id"))
      .resolves.toEqual({ HOME: 2, DRAW: 1, AWAY: 0 });
  });

  it("counts grouped crowd results for legacy match_id-only predictions", async () => {
    const db = new MemoryCloudBaseDb();
    const repo = createCloudBaseRepository(db);
    const col = cloudBaseCollectionName(CONFIG.resource_namespace, "predictions");
    const addLegacy = async (prediction: Prediction) => {
      const { canonical_match_id: _ignored, ...fields } = prediction;
      await db.add(col, prediction.prediction_id, { ...fields, _id: prediction.prediction_id });
    };
    await addLegacy(makeHistoryPrediction({
      prediction_id: "p-legacy-home", user_id: "u-legacy-home", match_id: "match-id",
      idempotency_key: "k-legacy-home", derived_result: "HOME",
    }));
    await addLegacy(makeHistoryPrediction({
      prediction_id: "p-legacy-draw", user_id: "u-legacy-draw", match_id: "match-id",
      idempotency_key: "k-legacy-draw", derived_result: "DRAW",
    }));
    await addLegacy(makeHistoryPrediction({
      prediction_id: "p-legacy-away", user_id: "u-legacy-away", match_id: "match-id",
      idempotency_key: "k-legacy-away", derived_result: "AWAY",
    }));
    await addLegacy(makeHistoryPrediction({
      prediction_id: "p-legacy-other", user_id: "u-legacy-other", match_id: "other-match",
      idempotency_key: "k-legacy-other", derived_result: "HOME",
    }));
    await expect(repo.predictions.countByMatchGroupedByResult("match-id"))
      .resolves.toEqual({ HOME: 1, DRAW: 1, AWAY: 1 });
  });

  it("unions canonical and legacy crowd counts without double-counting", async () => {
    const db = new MemoryCloudBaseDb();
    const repo = createCloudBaseRepository(db);
    const col = cloudBaseCollectionName(CONFIG.resource_namespace, "predictions");
    await repo.predictions.insert(makeHistoryPrediction({
      prediction_id: "p-canonical-home", user_id: "u-canonical-home", match_id: "match-id",
      canonical_match_id: "match-id", idempotency_key: "k-canonical-home", derived_result: "HOME",
    }));
    const { canonical_match_id: _ignored, ...legacyDraw } = makeHistoryPrediction({
      prediction_id: "p-legacy-draw", user_id: "u-legacy-draw", match_id: "match-id",
      idempotency_key: "k-legacy-draw", derived_result: "DRAW",
    });
    await db.add(col, "p-legacy-draw", { ...legacyDraw, _id: "p-legacy-draw" });
    await db.add(col, "p-null-canonical-away", {
      ...legacyDraw,
      prediction_id: "p-null-canonical-away",
      user_id: "u-null-canonical-away",
      canonical_match_id: null,
      idempotency_key: "k-null-canonical-away",
      derived_result: "AWAY",
      _id: "p-null-canonical-away",
    });
    await expect(repo.predictions.countByMatchGroupedByResult("match-id"))
      .resolves.toEqual({ HOME: 1, DRAW: 1, AWAY: 1 });
  });

  it("matches in-memory crowd counts on mixed canonical and legacy predictions", async () => {
    const memory = new InMemoryRepository();
    const db = new MemoryCloudBaseDb();
    const cloudbase = createCloudBaseRepository(db);
    const col = cloudBaseCollectionName(CONFIG.resource_namespace, "predictions");
    const canonicalHome = makeHistoryPrediction({
      prediction_id: "p-canonical-home", user_id: "u-canonical-home", match_id: "match-id",
      canonical_match_id: "match-id", idempotency_key: "k-canonical-home", derived_result: "HOME",
    });
    const { canonical_match_id: _ignored, ...legacyDrawFields } = makeHistoryPrediction({
      prediction_id: "p-legacy-draw", user_id: "u-legacy-draw", match_id: "match-id",
      idempotency_key: "k-legacy-draw", derived_result: "DRAW",
    });
    const legacyDraw = legacyDrawFields as Prediction;
    await memory.predictions.insert(canonicalHome);
    await memory.predictions.insert(legacyDraw);
    await cloudbase.predictions.insert(canonicalHome);
    await db.add(col, legacyDraw.prediction_id, { ...legacyDraw, _id: legacyDraw.prediction_id });
    const expected = { HOME: 1, DRAW: 1, AWAY: 0 };
    await expect(memory.predictions.countByMatchGroupedByResult("match-id")).resolves.toEqual(expected);
    await expect(cloudbase.predictions.countByMatchGroupedByResult("match-id")).resolves.toEqual(expected);
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

  it("listFinalSeasonIds pushes distinct season lookup down via db.distinctQuery and ignores head rows", async () => {
    const db = new MemoryCloudBaseDb();
    const querySpy = vi.spyOn(db, "query");
    const distinctQuery = vi.fn<NonNullable<CloudBaseDb["distinctQuery"]>>(async () => [
      { level_season_id: "2026_2027", snapshot_kind: "" },
      { level_season_id: "2027_2028", snapshot_kind: "" },
      { level_season_id: "2027_2028", snapshot_kind: "" },
      { level_season_id: "2025_2026", snapshot_kind: "head" },
      { level_season_id: "", snapshot_kind: "" },
    ]);
    (db as CloudBaseDb).distinctQuery = distinctQuery;
    const repo = createCloudBaseRepository(db);

    await expect(repo.boardSnapshots.listFinalSeasonIds()).resolves.toEqual(["2027_2028", "2026_2027"]);
    expect(distinctQuery).toHaveBeenCalledWith(
      cloudBaseCollectionName(CONFIG.resource_namespace, "board_snapshots"),
      ["level_season_id", "snapshot_kind"],
      { board: "season", is_final: true },
    );
    expect(querySpy).not.toHaveBeenCalled();
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
    for (const jobType of ["near_match", "live_match", "post_finish_verify", "stale_recovery"] as const) {
      const query = { jobType, now: NOW, limit: 50 };
      const memoryIds = (await memory.matches.findActiveWindow(query)).map((row) => row.match_id);
      const cloudIds = (await cloud.matches.findActiveWindow(query)).map((row) => row.match_id);
      expect(cloudIds).toEqual(memoryIds);
    }
  }

  it("恢复任务超出上限时优先查询最早的候选", async () => {
    const repo = createCloudBaseRepository(new RangeAwareMemoryCloudBaseDb());
    for (let index = 0; index < 12; index += 1) {
      await repo.matches.insert(makeWindowMatch({ match_id: `stale-${index}`, kickoff_at: new Date(NOW.getTime() - (index + 7) * hour) }));
    }
    const result = await repo.matches.findActiveWindow({ jobType: "stale_recovery", now: NOW, limit: 10 });
    expect(result.map((match) => match.match_id)).toEqual(Array.from({ length: 10 }, (_, index) => `stale-${11 - index}`));
  });

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

  it("stale_recovery 下推 superseded_by: null，存在 >=10 条历史取代旧记录时不饿死滞留比赛 (A-S3-08)", async () => {
    const db = new RangeAwareMemoryCloudBaseDb();
    const repo = createCloudBaseRepository(db);
    for (let index = 0; index < 12; index += 1) {
      const replacement = makeWindowMatch({
        match_id: `rep-${index}`,
        kickoff_at: new Date(NOW.getTime() + (index + 24) * hour),
      });
      const old = makeWindowMatch({
        match_id: `old-${index}`,
        kickoff_at: new Date(NOW.getTime() - (index + 20) * hour),
      });
      await repo.matches.insert(replacement);
      await repo.matches.insert(old);
      await repo.matches.update({ ...old, canonical_match_id: replacement.match_id, superseded_by: replacement.match_id });
    }
    const realStale = makeWindowMatch({
      match_id: "real-stale",
      kickoff_at: new Date(NOW.getTime() - 8 * hour),
    });
    await repo.matches.insert(realStale);
    const querySpy = vi.spyOn(db, "query");

    const found = await repo.matches.findActiveWindow({ jobType: "stale_recovery", now: NOW, limit: 10 });
    expect(found.map((match) => match.match_id)).toEqual(["real-stale"]);
    for (const call of querySpy.mock.calls) {
      expect(call[1]).toMatchObject({ superseded_by: null });
    }
  });

  it("[CR42-08] 同开球时间超过 10 场滞留时，stale_recovery 带 after 游标向后翻页返回第 11+ 场", async () => {
    const db = new RangeAwareMemoryCloudBaseDb();
    const repo = createCloudBaseRepository(db);
    const sameKickoff = new Date(NOW.getTime() - 10 * hour);
    for (let index = 1; index <= 12; index += 1) {
      const id = `same-${String(index).padStart(2, "0")}`;
      await repo.matches.insert(makeWindowMatch({ match_id: id, kickoff_at: sameKickoff }));
    }

    const firstPage = await repo.matches.findActiveWindow({
      jobType: "stale_recovery",
      now: NOW,
      limit: 10,
    });
    expect(firstPage.map((m) => m.match_id)).toEqual(
      Array.from({ length: 10 }, (_, idx) => `same-${String(idx + 1).padStart(2, "0")}`),
    );

    const lastOfFirst = firstPage[firstPage.length - 1]!;
    const secondPage = await repo.matches.findActiveWindow({
      jobType: "stale_recovery",
      now: NOW,
      limit: 10,
      after: { kickoff_at: lastOfFirst.kickoff_at, match_id: lastOfFirst.match_id },
    });
    expect(secondPage.map((m) => m.match_id)).toEqual(["same-11", "same-12"]);
  });

  it("[Slice 4] board_snapshots 多时间截面下 findLatestByBoard/findLatestBySeason 只查最新非终榜截面", async () => {
    const db = new MemoryCloudBaseDb();
    const repo = createCloudBaseRepository(db);
    const t1 = new Date("2026-08-01T00:00:00.000Z");
    const t2 = new Date("2026-08-02T00:00:00.000Z");
    const tFinal = new Date("2026-08-03T00:00:00.000Z");
    const baseSnap = {
      schema_version: 1 as const,
      board: "season" as const,
      user_id: "u1",
      level_season_id: "2026_2027",
      rank: 1,
      career_points: null,
      career_exact_hits: null,
      career_valid_predictions: null,
      career_last_scoring_match_at: null,
      window_score_sum: null,
      window_n: null,
    };
    await repo.boardSnapshots.insert({
      ...baseSnap,
      snapshot_id: "snap-1",
      snapshot_at: t1,
      season_points: 10,
      season_exact_hits: 0,
      season_valid_predictions: 1,
      season_last_scoring_match_at: t1,
      is_final: false,
      created_at: t1,
    });
    await repo.boardSnapshots.insert({
      ...baseSnap,
      snapshot_id: "snap-2",
      snapshot_at: t2,
      season_points: 24,
      season_exact_hits: 2,
      season_valid_predictions: 2,
      season_last_scoring_match_at: t2,
      is_final: false,
      created_at: t2,
    });
    await repo.boardSnapshots.insert({
      ...baseSnap,
      snapshot_id: "snap-final",
      snapshot_at: tFinal,
      season_points: 99,
      season_exact_hits: 5,
      season_valid_predictions: 5,
      season_last_scoring_match_at: tFinal,
      is_final: true,
      created_at: tFinal,
    });

    const querySpy = vi.spyOn(db, "query");
    const latestBoard = await repo.boardSnapshots.findLatestByBoard("season");
    expect(latestBoard).toHaveLength(1);
    expect(latestBoard[0]?.snapshot_at.toISOString()).toBe(t2.toISOString());
    expect(querySpy).toHaveBeenCalledWith(
      expect.any(String),
      { board: "season", is_final: false },
      { order_by: "snapshot_at", direction: "desc", limit: 100, offset: 0 },
    );
    expect(querySpy).toHaveBeenCalledWith(
      expect.any(String),
      { board: "season", snapshot_at: t2 },
      undefined,
    );

    querySpy.mockClear();
    const latestSeason = await repo.boardSnapshots.findLatestBySeason("2026_2027");
    expect(latestSeason).toHaveLength(1);
    expect(latestSeason[0]?.snapshot_at.toISOString()).toBe(t2.toISOString());
    expect(querySpy).toHaveBeenCalledWith(
      expect.any(String),
      { board: "season", level_season_id: "2026_2027", is_final: false },
      { order_by: "snapshot_at", direction: "desc", limit: 100, offset: 0 },
    );
  });

  it("findLatestByBoard/findLatestBySeason 分页扫过终榜窗口后仍能命中旧的非终榜截面，并按 rank 升序", async () => {
    const repo = createCloudBaseRepository();
    const oldAt = new Date("2026-01-01T00:00:00.000Z");
    const rank2 = makeSeasonSnapshot({
      snapshot_id: "old-rank-2", snapshot_at: oldAt, user_id: "u-old-2", rank: 2, is_final: false, created_at: oldAt,
    });
    const rank1 = makeSeasonSnapshot({
      snapshot_id: "old-rank-1", snapshot_at: oldAt, user_id: "u-old-1", rank: 1, is_final: false, created_at: oldAt,
    });
    await repo.boardSnapshots.insert(rank2);
    await repo.boardSnapshots.insert(rank1);
    for (let i = 0; i < 120; i += 1) {
      const at = new Date(oldAt.getTime() + (i + 1) * 1000);
      await repo.boardSnapshots.insert(makeSeasonSnapshot({
        snapshot_id: `final-${i}`, snapshot_at: at, user_id: `u-final-${i}`, is_final: true, created_at: at,
      }));
    }
    const expected = [
      expect.objectContaining({ user_id: "u-old-1", rank: 1, snapshot_at: oldAt }),
      expect.objectContaining({ user_id: "u-old-2", rank: 2, snapshot_at: oldAt }),
    ];
    await expect(repo.boardSnapshots.findLatestBySeason("2026_2027")).resolves.toEqual(expected);
    await expect(repo.boardSnapshots.findLatestByBoard("season")).resolves.toEqual(expected);
  });

  it("is_final 缺失、null、false 都当作非终榜可用，true 被排除", async () => {
    const db = new MemoryCloudBaseDb();
    const repo = createCloudBaseRepository(db);
    const col = cloudBaseCollectionName(CONFIG.resource_namespace, "board_snapshots");
    const tFinal = new Date("2026-08-04T00:00:00.000Z");
    const tUsable = new Date("2026-08-03T00:00:00.000Z");
    const addRaw = async (overrides: Record<string, unknown>) => {
      const snapshot = makeSeasonSnapshot(overrides as Partial<BoardSnapshot>);
      const document: CloudBaseDocument = { ...snapshot, _id: snapshot.snapshot_id };
      if (!("is_final" in overrides)) delete document.is_final;
      await db.add(col, snapshot.snapshot_id, document);
    };
    await addRaw({ snapshot_id: "final-newer", snapshot_at: tFinal, user_id: "u-final", is_final: true, created_at: tFinal });
    await addRaw({ snapshot_id: "missing", snapshot_at: tUsable, user_id: "u-missing", rank: 3, created_at: tUsable });
    await addRaw({ snapshot_id: "null-final", snapshot_at: tUsable, user_id: "u-null", rank: 1, is_final: null, created_at: tUsable });
    await addRaw({ snapshot_id: "false-final", snapshot_at: tUsable, user_id: "u-false", rank: 2, is_final: false, created_at: tUsable });
    await addRaw({ snapshot_id: "true-same", snapshot_at: tUsable, user_id: "u-true", rank: 4, is_final: true, created_at: tUsable });
    const latestSeason = await repo.boardSnapshots.findLatestBySeason("2026_2027");
    const latestBoard = await repo.boardSnapshots.findLatestByBoard("season");
    const expectedIds = ["null-final", "false-final", "missing"];
    expect(latestSeason.map((item) => item.snapshot_id)).toEqual(expectedIds);
    expect(latestBoard.map((item) => item.snapshot_id)).toEqual(expectedIds);
    expect(latestSeason.map((item) => item.rank)).toEqual([1, 2, 3]);
  });

  it("没有任何非终榜时返回空数组，且分页扫描有明确终止", async () => {
    const db = new MemoryCloudBaseDb();
    const repo = createCloudBaseRepository(db);
    for (let i = 0; i < 250; i += 1) {
      const at = new Date(NOW.getTime() + i * 1000);
      await repo.boardSnapshots.insert(makeSeasonSnapshot({
        snapshot_id: `only-final-${i}`, snapshot_at: at, user_id: `u-only-final-${i}`, is_final: true, created_at: at,
      }));
    }
    const querySpy = vi.spyOn(db, "query");
    await expect(repo.boardSnapshots.findLatestBySeason("2026_2027")).resolves.toEqual([]);
    const seasonCalls = querySpy.mock.calls.length;
    expect(seasonCalls).toBeGreaterThan(0);
    expect(seasonCalls).toBeLessThanOrEqual(5);
    querySpy.mockClear();
    await expect(repo.boardSnapshots.findLatestByBoard("season")).resolves.toEqual([]);
    expect(querySpy.mock.calls.length).toBeGreaterThan(0);
    expect(querySpy.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("[Slice 4] findBySeasonInWindow 下推 kickoff_at 范围过滤，findUnfinalizedWeeks 下推未封周榜过滤", async () => {
    const db = new RangeAwareMemoryCloudBaseDb();
    const repo = createCloudBaseRepository(db);
    const from = new Date(NOW.getTime() - 2 * hour);
    const to = new Date(NOW.getTime() + 2 * hour);
    await repo.matches.insert(makeWindowMatch({ match_id: "in-window", kickoff_at: NOW }));
    await repo.matches.insert(makeWindowMatch({ match_id: "too-early", kickoff_at: new Date(NOW.getTime() - 24 * hour) }));
    await repo.matches.insert(makeWindowMatch({ match_id: "too-late", kickoff_at: new Date(NOW.getTime() + 24 * hour) }));

    const querySpy = vi.spyOn(db, "query");
    const inWindow = await repo.matches.findBySeasonInWindow!("2026_2027", from, to);
    expect(inWindow.map((m) => m.match_id)).toEqual(["in-window"]);
    expect(querySpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        season_id: "2026_2027",
        kickoff_at: { __gte: from, __lte: to },
      }),
      undefined,
    );

    await repo.rankings.insert({
      schema_version: 1,
      period_type: "week",
      period_key: "2026-W31",
      user_id: USER_ID,
      period_score: 12,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
      last_scoring_match_at: NOW,
      global_rank: 1,
      is_final: true,
      created_at: NOW,
      updated_at: NOW,
    });
    await repo.rankings.insert({
      schema_version: 1,
      period_type: "week",
      period_key: "2026-W32",
      user_id: USER_ID,
      period_score: 24,
      valid_predictions: 2,
      wdl_hits: 2,
      exact_hits: 2,
      last_scoring_match_at: NOW,
      global_rank: 1,
      is_final: false,
      created_at: NOW,
      updated_at: NOW,
    });
    const unfinalized = await repo.rankings.findUnfinalizedWeeks!();
    expect(unfinalized.map((r) => r.period_key)).toEqual(["2026-W32"]);
  });

  it("[Slice 2] findByPeriodAnchorWindow 与 findWeekEntriesSince 下推范围/未定稿过滤", async () => {
    const db = new RangeAwareMemoryCloudBaseDb();
    const repo = createCloudBaseRepository(db);
    const start = new Date("2026-08-24T00:00:00.000Z");
    const end = new Date("2026-08-31T00:00:00.000Z");
    await repo.matches.insert(makeWindowMatch({
      match_id: "anchor-in",
      period_anchor_at: new Date("2026-08-26T12:00:00.000Z"),
    }));
    await repo.matches.insert(makeWindowMatch({
      match_id: "anchor-before",
      period_anchor_at: new Date("2026-08-23T12:00:00.000Z"),
    }));
    await repo.matches.insert(makeWindowMatch({
      match_id: "anchor-after",
      period_anchor_at: end,
    }));
    const inWindow = await repo.matches.findByPeriodAnchorWindow!(start, end);
    expect(inWindow.map((match) => match.match_id)).toEqual(["anchor-in"]);

    for (const [key, final] of [
      ["2026-W32", false],
      ["2026-W33", true],
      ["2026-W34", false],
      ["2026-W35", true],
    ] as const) {
      await repo.rankings.insert({
        schema_version: 1,
        period_type: "week",
        period_key: key,
        user_id: USER_ID,
        period_score: 12,
        valid_predictions: 1,
        wdl_hits: 1,
        exact_hits: 1,
        last_scoring_match_at: NOW,
        global_rank: 1,
        is_final: final,
        created_at: NOW,
        updated_at: NOW,
      });
    }
    const sinceOnly = (await repo.rankings.findWeekEntriesSince!("2026-W34", false))
      .map((row) => row.period_key)
      .sort();
    expect(sinceOnly).toEqual(["2026-W34", "2026-W35"]);
    const weeks = (await repo.rankings.findWeekEntriesSince!("2026-W34", true))
      .map((row) => row.period_key)
      .sort();
    expect(weeks).toEqual(["2026-W32", "2026-W34", "2026-W35"]);

    const memory = new InMemoryRepository();
    for (const [key, final] of [
      ["2026-W32", false],
      ["2026-W33", true],
      ["2026-W34", false],
      ["2026-W35", true],
    ] as const) {
      await memory.rankings.insert({
        schema_version: 1,
        period_type: "week",
        period_key: key,
        user_id: USER_ID,
        period_score: 12,
        valid_predictions: 1,
        wdl_hits: 1,
        exact_hits: 1,
        last_scoring_match_at: NOW,
        global_rank: 1,
        is_final: final,
        created_at: NOW,
        updated_at: NOW,
      });
    }
    expect((await memory.rankings.findWeekEntriesSince!("2026-W34", false))
      .map((row) => row.period_key)
      .sort()).toEqual(["2026-W34", "2026-W35"]);
    expect((await memory.rankings.findWeekEntriesSince!("2026-W34", true))
      .map((row) => row.period_key)
      .sort()).toEqual(["2026-W32", "2026-W34", "2026-W35"]);
  });

  it("[Slice 2] findSettledCorrectionsPendingReeval 在查询层排除 completed 并保留 legacy 缺失字段", async () => {
    const makeSettlement = (
      settlementId: string,
      levelReevalStatus?: "pending" | "completed",
    ): SettlementDoc => ({
      schema_version: 1,
      settlement_id: settlementId,
      match_id: `match-${settlementId}`,
      result_version: 2,
      rule_version: "scoring_v1",
      status: SettlementDocStatus.Settled,
      phase: SettlementPhase.Done,
      is_correction: true,
      ...(levelReevalStatus === undefined ? {} : { level_reeval_status: levelReevalStatus }),
      started_at: NOW,
      settled_at: NOW,
      attempt_count: 1,
      last_error_code: null,
      last_error_message: null,
      created_at: NOW,
      updated_at: NOW,
    });
    const seed = async (repo: InMemoryRepository | CloudBaseAppRepository) => {
      await repo.settlements.insert(makeSettlement("completed", "completed"));
      await repo.settlements.insert(makeSettlement("pending", "pending"));
      await repo.settlements.insert(makeSettlement("legacy"));
    };

    const memory = new InMemoryRepository();
    await seed(memory);
    expect((await memory.settlements.findSettledCorrectionsPendingReeval!())
      .map((row) => row.settlement_id)
      .sort()).toEqual(["legacy", "pending"]);

    const db = new MemoryCloudBaseDb();
    const cloud = createCloudBaseRepository(db);
    await seed(cloud);
    const querySpy = vi.spyOn(db, "query");
    const rows = await cloud.settlements.findSettledCorrectionsPendingReeval!();
    expect(rows.map((row) => row.settlement_id).sort()).toEqual(["legacy", "pending"]);
    expect(querySpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        status: "settled",
        is_correction: true,
        level_reeval_status: { __ne: "completed" },
      }),
      undefined,
    );
  });

  it("[Slice 4] jobLocks.acquire 在 fallback 并发冲突时捕获唯一冲突并返回 false", async () => {
    // 事务视图复用同一实例，唯一冲突才真正落在 jobLocks.acquire 的 add 调用上；
    // MemoryCloudBaseDb.runTransaction 会新建实例，无法观察 add 抛错。
    const duplicateDb: CloudBaseDb = {
      get: async () => null,
      add: async () => {
        throw new CloudBaseDuplicateKeyError("job_locks", "pk_job_locks", { _id: "lock:race" });
      },
      update: async () => undefined,
      query: async () => [],
      count: async () => 0,
      transaction: async (work) => work(duplicateDb),
    };
    const repo = new CloudBaseAppRepository(CONFIG, duplicateDb);
    await expect(repo.jobLocks.acquire("lock:race", "owner-1", new Date(Date.now() + 60_000))).resolves.toBe(false);
  });
});

describe("InMemoryRepository.findLeagueSeasonCatalog", () => {
  async function seedCatalog(repo: InMemoryRepository): Promise<void> {
    await repo.matches.insert(makeWindowMatch({
      match_id: "pl-old-03", league_id: "premier_league", season_id: "2025_2026", round_id: "03",
    }));
    await repo.matches.insert(makeWindowMatch({
      match_id: "pl-old-01a", league_id: "premier_league", season_id: "2025_2026", round_id: "01",
    }));
    await repo.matches.insert(makeWindowMatch({
      match_id: "pl-old-01b", league_id: "premier_league", season_id: "2025_2026", round_id: "01",
    }));
    await repo.matches.insert(makeWindowMatch({
      match_id: "pl-new-02", league_id: "premier_league", season_id: "2026_2027", round_id: "02",
    }));
    await repo.matches.insert(makeWindowMatch({
      match_id: "bl-new-01", league_id: "bundesliga", season_id: "2026_2027", round_id: "01",
    }));
    await repo.matches.insert(makeWindowMatch({
      match_id: "bl-old-10", league_id: "bundesliga", season_id: "2024_2025", round_id: "10",
    }));
    await repo.matches.insert(makeWindowMatch({
      match_id: "bl-old-02", league_id: "bundesliga", season_id: "2024_2025", round_id: "02",
    }));
  }

  it("aggregates by league/season with league_id asc, season_id desc, unique sorted round_ids", async () => {
    const repo = new InMemoryRepository();
    await seedCatalog(repo);
    await expect(repo.matches.findLeagueSeasonCatalog()).resolves.toEqual([
      { league_id: "bundesliga", season_id: "2026_2027", round_ids: ["01"] },
      { league_id: "bundesliga", season_id: "2024_2025", round_ids: ["02", "10"] },
      { league_id: "premier_league", season_id: "2026_2027", round_ids: ["02"] },
      { league_id: "premier_league", season_id: "2025_2026", round_ids: ["01", "03"] },
    ]);
  });

  it("filters by leagueId", async () => {
    const repo = new InMemoryRepository();
    await seedCatalog(repo);
    await expect(repo.matches.findLeagueSeasonCatalog("premier_league")).resolves.toEqual([
      { league_id: "premier_league", season_id: "2026_2027", round_ids: ["02"] },
      { league_id: "premier_league", season_id: "2025_2026", round_ids: ["01", "03"] },
    ]);
  });

  it("returns [] when there are no matches", async () => {
    const repo = new InMemoryRepository();
    await expect(repo.matches.findLeagueSeasonCatalog()).resolves.toEqual([]);
  });

  it("excludes superseded matches across InMemoryRepository and CloudBaseAppRepository (distinct & fallback)", async () => {
    const repo = new InMemoryRepository();
    await repo.matches.insert(makeWindowMatch({
      match_id: "pl-active",
      canonical_match_id: "pl-active",
      league_id: "premier_league",
      season_id: "2026_2027",
      round_id: "01",
    }));
    const oldMatch = makeWindowMatch({
      match_id: "pl-old-superseded",
      canonical_match_id: "pl-active",
      league_id: "premier_league",
      season_id: "2026_2027",
      round_id: "99",
    });
    await repo.matches.insert(oldMatch);
    await repo.matches.update({ ...oldMatch, superseded_by: "pl-active", updated_at: NOW });
    await expect(repo.matches.findLeagueSeasonCatalog()).resolves.toEqual([
      { league_id: "premier_league", season_id: "2026_2027", round_ids: ["01"] },
    ]);

    const db = new MemoryCloudBaseDb();
    (db as CloudBaseDb).distinctQuery = vi.fn(async () => [
      { league_id: "premier_league", season_id: "2026_2027", round_id: "01", superseded_by: "" },
      { league_id: "premier_league", season_id: "2026_2027", round_id: "99", superseded_by: "pl-active" },
    ]);
    const cbRepo = new CloudBaseAppRepository(CONFIG, db);
    await expect(cbRepo.matches.findLeagueSeasonCatalog()).resolves.toEqual([
      { league_id: "premier_league", season_id: "2026_2027", round_ids: ["01"] },
    ]);

    const fallbackDb = new MemoryCloudBaseDb();
    delete (fallbackDb as CloudBaseDb).distinctQuery;
    const fallbackRepo = new CloudBaseAppRepository(CONFIG, fallbackDb);
    await fallbackRepo.matches.insert(makeWindowMatch({
      match_id: "pl-active",
      canonical_match_id: "pl-active",
      league_id: "premier_league",
      season_id: "2026_2027",
      round_id: "01",
    }));
    await fallbackRepo.matches.insert(oldMatch);
    await fallbackRepo.matches.update({ ...oldMatch, superseded_by: "pl-active", updated_at: NOW });
    await expect(fallbackRepo.matches.findLeagueSeasonCatalog()).resolves.toEqual([
      { league_id: "premier_league", season_id: "2026_2027", round_ids: ["01"] },
    ]);
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

describe("InMemoryRepository.predictions.findHistoryPage", () => {
  const T1 = new Date("2026-08-08T05:00:00.000Z");
  const T2 = new Date("2026-08-08T06:00:00.000Z");
  const T3 = new Date("2026-08-08T07:00:00.000Z");

  async function insertMatchAndPrediction(
    repo: InMemoryRepository,
    matchOverrides: Partial<Match>,
    predictionOverrides: Partial<Prediction>,
  ): Promise<Prediction> {
    const match = makeWindowMatch(matchOverrides);
    await repo.matches.insert(match);
    const prediction = makeHistoryPrediction({
      match_id: match.match_id,
      canonical_match_id: match.canonical_match_id,
      ...predictionOverrides,
    });
    await repo.predictions.insert(prediction);
    return prediction;
  }

  it("不传筛选时按 submitted_at 降序，同时间按 prediction_id 降序", async () => {
    const repo = new InMemoryRepository();
    await insertMatchAndPrediction(repo, { match_id: "m-late-a" }, {
      prediction_id: "pred-a", idempotency_key: "k-a", submitted_at: T2,
    });
    await insertMatchAndPrediction(repo, { match_id: "m-late-b" }, {
      prediction_id: "pred-b", idempotency_key: "k-b", submitted_at: T2,
    });
    await insertMatchAndPrediction(repo, { match_id: "m-early" }, {
      prediction_id: "pred-c", idempotency_key: "k-c", submitted_at: T1,
    });
    await insertMatchAndPrediction(repo, { match_id: "m-other-user" }, {
      prediction_id: "pred-other", user_id: USER_ID_2, idempotency_key: "k-other", submitted_at: T3,
    });
    const page = await repo.predictions.findHistoryPage({
      user_id: USER_ID, league_id: null, season_id: null, cursor: null, limit: 10,
    });
    expect(page.map((item) => item.prediction_id)).toEqual(["pred-b", "pred-a", "pred-c"]);
  });

  it("传 league_id 只返回该联赛", async () => {
    const repo = new InMemoryRepository();
    await insertMatchAndPrediction(repo, { match_id: "m-pl", league_id: "premier_league" }, {
      prediction_id: "pred-pl", idempotency_key: "k-pl",
    });
    await insertMatchAndPrediction(repo, { match_id: "m-bl", league_id: "bundesliga" }, {
      prediction_id: "pred-bl", idempotency_key: "k-bl",
    });
    const page = await repo.predictions.findHistoryPage({
      user_id: USER_ID, league_id: "premier_league", season_id: null, cursor: null, limit: 10,
    });
    expect(page.map((item) => item.prediction_id)).toEqual(["pred-pl"]);
  });

  it("传 season_id 只返回该赛季", async () => {
    const repo = new InMemoryRepository();
    await insertMatchAndPrediction(repo, { match_id: "m-new", season_id: "2026_2027" }, {
      prediction_id: "pred-new", idempotency_key: "k-new",
    });
    await insertMatchAndPrediction(repo, { match_id: "m-old", season_id: "2025_2026" }, {
      prediction_id: "pred-old", idempotency_key: "k-old",
    });
    const page = await repo.predictions.findHistoryPage({
      user_id: USER_ID, league_id: null, season_id: "2026_2027", cursor: null, limit: 10,
    });
    expect(page.map((item) => item.prediction_id)).toEqual(["pred-new"]);
  });

  it("预测挂在已被 superseded_by 取代的旧比赛上时，按有效比赛的联赛/赛季命中且不重复", async () => {
    const repo = new InMemoryRepository();
    const current = makeWindowMatch({
      match_id: "m-current", canonical_match_id: "canonical-1",
      league_id: "premier_league", season_id: "2026_2027",
    });
    const old = makeWindowMatch({
      match_id: "m-old", canonical_match_id: "canonical-1",
      league_id: "bundesliga", season_id: "2025_2026",
    });
    await repo.matches.insert(current);
    await repo.matches.insert(old);
    await repo.matches.update({ ...old, superseded_by: current.match_id });
    await repo.predictions.insert(makeHistoryPrediction({
      prediction_id: "pred-on-old",
      match_id: old.match_id,
      canonical_match_id: old.canonical_match_id,
      idempotency_key: "k-on-old",
    }));
    const byEffective = await repo.predictions.findHistoryPage({
      user_id: USER_ID, league_id: "premier_league", season_id: "2026_2027", cursor: null, limit: 10,
    });
    expect(byEffective.map((item) => item.prediction_id)).toEqual(["pred-on-old"]);
    const byOldIdentity = await repo.predictions.findHistoryPage({
      user_id: USER_ID, league_id: "bundesliga", season_id: "2025_2026", cursor: null, limit: 10,
    });
    expect(byOldIdentity).toEqual([]);
  });

  it("游标翻页：第一页 limit=2，用最后一条做 cursor 取第二页，两页不重不漏", async () => {
    const repo = new InMemoryRepository();
    await insertMatchAndPrediction(repo, { match_id: "m-1" }, {
      prediction_id: "pred-1", idempotency_key: "k-1", submitted_at: T1,
    });
    await insertMatchAndPrediction(repo, { match_id: "m-2" }, {
      prediction_id: "pred-2", idempotency_key: "k-2", submitted_at: T2,
    });
    await insertMatchAndPrediction(repo, { match_id: "m-3" }, {
      prediction_id: "pred-3", idempotency_key: "k-3", submitted_at: T3,
    });
    const first = await repo.predictions.findHistoryPage({
      user_id: USER_ID, league_id: null, season_id: null, cursor: null, limit: 2,
    });
    expect(first.map((item) => item.prediction_id)).toEqual(["pred-3", "pred-2"]);
    const last = first[first.length - 1]!;
    const second = await repo.predictions.findHistoryPage({
      user_id: USER_ID, league_id: null, season_id: null,
      cursor: { submitted_at: last.submitted_at, prediction_id: last.prediction_id },
      limit: 2,
    });
    expect(second.map((item) => item.prediction_id)).toEqual(["pred-1"]);
    expect([...first, ...second].map((item) => item.prediction_id)).toEqual(["pred-3", "pred-2", "pred-1"]);
  });

  it("limit 生效：数据 3 条、limit=2 只返回 2 条", async () => {
    const repo = new InMemoryRepository();
    await insertMatchAndPrediction(repo, { match_id: "m-1" }, {
      prediction_id: "pred-1", idempotency_key: "k-1", submitted_at: T1,
    });
    await insertMatchAndPrediction(repo, { match_id: "m-2" }, {
      prediction_id: "pred-2", idempotency_key: "k-2", submitted_at: T2,
    });
    await insertMatchAndPrediction(repo, { match_id: "m-3" }, {
      prediction_id: "pred-3", idempotency_key: "k-3", submitted_at: T3,
    });
    const page = await repo.predictions.findHistoryPage({
      user_id: USER_ID, league_id: null, season_id: null, cursor: null, limit: 2,
    });
    expect(page).toHaveLength(2);
    expect(page.map((item) => item.prediction_id)).toEqual(["pred-3", "pred-2"]);
  });
});

describe("CloudBaseAppRepository Slice 3.3 batch & pushdown methods", () => {
  it("batches users/teams/matches/settlements/settlementItems/levelHistory/userSeasonStats in O(1) inFilter queries", async () => {
    const db = new MemoryCloudBaseDb();
    const repo = new CloudBaseAppRepository(CONFIG, db);
    await repo.users.insert(makeUser("u1"));
    await repo.users.insert(makeUser("u2"));
    await repo.teams.insert({
      schema_version: 1, team_id: "t1", league_id: "premier_league", name: "Home", short_name: "H",
      primary_color: null, secondary_color: null, status: "active", created_at: NOW, updated_at: NOW,
    });
    await repo.teams.insert({
      schema_version: 1, team_id: "t2", league_id: "premier_league", name: "Away", short_name: "A",
      primary_color: null, secondary_color: null, status: "active", created_at: NOW, updated_at: NOW,
    });
    await repo.matches.insert(makeWindowMatch({ match_id: "m1" }));
    await repo.matches.insert(makeWindowMatch({ match_id: "m2" }));
    await repo.settlementItems.insert({
      schema_version: 1, settlement_id: "s1", prediction_id: "p1", user_id: "u1",
      source_result_version: 1, old_score: 0, new_score: 3, old_wdl_hit: false, new_wdl_hit: true,
      old_exact_hit: false, new_exact_hit: false, score_delta: 3, valid_prediction_delta: 1,
      status: "applied", applied_at: NOW, attempt_count: 1, last_error_code: null, last_error_message: null,
      created_at: NOW, updated_at: NOW,
    });

    const querySpy = vi.spyOn(db, "query");
    const getSpy = vi.spyOn(db, "get");

    const usersMap = await repo.users.findByIds!(["u1", "u2", "missing"]);
    expect([...usersMap.keys()].sort()).toEqual(["u1", "u2"]);
    const teamsMap = await repo.teams.findByIds!(["t1", "t2"]);
    expect([...teamsMap.keys()].sort()).toEqual(["t1", "t2"]);
    const matchesMap = await repo.matches.findByIds!(["m1", "m2"]);
    expect([...matchesMap.keys()].sort()).toEqual(["m1", "m2"]);
    const appliedForU1 = await repo.settlementItems.findByUserAndStatus!("u1", "applied");
    expect(appliedForU1).toHaveLength(1);
    expect(querySpy).toHaveBeenCalledTimes(4);
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("[Slice 3.4] predictions.findHistoryPageWithScanResume 透传适配器 exhausted/resumeCursor", async () => {
    const db = new MemoryCloudBaseDb();
    const prediction = makeHistoryPrediction({ prediction_id: "p1", match_id: "m1" });
    const resumeCursor = { submitted_at: NOW, prediction_id: "p1" };
    (db as CloudBaseDb).findPredictionHistoryPage = vi.fn(async () => ({
      documents: [{ ...prediction, _id: "p1" }],
      exhausted: false,
      resumeCursor,
    }));
    const repo = new CloudBaseAppRepository(CONFIG, db);

    const page = await repo.predictions.findHistoryPageWithScanResume!({
      user_id: USER_ID,
      league_id: null,
      season_id: null,
      cursor: null,
      limit: 21,
    });

    expect(page.exhausted).toBe(false);
    expect(page.resume_cursor).toEqual(resumeCursor);
    expect(page.predictions.map((item) => item.prediction_id)).toEqual(["p1"]);
    expect(await repo.predictions.findHistoryPage({
      user_id: USER_ID,
      league_id: null,
      season_id: null,
      cursor: null,
      limit: 21,
    })).toHaveLength(1);
  });

  it("uses db.findLatestRegularBoardSnapshot and db.findSettlementFallbackPage when available, and pushes gteFilter on fallback", async () => {
    const db = new MemoryCloudBaseDb();
    const regularDoc = {
      ...makeSeasonSnapshot({ snapshot_id: "reg-1", snapshot_at: NOW, user_id: "u1", is_final: false }),
      _id: "reg-1",
    };
    const findLatestRegularBoardSnapshot = vi.fn(async () => [regularDoc]);
    const findSettlementFallbackPage = vi.fn(async () => [{ ...makeWindowMatch({ match_id: "m-fb" }), _id: "m-fb" }]);
    (db as CloudBaseDb).findLatestRegularBoardSnapshot = findLatestRegularBoardSnapshot;
    (db as CloudBaseDb).findSettlementFallbackPage = findSettlementFallbackPage;

    const querySpy = vi.spyOn(db, "query");
    const repo = new CloudBaseAppRepository(CONFIG, db);
    const snap = await repo.boardSnapshots.findLatestBySeason("2026_2027");
    expect(snap).toHaveLength(1);
    expect(findLatestRegularBoardSnapshot).toHaveBeenCalledTimes(1);

    const after = { kickoff_at: NOW, match_id: "m-0" };
    const fb = await repo.matches.findSettlementFallbackPage({ limit: 10, after });
    expect(fb).toHaveLength(1);
    expect(findSettlementFallbackPage).toHaveBeenCalledTimes(1);
    expect(querySpy).not.toHaveBeenCalled();

    // Non-PG fallback pushes gteFilter("kickoff_at", after.kickoff_at)
    const fallbackDb = new MemoryCloudBaseDb();
    (fallbackDb as CloudBaseDb).gteFilter = (field, value) => ({ [field]: { __gte: value } });
    const fbRepo = new CloudBaseAppRepository(CONFIG, fallbackDb);
    const fbQuerySpy = vi.spyOn(fallbackDb, "query");
    await fbRepo.matches.findSettlementFallbackPage({ limit: 10, after });
    expect(fbQuerySpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        match_status: "finished",
        kickoff_at: { __gte: NOW },
      }),
      expect.objectContaining({
        order_by: "kickoff_at",
        order_bys: [
          { field: "kickoff_at", direction: "asc" },
          { field: "match_id", direction: "asc" },
        ],
      }),
    );
  });

  it("[Slice 3.4] findSettlementFallbackPage 在同 kickoff_at 多于单批 limit 时按 (kickoff_at, match_id) 无漏续扫", async () => {
    const repo = createCloudBaseRepository();
    const kickoff = new Date("2026-08-05T15:00:00.000Z");
    for (const id of ["m-c", "m-a", "m-b"]) {
      await repo.matches.insert(makeWindowMatch({
        match_id: id,
        canonical_match_id: id,
        kickoff_at: kickoff,
        match_status: MatchStatus.Finished,
        settlement_status: SettlementStatus.Pending,
      }));
    }

    const first = await repo.matches.findSettlementFallbackPage({ limit: 2 });
    expect(first.map((match) => match.match_id)).toEqual(["m-a", "m-b"]);
    const second = await repo.matches.findSettlementFallbackPage({
      limit: 2,
      after: { kickoff_at: first[1]!.kickoff_at, match_id: first[1]!.match_id },
    });
    expect(second.map((match) => match.match_id)).toEqual(["m-c"]);
  });
});

describe("CloudBaseAppRepository anomaly page [A-S8-13]", () => {
  it("下推 status/blocking/keyset，并按 limit+1 计算 has_more", async () => {
    const db = new MemoryCloudBaseDb();
    const after = {
      last_seen_at: NOW,
      anomaly_id: "00000000-0000-4000-8000-000000000001",
    };
    const docs = [
      makeAnomaly({ anomaly_id: "00000000-0000-4000-8000-000000000003" }),
      makeAnomaly({ anomaly_id: "00000000-0000-4000-8000-000000000002" }),
      makeAnomaly({ anomaly_id: "00000000-0000-4000-8000-000000000001" }),
    ].map((anomaly) => ({ ...anomaly, _id: anomaly.anomaly_id }));
    const findAnomalyPage = vi.fn(async () => docs);
    (db as CloudBaseDb).findAnomalyPage = findAnomalyPage;
    const querySpy = vi.spyOn(db, "query");
    const repo = new CloudBaseAppRepository(CONFIG, db);

    const page = await repo.anomalies.findPage({
      status: AnomalyStatus.Open,
      blocking: false,
      after,
      limit: 2,
    });

    expect(findAnomalyPage).toHaveBeenCalledWith({
      collection: cloudBaseCollectionName(CONFIG.resource_namespace, "anomalies"),
      status: AnomalyStatus.Open,
      blocking: false,
      after,
      limit: 3,
    });
    expect(page.items.map((item) => item.anomaly_id)).toEqual([
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000002",
    ]);
    expect(page.has_more).toBe(true);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("适配器无下推时保持原内存筛选与 keyset 游标语义", async () => {
    const repo = createCloudBaseRepository();
    const sharedLastSeenAt = new Date("2026-08-09T10:00:00.000Z");
    for (const anomalyId of [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    ]) {
      await repo.anomalies.insert(makeAnomaly({
        anomaly_id: anomalyId,
        last_seen_at: sharedLastSeenAt,
      }));
    }

    const first = await repo.anomalies.findPage({
      status: AnomalyStatus.Open,
      blocking: false,
      after: null,
      limit: 2,
    });
    expect(first.items.map((item) => item.anomaly_id)).toEqual([
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000002",
    ]);
    expect(first.has_more).toBe(true);

    const last = first.items.at(-1)!;
    const second = await repo.anomalies.findPage({
      status: AnomalyStatus.Open,
      blocking: false,
      after: { last_seen_at: last.last_seen_at, anomaly_id: last.anomaly_id },
      limit: 2,
    });
    expect(second.items.map((item) => item.anomaly_id)).toEqual([
      "00000000-0000-4000-8000-000000000001",
    ]);
    expect(second.has_more).toBe(false);
  });
});

describe("CloudBaseAppRepository Slice 1 ranking patch & deleted user rebuild", () => {
  it("updateGlobalRank 只写 global_rank/updated_at，不覆盖积分与命中字段", async () => {
    const db = new MemoryCloudBaseDb();
    const repo = new CloudBaseAppRepository(CONFIG, db);
    await repo.rankings.insert({
      schema_version: 1,
      period_type: "week",
      period_key: "2026-W32",
      user_id: USER_ID,
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
    expect((db as CloudBaseDb).patch).toBeUndefined();
    const updateSpy = vi.spyOn(db, "update");
    await repo.rankings.updateGlobalRank!(
      "week",
      "2026-W32",
      USER_ID,
      2,
      updatedAt,
    );
    expect(updateSpy).toHaveBeenCalledWith(
      expect.stringContaining("rankings"),
      expect.any(String),
      { global_rank: 2, updated_at: updatedAt },
    );
    expect(await repo.rankings.findByPeriodAndUser("week", "2026-W32", USER_ID))
      .toMatchObject({
        period_score: 12,
        valid_predictions: 3,
        wdl_hits: 2,
        exact_hits: 1,
        last_scoring_match_at: NOW,
        global_rank: 2,
        updated_at: updatedAt,
      });
  });

  it("已注销且首评跳过时重建只改统计，保留冻结等级状态且不新增历史", async () => {
    const db = new MemoryCloudBaseDb();
    const repo = new CloudBaseAppRepository(CONFIG, db);
    const deletedAt = new Date("2026-08-05T00:00:00.000Z");
    await repo.users.insert({
      ...makeUser(USER_ID),
      status: UserStatus.Deleted,
      openid: `deleted:${USER_ID}`,
      deleted_at: deletedAt,
    });
    await repo.userSeasonStats.insert({
      schema_version: 1,
      user_id: USER_ID,
      level_season_id: "2026_2027",
      points: 0,
      valid_predictions: 0,
      wdl_hits: 0,
      exact_hits: 0,
      last_scoring_match_at: null,
      level: 1,
      best_level: 1,
      level_state: defaultLevelState(),
      is_level_frozen: true,
      created_at: NOW,
      updated_at: NOW,
    });
    const lastScoring = await insertExactHitFacts(repo, USER_ID, 20, "deleted-first");

    const outcome = await new RebuildUserStatsService(
      repo,
      new Date("2026-08-03T02:00:00.000Z"),
    ).rebuildUserStats(USER_ID, new Date("2026-12-01T00:00:00.000Z"));

    expect(outcome.user).toMatchObject({
      status: UserStatus.Deleted,
      career_points: 240,
      career_valid_predictions: 20,
      career_wdl_hits: 20,
      career_exact_hits: 20,
      career_last_scoring_match_at: lastScoring,
      career_level: 1,
      career_best_level: 1,
      career_level_state: defaultLevelState(),
    });
    expect(outcome.season_stats).toEqual([
      expect.objectContaining({
        level_season_id: "2026_2027",
        points: 240,
        valid_predictions: 20,
        wdl_hits: 20,
        exact_hits: 20,
        level: 1,
        best_level: 1,
        level_state: defaultLevelState(),
        is_level_frozen: true,
      }),
    ]);
    expect(outcome.created_level_history).toEqual([]);
    expect(await repo.levelHistory.findByUser(USER_ID)).toEqual([]);
  });

  it("已注销且已有评估时间时重建保留 career/冻结 season 等级与 level_state", async () => {
    const db = new MemoryCloudBaseDb();
    const repo = new CloudBaseAppRepository(CONFIG, db);
    const lastEvalAsOf = new Date("2026-08-03T02:00:00.000Z");
    const levelState = {
      below_count: 0,
      week_base_level: 1,
      week_base_below_count: 0,
      week_base_as_of: lastEvalAsOf,
      last_eval_as_of: lastEvalAsOf,
      last_eval_n: 20,
      last_eval_score_sum: 240,
      last_eval_b_points: 0,
      last_eval_rule_version: "level_v3.0",
    };
    await repo.users.insert({
      ...makeUser(USER_ID_2),
      status: UserStatus.Deleted,
      openid: `deleted:${USER_ID_2}`,
      deleted_at: new Date("2026-08-15T00:00:00.000Z"),
      career_points: 999,
      career_valid_predictions: 20,
      career_wdl_hits: 0,
      career_exact_hits: 0,
      career_level: 2,
      career_best_level: 2,
      career_level_state: levelState,
    });
    await repo.userSeasonStats.insert({
      schema_version: 1,
      user_id: USER_ID_2,
      level_season_id: "2026_2027",
      points: 999,
      valid_predictions: 20,
      wdl_hits: 0,
      exact_hits: 0,
      last_scoring_match_at: null,
      level: 2,
      best_level: 2,
      level_state: levelState,
      is_level_frozen: true,
      created_at: NOW,
      updated_at: NOW,
    });
    await insertExactHitFacts(repo, USER_ID_2, 20, "deleted-evaluated");

    const outcome = await new RebuildUserStatsService(
      repo,
      new Date("2026-08-03T02:00:00.000Z"),
    ).rebuildUserStats(USER_ID_2, new Date("2026-12-01T00:00:00.000Z"));

    expect(outcome.user).toMatchObject({
      career_points: 240,
      career_valid_predictions: 20,
      career_level: 2,
      career_best_level: 2,
      career_level_state: levelState,
    });
    expect(outcome.season_stats).toEqual([
      expect.objectContaining({
        level_season_id: "2026_2027",
        points: 240,
        valid_predictions: 20,
        level: 2,
        best_level: 2,
        level_state: levelState,
        is_level_frozen: true,
      }),
    ]);
    expect(outcome.created_level_history).toEqual([]);
    expect(await repo.levelHistory.findByUser(USER_ID_2)).toEqual([]);
  });
});
