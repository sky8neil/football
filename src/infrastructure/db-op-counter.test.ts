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
    expect(counter.end()).toEqual({ read: 0, write: 0 });
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
    expect(counter.end()).toEqual({ read: 3, write: 4 });
    expect(counter.active).toBe(false);
  });

  it("resets on a later begin after end", async () => {
    const { db, counter } = createCountingDb(fakeDb());
    counter.begin();
    await db.get("users", "u1");
    await db.add("users", "u1", { _id: "u1" });
    expect(counter.end()).toEqual({ read: 1, write: 1 });
    counter.begin();
    await db.query("users");
    await db.update("users", "u1", { _id: "u1" } as CloudBaseDocument);
    expect(counter.end()).toEqual({ read: 1, write: 1 });
  });

  it("counts calls made through transactionDb", async () => {
    const { db, counter } = createCountingDb(fakeDb());
    counter.begin();
    await db.transaction(async (tx) => {
      await tx.get("users", "u1");
      await tx.add("users", "u1", { _id: "u1" });
    });
    expect(counter.end()).toEqual({ read: 1, write: 1 });
  });

  it("counts getCounter as a read", async () => {
    const { db, counter } = createCountingDb(fakeDb());
    counter.begin();
    await db.getCounter?.("counters", "c1", "n");
    expect(counter.end()).toEqual({ read: 1, write: 0 });
  });
});
