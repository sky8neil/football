import { describe, expect, it } from "vitest";
import { Provider } from "../domain/enums.js";
import type { MatchProviderMapping } from "../domain/types.js";
import { CloudBaseAppRepository } from "./cloudbase-app-repository.js";
import type {
  CloudBaseDb,
  CloudBaseDocument,
  CloudBaseQueryOptions,
  CloudBaseRepositoryConfig,
} from "./cloudbase-db.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const CONFIG: CloudBaseRepositoryConfig = {
  cloud_environment_id: "cloud-test",
  resource_namespace: "ft",
};

function isInOp(value: unknown): value is { __in: readonly string[] } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "__in" in value;
}

class FakeDb implements CloudBaseDb {
  documents = new Map<string, CloudBaseDocument>();
  queries: Array<{ collection: string; filter: Record<string, unknown> }> = [];
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
    _options?: CloudBaseQueryOptions,
  ): Promise<CloudBaseDocument[]> {
    this.queries.push({ collection, filter });
    return [...this.documents.entries()]
      .filter(([key]) => key.startsWith(`${collection}/`))
      .map(([, document]) => document)
      .filter((document) => Object.entries(filter).every(([field, value]) => {
        if (isInOp(value)) return value.__in.includes(String(document[field] ?? ""));
        return document[field] === value;
      }));
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

describe("CloudBase match mapping batch (RP11)", () => {
  it("inFilter 可用时按 50 个一块切分：120 个 ID 查询 3 次", async () => {
    const db = new FakeDb(true);
    const repo = new CloudBaseAppRepository(CONFIG, db);
    const mappings = Array.from({ length: 120 }, (_, i) => makeMapping(i));
    for (const row of mappings) await repo.matchProviderMappings.insert(row);
    db.queries = [];

    const ids = mappings.map((row) => row.provider_match_id);
    const found = await repo.matchProviderMappings.findByProviderAndExternalIds(Provider.ApiFootball, ids);

    expect(db.queries).toHaveLength(3);
    expect(db.queries.map((query) => {
      const clause = query.filter.provider_match_id as { __in: readonly string[] };
      return clause.__in.length;
    })).toEqual([50, 50, 20]);
    expect(found.size).toBe(120);
    expect(found.get("ext-0")?.match_id).toBe("match-0");
    expect(found.get("ext-119")?.match_id).toBe("match-119");
  });

  it("inFilter 不可用时退化为逐条查询，结果正确", async () => {
    const db = new FakeDb(false);
    const repo = new CloudBaseAppRepository(CONFIG, db);
    const mappings = Array.from({ length: 5 }, (_, i) => makeMapping(i));
    for (const row of mappings) await repo.matchProviderMappings.insert(row);
    db.queries = [];

    const ids = mappings.map((row) => row.provider_match_id);
    const found = await repo.matchProviderMappings.findByProviderAndExternalIds(Provider.ApiFootball, ids);

    expect(db.queries).toHaveLength(5);
    expect(found.size).toBe(5);
    expect([...found.keys()].sort()).toEqual(["ext-0", "ext-1", "ext-2", "ext-3", "ext-4"]);
    expect(found.get("ext-2")?.match_id).toBe("match-2");
  });
});
