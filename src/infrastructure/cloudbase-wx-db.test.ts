import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { SyncJobType } from "../domain/enums.js";
import { CloudBaseDocumentNotFoundError } from "./cloudbase-db.js";
import { CloudBaseProviderLeagueStateStore } from "./cloudbase-provider-league-state.js";
import { CloudBaseWxDb, type CloudBaseSdkDatabase } from "./cloudbase-wx-db.js";

function fakeDatabase(format: "nested" | "top-level" = "nested") {
  const docs = new Map<string, Record<string, unknown>>();
  const getSizes: number[] = [];
  let committed = 0;
  let rolledBack = 0;
  const updateResult = (updated: number) => format === "nested" ? { stats: { updated } } : { updated };
  const command = {
    inc(value: number) { return { __operation: "inc", value }; },
    lt(value: number) { return { __operation: "lt", value }; },
  };
  const makeDatabase = (transaction = false) => ({
    command,
    collection(name: string) {
      let filter: Record<string, unknown> = {};
      let offset = 0;
      let limit = 1000;
      let order: { field: string; direction: "asc" | "desc" } | null = null;
      const matches = (value: Record<string, unknown>) => Object.entries(filter).every(([key, expected]) => {
        if (typeof expected === "object" && expected !== null && "__operation" in expected) {
          const condition = expected as { __operation: string; value: number };
          if (condition.__operation === "lt") return Number(value[key]) < condition.value;
        }
        return value[key] === expected;
      });
      const rows = () => [...docs.entries()].filter(([key]) => key.startsWith(`${name}/`))
        .map(([, value]) => value).filter(matches);
      const chain = {
        where(value: Record<string, unknown>) { filter = value; return chain; },
        orderBy(field: string, direction: "asc" | "desc") { order = { field, direction }; return chain; },
        skip(value: number) { offset = value; return chain; },
        limit(value: number) { limit = value; return chain; },
        async get() {
          const values = rows();
          if (order) {
            const { field, direction } = order;
            values.sort((a, b) => String(a[field]).localeCompare(String(b[field])) * (direction === "desc" ? -1 : 1));
          }
          const page = values.slice(offset, offset + limit);
          getSizes.push(page.length);
          return { data: page };
        },
        async count() { return { total: rows().length }; },
        doc(id: string) {
          return {
            async get() {
              const value = docs.get(`${name}/${id}`);
              if (!value) throw Object.assign(new Error("document not exist"), { errCode: -502005 });
              return { data: value };
            },
            async create({ data }: { data: Record<string, unknown> }) {
              const key = `${name}/${id}`;
              if (docs.has(key)) throw Object.assign(new Error("duplicate key"), { errCode: "DATABASE_DUPLICATE_KEY" });
              docs.set(key, { ...data, _id: id });
            },
            async update({ data }: { data: Record<string, unknown> }) {
              const key = `${name}/${id}`;
              const existing = docs.get(key);
              if (!existing) return updateResult(0);
              const next = { ...existing, ...data, _id: id };
              const updated = isDeepStrictEqual(existing, next) ? 0 : 1;
              docs.set(key, next);
              return updateResult(updated);
            },
            async remove() { docs.delete(`${name}/${id}`); return { stats: { removed: 1 } }; },
          };
        },
        async add({ data }: { data: Record<string, unknown> }) {
          const id = String(data._id);
          const key = `${name}/${id}`;
          if (docs.has(key)) throw Object.assign(new Error("duplicate key"), { errCode: "DATABASE_DUPLICATE_KEY" });
          docs.set(key, { ...data, _id: id });
          return { _id: id };
        },
        async update({ data }: { data: Record<string, unknown> }) {
          const matched = [...docs.entries()].filter(([key, value]) => key.startsWith(`${name}/`) && matches(value));
          for (const [key, value] of matched) {
            const updated = { ...value };
            for (const [field, operation] of Object.entries(data)) {
              if (typeof operation === "object" && operation !== null && "__operation" in operation) {
                const command = operation as { __operation: string; value: number };
                if (command.__operation === "inc") {
                  updated[field] = (typeof updated[field] === "number" ? updated[field] as number : 0) + command.value;
                  continue;
                }
              }
              updated[field] = operation;
            }
            docs.set(key, updated);
          }
          return updateResult(matched.length);
        },
      };
      return chain;
    },
    async startTransaction() {
      return {
        ...makeDatabase(true),
        async commit() { committed += 1; },
        async rollback() { rolledBack += 1; },
      };
    },
  });
  return { db: makeDatabase() as unknown as CloudBaseSdkDatabase, docs, getSizes, committed: () => committed, rolledBack: () => rolledBack };
}

