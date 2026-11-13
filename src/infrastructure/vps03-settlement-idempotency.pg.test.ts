import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { MatchScoreValue, MatchStatus, PeriodType, SettlementDocStatus, SettlementItemStatus, SettlementStatus } from "../domain/enums.js";
import { defaultLevelState, type Match, type MatchResult, type Prediction, type User } from "../domain/types.js";
import { FirstSettlementService } from "../application/first-settlement-service.js";
import {
  createAtomicSettlementItemWorker,
  SettlementItemApplicationService,
} from "../application/settlement-item-application-service.js";
import { calculatePeriodKey, levelSeasonOf } from "../domain/time.js";
import { COLLECTION_DEFINITIONS } from "../schema/collections.js";
import { UNIQUE_INDEXES } from "../schema/indexes.js";
import { CloudBaseAppRepository } from "./cloudbase-app-repository.js";
import {
  CloudBaseDocumentNotFoundError,
  CloudBaseDuplicateKeyError,
  type CloudBaseDb,
  type CloudBaseDocument,
  type CloudBaseQueryOptions,
} from "./cloudbase-db.js";
import {
  createPostgresDocumentDb,
  createPostgresQueryFn,
  type PostgresConnectFn,
} from "./postgres-document-db.js";
import { applyPostgresSchema, buildPostgresSchemaPlan, quoteIdent } from "./postgres-schema.js";
import type { AppRepository } from "./repositories.js";

