import { describe, expect, it } from "vitest";
import { SyncJobType } from "../domain/enums.js";
import { ProviderBudget, usageBucketId, type ProviderUsageBucket } from "../provider/budget.js";
import { COLLECTION_DEFINITIONS } from "../schema/collections.js";
import { UNIQUE_INDEXES } from "../schema/indexes.js";
import { CloudBaseProviderKeyStateStore } from "./cloudbase-provider-key-state.js";
import { CloudBaseProviderLeagueStateStore } from "./cloudbase-provider-league-state.js";
import { CloudBaseProviderUsageStore } from "./cloudbase-provider-usage.js";
import type { CloudBaseDb, CloudBaseDocument, CloudBaseQueryOptions } from "./cloudbase-db.js";

const NOW = new Date("2026-10-12T12:30:00.000Z");
const NAMESPACE = "football_test";

function clone<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)])) as T;
  return value;
}

class MemoryCloudDb implements CloudBaseDb {
  private readonly documents = new Map<string, CloudBaseDocument>();

  async get(collection: string, id: string): Promise<CloudBaseDocument | null> {
    const value = this.documents.get(`${collection}/${id}`);
    return value ? clone(value) : null;
  }

  async add(collection: string, id: string, document: CloudBaseDocument): Promise<void> {
    const key = `${collection}/${id}`;
    if (this.documents.has(key)) throw new Error(`duplicate ${key}`);
    this.documents.set(key, clone({ ...document, _id: id }));
  }

  async update(collection: string, id: string, document: CloudBaseDocument): Promise<void> {
    const key = `${collection}/${id}`;
    const existing = this.documents.get(key);
    if (!existing) throw new Error(`missing ${key}`);
    this.documents.set(key, clone({ ...existing, ...document, _id: id }));
  }

  async query(collection: string, filter: Record<string, unknown> = {}, options: CloudBaseQueryOptions = {}): Promise<CloudBaseDocument[]> {
    const rows = [...this.documents.entries()]
      .filter(([key]) => key.startsWith(`${collection}/`))
      .map(([, document]) => clone(document))
      .filter((document) => Object.entries(filter).every(([key, value]) => document[key] === value));
    const offset = options.offset ?? 0;
    return options.limit === undefined ? rows.slice(offset) : rows.slice(offset, offset + options.limit);
  }

  async count(collection: string, filter: Record<string, unknown> = {}): Promise<number> {
    return (await this.query(collection, filter)).length;
  }

  async reserveCounter(collection: string, id: string, field: string, limit: number, initial: CloudBaseDocument): Promise<boolean> {
    const key = `${collection}/${id}`;
    const document: CloudBaseDocument = this.documents.get(key) ?? clone({ ...initial, _id: id });
    const current = typeof document[field] === "number" ? document[field] as number : 0;
    if (current >= limit) return false;
    document[field] = current + 1;
    this.documents.set(key, clone(document));
    return true;
  }

  async adjustCounter(collection: string, id: string, field: string, delta: number): Promise<void> {
    const key = `${collection}/${id}`;
    const document = this.documents.get(key);
    if (!document) return;
    document[field] = (typeof document[field] === "number" ? document[field] as number : 0) + delta;
  }

  async getCounter(collection: string, id: string, field: string): Promise<number> {
    const value = (await this.get(collection, id))?.[field];
    return typeof value === "number" ? value : 0;
  }

  async transaction<T>(work: (transactionDb: CloudBaseDb) => Promise<T>): Promise<T> {
    return work(this);
  }

  async all(collection: string): Promise<CloudBaseDocument[]> {
    return this.query(collection);
  }
}

function assertMatchesSchema(collection: string, document: CloudBaseDocument) {
  const definition = COLLECTION_DEFINITIONS.find((item) => item.collection === collection);
  expect(definition).toBeDefined();
  const fields = definition!.fields;
  for (const key of Object.keys(document).filter((name) => name !== "_id")) expect(fields).toHaveProperty(key);
  for (const [key, field] of Object.entries(fields)) {
    if (field?.required) expect(document).toHaveProperty(key);
  }
}

