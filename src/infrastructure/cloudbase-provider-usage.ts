import type { CloudBaseDb, CloudBaseDocument } from "./cloudbase-db.js";
import { cloudBaseCollectionName } from "./cloudbase-db.js";
import type { ProviderUsageBucket, ProviderUsageStore } from "../provider/budget.js";
import { usageBucketId } from "../provider/budget.js";

export class CloudBaseProviderUsageStore implements ProviderUsageStore {
  private readonly collection: string;

  constructor(private readonly db: CloudBaseDb, namespace: string) {
    this.collection = cloudBaseCollectionName(namespace, "provider_usage");
  }

  async reserve(bucket: ProviderUsageBucket, limit: number, now: Date): Promise<boolean> {
    if (this.db.reserveCounter === undefined) {
      throw new Error("CloudBase database adapter does not support atomic counters");
    }
    const id = usageBucketId(bucket);
    const initial: CloudBaseDocument = {
      _id: id,
      source_id: bucket.source_id,
      bucket_type: bucket.bucket_type,
      bucket_key: bucket.bucket_key,
      bucket_start: bucket.bucket_start,
      ...(bucket.key_id ? { key_id: bucket.key_id } : {}),
      ...(bucket.league_id ? { league_id: bucket.league_id } : {}),
      request_count: 0,
      created_at: now,
      updated_at: now,
      schema_version: 1,
    };
    return this.db.reserveCounter(this.collection, id, "request_count", limit, initial);
  }

  async release(bucket: ProviderUsageBucket): Promise<void> {
    if (this.db.adjustCounter === undefined) {
      throw new Error("CloudBase database adapter does not support atomic counters");
    }
    await this.db.adjustCounter(this.collection, usageBucketId(bucket), "request_count", -1);
  }

  async read(bucket: ProviderUsageBucket): Promise<number> {
    if (this.db.getCounter === undefined) {
      throw new Error("CloudBase database adapter does not support atomic counters");
    }
    return this.db.getCounter(this.collection, usageBucketId(bucket), "request_count");
  }
}
