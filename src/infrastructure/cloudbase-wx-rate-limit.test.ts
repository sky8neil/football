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
});
