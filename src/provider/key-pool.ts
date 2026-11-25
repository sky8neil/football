import { createHash } from "node:crypto";
import type { ProviderSource, ProviderSourceKey } from "./sources.js";

export interface ProviderKeyState {
  key_id: string;
  status: "healthy" | "cooldown" | "invalid";
  cooldown_until: Date | null;
  network_errors: number;
  last_error_code: string | null;
  key_fingerprint?: string | null;
  updated_at: Date;
}

export function keyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

const WAF_403_CODES = new Set(["1010", "waf_403"]);

function isWaf403Failure(statusCode: number, errorCode: string | null): boolean {
  if (statusCode !== 403) return false;
  if (errorCode !== null && WAF_403_CODES.has(errorCode)) return true;
  return errorCode !== null && /cloudflare|waf|html|1010|1020/i.test(errorCode);
}

export interface ProviderKeyStateStore {
  get(keyId: string): Promise<ProviderKeyState | null>;
  save(state: ProviderKeyState): Promise<void>;
  list(keyIds: readonly string[]): Promise<ProviderKeyState[]>;
}

export class InMemoryProviderKeyStateStore implements ProviderKeyStateStore {
  private readonly states = new Map<string, ProviderKeyState>();

  async get(keyId: string): Promise<ProviderKeyState | null> {
    const state = this.states.get(keyId);
    return state ? { ...state, cooldown_until: state.cooldown_until ? new Date(state.cooldown_until) : null, updated_at: new Date(state.updated_at) } : null;
  }

  async save(state: ProviderKeyState): Promise<void> {
    this.states.set(state.key_id, { ...state });
  }

  async list(keyIds: readonly string[]): Promise<ProviderKeyState[]> {
    return (await Promise.all(keyIds.map((keyId) => this.get(keyId)))).filter((state): state is ProviderKeyState => state !== null);
  }
}

export class KeyPool {
  constructor(
    private readonly source: ProviderSource,
    private readonly store: ProviderKeyStateStore,
    private readonly log?: (entry: Record<string, unknown>) => void,
  ) {}

  get keys(): readonly ProviderSourceKey[] {
    return this.source.api_keys;
  }

  private fingerprintForKey(keyId: string): string | null {
    const key = this.keys.find((entry) => entry.key_id === keyId);
    return key ? keyFingerprint(key.api_key) : null;
  }

  private effectiveState(key: ProviderSourceKey, state: ProviderKeyState | undefined): ProviderKeyState | undefined {
    if (state === undefined) return undefined;
    const currentFp = keyFingerprint(key.api_key);
    if (state.key_fingerprint != null && state.key_fingerprint !== currentFp) {
      return undefined;
    }
    if (state.key_fingerprint == null && state.status === "invalid" && state.last_error_code === "1010") {
      return undefined;
    }
    return state;
  }

  async candidates(now: Date, preferred: readonly string[] = []): Promise<string[]> {
    const states = new Map((await this.store.list(this.keys.map((key) => key.key_id))).map((state) => [state.key_id, state]));
    const available = this.keys.filter((key) => {
      const state = this.effectiveState(key, states.get(key.key_id));
      if (state?.status === "invalid") return false;
      return !(state?.status === "cooldown" && state.cooldown_until && now < state.cooldown_until);
    });
    const ordered = this.source.pool_strategy === "failover"
      ? [...available]
      : [...available].sort((left, right) => preferred.indexOf(left.key_id) - preferred.indexOf(right.key_id));
    return ordered.map((key) => key.key_id);
  }

  async nextRecoveryAt(now: Date): Promise<Date | null> {
    const states = new Map((await this.store.list(this.keys.map((key) => key.key_id))).map((state) => [state.key_id, state]));
    let earliest: Date | null = null;
    for (const key of this.keys) {
      const state = this.effectiveState(key, states.get(key.key_id));
      if (state?.status !== "cooldown" || state.cooldown_until === null || now >= state.cooldown_until) {
        continue;
      }
      if (earliest === null || state.cooldown_until.getTime() < earliest.getTime()) {
        earliest = new Date(state.cooldown_until);
      }
    }
    return earliest;
  }

