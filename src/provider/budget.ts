import { SyncJobType } from "../domain/enums.js";
import { ProviderError } from "./http.js";
import type { ProviderSource, ProviderSourceId } from "./sources.js";

export type ProviderBudgetJob =
  | typeof SyncJobType.PostFinishVerify
  | typeof SyncJobType.LiveMatch
  | typeof SyncJobType.NearMatch
  | typeof SyncJobType.FutureSchedule
  | typeof SyncJobType.FullScheduleVerify;
type BudgetLimitReason = "hour_limit" | "day_limit" | "month_limit";

export class ProviderBudgetDeniedError extends ProviderError {
  constructor(readonly reason: string) {
    super("PROVIDER_BUDGET_DENIED", `provider budget denied: ${reason}`);
    this.name = "ProviderBudgetDeniedError";
  }
}

export interface ProviderUsageBucket {
  source_id: ProviderSourceId;
  bucket_type: "minute" | "hour" | "day" | "month";
  bucket_key: string;
  bucket_start: Date;
  key_id?: string;
  league_id?: string;
}

export interface ProviderUsageStore {
  reserve(bucket: ProviderUsageBucket, limit: number, now: Date): Promise<boolean>;
  release(bucket: ProviderUsageBucket): Promise<void>;
  read(bucket: ProviderUsageBucket): Promise<number>;
}

export type ProviderBudgetDecision =
  | { allowed: true; minute_used: number; daily_used: number; daily_limit: number; key_id: string }
  | { allowed: false; reason: "source_unconfigured" | "minute_limit" | "hour_limit" | "day_limit" | "month_limit" | "provider_quota" | "provider_cooldown"; key_id?: string };

const PRIORITY_SHARE: Record<ProviderBudgetJob, number> = {
  [SyncJobType.PostFinishVerify]: 1,
  [SyncJobType.LiveMatch]: 0.9,
  [SyncJobType.NearMatch]: 0.7,
  [SyncJobType.FutureSchedule]: 0.5,
  [SyncJobType.FullScheduleVerify]: 0.5,
};

function makeBucket(
  sourceId: ProviderSourceId,
  bucketType: ProviderUsageBucket["bucket_type"],
  key: string,
  start: Date,
  keyId?: string,
): ProviderUsageBucket {
  return { source_id: sourceId, bucket_type: bucketType, bucket_key: key, bucket_start: start, ...(keyId ? { key_id: keyId } : {}) };
}

function minuteBucket(sourceId: ProviderSourceId, now: Date, keyId?: string): ProviderUsageBucket {
  const start = new Date(now);
  start.setUTCSeconds(0, 0);
  return makeBucket(sourceId, "minute", start.toISOString().slice(0, 16), start, keyId);
}

function hourBucket(sourceId: ProviderSourceId, now: Date): ProviderUsageBucket {
  const start = new Date(now);
  start.setUTCMinutes(0, 0, 0);
  return makeBucket(sourceId, "hour", start.toISOString().slice(0, 13), start);
}

function dayBucket(source: ProviderSource, now: Date, leagueId?: string): ProviderUsageBucket {
  let key: string;
  if (source.day_boundary === "utc") {
    key = now.toISOString().slice(0, 10);
  } else {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    key = `${fields.year}-${fields.month}-${fields.day}`;
  }
  return {
    ...makeBucket(source.source_id, "day", key, new Date(`${key}T00:00:00.000Z`)),
    ...(leagueId ? { league_id: leagueId } : {}),
  };
}

function monthBucket(sourceId: ProviderSourceId, now: Date): ProviderUsageBucket {
  const key = now.toISOString().slice(0, 7);
  return makeBucket(sourceId, "month", key, new Date(`${key}-01T00:00:00.000Z`));
}

function providerStateKey(sourceId: ProviderSourceId, keyId?: string): string {
  return sourceId === "fd" && keyId ? `${sourceId}:${keyId}` : sourceId;
}

export class InMemoryProviderUsageStore implements ProviderUsageStore {
  private readonly counters = new Map<string, number>();

  async reserve(bucket: ProviderUsageBucket, limit: number): Promise<boolean> {
    const key = usageBucketId(bucket);
    const value = this.counters.get(key) ?? 0;
    if (value >= limit) return false;
    this.counters.set(key, value + 1);
    return true;
  }

  async release(bucket: ProviderUsageBucket): Promise<void> {
    const key = usageBucketId(bucket);
    this.counters.set(key, Math.max(0, (this.counters.get(key) ?? 0) - 1));
  }