describe("CloudBase wx-server-sdk database adapter", () => {
  it.each(["nested", "top-level"] as const)("accepts same-value updates and rejects missing documents with %s statistics", async (format) => {
    const fake = fakeDatabase(format);
    const db = new CloudBaseWxDb(fake.db, "football_test");
    const collection = "football_test_users";
    const document = { _id: "user-1", nickname: "A" };
    await db.add(collection, document._id, document);

    await expect(db.update(collection, document._id, { ...document, nickname: "B" })).resolves.toBeUndefined();
    await expect(db.update(collection, document._id, { ...document, nickname: "B" })).resolves.toBeUndefined();
    await expect(db.get(collection, document._id)).resolves.toMatchObject({ nickname: "B" });
    await expect(db.update(collection, "missing", { _id: "missing" })).rejects.toBeInstanceOf(CloudBaseDocumentNotFoundError);
  });

  it.each(["nested", "top-level"] as const)("records league success twice at the same task time with %s statistics", async (format) => {
    const fake = fakeDatabase(format);
    const db = new CloudBaseWxDb(fake.db, "football_test");
    const store = new CloudBaseProviderLeagueStateStore(db, "football_test");
    const now = new Date("2026-10-13T08:15:58.153Z");

    await store.markSuccess("fd", "premier_league", SyncJobType.FutureSchedule, now);
    await expect(store.markSuccess("fd", "premier_league", SyncJobType.FutureSchedule, new Date(now))).resolves.toBeUndefined();
    await expect(store.get("fd", "premier_league", SyncJobType.FutureSchedule)).resolves.toMatchObject({ last_success_at: now });
    expect(fake.docs.size).toBe(1);
  });

  it("uses deterministic document ids and maps duplicate and missing records", async () => {
    const fake = fakeDatabase();
    const db = new CloudBaseWxDb(fake.db, "football_test");
    await db.add("football_test_users", "user-1", { _id: "user-1", nickname: "A" });
    await expect(db.get("football_test_users", "user-1")).resolves.toMatchObject({ nickname: "A" });
    await expect(db.add("football_test_users", "user-1", { _id: "user-1" })).rejects.toMatchObject({ name: "CloudBaseDuplicateKeyError" });
    await expect(db.get("football_test_users", "missing")).resolves.toBeNull();
    await expect(db.update("football_test_users", "missing", { _id: "missing" })).rejects.toBeInstanceOf(CloudBaseDocumentNotFoundError);
  });

  it("queries in pages of at most 100, supports offset and count", async () => {
    const fake = fakeDatabase();
    const db = new CloudBaseWxDb(fake.db, "football_test");
    for (let index = 0; index < 230; index += 1) {
      await db.add("football_test_matches", String(index).padStart(3, "0"), { _id: String(index).padStart(3, "0"), league_id: index % 2 ? "a" : "b" });
    }
    const page = await db.query("football_test_matches", { league_id: "a" }, { offset: 3, limit: 107 });
    expect(page).toHaveLength(107);
    expect(fake.getSizes.every((size) => size <= 100)).toBe(true);
    await expect(db.count("football_test_matches", { league_id: "a" })).resolves.toBe(115);
  });

  it("commits successful transactions and rolls back failed work", async () => {
    const fake = fakeDatabase();
    const db = new CloudBaseWxDb(fake.db, "football_test");
    await expect(db.transaction(async (tx) => tx.add("football_test_users", "u1", { _id: "u1" }))).resolves.toBeUndefined();
    expect(fake.committed()).toBe(1);
    await expect(db.transaction(async () => { throw new Error("transaction failed"); })).rejects.toThrow("transaction failed");
    expect(fake.rolledBack()).toBe(1);
  });

  it.each(["nested", "top-level"] as const)("reserves a counter using %s statistics and rejects exhausted capacity", async (format) => {
    const fake = fakeDatabase(format);
    const db = new CloudBaseWxDb(fake.db, "football_test", false, fake.db.command);
    const initial = { _id: "provider_usage_fd_minute_202610130743", request_count: 0 };

    await expect(db.reserveCounter("football_test_provider_usage", initial._id, "request_count", 2, initial)).resolves.toBe(true);
    await expect(db.reserveCounter("football_test_provider_usage", initial._id, "request_count", 2, initial)).resolves.toBe(true);
    await expect(db.reserveCounter("football_test_provider_usage", initial._id, "request_count", 2, initial)).resolves.toBe(false);
    expect(fake.docs.get(`football_test_provider_usage/${initial._id}`)).toMatchObject({ request_count: 2 });
  });
});
