import { describe, expect, it, vi } from "vitest";
import { CloudBaseDocumentNotFoundError } from "./cloudbase-db.js";
import { CloudBaseWxDb, type CloudBaseSdkDatabase } from "./cloudbase-wx-db.js";

function fakeDatabase() {
  const docs = new Map<string, Record<string, unknown>>();
  const getSizes: number[] = [];
  let committed = 0;
  let rolledBack = 0;
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
              if (!docs.has(key)) return { stats: { updated: 0 } };
              docs.set(key, { ...docs.get(key), ...data, _id: id });
              return { stats: { updated: 1 } };
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
          return { stats: { updated: matched.length } };
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

  it("reserves a counter using CloudBase stats.updated results", async () => {
    const fake = fakeDatabase();
    const db = new CloudBaseWxDb(fake.db, "football_test", false, fake.db.command);
    const initial = { _id: "provider_usage_fd_minute_202610130743", request_count: 0 };

    await expect(db.reserveCounter("football_test_provider_usage", initial._id, "request_count", 2, initial)).resolves.toBe(true);
    await expect(db.reserveCounter("football_test_provider_usage", initial._id, "request_count", 2, initial)).resolves.toBe(true);
    await expect(db.reserveCounter("football_test_provider_usage", initial._id, "request_count", 2, initial)).resolves.toBe(false);
    expect(fake.docs.get(`football_test_provider_usage/${initial._id}`)).toMatchObject({ request_count: 2 });
  });
});
