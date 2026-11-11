import { describe, expect, it } from "vitest";
import type { CloudBaseDb, CloudBaseDocument } from "./cloudbase-db.js";
import { createCountingDb } from "./db-op-counter.js";

function fakeDb(): CloudBaseDb {
  const impl: CloudBaseDb = {
    async get() { return null; },
    async add() {},
    async update() {},
    async query() { return []; },
    async count() { return 0; },
    async getCounter() { return 0; },
    async adjustCounter() {},
    async reserveCounter() { return true; },
    async transaction(work) { return work(impl); },
  };
  return impl;
}

describe("createCountingDb", () => {
  it("does not count calls before begin", async () => {
    const { db, counter } = createCountingDb(fakeDb());
    await db.get("users", "u1");
    await db.add("users", "u1", { _id: "u1" });
    expect(counter.active).toBe(false);
    expect(counter.end()).toEqual({ read: 0, write: 0, by_collection: [] });
  });

  it("counts reads and writes only between begin and end", async () => {
    const { db, counter } = createCountingDb(fakeDb());
    counter.begin();
    await db.get("users", "u1");
    await db.query("users");
    await db.count("users");
    await db.add("users", "u1", { _id: "u1" });
    await db.update("users", "u1", { _id: "u1" });
    await db.adjustCounter?.("counters", "c1", "n", 1);
    await db.reserveCounter?.("counters", "c1", "n", 10, { _id: "c1" });
    expect(counter.active).toBe(true);
    expect(counter.end()).toEqual({
      read: 3,
      write: 4,
      by_collection: [
        { collection: "users", read: 3, write: 2 },
        { collection: "counters", read: 0, write: 2 },
      ],
    });
    expect(counter.active).toBe(false);
  });

  it("resets on a later begin after end", async () => {
    const { db, counter } = createCountingDb(fakeDb());
    counter.begin();
    await db.get("users", "u1");
    await db.add("users", "u1", { _id: "u1" });
    expect(counter.end()).toEqual({
      read: 1,
      write: 1,
      by_collection: [{ collection: "users", read: 1, write: 1 }],
    });
    counter.begin();
    await db.query("users");
    await db.update("users", "u1", { _id: "u1" } as CloudBaseDocument);
    expect(counter.end()).toEqual({
      read: 1,
      write: 1,
      by_collection: [{ collection: "users", read: 1, write: 1 }],
    });
  });

  it("counts calls made through transactionDb", async () => {
    const { db, counter } = createCountingDb(fakeDb());
    counter.begin();
    await db.transaction(async (tx) => {
      await tx.get("users", "u1");
      await tx.add("users", "u1", { _id: "u1" });
    });
    expect(counter.end()).toEqual({
      read: 1,
      write: 1,
      by_collection: [{ collection: "users", read: 1, write: 1 }],
    });
  });

  it("counts getCounter as a read", async () => {
    const { db, counter } = createCountingDb(fakeDb());
    counter.begin();
    await db.getCounter?.("counters", "c1", "n");
    expect(counter.end()).toEqual({
      read: 1,
      write: 0,
      by_collection: [{ collection: "counters", read: 1, write: 0 }],
    });
  });

  it("groups mixed reads and writes by collection, sorted by read+write desc", async () => {
    const { db, counter } = createCountingDb(fakeDb());
    counter.begin();
    await db.get("provider_keys", "k1");
    await db.query("provider_usage");
    await db.query("provider_usage");
    await db.add("provider_snaps", "s1", { _id: "s1" });
    await db.update("provider_usage", "u1", { _id: "u1" });
    await db.count("provider_keys");
    expect(counter.end()).toEqual({
      read: 4,
      write: 2,
      by_collection: [
        { collection: "provider_usage", read: 2, write: 1 },
        { collection: "provider_keys", read: 2, write: 0 },
        { collection: "provider_snaps", read: 0, write: 1 },
      ],
    });
  });

  it("caps by_collection at 15 by default and honors an explicit limit", async () => {
    const { db, counter } = createCountingDb(fakeDb());
    counter.begin();
    for (let i = 0; i < 16; i += 1) {
      await db.get(`col_${i}`, "id");
    }
    const defaulted = counter.end();
    expect(defaulted.by_collection).toHaveLength(15);
    expect(defaulted.read).toBe(16);

    counter.begin();
    await db.get("a", "1");
    await db.add("a", "1", { _id: "1" });
    await db.get("b", "1");
    await db.query("c");
    await db.update("c", "1", { _id: "1" });
    await db.add("c", "2", { _id: "2" });
    const limited = counter.end(2);
    expect(limited.by_collection).toEqual([
      { collection: "c", read: 1, write: 2 },
      { collection: "a", read: 1, write: 1 },
    ]);
  });

  it("does not leak by_collection counts across begin/end windows", async () => {
    const { db, counter } = createCountingDb(fakeDb());
    counter.begin();
    await db.get("provider_usage", "u1");
    await db.add("provider_keys", "k1", { _id: "k1" });
    expect(counter.end().by_collection).toEqual([
      { collection: "provider_usage", read: 1, write: 0 },
      { collection: "provider_keys", read: 0, write: 1 },
    ]);
    counter.begin();
    await db.query("provider_snaps");
    expect(counter.end()).toEqual({
      read: 1,
      write: 0,
      by_collection: [{ collection: "provider_snaps", read: 1, write: 0 }],
    });
  });

  it("does not include out-of-window calls in by_collection", async () => {
    const { db, counter } = createCountingDb(fakeDb());
    await db.get("provider_usage", "u1");
    await db.add("provider_keys", "k1", { _id: "k1" });
    counter.begin();
    await db.query("provider_snaps");
    await db.update("provider_snaps", "s1", { _id: "s1" });
    const snapshot = counter.end();
    expect(snapshot).toEqual({
      read: 1,
      write: 1,
      by_collection: [{ collection: "provider_snaps", read: 1, write: 1 }],
    });
    await db.count("provider_usage");
    expect(counter.end()).toEqual({
      read: 1,
      write: 1,
      by_collection: [{ collection: "provider_snaps", read: 1, write: 1 }],
    });
  });
});