const DATABASE_URL = process.env.FOOTBALL_TEST_DATABASE_URL ?? "";
const ENABLED = DATABASE_URL.length > 0;
const SCHEMA = "football_vps03_settle";
const NAMESPACE = "ft";
const NOW = new Date("2026-08-09T00:00:00.000Z");
const ANCHOR = new Date("2026-08-08T14:00:00.000Z");
const FINISH_AT = new Date(NOW.getTime() - 10 * 60 * 1000);
const RULE = "scoring_v1";
const MATCH_ID = "00000000-0000-4000-8000-000000000060";
const USER_ID = "00000000-0000-4000-8000-000000000000";
const PREDICTION_ID = "00000000-0000-4000-8000-000000000000";

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
      throw new CloudBaseDuplicateKeyError(collection, "pk_document", { _id: id });
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
      .filter((document) => Object.entries(filter).every(([field, value]) => equal(document[field], value)));
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
    return options.limit === undefined ? result.slice(offset) : result.slice(offset, offset + options.limit);
  }

  async count(collection: string, filter: Record<string, unknown> = {}): Promise<number> {
    return (await this.query(collection, filter)).length;
  }

  async transaction<T>(work: (transactionDb: CloudBaseDb) => Promise<T>): Promise<T> {
    if (this.transactionView) return this.runTransaction(work);
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
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

function makeMatch(): Match {
  return {
    schema_version: 1,
    match_id: MATCH_ID,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: "00000000-0000-4000-8000-000000000061",
    away_team_id: "00000000-0000-4000-8000-000000000062",
    kickoff_at: ANCHOR,
    kickoff_confirmed: true,
    prediction_deadline_at: new Date(ANCHOR.getTime() - 600_000),
    prediction_closed_at: new Date(ANCHOR.getTime() - 600_000),
    period_anchor_at: ANCHOR,
    match_status: MatchStatus.Finished,
    settlement_status: SettlementStatus.Waiting,
    regular_home_score: 2,
    regular_away_score: 1,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 1,
    settled_result_version: 0,
    result_source: "provider",
    scoring_rule_version: RULE,
    finish_detected_at: FINISH_AT,
    settled_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeResult(): MatchResult {
  return {
    schema_version: 1,
    match_id: MATCH_ID,
    result_version: 1,
    regular_home_score: 2,
    regular_away_score: 1,
    source: "provider",
    provider_status: "FT",
    admin_id: null,
    reason: null,
    created_at: FINISH_AT,
  };
}

function makeUser(): User {
  return {
    schema_version: 1,
    user_id: USER_ID,
    openid: "openid_i0",
    unionid: null,
    nickname: "User0",
    favorite_team_id: null,
    status: "active",
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_level: 1,
    career_best_level: 1,
    career_last_scoring_match_at: null,
    career_level_state: defaultLevelState(),
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makePrediction(): Prediction {
  return {
    schema_version: 1,
    prediction_id: PREDICTION_ID,
    user_id: USER_ID,
    match_id: MATCH_ID,
    idempotency_key: "00000000-0000-4000-8000-000000000063",
    pred_home_score: 2,
    pred_away_score: 1,
    derived_result: "HOME",
    submitted_at: NOW,
    scoring_rule_version: RULE,
    match_score: null,
    wdl_hit: null,
    exact_hit: null,
    applied_result_version: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

function iso(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

async function seed(repo: AppRepository): Promise<void> {
  await repo.matches.insert(makeMatch());
  await repo.matchResults.insert(makeResult());
  await repo.users.insert(makeUser());
  await repo.predictions.insert(makePrediction());
}

async function businessSnapshot(repo: AppRepository) {
  const user = await repo.users.findById(USER_ID);
  const match = await repo.matches.findById(MATCH_ID);
  const prediction = await repo.predictions.findById(PREDICTION_ID);
  const settlement = await repo.settlements.findByMatchAndVersionAndRule(MATCH_ID, 1, RULE);
  const items = settlement === null
    ? []
    : await repo.settlementItems.findBySettlement(settlement.settlement_id);
  const seasonId = levelSeasonOf(ANCHOR);
  const seasonStats = repo.userSeasonStats;
  const rankings = repo.rankings;
  if (seasonStats === undefined || rankings === undefined) {
    throw new Error("settlement snapshot requires userSeasonStats and rankings ports");
  }
  const season = await seasonStats.findByUserAndSeason(USER_ID, seasonId);
  const periodKey = calculatePeriodKey(PeriodType.Week, ANCHOR);
  const ranking = await rankings.findByPeriodAndUser(PeriodType.Week, periodKey, USER_ID);
  return {
    user: user === null ? null : {
      career_points: user.career_points,
      career_valid_predictions: user.career_valid_predictions,
      career_wdl_hits: user.career_wdl_hits,
      career_exact_hits: user.career_exact_hits,
      career_last_scoring_match_at: iso(user.career_last_scoring_match_at),
    },
    match: match === null ? null : {
      settlement_status: match.settlement_status,
      settled_result_version: match.settled_result_version,
      settled_at: iso(match.settled_at),
    },
    prediction: prediction === null ? null : {
      match_score: prediction.match_score,
      wdl_hit: prediction.wdl_hit,
      exact_hit: prediction.exact_hit,
      applied_result_version: prediction.applied_result_version,
    },
    settlement: settlement === null ? null : {
      result_version: settlement.result_version,
      rule_version: settlement.rule_version,
      status: settlement.status,
      phase: settlement.phase,
      is_correction: settlement.is_correction,
      attempt_count: settlement.attempt_count,
    },
    items: items
      .map((item) => ({
        user_id: item.user_id,
        prediction_id: item.prediction_id,
        old_score: item.old_score,
        new_score: item.new_score,
        score_delta: item.score_delta,
        status: item.status,
        attempt_count: item.attempt_count,
      }))
      .sort((a, b) => a.prediction_id.localeCompare(b.prediction_id)),
    season: season === null ? null : {
      points: season.points,
      valid_predictions: season.valid_predictions,
      wdl_hits: season.wdl_hits,
      exact_hits: season.exact_hits,
      last_scoring_match_at: iso(season.last_scoring_match_at),
    },
    ranking: ranking === null ? null : {
      period_score: ranking.period_score,
      valid_predictions: ranking.valid_predictions,
      wdl_hits: ranking.wdl_hits,
      exact_hits: ranking.exact_hits,
      global_rank: ranking.global_rank,
      last_scoring_match_at: iso(ranking.last_scoring_match_at),
    },
  };
}

async function runI60(repo: AppRepository) {
  await seed(repo);
  const service = new FirstSettlementService(
    repo,
    createAtomicSettlementItemWorker(new SettlementItemApplicationService(repo)),
  );
  const first = await service.start(MATCH_ID, NOW, false);
  const afterFirst = await businessSnapshot(repo);
  const second = await service.start(MATCH_ID, NOW, false);
  const afterSecond = await businessSnapshot(repo);
  return { first, second, afterFirst, afterSecond };
}

describe.skipIf(!ENABLED)("VPS03 I60 重复结算：PostgreSQL 与 CloudBase fixture 结果一致", () => {
  let pool!: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
    const queryFn = createPostgresQueryFn(pool);
    await applyPostgresSchema(queryFn, buildPostgresSchemaPlan(NAMESPACE, SCHEMA));
  });

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(SCHEMA)} CASCADE`);
    await pool.end();
  });

  it("同一场结算执行两次积分只变化一次，两端业务结果一致", async () => {
    const queryFn = createPostgresQueryFn(pool);
    const connect: PostgresConnectFn = async () => {
      const client = await pool.connect();
      return {
        query: createPostgresQueryFn(client),
        release: () => client.release(),
      };
    };
    const pgDb = createPostgresDocumentDb(queryFn, { schema: SCHEMA, namespace: NAMESPACE }, { connect });
    const pgRepo = new CloudBaseAppRepository({ resource_namespace: NAMESPACE }, pgDb);
    const cloudRepo = new CloudBaseAppRepository(
      { resource_namespace: NAMESPACE },
      new MemoryCloudBaseDb(),
    );

    const postgres = await runI60(pgRepo);
    const cloudbase = await runI60(cloudRepo);

    expect(postgres.first).toMatchObject({ kind: "started", settlement_created: true, processed_count: 1 });
    expect(postgres.second).toMatchObject({ kind: "already_settled", processed_count: 0 });
    expect(postgres.afterFirst.user?.career_points).toBe(MatchScoreValue.ExactHit);
    expect(postgres.afterSecond.user?.career_points).toBe(MatchScoreValue.ExactHit);
    expect(postgres.afterFirst.match?.settlement_status).toBe(SettlementStatus.Settled);
    expect(postgres.afterFirst.settlement?.status).toBe(SettlementDocStatus.Settled);
    expect(postgres.afterFirst.items).toEqual([
      expect.objectContaining({
        prediction_id: PREDICTION_ID,
        new_score: MatchScoreValue.ExactHit,
        score_delta: MatchScoreValue.ExactHit,
        status: SettlementItemStatus.Applied,
        attempt_count: 1,
      }),
    ]);
    expect(postgres.afterSecond).toEqual(postgres.afterFirst);
    expect(cloudbase.first).toMatchObject({ kind: "started", settlement_created: true, processed_count: 1 });
    expect(cloudbase.second).toMatchObject({ kind: "already_settled", processed_count: 0 });
    expect(cloudbase.afterFirst).toEqual(postgres.afterFirst);
    expect(cloudbase.afterSecond).toEqual(postgres.afterSecond);
  });
});
