import { describe, expect, it, vi } from "vitest";
import { CloudBaseDocumentNotFoundError } from "./cloudbase-db.js";
import { CloudBaseWxDb, type CloudBaseSdkDatabase } from "./cloudbase-wx-db.js";

function fakeDatabase() {
  const docs = new Map<string, Record<string, unknown>>();
  const getSizes: number[] = [];
  let committed = 0;
  let rolledBack = 0;
  const makeDatabase = (transaction = false) => ({
    collection(name: string) {
      let filter: Record<string, unknown> = {};
      let offset = 0;
      let limit = 1000;
      let order: { field: string; direction: "asc" | "desc" } | null = null;
      const rows = () => [...docs.entries()].filter(([key]) => key.startsWith(`${name}/`))
        .map(([, value]) => value).filter((value) => Object.entries(filter).every(([key, expected]) => value[key] === expected));
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
              if (!docs.has(key)) return { updated: 0 };
              docs.set(key, { ...docs.get(key), ...data, _id: id });
              return { updated: 1 };
            },
            async remove() { docs.delete(`${name}/${id}`); return { removed: 1 }; },
          };
        },
        async add({ data }: { data: Record<string, unknown> }) {
          const id = String(data._id);
          const key = `${name}/${id}`;
          if (docs.has(key)) throw Object.assign(new Error("duplicate key"), { errCode: "DATABASE_DUPLICATE_KEY" });
          docs.set(key, { ...data, _id: id });
          return { _id: id };
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
});
