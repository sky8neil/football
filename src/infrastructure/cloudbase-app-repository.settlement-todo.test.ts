import { describe, expect, it } from "vitest";
import { MatchStatus, SettlementStatus } from "../domain/enums.js";
import { SETTLEMENT_TODO_STATUSES } from "./settlement-todo-query.js";
import { CloudBaseAppRepository } from "./cloudbase-app-repository.js";
import {
  cloudBaseCollectionName,
  type CloudBaseDb,
  type CloudBaseDocument,
  type CloudBaseQueryOptions,
  type CloudBaseRepositoryConfig,
} from "./cloudbase-db.js";

const T1 = new Date("2026-08-08T12:00:00.000Z");
const CONFIG: CloudBaseRepositoryConfig = {
  cloud_environment_id: "cloud-test",
  resource_namespace: "ft-test",
};

function kickoff(offsetMinutes: number): Date {
  return new Date(T1.getTime() + offsetMinutes * 60_000);
}

function matchDoc(input: {
  match_id: string;
  settlement_status: string;
  kickoff_at: Date;
  match_status?: string;
}): CloudBaseDocument {
  return {
    _id: `${input.match_id}:${input.settlement_status}`,
    match_id: input.match_id,
    match_status: input.match_status ?? MatchStatus.Finished,
    settlement_status: input.settlement_status,
    kickoff_at: input.kickoff_at,
  };
}

class FilterRecordingDb implements CloudBaseDb {
  readonly queries: Array<{
    collection: string;
    filter: Record<string, unknown>;
    options: CloudBaseQueryOptions;
  }> = [];
  private readonly documents: CloudBaseDocument[];

  constructor(documents: CloudBaseDocument[]) {
    this.documents = documents;
  }

  async get(): Promise<CloudBaseDocument | null> {
    return null;
  }

  async add(): Promise<void> {}

  async update(): Promise<void> {}

  async query(
    collection: string,
    filter: Record<string, unknown> = {},
    options: CloudBaseQueryOptions = {},
  ): Promise<CloudBaseDocument[]> {
    this.queries.push({ collection, filter, options });
    let rows = this.documents
      .filter((document) => collection.endsWith("_matches") || collection.includes("matches"))
      .filter((document) =>
        Object.entries(filter).every(([field, value]) => document[field] === value),
      );
    if (options.order_by) {
      const field = options.order_by;
      const direction = options.direction === "desc" ? -1 : 1;
      rows = rows.sort((left, right) => {
        const a = left[field];
        const b = right[field];
        const compare =
          a instanceof Date && b instanceof Date
            ? a.getTime() - b.getTime()
            : String(a).localeCompare(String(b));
        return compare * direction;
      });
    }
    const offset = options.offset ?? 0;
    return options.limit === undefined ? rows.slice(offset) : rows.slice(offset, offset + options.limit);
  }

  async count(): Promise<number> {
    return 0;
  }

  async transaction<T>(work: (transactionDb: CloudBaseDb) => Promise<T>): Promise<T> {
    return work(this);
  }
}

function repoWith(docs: CloudBaseDocument[]) {
  const db = new FilterRecordingDb(docs);
  const repo = new CloudBaseAppRepository(CONFIG, db);
  return { db, repo };
}

const TODO_DOCS: CloudBaseDocument[] = [
  matchDoc({ match_id: "m01", settlement_status: SettlementStatus.Pending, kickoff_at: kickoff(1) }),
  matchDoc({ match_id: "m02", settlement_status: SettlementStatus.Pending, kickoff_at: kickoff(2) }),
  matchDoc({ match_id: "m02", settlement_status: SettlementStatus.Waiting, kickoff_at: kickoff(2) }),
  matchDoc({ match_id: "m03", settlement_status: SettlementStatus.Waiting, kickoff_at: kickoff(3) }),
  matchDoc({ match_id: "m04", settlement_status: SettlementStatus.Settling, kickoff_at: kickoff(4) }),
  matchDoc({ match_id: "m05", settlement_status: SettlementStatus.Failed, kickoff_at: kickoff(5) }),
  matchDoc({ match_id: "m06", settlement_status: SettlementStatus.Correcting, kickoff_at: kickoff(6) }),
  matchDoc({ match_id: "m07", settlement_status: SettlementStatus.Correcting, kickoff_at: kickoff(7) }),
  matchDoc({
    match_id: "settled",
    settlement_status: SettlementStatus.Settled,
    kickoff_at: kickoff(0),
  }),
];

describe("CloudBaseAppRepository.findSettlementTodos", () => {
  it("limit=5 时对每个非终态状态各发 1 次 query，filter 同时含 finished 与该状态", async () => {
    const { db, repo } = repoWith(TODO_DOCS);
    await repo.matches.findSettlementTodos({ limit: 5 });

    const matchQueries = db.queries.filter(
      (query) => query.collection === cloudBaseCollectionName(CONFIG.resource_namespace, "matches"),
    );
    expect(matchQueries).toHaveLength(5);
    const statuses = matchQueries.map((query) => query.filter.settlement_status).sort();
    expect(statuses).toEqual([...SETTLEMENT_TODO_STATUSES].sort());
    for (const query of matchQueries) {
      expect(query.filter.match_status).toBe(MatchStatus.Finished);
      expect(query.options.order_by).toBe("kickoff_at");
      expect(query.options.limit).toBe(5);
    }
  });

  it("返回结果合并去重、按 kickoff/match_id 排序并截断到 limit", async () => {
    const { repo } = repoWith(TODO_DOCS);
    const selected = await repo.matches.findSettlementTodos({ limit: 5 });
    expect(selected.map((row) => row.match_id)).toEqual(["m01", "m02", "m03", "m04", "m05"]);
    expect(new Set(selected.map((row) => row.match_id)).size).toBe(selected.length);
  });

  it("after 游标过滤掉游标之前的记录", async () => {
    const { repo } = repoWith(TODO_DOCS);
    const selected = await repo.matches.findSettlementTodos({
      limit: 5,
      after: { kickoff_at: kickoff(3), match_id: "m03" },
    });
    expect(selected.map((row) => row.match_id)).toEqual(["m04", "m05", "m06", "m07"]);
  });
});
