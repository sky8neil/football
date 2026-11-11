import { describe, expect, it } from "vitest";
import { MatchStatus, Provider, SettlementStatus } from "../domain/enums.js";
import type { Match, MatchProviderMapping, ProviderSnapshot } from "../domain/types.js";
import { CloudBaseAppRepository } from "./cloudbase-app-repository.js";
import type {
  CloudBaseDb,
  CloudBaseDocument,
  CloudBaseQueryOptions,
  CloudBaseRepositoryConfig,
} from "./cloudbase-db.js";
import { createCountingDb } from "./db-op-counter.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const MATCH_ID = "m-1";
const CONFIG: CloudBaseRepositoryConfig = {
  cloud_environment_id: "cloud-test",
  resource_namespace: "ft",
};

function isInOp(value: unknown): value is { __in: readonly string[] } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "__in" in value;
}

function isLteOp(value: unknown): value is { __lte: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "__lte" in value;
}

class FakeDb implements CloudBaseDb {
  documents = new Map<string, CloudBaseDocument>();
  queries: Array<{
    collection: string;
    filter: Record<string, unknown>;
    options?: CloudBaseQueryOptions | undefined;
  }> = [];
  inFilter?: (field: string, values: readonly string[]) => Record<string, unknown> | undefined;
  lteFilter?: (field: string, value: unknown) => Record<string, unknown> | undefined;

  constructor(enableIn: boolean, enableLte: boolean) {
    if (enableIn) {
      this.inFilter = function inFilter(this: FakeDb, field, values) {
        if (this.documents === undefined) throw new Error("inFilter lost this");
        return { [field]: { __in: values } };
      };
    }
    if (enableLte) {
      this.lteFilter = function lteFilter(this: FakeDb, field, value) {
        if (this.documents === undefined) throw new Error("lteFilter lost this");
        return { [field]: { __lte: value } };
      };
    }
  }

  async get(collection: string, id: string): Promise<CloudBaseDocument | null> {
    return this.documents.get(`${collection}/${id}`) ?? null;
  }

  async add(collection: string, id: string, document: CloudBaseDocument): Promise<void> {
    this.documents.set(`${collection}/${id}`, { ...document, _id: id });
  }

  async update(): Promise<void> {}

  async query(
    collection: string,
    filter: Record<string, unknown> = {},
    options?: CloudBaseQueryOptions,
  ): Promise<CloudBaseDocument[]> {
    this.queries.push({ collection, filter, options });
    const rows = [...this.documents.entries()]
      .filter(([key]) => key.startsWith(`${collection}/`))
      .map(([, document]) => document)
      .filter((document) =>
        Object.entries(filter).every(([field, value]) => {
          if (isInOp(value)) return value.__in.includes(String(document[field] ?? ""));
          if (isLteOp(value)) {
            const left = document[field];
            const right = value.__lte;
            const leftMs = left instanceof Date ? left.getTime() : new Date(String(left)).getTime();
            const rightMs = right instanceof Date ? right.getTime() : new Date(String(right)).getTime();
            return leftMs <= rightMs;
          }
          return document[field] === value;
        }),
      );
    if (options?.order_by !== undefined) {
      const field = options.order_by;
      const direction = options.direction ?? "asc";
      rows.sort((a, b) => {
        const left = new Date(a[field] as string | Date).getTime();
        const right = new Date(b[field] as string | Date).getTime();
        return direction === "desc" ? right - left : left - right;
      });
    }
    return options?.limit === undefined ? rows : rows.slice(0, options.limit);
  }

  async count(): Promise<number> {
    return 0;
  }