  async read(bucket: ProviderUsageBucket): Promise<number> {
    return this.counters.get(usageBucketId(bucket)) ?? 0;
  }
}

export function usageBucketId(bucket: ProviderUsageBucket): string {
  const keyPart = bucket.key_id ? `_${bucket.key_id.replace(/[^a-zA-Z0-9]/g, "")}` : "";
  const leaguePart = bucket.league_id ? `_league_${bucket.league_id.replace(/[^a-zA-Z0-9]/g, "")}` : "";
  return `provider_usage_${bucket.source_id}_${bucket.bucket_type}${keyPart}${leaguePart}_${bucket.bucket_key.replace(/[^0-9]/g, "")}`;
}

export class ProviderBudget {
  private readonly sources = new Map<ProviderSourceId, ProviderSource>();
  private readonly blockedUntil = new Map<string, number>();
  private readonly observedRemaining = new Map<string, { count: number; reset_at: number }>();

  constructor(
    sources: readonly ProviderSource[],
    private readonly store: ProviderUsageStore,
    private readonly log?: (entry: Record<string, unknown>) => void,
  ) {
    for (const source of sources) this.sources.set(source.source_id, source);
  }

  async candidateKeys(sourceId: ProviderSourceId, now: Date, excluded: readonly string[] = []): Promise<string[]> {
    const source = this.sources.get(sourceId);
    if (source === undefined) return [];
    const available = source.api_keys.filter((key) => !excluded.includes(key.key_id));
    if (source.pool_strategy === "failover") return available.map((key) => key.key_id);
    const withUsage = await Promise.all(available.map(async (key, index) => ({
      key_id: key.key_id,
      index,
      used: await this.store.read(minuteBucket(sourceId, now, sourceId === "fd" ? key.key_id : undefined)),
    })));
    return withUsage.sort((a, b) => a.used - b.used || a.index - b.index).map((entry) => entry.key_id);
  }

  async usageForKey(sourceId: ProviderSourceId, now: Date, keyId: string): Promise<number> {
    return this.store.read(minuteBucket(sourceId, now, sourceId === "fd" ? keyId : undefined));
  }

  async acquire(
    sourceId: ProviderSourceId,
    jobType: ProviderBudgetJob,
    now: Date,
    keyId?: string,
    leagueId?: string,
  ): Promise<ProviderBudgetDecision> {
    const source = this.sources.get(sourceId);
    if (source === undefined) return { allowed: false, reason: "source_unconfigured" };
    const key = source.api_keys.find((candidate) => candidate.key_id === keyId) ?? source.api_keys[0];
    if (key === undefined) return { allowed: false, reason: "source_unconfigured" };
    const stateKey = providerStateKey(sourceId, keyId);
    const blocked = this.blockedUntil.get(stateKey);
    if (blocked !== undefined) {
      if (now.getTime() < blocked) return { allowed: false, reason: "provider_cooldown", key_id: key.key_id };
      this.blockedUntil.delete(stateKey);
    }
    const observation = this.observedRemaining.get(stateKey);
    if (observation !== undefined) {
      if (now.getTime() < observation.reset_at && observation.count <= 0) {
        return { allowed: false, reason: "provider_quota", key_id: key.key_id };
      }
      if (now.getTime() >= observation.reset_at) this.observedRemaining.delete(stateKey);
    }

    const minute = minuteBucket(sourceId, now);
    const keyMinute = sourceId === "fd" ? minuteBucket(sourceId, now, key.key_id) : minute;
    const day = dayBucket(source, now);
    const share = PRIORITY_SHARE[jobType];
    const dailyLimit = source.daily_cap > 0 ? Math.floor(source.daily_cap * share) : 0;
    if (!await this.store.reserve(minute, source.max_per_minute, now)) {
      return { allowed: false, reason: "minute_limit", key_id: key.key_id };
    }

    const reserved: ProviderUsageBucket[] = [minute];
    if (keyMinute !== minute) {
      if (!await this.store.reserve(keyMinute, key.max_per_minute, now)) {
        await this.store.release(minute);
        return { allowed: false, reason: "minute_limit", key_id: key.key_id };
      }
      reserved.push(keyMinute);
    }
    const reserve = async (bucket: ProviderUsageBucket, cap: number, reason: BudgetLimitReason) => {
      if (!await this.store.reserve(bucket, Math.floor(cap * share), now)) {
        for (const item of reserved) await this.store.release(item);
        return { allowed: false, reason, key_id: key.key_id } as ProviderBudgetDecision;
      }
      reserved.push(bucket);
      return null;
    };

    if (source.hourly_cap !== null) {
      const denied = await reserve(hourBucket(sourceId, now), source.hourly_cap, "hour_limit");
      if (denied) return denied;
    }
    if (dailyLimit > 0) {
      const denied = await reserve(day, source.daily_cap, "day_limit");
      if (denied) return denied;
    }
    if (source.monthly_cap !== null) {
      const denied = await reserve(monthBucket(sourceId, now), source.monthly_cap, "month_limit");
      if (denied) return denied;
    }

    if (leagueId) {
      await this.store.reserve(dayBucket(source, now, leagueId), Number.MAX_SAFE_INTEGER, now);
    }

    const currentObservation = this.observedRemaining.get(stateKey);
    if (currentObservation && now.getTime() < currentObservation.reset_at) currentObservation.count -= 1;

    const [minuteUsed, dailyUsed] = await Promise.all([this.store.read(minute), dailyLimit > 0 ? this.store.read(day) : Promise.resolve(0)]);
    if (dailyLimit > 0 && dailyUsed >= Math.ceil(source.daily_cap * 0.8)) {
      this.log?.({ diag_code: "DIAG_PROVIDER_QUOTA_WARN", source_id: sourceId, daily_used: dailyUsed, daily_cap: source.daily_cap });
    }
    return { allowed: true, minute_used: minuteUsed, daily_used: dailyUsed, daily_limit: dailyLimit, key_id: key.key_id };
  }