describe("CloudBase provider state stores", () => {
  it("shares atomic usage reservations across store instances and persists schema fields", async () => {
    const db = new MemoryCloudDb();
    const first = new CloudBaseProviderUsageStore(db, NAMESPACE);
    const second = new CloudBaseProviderUsageStore(db, NAMESPACE);
    const bucket: ProviderUsageBucket = {
      source_id: "fd", bucket_type: "day", bucket_key: "2026-10-12", bucket_start: new Date("2026-10-12T00:00:00.000Z"),
      key_id: "fd#1", league_id: "premier_league",
    };
    const id = usageBucketId(bucket);
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      (index % 2 === 0 ? first : second).reserve(bucket, 3, NOW),
    ));

    expect(results.filter(Boolean)).toHaveLength(3);
    await expect(first.read(bucket)).resolves.toBe(3);
    await second.release(bucket);
    await expect(first.read(bucket)).resolves.toBe(2);
    const document = (await db.all(`${NAMESPACE}_provider_usage`))[0]!;
    expect(document._id).toBe(id);
    expect(document).toMatchObject({
      source_id: "fd", bucket_type: "day", bucket_key: "2026-10-12", key_id: "fd#1",
      league_id: "premier_league", request_count: 2, created_at: NOW, updated_at: NOW, schema_version: 1,
    });
    assertMatchesSchema("provider_usage", document);
    expect(UNIQUE_INDEXES.some((index) => index.collection === "provider_usage")).toBe(false);
  });

  it("persists key health by opaque key id and reads cooldown state across instances", async () => {
    const db = new MemoryCloudDb();
    const first = new CloudBaseProviderKeyStateStore(db, NAMESPACE);
    const second = new CloudBaseProviderKeyStateStore(db, NAMESPACE);
    await first.save({
      key_id: "fd#1", status: "healthy", cooldown_until: null, network_errors: 0, last_error_code: null, updated_at: NOW,
    });
    const cooldown = new Date(NOW.getTime() + 60_000);
    await second.save({
      key_id: "fd#1", status: "cooldown", cooldown_until: cooldown, network_errors: 0, last_error_code: "429", updated_at: cooldown,
    });

    await expect(first.get("fd#1")).resolves.toEqual({
      key_id: "fd#1", status: "cooldown", cooldown_until: cooldown, network_errors: 0, last_error_code: "429", updated_at: cooldown,
    });
    await expect(first.list(["fd#1", "fd#2"])).resolves.toHaveLength(1);
    const document = (await db.all(`${NAMESPACE}_provider_key_state`))[0]!;
    expect(document._id).toBe("provider_key_state_fd1");
    expect(document).not.toHaveProperty("api_key");
    assertMatchesSchema("provider_key_state", document);
    expect(UNIQUE_INDEXES).toContainEqual(expect.objectContaining({
      collection: "provider_key_state", name: "uk_provider_key_state_key_id", fields: ["key_id"], unique: true,
    }));
  });

  it("persists the last successful source, league, and job independently", async () => {
    const db = new MemoryCloudDb();
    const first = new CloudBaseProviderLeagueStateStore(db, NAMESPACE);
    const second = new CloudBaseProviderLeagueStateStore(db, NAMESPACE);
    const later = new Date(NOW.getTime() + 5 * 60_000);
    await first.markSuccess("fd", "premier_league", SyncJobType.FutureSchedule, NOW);
    await second.markSuccess("fd", "premier_league", SyncJobType.FutureSchedule, later);
    await first.markSuccess("fd", "la_liga", SyncJobType.FutureSchedule, NOW);

    await expect(first.get("fd", "premier_league", SyncJobType.FutureSchedule)).resolves.toEqual({
      source_id: "fd", league_id: "premier_league", job_type: SyncJobType.FutureSchedule, last_success_at: later,
    });
    await expect(first.get("fd", "premier_league", SyncJobType.LiveMatch)).resolves.toBeNull();
    const documents = await db.all(`${NAMESPACE}_provider_league_state`);
    expect(documents).toHaveLength(2);
    for (const document of documents) assertMatchesSchema("provider_league_state", document);
    expect(documents.find((document) => document.league_id === "premier_league")).toMatchObject({
      created_at: NOW, updated_at: later, last_success_at: later,
    });
    expect(UNIQUE_INDEXES).toContainEqual(expect.objectContaining({
      collection: "provider_league_state", name: "uk_provider_league_state_source_job_league",
      fields: ["source_id", "job_type", "league_id"], unique: true,
    }));
  });
});
