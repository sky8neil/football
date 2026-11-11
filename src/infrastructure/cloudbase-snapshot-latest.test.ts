import { describe, expect, it } from "vitest";
import { Provider } from "../domain/enums.js";
import type { ProviderSnapshot } from "../domain/types.js";
import { CloudBaseAppRepository } from "./cloudbase-app-repository.js";
import type {
  CloudBaseDb,
  CloudBaseDocument,
  CloudBaseQueryOptions,
  CloudBaseRepositoryConfig,
} from "./cloudbase-db.js";

const CONFIG: CloudBaseRepositoryConfig = {
  cloud_environment_id: "cloud-test",
  resource_namespace: "ft",
};
const MATCH_ID = "m-1";

function isInOp(value: unknown): value is { __in: readonly string[] } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "__in" in value;
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

class FakeDb implements CloudBaseDb {
  documents = new Map<string, CloudBaseDocument>();
  queries: Array<{ collection: string; filter: Record<string, unknown>; options?: CloudBaseQueryOptions | undefined }> = [];
  inFilter?: (field: string, values: readonly string[]) => Record<string, unknown> | undefined;

  constructor(enableIn: boolean) {
    if (enableIn) {
      this.inFilter = (field, values) => ({ [field]: { __in: values } });
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

async function seed(db: FakeDb): Promise<void> {
  const repo = new CloudBaseAppRepository(CONFIG, db);
  // 乱序插入，确保排序真的生效
  await repo.providerSnapshots.insert(makeSnapshot("s-mid", "status_changed", new Date("2026-08-09T00:01:00.000Z")));
  await repo.providerSnapshots.insert(makeSnapshot("s-old", "discovered", new Date("2026-08-09T00:00:00.000Z")));
  await repo.providerSnapshots.insert(makeSnapshot("s-new", "result_observed", new Date("2026-08-09T00:02:00.000Z")));
}

describe("CloudBaseAppRepository.providerSnapshots.findLatestSuccessByEntity", () => {
  it("把 event_type 与 created_at 排序下推，只读 1 条并返回最近成功快照", async () => {
    const db = new FakeDb(true);
    await seed(db);
    const repo = new CloudBaseAppRepository(CONFIG, db);
    db.queries.length = 0;

    const latest = await repo.providerSnapshots.findLatestSuccessByEntity("match", MATCH_ID);

    expect(latest?.snapshot_id).toBe("s-new");
    expect(db.queries).toHaveLength(1);
    const query = db.queries[0]!;
    expect(query.collection).toBe("ft_provider_snaps");
    expect(query.filter.entity_type).toBe("match");
    expect(query.filter.entity_id).toBe(MATCH_ID);
    expect(isInOp(query.filter.event_type)).toBe(true);
    expect(query.options).toEqual({ order_by: "created_at", direction: "desc", limit: 1 });
  });

  it("只命中成功类 event_type，跳过最新但非成功的事件", async () => {
    const db = new FakeDb(true);
    await seed(db);
    const repo = new CloudBaseAppRepository(CONFIG, db);
    // 更新的一条失败类事件，不应被返回
    await repo.providerSnapshots.insert(
      makeSnapshot("s-failed", "sync_failed" as ProviderSnapshot["event_type"], new Date("2026-08-09T00:03:00.000Z")),
    );

    const latest = await repo.providerSnapshots.findLatestSuccessByEntity("match", MATCH_ID);

    expect(latest?.snapshot_id).toBe("s-new");
  });

  it("适配器不支持 in 查询时退化为内存过滤，结果一致", async () => {
    const db = new FakeDb(false);
    await seed(db);
    const repo = new CloudBaseAppRepository(CONFIG, db);
    db.queries.length = 0;

    const latest = await repo.providerSnapshots.findLatestSuccessByEntity("match", MATCH_ID);

    expect(latest?.snapshot_id).toBe("s-new");
    // 退化路径不带 order_by/limit，读取该实体全部快照
    expect(db.queries[0]?.options).toBeUndefined();
    expect(db.queries[0]?.filter.event_type).toBeUndefined();
  });

  it("没有成功类快照时返回 null", async () => {
    const db = new FakeDb(true);
    const repo = new CloudBaseAppRepository(CONFIG, db);
    await repo.providerSnapshots.insert(
      makeSnapshot("s-only-failed", "sync_failed" as ProviderSnapshot["event_type"], new Date("2026-08-09T00:00:00.000Z")),
    );

    await expect(repo.providerSnapshots.findLatestSuccessByEntity("match", MATCH_ID)).resolves.toBeNull();
  });
});