  async leagueDailyUsage(sourceId: ProviderSourceId, leagueId: string, now: Date): Promise<number> {
    const source = this.sources.get(sourceId);
    if (source === undefined) return 0;
    return this.store.read(dayBucket(source, now, leagueId));
  }

  async recordLeagueRequest(sourceId: ProviderSourceId, leagueId: string, now: Date): Promise<void> {
    const source = this.sources.get(sourceId);
    if (source === undefined) return;
    await this.store.reserve(dayBucket(source, now, leagueId), Number.MAX_SAFE_INTEGER, now);
  }

  observeRemoteQuota(sourceId: ProviderSourceId, remaining: number, resetAt: Date | null, now: Date, keyId?: string): void {
    const reset = resetAt ?? new Date(now.getTime() + 60_000);
    const stateKey = providerStateKey(sourceId, keyId);
    this.observedRemaining.set(stateKey, { count: remaining, reset_at: reset.getTime() });
    this.log?.({ event: "provider_quota_observed", source_id: sourceId, ...(keyId ? { key_id: keyId } : {}), remaining_requests: remaining, resets_at: reset.toISOString() });
  }

  pauseSource(sourceId: ProviderSourceId, until: Date, providerCode: string | null, keyId?: string): void {
    const stateKey = providerStateKey(sourceId, keyId);
    this.blockedUntil.set(stateKey, until.getTime());
    this.log?.({ diag_code: "DIAG_PROVIDER_QUOTA", source_id: sourceId, ...(keyId ? { key_id: keyId } : {}), provider_code: providerCode, resets_at: until.toISOString() });
  }

  async usageSnapshot(now: Date): Promise<Partial<Record<ProviderSourceId, { used: number; cap: number; warning: boolean; minute_used: number; hour_used: number; month_used: number; remote_remaining: number | null; remote_reset_at: string | null }>>> {
    const result: Partial<Record<ProviderSourceId, { used: number; cap: number; warning: boolean; minute_used: number; hour_used: number; month_used: number; remote_remaining: number | null; remote_reset_at: string | null }>> = {};
    for (const source of this.sources.values()) {
      const day = await this.store.read(dayBucket(source, now));
      const minute = await this.store.read(minuteBucket(source.source_id, now));
      const hour = source.hourly_cap === null ? 0 : await this.store.read(hourBucket(source.source_id, now));
      const month = source.monthly_cap === null ? 0 : await this.store.read(monthBucket(source.source_id, now));
      result[source.source_id] = {
        used: day,
        cap: source.daily_cap,
        warning: source.daily_cap > 0 && day >= Math.ceil(source.daily_cap * 0.8),
        minute_used: minute,
        hour_used: hour,
        month_used: month,
        remote_remaining: this.observedRemaining.get(source.source_id)?.count ?? null,
        remote_reset_at: this.observedRemaining.has(source.source_id)
          ? new Date(this.observedRemaining.get(source.source_id)!.reset_at).toISOString()
          : null,
      };
    }
    return result;
  }
}