  async markSuccess(keyId: string, now: Date): Promise<void> {
    const fp = this.fingerprintForKey(keyId);
    await this.store.save({
      key_id: keyId,
      status: "healthy",
      cooldown_until: null,
      network_errors: 0,
      last_error_code: null,
      ...(fp === null ? {} : { key_fingerprint: fp }),
      updated_at: now,
    });
  }

  async markFailure(
    keyId: string,
    statusCode: number,
    errorCode: string | null,
    now: Date,
    resetAt: Date | null,
  ): Promise<void> {
    const key = this.keys.find((entry) => entry.key_id === keyId);
    const rawPrevious = await this.store.get(keyId);
    const previous = key && rawPrevious ? this.effectiveState(key, rawPrevious) : rawPrevious ?? undefined;
    const fp = key ? keyFingerprint(key.api_key) : null;
    const fingerprintField = fp === null ? {} : { key_fingerprint: fp };
    const networkErrors = statusCode === 0 || statusCode >= 500 ? (previous?.network_errors ?? 0) + 1 : 0;

    if (isWaf403Failure(statusCode, errorCode)) {
      const wafErrors =
        previous && isWaf403Failure(403, previous.last_error_code)
          ? previous.network_errors + 1
          : 1;
      const waitMinutes = Math.min(60, 15 * 2 ** Math.min(2, wafErrors - 1));
      await this.store.save({
        key_id: keyId,
        status: "cooldown",
        cooldown_until: resetAt ?? new Date(now.getTime() + waitMinutes * 60_000),
        network_errors: wafErrors,
        last_error_code: errorCode ?? "waf_403",
        ...fingerprintField,
        updated_at: now,
      });
      this.log?.({
        event: "provider_key_waf_cooldown",
        source_id: this.source.source_id,
        key_id: keyId,
        error_code: errorCode ?? "waf_403",
        wait_minutes: waitMinutes,
      });
      return;
    }

    if (statusCode === 401 || statusCode === 403) {
      await this.store.save({
        key_id: keyId,
        status: "invalid",
        cooldown_until: null,
        network_errors: networkErrors,
        last_error_code: errorCode ?? String(statusCode),
        ...fingerprintField,
        updated_at: now,
      });
      this.log?.({ diag_code: "DIAG_PROVIDER_KEY_INVALID", source_id: this.source.source_id, key_id: keyId });
      return;
    }
    if (statusCode === 429) {
      const nextMinute = new Date(now);
      nextMinute.setUTCSeconds(0, 0);
      nextMinute.setUTCMinutes(nextMinute.getUTCMinutes() + 1);
      await this.store.save({
        key_id: keyId,
        status: "cooldown",
        cooldown_until: resetAt ?? nextMinute,
        network_errors: 0,
        last_error_code: errorCode ?? "429",
        ...fingerprintField,
        updated_at: now,
      });
      return;
    }
    if (networkErrors >= 3) {
      const waitMinutes = Math.min(5, 2 ** Math.min(2, networkErrors - 3));
      await this.store.save({
        key_id: keyId,
        status: "cooldown",
        cooldown_until: new Date(now.getTime() + waitMinutes * 60_000),
        network_errors: networkErrors,
        last_error_code: errorCode ?? String(statusCode),
        ...fingerprintField,
        updated_at: now,
      });
      return;
    }
    await this.store.save({
      key_id: keyId,
      status: "healthy",
      cooldown_until: null,
      network_errors: networkErrors,
      last_error_code: errorCode ?? String(statusCode),
      ...fingerprintField,
      updated_at: now,
    });
  }

  async snapshot(now: Date): Promise<Array<{ key_id: string; status: "healthy" | "cooldown" | "invalid"; cooldown_until: string | null; last_error_code: string | null }>> {
    const states = new Map((await this.store.list(this.keys.map((key) => key.key_id))).map((state) => [state.key_id, state]));
    return this.keys.map((key) => {
      const state = this.effectiveState(key, states.get(key.key_id));
      const inCooldown = state?.status === "cooldown" && state.cooldown_until !== null && now < state.cooldown_until;
      return {
        key_id: key.key_id,
        status: state?.status === "invalid" ? "invalid" : inCooldown ? "cooldown" : "healthy",
        cooldown_until: state?.status === "invalid" || inCooldown ? state?.cooldown_until?.toISOString() ?? null : null,
        last_error_code: state?.last_error_code ?? null,
      };
    });
  }
}
