import { describe, expect, it } from "vitest";
import type { CloudBaseSdkDatabase } from "./cloudbase-wx-db.js";
import { CloudBaseWxRateLimitDatabase } from "./cloudbase-wx-rate-limit.js";

function fakeDatabase() {
  const documents = new Map<string, { window_start: number; count: number }>();
  const collection = (name: string) => ({
    doc(id: string) {
      const key = `${name}/${id}`;
      return {
        async get() {
          const data = documents.get(key);
          if (!data) throw new Error("document not exist");
          return { data };
        },
        async set({ data }: { data: { window_start: number; count: number } }) {
          documents.set(key, data);
        },
        async update({ data }: { data: { window_start: number; count: number } }) {
          documents.set(key, data);
        },
      };
    },
  });
  return {
    db: {
      collection,
      async startTransaction() {
        return { collection, async commit() {}, async rollback() {} };
      },
    } as unknown as CloudBaseSdkDatabase,
  };
}

function conflictingDatabase() {
  let version = 0;
  const documents = new Map<string, { window_start: number; count: number }>();
  const clone = () => new Map([...documents].map(([key, value]) => [key, { ...value }]));
  const collection = (snapshot: Map<string, { window_start: number; count: number }>, writes: Set<string>) => (name: string) => ({
    doc(id: string) {
      const key = `${name}/${id}`;
      return {
        async get() {
          const data = snapshot.get(key);
          if (!data) throw new Error("document not exist");
          return { data };
        },
        async set({ data }: { data: { window_start: number; count: number } }) {
          snapshot.set(key, data);
          writes.add(key);
        },
        async update({ data }: { data: { window_start: number; count: number } }) {
          snapshot.set(key, data);
          writes.add(key);
        },
      };
    },
  });

  return {
    db: {
      collection: collection(documents, new Set()),
      async startTransaction() {
        const startingVersion = version;
        const snapshot = clone();
        const writes = new Set<string>();
        return {
          collection: collection(snapshot, writes),
          async commit() {
            if (startingVersion !== version) {
              throw {
                code: "DATABASE_TRANSACTION_CONFLICT",
                message: "Transaction is conflict, resource operated by others",
              };
            }
            for (const key of writes) {
              const value = snapshot.get(key);
              if (value) documents.set(key, value);
            }
            version += 1;
          },
          async rollback() {},
        };
      },
    } as unknown as CloudBaseSdkDatabase,
  };
}

describe("CloudBase wx-server-sdk shared rate-limit storage", () => {
  it("shares a deterministic counter across adapter instances and resets each window", async () => {
    const { db } = fakeDatabase();
    const firstInstance = new CloudBaseWxRateLimitDatabase(db, "football_test");
    const secondInstance = new CloudBaseWxRateLimitDatabase(db, "football_test");
    const key = "public_reads:match-list";
    const now = new Date("2026-10-11T12:00:00.000Z");

    await expect(firstInstance.incrementInWindow(key, 1000, now)).resolves.toBe(1);
    await expect(secondInstance.incrementInWindow(key, 1000, now)).resolves.toBe(2);
    await expect(firstInstance.incrementInWindow(key, 2000, now)).resolves.toBe(1);
  });

  it("retries transaction conflicts from concurrent authenticated reads", async () => {
    const { db } = conflictingDatabase();
    const limiter = new CloudBaseWxRateLimitDatabase(db, "football_test");
    const now = new Date("2026-10-11T12:00:00.000Z");

    const counts = await Promise.all(
      Array.from({ length: 5 }, () =>
        limiter.incrementInWindow("authenticated_reads\u0000user", 1000, now),
      ),
    );

    expect(counts.sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5]);
  });
});
