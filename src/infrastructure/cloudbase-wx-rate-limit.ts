import { createHash } from "node:crypto";
import { cloudBaseCollectionName } from "./cloudbase-db.js";
import type { CloudBaseSdkDatabase } from "./cloudbase-wx-db.js";
import type { CloudBaseRateLimitDatabase } from "../api/v1/cloudbase-rate-limit-store.js";

type RateLimitDoc = {
  get(): Promise<{ data?: { window_start?: number; count?: number } }>;
  set(options: { data: { window_start: number; count: number } }): Promise<unknown>;
  update(options: { data: { window_start: number; count: number } }): Promise<unknown>;
};
type RateLimitDatabase = CloudBaseSdkDatabase & {
  collection(name: string): ReturnType<CloudBaseSdkDatabase["collection"]> & { doc(id: string): RateLimitDoc };
};

/** Transactional CloudBase counter shared by all function instances. */
export class CloudBaseWxRateLimitDatabase implements CloudBaseRateLimitDatabase {
  private readonly db: RateLimitDatabase;
  private readonly collection: string;

  constructor(db: CloudBaseSdkDatabase, namespace: string) {
    this.db = db as RateLimitDatabase;
    this.collection = cloudBaseCollectionName(namespace, "rate_limits");
  }

  async incrementInWindow(key: string, windowStart: number, _serverNow: Date): Promise<number> {
    const id = `rate_${createHash("sha256").update(key).digest("hex")}`;
    const tx = await this.db.startTransaction();
    try {
      const reference = tx.collection(this.collection).doc(id);
      let current: { window_start?: number; count?: number } | undefined;
      try {
          const data = (await reference.get()).data;
          if (data) {
            current = {};
            if (typeof data.window_start === "number") current.window_start = data.window_start;
            if (typeof data.count === "number") current.count = data.count;
          }
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        if (!message.includes("not exist") && !message.includes("not found")) throw error;
      }
      const count = current?.window_start === windowStart ? (current.count ?? 0) + 1 : 1;
      const value = { window_start: windowStart, count };
      if (current === undefined) await reference.set({ data: value });
      else await reference.update({ data: value });
      await tx.commit();
      return count;
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }
}
