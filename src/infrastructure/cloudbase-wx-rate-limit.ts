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

const MAX_TRANSACTION_ATTEMPTS = 6;
const INITIAL_RETRY_DELAY_MS = 5;
const MAX_RETRY_DELAY_MS = 80;

function isTransactionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; errCode?: unknown; message?: unknown };
  const code = String(value.code ?? value.errCode ?? "").toUpperCase();
  const message = String(value.message ?? "").toLowerCase();
  return code === "DATABASE_TRANSACTION_CONFLICT" ||
    message.includes("transactionconflict") ||
    message.includes("transaction is conflict");
}

function retryDelayMs(attempt: number): number {
  return Math.min(INITIAL_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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
    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      let tx: Awaited<ReturnType<CloudBaseSdkDatabase["startTransaction"]>> | undefined;
      try {
        tx = await this.db.startTransaction();
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
        if (tx !== undefined) {
          // A conflicted CloudBase transaction may already be aborted. Preserve the
          // original error so it can be classified and retried below.
          try {
            await tx.rollback();
          } catch {
            // The transaction may already have been rolled back by the service.
          }
        }
        if (!isTransactionConflict(error) || attempt === MAX_TRANSACTION_ATTEMPTS - 1) {
          throw error;
        }
        await delay(retryDelayMs(attempt));
      }
    }
    throw new Error("CloudBase rate-limit transaction attempts exhausted");
  }
}