  async transaction<T>(work: (transactionDb: CloudBaseDb) => Promise<T>): Promise<T> {
    return work(this);
  }
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
    entity_id: MATCH_ID,
    provider_entity_id: "123",
    event_type: eventType,
    payload: {},
    created_at: createdAt,
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

function wrapRepo(inner: FakeDb): CloudBaseAppRepository {
  return new CloudBaseAppRepository(CONFIG, createCountingDb(inner).db);
}

describe("createCountingDb passthrough of inFilter/lteFilter", () => {
  it("包装后批量映射仍走 in 查询，filter 含 in 条件", async () => {
    const inner = new FakeDb(true, true);
    const repo = wrapRepo(inner);
    const mappings = Array.from({ length: 3 }, (_, i) => makeMapping(i));
    for (const row of mappings) await repo.matchProviderMappings.insert(row);
    inner.queries = [];

    const found = await repo.matchProviderMappings.findByProviderAndExternalIds(
      Provider.ApiFootball,
      mappings.map((row) => row.provider_match_id),
    );

    expect(inner.queries).toHaveLength(1);
    expect(inner.queries[0]?.collection).toBe("ft_match_src_map");
    expect(isInOp(inner.queries[0]?.filter.provider_match_id)).toBe(true);
    expect((inner.queries[0]?.filter.provider_match_id as { __in: readonly string[] }).__in).toEqual([
      "ext-0",
      "ext-1",
      "ext-2",
    ]);
    expect(found.size).toBe(3);
  });

  it("包装后最近成功快照仍带 event_type in、倒序 created_at、limit 1", async () => {
    const inner = new FakeDb(true, true);
    const repo = wrapRepo(inner);
    await repo.providerSnapshots.insert(makeSnapshot("s-old", "discovered", new Date("2026-08-09T00:00:00.000Z")));
    await repo.providerSnapshots.insert(makeSnapshot("s-new", "result_observed", new Date("2026-08-09T00:02:00.000Z")));
    inner.queries = [];

    const latest = await repo.providerSnapshots.findLatestSuccessByEntity("match", MATCH_ID);

    expect(latest?.snapshot_id).toBe("s-new");
    expect(inner.queries).toHaveLength(1);
    const query = inner.queries[0]!;
    expect(query.collection).toBe("ft_provider_snaps");
    expect(query.filter.entity_type).toBe("match");
    expect(query.filter.entity_id).toBe(MATCH_ID);
    expect(isInOp(query.filter.event_type)).toBe(true);
    expect(query.options).toEqual({ order_by: "created_at", direction: "desc", limit: 1 });
  });

  it("包装后候选窗口查询仍带 kickoff_at 上界", async () => {
    const inner = new FakeDb(true, true);
    const repo = wrapRepo(inner);
    await repo.matches.insert(makeMatch({
      match_id: "sched-12h",
      kickoff_at: new Date(NOW.getTime() + 12 * 60 * 60 * 1000),
    }));
    inner.queries = [];

    await repo.matches.findActiveWindow({ jobType: "near_match", now: NOW, limit: 50 });

    expect(inner.queries.length).toBeGreaterThan(0);
    const query = inner.queries.find((item) => item.collection === "ft_matches");
    expect(query).toBeDefined();
    expect(query?.filter.match_status).toBe(MatchStatus.Scheduled);
    expect(isLteOp(query?.filter.kickoff_at)).toBe(true);
    expect((query?.filter.kickoff_at as { __lte: Date }).__lte).toEqual(new Date(NOW.getTime() + 24 * 60 * 60 * 1000));
  });

  it("事务内拿到的 db 同样具备 inFilter / lteFilter", async () => {
    const inner = new FakeDb(true, true);
    const { db } = createCountingDb(inner);
    await db.transaction(async (tx) => {
      expect(typeof tx.inFilter).toBe("function");
      expect(typeof tx.lteFilter).toBe("function");
      expect(tx.inFilter?.("provider_match_id", ["ext-1"])).toEqual({
        provider_match_id: { __in: ["ext-1"] },
      });
      expect(tx.lteFilter?.("kickoff_at", NOW)).toEqual({
        kickoff_at: { __lte: NOW },
      });
    });
  });

  it("底层不支持这两个方法时，包装后也不存在，仓储走退化路径", async () => {
    const inner = new FakeDb(false, false);
    const { db } = createCountingDb(inner);
    expect(db.inFilter).toBeUndefined();
    expect(db.lteFilter).toBeUndefined();
    await db.transaction(async (tx) => {
      expect(tx.inFilter).toBeUndefined();
      expect(tx.lteFilter).toBeUndefined();
    });

    const repo = new CloudBaseAppRepository(CONFIG, db);
    const mappings = Array.from({ length: 2 }, (_, i) => makeMapping(i));
    for (const row of mappings) await repo.matchProviderMappings.insert(row);
    inner.queries = [];

    const found = await repo.matchProviderMappings.findByProviderAndExternalIds(
      Provider.ApiFootball,
      mappings.map((row) => row.provider_match_id),
    );

    expect(inner.queries).toHaveLength(2);
    expect(inner.queries.every((query) => query.filter.provider_match_id !== undefined && !isInOp(query.filter.provider_match_id))).toBe(true);
    expect(found.size).toBe(2);
  });

  it("构造 filter 本身不增加 read 计数", () => {
    const inner = new FakeDb(true, true);
    const { db, counter } = createCountingDb(inner);
    counter.begin();
    expect(db.inFilter?.("provider_match_id", ["ext-1"])).toEqual({
      provider_match_id: { __in: ["ext-1"] },
    });
    expect(db.lteFilter?.("kickoff_at", NOW)).toEqual({
      kickoff_at: { __lte: NOW },
    });
    expect(counter.end()).toEqual({ read: 0, write: 0, by_collection: [] });
  });
});
