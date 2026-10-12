import type { ProviderSource, ProviderSourceKey } from "./sources.js";

export interface ProviderKeyState {
  key_id: string;
  status: "healthy" | "cooldown" | "invalid";
  cooldown_until: Date | null;
  network_errors: number;
  last_error_code: string | null;
  updated_at: Date;
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

  async candidates(now: Date, preferred: readonly string[] = []): Promise<string[]> {
    const states = new Map((await this.store.list(this.keys.map((key) => key.key_id))).map((state) => [state.key_id, state]));
    const available = this.keys.filter((key) => {
      const state = states.get(key.key_id);
      if (state?.status === "invalid") return false;
      return !(state?.status === "cooldown" && state.cooldown_until && now < state.cooldown_until);
    });
    const ordered = this.source.pool_strategy === "failover"
      ? [...available]
      : [...available].sort((left, right) => preferred.indexOf(left.key_id) - preferred.indexOf(right.key_id));
    return ordered.map((key) => key.key_id);
  }

  async markSuccess(keyId: string, now: Date): Promise<void> {
    await this.store.save({ key_id: keyId, status: "healthy", cooldown_until: null, network_errors: 0, last_error_code: null, updated_at: now });
  }

  async markFailure(
    keyId: string,
    statusCode: number,
    errorCode: string | null,
    now: Date,
    resetAt: Date | null,
  ): Promise<void> {
    const previous = await this.store.get(keyId);
    const networkErrors = statusCode === 0 || statusCode >= 500 ? (previous?.network_errors ?? 0) + 1 : 0;
    if (statusCode === 401 || statusCode === 403) {
      await this.store.save({ key_id: keyId, status: "invalid", cooldown_until: null, network_errors: networkErrors, last_error_code: String(statusCode), updated_at: now });
      this.log?.({ diag_code: "DIAG_PROVIDER_KEY_INVALID", source_id: this.source.source_id, key_id: keyId });
      return;
    }
    if (statusCode === 429) {
      const nextMinute = new Date(now);
      nextMinute.setUTCSeconds(0, 0);
      nextMinute.setUTCMinutes(nextMinute.getUTCMinutes() + 1);
      await this.store.save({ key_id: keyId, status: "cooldown", cooldown_until: resetAt ?? nextMinute, network_errors: 0, last_error_code: errorCode ?? "429", updated_at: now });
      return;
    }
    if (networkErrors >= 3) {
      const waitMinutes = Math.min(5, 2 ** Math.min(2, networkErrors - 3));
      await this.store.save({ key_id: keyId, status: "cooldown", cooldown_until: new Date(now.getTime() + waitMinutes * 60_000), network_errors: networkErrors, last_error_code: errorCode ?? String(statusCode), updated_at: now });
      return;
    }
    await this.store.save({ key_id: keyId, status: "healthy", cooldown_until: null, network_errors: networkErrors, last_error_code: errorCode ?? String(statusCode), updated_at: now });
  }

  async snapshot(now: Date): Promise<Array<{ key_id: string; status: "healthy" | "cooldown" | "invalid"; cooldown_until: string | null; last_error_code: string | null }>> {
    const states = new Map((await this.store.list(this.keys.map((key) => key.key_id))).map((state) => [state.key_id, state]));
    return this.keys.map((key) => {
      const state = states.get(key.key_id);
      const inCooldown = state?.status === "cooldown" && state.cooldown_until !== null && now < state.cooldown_until;
      return {
        key_id: key.key_id,
        status: state?.status === "invalid" ? "invalid" : inCooldown ? "cooldown" : "healthy",
        cooldown_until: state?.cooldown_until?.toISOString() ?? null,
        last_error_code: state?.last_error_code ?? null,
      };
    });
  }
}
