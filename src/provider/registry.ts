import { SUPPORTED_LEAGUES } from "../domain/config.js";
import type { ApiFootballFixturesQuery, ApiFootballSeasonFixturesQuery, ApiFootballTeamQuery, ProviderHttpClient as LegacyProviderHttpClient } from "./http.js";
import { ApiFootballClient, ProviderHttpError, ProviderQuotaExceededError } from "./http.js";
import type { ApiFootballFixture, ApiFootballTeam } from "./types.js";
import type { ProviderAdapter, ProviderAdapterLeague, ProviderHttpClient, ProviderHttpResponse } from "./adapter.js";
import { BsdAdapter } from "./bsd-adapter.js";
import { FiveDollarAdapter } from "./fivedollar-adapter.js";
import { FootballDataAdapter } from "./football-data-adapter.js";
import { OpenFootAdapter } from "./openfoot-adapter.js";
import { SportApiAdapter } from "./sportapi-adapter.js";
import type { ProviderSource, ProviderSourceId, ProviderSourcesConfig } from "./sources.js";
import type { ProviderResponseMetadata } from "./transport.js";
import { FetchProviderHttpClient } from "./transport.js";
import { ProviderBudget, ProviderBudgetDeniedError, type ProviderBudgetJob } from "./budget.js";
import { KeyPool, InMemoryProviderKeyStateStore, type ProviderKeyStateStore } from "./key-pool.js";
import { InMemoryProviderLeagueStateStore, type ProviderLeagueStateStore } from "./league-state.js";
import { SyncJobType } from "../domain/enums.js";
import { planRequests } from "./strategy.js";

export interface ProviderRegistryClient {
  getFixtures(query: ApiFootballFixturesQuery): Promise<readonly ApiFootballFixture[]>;
  getSeasonFixtures(query: ApiFootballSeasonFixturesQuery): Promise<readonly ApiFootballFixture[]>;
  getTeams(query: ApiFootballTeamQuery): Promise<readonly ApiFootballTeam[]>;
  getFixturesFromSource(sourceId: ProviderSourceId, query: ApiFootballFixturesQuery): Promise<readonly ApiFootballFixture[]>;
  orderLeagues?(leagueIds: readonly string[], jobType: ProviderBudgetJob, now: Date): Promise<string[]>;
}

export interface ProviderRegistryOptions {
  config: ProviderSourcesConfig;
  fetchImpl?: typeof fetch;
  legacyClient?: ApiFootballClient;
  budget?: ProviderBudget;
  keyStateStore?: ProviderKeyStateStore;
  leagueStateStore?: ProviderLeagueStateStore;
  minimumGapMs?: number;
  log?: (entry: Record<string, unknown>) => void;
}

class PooledProviderHttpClient implements ProviderHttpClient {
  private selectedKeyId: string;
  private retrySelector: ((excluded: readonly string[]) => Promise<string | null>) | undefined;
  private context: { jobType: ProviderBudgetJob; serverNow: Date } | undefined;

  constructor(
    private readonly source: ProviderSource,
    private readonly clients: Map<string, FetchProviderHttpClient>,
    private readonly pool: KeyPool,
    private readonly log?: (entry: Record<string, unknown>) => void,
    private readonly beforeSend?: () => Promise<void>,
  ) {
    this.selectedKeyId = source.api_keys[0]!.key_id;
  }

  setContext(
    jobType: ProviderBudgetJob,
    serverNow: Date,
    selectRetryKey: (excluded: readonly string[]) => Promise<string | null>,
  ): void {
    this.context = { jobType, serverNow };
    this.retrySelector = selectRetryKey;
  }

  selectKey(keyId: string): void {
    this.selectedKeyId = keyId;
  }

  async getJson(path: string, query: Record<string, string>): Promise<unknown> {
    return (await this.getJsonResponse(path, query)).data;
  }

  async getJsonResponse(path: string, query: Record<string, string>, headers?: Record<string, string>): Promise<ProviderHttpResponse> {
    const firstKey = this.selectedKeyId;
    try {
      const response = await this.request(firstKey, path, query, headers);
      await this.pool.markSuccess(firstKey, this.context?.serverNow ?? new Date());
      return response;
    } catch (error) {
      const status = providerErrorStatus(error);
      const resetAt = error instanceof ProviderQuotaExceededError ? error.resetAt : null;
      const code = error instanceof ProviderQuotaExceededError ? error.providerCode : status ? String(status) : null;
      await this.pool.markFailure(firstKey, status, code, this.context?.serverNow ?? new Date(), resetAt);
      if (!isRetryable(error) || this.retrySelector === undefined) throw error;
      const secondKey = await this.retrySelector([firstKey]);
      if (secondKey === null) throw error;
      this.log?.({ event: "provider_key_failover", source_id: this.source.source_id, from_key_id: firstKey, to_key_id: secondKey, status });
      try {
        const response = await this.request(secondKey, path, query, headers);
        await this.pool.markSuccess(secondKey, this.context?.serverNow ?? new Date());
        return response;
      } catch (retryError) {
        const retryStatus = providerErrorStatus(retryError);
        await this.pool.markFailure(
          secondKey,
          retryStatus,
          retryError instanceof ProviderQuotaExceededError ? retryError.providerCode : retryStatus ? String(retryStatus) : null,
          this.context?.serverNow ?? new Date(),
          retryError instanceof ProviderQuotaExceededError ? retryError.resetAt : null,
        );
        throw retryError;
      }
    }
  }

  private async request(keyId: string, path: string, query: Record<string, string>, headers?: Record<string, string>): Promise<ProviderHttpResponse> {
    const client = this.clients.get(keyId);
    if (client === undefined) throw new Error("provider key client is not configured");
    await this.beforeSend?.();
    return client.getJsonResponse(path, query, headers);
  }
}

function providerErrorStatus(error: unknown): number {
  if (error instanceof ProviderQuotaExceededError) return 429;
  return error instanceof ProviderHttpError ? error.status : 0;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof ProviderQuotaExceededError) return true;
  if (error instanceof ProviderHttpError) return error.status >= 500;
  return error instanceof Error;
}

function adapterForSource(
  source: ProviderSource,
  http: ProviderHttpClient,
  log?: (entry: Record<string, unknown>) => void,
  onOpenFootQuota?: (remaining: number, resetAt: Date, now: Date) => void,
): ProviderAdapter {
  switch (source.adapter) {
    case "football_data": return new FootballDataAdapter(http);
    case "bsd": return new BsdAdapter(http, log);
    case "fivedollar": return new FiveDollarAdapter(http);
    case "openfoot": return new OpenFootAdapter(http, onOpenFootQuota);
    case "sportapi": return new SportApiAdapter(http);
  }
}

interface SourceLeagueEntry {
  source: ProviderSource;
  adapter: ProviderAdapter;
  league: ProviderAdapterLeague;
  roles: ProviderSource["leagues"][number]["roles"];
}

interface ProviderLastRequest {
  status: number;
  duration_ms: number;
  at: string;
  provider_code?: string;
  quota_remaining?: number;
  quota_reset_at?: string;
}

export class ProviderRegistry {
  private readonly adapters = new Map<ProviderSourceId, ProviderAdapter>();
  private readonly httpBySource = new Map<ProviderSourceId, PooledProviderHttpClient>();
  private readonly sources = new Map<ProviderSourceId, ProviderSource>();
  private readonly sourceLeagues = new Map<string, SourceLeagueEntry[]>();
  private readonly lastRequestsByJob = new Map<string, number>();
  private readonly legacyClient: ApiFootballClient | undefined;
  private readonly budget: ProviderBudget | undefined;
  private readonly providerConfig: ProviderSourcesConfig;
  private readonly log: ((entry: Record<string, unknown>) => void) | undefined;
  private readonly lastRequests = new Map<string, ProviderLastRequest>();
  private readonly lastResponseMetadata = new Map<string, ProviderResponseMetadata>();
  private readonly keyResponseMetadata = new Map<string, ProviderResponseMetadata>();
  private readonly activeRequestContext = new Map<string, { key_id: string; now: number }>();
  private readonly lastSentAt = new Map<string, number>();
  private readonly requestTails = new Map<string, Promise<void>>();
  private readonly pools = new Map<ProviderSourceId, KeyPool>();
  private readonly syncProfile: ProviderSourcesConfig["sync_profile"];
  private readonly minimumGapMs: number;
  private readonly leagueStateStore: ProviderLeagueStateStore;
  private liveRequestCache: { key: string; value: Promise<readonly ApiFootballFixture[]> } | null = null;

  constructor(options: ProviderRegistryOptions) {
    this.legacyClient = options.legacyClient;
    this.budget = options.budget;
    this.providerConfig = options.config;
    this.log = options.log;
    this.syncProfile = options.config.sync_profile;
    this.minimumGapMs = options.minimumGapMs ?? 3000;
    this.leagueStateStore = options.leagueStateStore ?? new InMemoryProviderLeagueStateStore();
    const keyStateStore = options.keyStateStore ?? new InMemoryProviderKeyStateStore();
    for (const source of options.config.sources) {
      this.sources.set(source.source_id, source);
      const pool = new KeyPool(source, keyStateStore, this.log);
      this.pools.set(source.source_id, pool);
      const transports = new Map<string, FetchProviderHttpClient>();
      for (const key of source.api_keys) {
        transports.set(key.key_id, new FetchProviderHttpClient({
          apiKey: key.api_key,
          baseUrl: source.base_url,
          authHeaderName: source.auth.header,
          authScheme: source.auth.scheme,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          onResponse: (metadata) => this.observeProviderResponse(source.source_id, key.key_id, metadata),
        }));
      }
      const http = new PooledProviderHttpClient(source, transports, pool, this.log, () => this.waitForSourceGap(source.source_id));
      this.httpBySource.set(source.source_id, http);
      const adapter = adapterForSource(source, http, this.log, (remaining, resetAt, now) => {
        this.budget?.observeRemoteQuota("of", remaining, resetAt, now);
      });
      this.adapters.set(source.source_id, adapter);
      for (const league of source.leagues) {
        const entries = this.sourceLeagues.get(league.league_id) ?? [];
        entries.push({ source, adapter, league: {
          league_id: league.league_id,
          source_league_ref: league.source_league_ref,
          season_ref: league.season_ref,
        }, roles: league.roles });
        this.sourceLeagues.set(league.league_id, entries);
      }
    }
  }

  forLeague(leagueId: string): ProviderAdapter | null {
    const entry = this.primaryEntry(leagueId, "schedule") ?? this.primaryEntry(leagueId, "live");
    return entry?.adapter ?? null;
  }

  lastRequest(sourceId: ProviderSourceId): ProviderLastRequest | null {
    return this.lastRequests.get(sourceId) ?? null;
  }

  async keyDiagnostics(sourceId: ProviderSourceId, now: Date): Promise<unknown[]> {
    const source = this.source(sourceId);
    const pool = this.pools.get(sourceId);
    if (!source || !pool) return [];
    const states = await pool.snapshot(now);
    const [usage, sourceUsage] = await Promise.all([Promise.all(source.api_keys.map(async (key) => ({
      key_id: key.key_id,
      minute_used: this.budget ? await this.budget.usageForKey(sourceId, now, key.key_id) : null,
      minute_limit: key.max_per_minute,
      remote_remaining: parseNumber(this.keyResponseMetadata.get(`${sourceId}:${key.key_id}`)?.requests_available_minute ?? null),
      daily_used: null as number | null,
      daily_limit: source.daily_cap,
    }))), this.budget?.usageSnapshot(now)]);
    return states.map((state) => ({
      ...state,
      ...(usage.find((item) => item.key_id === state.key_id) ?? {}),
      daily_used: sourceUsage?.[sourceId]?.used ?? null,
    }));
  }

  async orderLeagues(leagueIds: readonly string[], jobType: ProviderBudgetJob, now: Date): Promise<string[]> {
    const records = await Promise.all(leagueIds.map(async (leagueId, index) => {
      const role = roleForJob(jobType);
      const entries = (this.sourceLeagues.get(leagueId) ?? []).filter((entry) =>
        entry.roles[role] === "primary" || entry.roles[role] === "secondary" || entry.roles[role] === "fallback",
      );
      const primary = entries.find((entry) => entry.roles[role] === "primary") ?? entries[0];
      const states = await Promise.all(entries.map((entry) => this.leagueStateStore.get(entry.source.source_id, leagueId, jobType)));
      const lastSuccess = states.reduce((latest, state) => Math.max(latest, state?.last_success_at.getTime() ?? Number.NEGATIVE_INFINITY), Number.NEGATIVE_INFINITY);
      return { leagueId, index, sourceId: primary?.source.source_id ?? "", lastSuccess };
    }));
    const sourceOrder = new Map<string, number>();
    for (const record of records) if (!sourceOrder.has(record.sourceId)) sourceOrder.set(record.sourceId, sourceOrder.size);
    return records.sort((left, right) =>
      (sourceOrder.get(left.sourceId) ?? 0) - (sourceOrder.get(right.sourceId) ?? 0) ||
      left.lastSuccess - right.lastSuccess || left.index - right.index,
    ).map((record) => record.leagueId);
  }

  async dueLeagues(
    leagueIds: readonly string[],
    jobType: ProviderBudgetJob,
    now: Date,
    intervalMs: number,
  ): Promise<string[]> {
    const ordered = await this.orderLeagues(leagueIds, jobType, now);
    const role = roleForJob(jobType);
    const due: string[] = [];
    for (const leagueId of ordered) {
      const entries = (this.sourceLeagues.get(leagueId) ?? []).filter((entry) =>
        entry.roles[role] === "primary" || entry.roles[role] === "secondary" || entry.roles[role] === "fallback",
      );
      const states = await Promise.all(entries.map((entry) =>
        this.leagueStateStore.get(entry.source.source_id, leagueId, jobType),
      ));
      const lastSuccess = states.reduce(
        (latest, state) => Math.max(latest, state?.last_success_at.getTime() ?? Number.NEGATIVE_INFINITY),
        Number.NEGATIVE_INFINITY,
      );
      if (!Number.isFinite(lastSuccess) || now.getTime() - lastSuccess >= intervalMs) due.push(leagueId);
    }
    return due;
  }

  async leagueDiagnostics(
    sourceId: ProviderSourceId,
    jobTypes: readonly ProviderBudgetJob[],
    now = new Date(),
  ): Promise<Array<Record<string, unknown>>> {
    const source = this.source(sourceId);
    if (!source) return [];
    const rows: Array<Record<string, unknown>> = [];
    for (const league of source.leagues) {
      const lastSuccess: Partial<Record<ProviderBudgetJob, string | null>> = {};
      for (const jobType of jobTypes) {
        const state = await this.leagueStateStore.get(sourceId, league.league_id, jobType);
        lastSuccess[jobType] = state?.last_success_at.toISOString() ?? null;
      }
      rows.push({
        league_id: league.league_id,
        source_league_ref: league.source_league_ref,
        season_ref: league.season_ref,
        roles: league.roles,
        last_success_at: lastSuccess,
        daily_request_count: this.budget ? await this.budget.leagueDailyUsage(sourceId, league.league_id, now) : null,
      });
    }
    return rows;
  }

  asClient(): ProviderRegistryClient {
    return {
      getFixtures: (query) => this.fetchQuery(query),
      getSeasonFixtures: (query) => this.fetchQuery(query, undefined, true),
      getTeams: async (query) => {
        const league = SUPPORTED_LEAGUES.find((row) => row.api_football_league_id === query.leagueId);
        if (!league) return this.legacyClient?.getTeams(query) ?? [];
        const entry = this.primaryEntry(league.league_id, "schedule");
        if (entry === null || entry === undefined) return this.legacyClient?.getTeams(query) ?? [];
        const now = query.serverNow ?? new Date();
        const jobType = asBudgetJob(query.jobType);
        return this.withRequest(entry.source.source_id, jobType, now, () => entry.adapter.fetchTeams(entry.league, this.callOptions(entry, jobType, now)), league.league_id);
      },
      getFixturesFromSource: async (sourceId, query) => {
        const league = SUPPORTED_LEAGUES.find((row) => row.api_football_league_id === query.leagueId);
        if (!league || !this.source(sourceId)) return [];
        return this.fetchQuery(query, sourceId);
      },
      orderLeagues: (leagueIds, jobType, now) => this.orderLeagues(leagueIds, jobType, now),
    };
  }

  private async fetchQuery(
    query: ApiFootballFixturesQuery | ApiFootballSeasonFixturesQuery,
    explicitSourceId?: ProviderSourceId,
    season = false,
  ): Promise<readonly ApiFootballFixture[]> {
    const league = SUPPORTED_LEAGUES.find((row) => row.api_football_league_id === query.leagueId);
    if (league === undefined) return [];
    const jobType = asBudgetJob(query.jobType);
    const now = query.serverNow ?? new Date();
    const selectedPlan = explicitSourceId ? null : this.requestPlan(league.league_id, jobType, now);
    const selected = explicitSourceId
      ? this.entryForSource(explicitSourceId, league.league_id)
      : selectedPlan ? this.entryForSource(selectedPlan.source_id, league.league_id) : null;
    if (selected === null || selected === undefined) return this.legacyFetch(query, season);
    if (jobType === SyncJobType.LiveMatch && !this.liveRequestDue(selected.source.source_id, now)) {
      return [];
    }
    const trackLeagueInBudget = !(jobType === SyncJobType.LiveMatch && selected.source.source_id === "5d");
    const callOptions = this.callOptions(selected, jobType, now, trackLeagueInBudget);
    const fetch = async (): Promise<readonly ApiFootballFixture[]> => {
      if (season || !("dateFrom" in query) || query.dateFrom === undefined || query.dateTo === undefined) {
        return selected.adapter.fetchSeasonFixtures(selected.league, callOptions);
      }
      return selected.adapter.fetchFixturesByDateRange(selected.league, query.dateFrom, query.dateTo, callOptions);
    };
    try {
      let primaryFixtures: readonly ApiFootballFixture[];
      if (jobType === SyncJobType.LiveMatch && selected.source.source_id === "5d") {
        const cacheKey = `${jobType}:${now.getTime()}`;
        if (this.liveRequestCache?.key !== cacheKey) {
          const liveAdapter = selected.adapter as FiveDollarAdapter;
          this.liveRequestCache = {
            key: cacheKey,
            value: this.withRequest(selected.source.source_id, jobType, now, () => liveAdapter.fetchLiveFixtures(callOptions), league.league_id),
          };
        }
        let allLive: readonly ApiFootballFixture[];
        try {
          allLive = await this.liveRequestCache.value;
        } catch (error) {
          if (this.liveRequestCache?.key === cacheKey) this.liveRequestCache = null;
          throw error;
        }
        primaryFixtures = allLive.filter((fixture) => String(fixture.league.id) === selected.league.source_league_ref);
        await this.leagueStateStore.markSuccess(selected.source.source_id, league.league_id, jobType, now);
        if (this.budget) await this.budget.recordLeagueRequest(selected.source.source_id, league.league_id, now);
      } else {
        primaryFixtures = await this.withRequest(selected.source.source_id, jobType, now, fetch, league.league_id);
      }
      if (season && primaryFixtures.length === 0) {
        this.log?.({
          diag_code: "DIAG_PROVIDER_NO_DATA",
          source_id: selected.source.source_id,
          league_id: league.league_id,
          season_ref: selected.league.season_ref,
          job_type: jobType,
          hint: "检查联赛赛季参数是否已过期",
        });
      }
      if (jobType !== SyncJobType.PostFinishVerify || !("dateFrom" in query) || !query.dateFrom || !query.dateTo) {
        return primaryFixtures;
      }
      const comparisons = await this.fetchResultComparisons(league.league_id, selected.source.source_id, query, jobType, false);
      return [...primaryFixtures, ...comparisons];
    } catch (error) {
      if (jobType === SyncJobType.PostFinishVerify) {
        if (error instanceof ProviderBudgetDeniedError) {
          this.log?.({ event: "skipped_budget", source_id: selected.source.source_id, league_id: league.league_id, reason: error.reason });
        }
        return this.fetchResultComparisons(league.league_id, selected.source.source_id, query, jobType, true);
      }
      if (error instanceof ProviderBudgetDeniedError && jobType !== SyncJobType.LiveMatch) {
        this.log?.({ event: "skipped_budget", source_id: selected.source.source_id, league_id: league.league_id, reason: error.reason });
        return [];
      }
      const fallbackReason = error instanceof ProviderBudgetDeniedError ? error.reason : "provider_unavailable";
      const fallbackPlan = this.requestPlan(league.league_id, jobType, now, new Map([[selected.source.source_id, fallbackReason]]));
      const fallback = fallbackPlan ? this.entryForSource(fallbackPlan.source_id, league.league_id) : null;
      if (fallback === null || fallback === undefined) throw error;
      this.log?.({ event: "fallback_used", diag_code: "DIAG_PROVIDER_FALLBACK_ACTIVE", source_id: fallback.source.source_id, failed_source_id: selected.source.source_id, league_id: league.league_id, job_type: jobType, reason: fallbackReason });
      const fallbackOptions = this.callOptions(fallback, jobType, now);
      const fallbackFixtures = await this.withRequest(fallback.source.source_id, jobType, now, () =>
        season || !("dateFrom" in query) || query.dateFrom === undefined || query.dateTo === undefined
          ? fallback.adapter.fetchSeasonFixtures(fallback.league, fallbackOptions)
          : fallback.adapter.fetchFixturesByDateRange(fallback.league, query.dateFrom, query.dateTo, fallbackOptions), league.league_id);
      if (season && fallbackFixtures.length === 0) {
        this.log?.({
          diag_code: "DIAG_PROVIDER_NO_DATA",
          source_id: fallback.source.source_id,
          league_id: league.league_id,
          season_ref: fallback.league.season_ref,
          job_type: jobType,
          hint: "检查联赛赛季参数是否已过期",
        });
      }
      return fallbackFixtures;
    }
  }

  private async fetchResultComparisons(
    leagueId: string,
    primarySourceId: ProviderSourceId,
    query: ApiFootballFixturesQuery | ApiFootballSeasonFixturesQuery,
    jobType: ProviderBudgetJob,
    includeFallbacks: boolean,
  ): Promise<ApiFootballFixture[]> {
    if (!("dateFrom" in query) || !query.dateFrom || !query.dateTo) return [];
    const entries = (this.sourceLeagues.get(leagueId) ?? []).filter((entry) =>
      entry.source.source_id !== primarySourceId &&
      (entry.roles.result === "secondary" || (includeFallbacks && entry.roles.result === "fallback")),
    );
    const results: ApiFootballFixture[] = [];
    for (const entry of entries) {
      try {
        const now = query.serverNow ?? new Date();
        const rows = await this.withRequest(entry.source.source_id, jobType, now, () =>
          entry.adapter.fetchFixturesByDateRange(
            entry.league,
            query.dateFrom!,
            query.dateTo!,
            this.callOptions(entry, jobType, now),
          ),
          leagueId,
        );
        results.push(...rows.filter((fixture) => fixture.fixture?.status?.short !== "NS"));
      } catch (error) {
        this.log?.({
          event: "provider_comparison_skipped",
          diag_code: "DIAG_PROVIDER_FALLBACK_ACTIVE",
          source_id: entry.source.source_id,
          league_id: leagueId,
          reason: error instanceof ProviderBudgetDeniedError ? error.reason : "provider_unavailable",
        });
      }
    }
    return results;
  }

  private async legacyFetch(
    query: ApiFootballFixturesQuery | ApiFootballSeasonFixturesQuery,
    season: boolean,
  ): Promise<readonly ApiFootballFixture[]> {
    if (season) return this.legacyClient?.getSeasonFixtures(query as ApiFootballSeasonFixturesQuery) ?? [];
    return this.legacyClient?.getFixtures(query as ApiFootballFixturesQuery) ?? [];
  }

  private entryForSource(sourceId: ProviderSourceId, leagueId: string): SourceLeagueEntry | null {
    return this.sourceLeagues.get(leagueId)?.find((entry) => entry.source.source_id === sourceId) ?? null;
  }

  private primaryEntry(leagueId: string, role: keyof SourceLeagueEntry["roles"]): SourceLeagueEntry | null {
    return this.sourceLeagues.get(leagueId)?.find((entry) => entry.roles[role] === "primary") ?? null;
  }

  private source(sourceId: ProviderSourceId): ProviderSource | null {
    return this.sources.get(sourceId) ?? null;
  }

  private callOptions(entry: SourceLeagueEntry, jobType: ProviderBudgetJob, serverNow: Date, trackLeagueUsage = true) {
    return {
      jobType,
      serverNow,
      beforeRequest: async () => {
        await this.prepareRequest(
          entry.source.source_id,
          jobType,
          serverNow,
          [],
          trackLeagueUsage ? entry.league.league_id : undefined,
        );
      },
    };
  }

  private requestPlan(
    leagueId: string,
    jobType: ProviderBudgetJob,
    now: Date,
    unavailableSources: ReadonlyMap<ProviderSourceId, string> = new Map(),
  ) {
    return planRequests(now, [{ league_id: leagueId, job_type: jobType }], {
      unavailable_sources: unavailableSources,
    }, { sources: this.providerConfig.sources })[0] ?? null;
  }

  private async prepareRequest(
    sourceId: ProviderSourceId,
    jobType: ProviderBudgetJob,
    now: Date,
    excluded: readonly string[] = [],
    leagueId?: string,
  ): Promise<string> {
    const pool = this.pools.get(sourceId)!;
    const http = this.httpBySource.get(sourceId)!;
    http.setContext(jobType, now, (retryExcluded) => this.chooseKey(sourceId, jobType, now, retryExcluded, leagueId));
    const preferred = this.budget ? await this.budget.candidateKeys(sourceId, now, excluded) : (this.source(sourceId)?.api_keys.map((key) => key.key_id) ?? []);
    const candidates = await pool.candidates(now, preferred);
    let lastReason = "provider_cooldown";
    for (const keyId of candidates) {
      const decision = this.budget ? await this.budget.acquire(sourceId, jobType, now, keyId, leagueId) : { allowed: true as const, key_id: keyId, minute_used: 0, daily_used: 0, daily_limit: 0 };
      if (decision.allowed) {
        http.selectKey(keyId);
        this.activeRequestContext.set(sourceId, { key_id: keyId, now: now.getTime() });
        return keyId;
      }
      lastReason = decision.reason;
    }
    throw new ProviderBudgetDeniedError(lastReason);
  }

  private async chooseKey(sourceId: ProviderSourceId, jobType: ProviderBudgetJob, now: Date, excluded: readonly string[], leagueId?: string): Promise<string | null> {
    try {
      return await this.prepareRequest(sourceId, jobType, now, excluded, leagueId);
    } catch {
      return null;
    }
  }

  private async waitForSourceGap(sourceId: ProviderSourceId): Promise<void> {
    const last = this.lastSentAt.get(sourceId);
    if (last !== undefined) {
      const waitMs = this.minimumGapMs - (Date.now() - last);
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    this.lastSentAt.set(sourceId, Date.now());
  }

  private async withRequest<T>(sourceId: ProviderSourceId, jobType: ProviderBudgetJob, now: Date, fn: () => Promise<T>, leagueId?: string): Promise<T> {
    return this.serializeSourceRequest(sourceId, async () => {
      const startedAt = Date.now();
      this.lastResponseMetadata.delete(sourceId);
      try {
        const value = await fn();
        this.lastRequestsByJob.set(`${sourceId}:${jobType}`, now.getTime());
        if (leagueId) await this.leagueStateStore.markSuccess(sourceId, leagueId, jobType, now);
        this.lastRequests.set(sourceId, this.requestInfo(sourceId, 200, Date.now() - startedAt, now));
        this.log?.({ event: "provider_request", source_id: sourceId, ...this.lastRequests.get(sourceId) });
        return value;
      } catch (error) {
        this.lastRequestsByJob.set(`${sourceId}:${jobType}`, now.getTime());
        if (error instanceof ProviderQuotaExceededError) {
          const resetAt = quotaResetAt(sourceId, now, error);
          const keyId = this.activeRequestContext.get(sourceId)?.key_id;
          this.budget?.pauseSource(sourceId, resetAt, error.providerCode, keyId);
        }
        const status = providerErrorStatus(error);
        this.lastRequests.set(sourceId, this.requestInfo(sourceId, status, Date.now() - startedAt, now, error instanceof ProviderHttpError ? error.providerCode : undefined));
        this.log?.({ event: "provider_request", source_id: sourceId, ...this.lastRequests.get(sourceId) });
        throw error;
      }
    });
  }

  private async serializeSourceRequest<T>(sourceId: ProviderSourceId, run: () => Promise<T>): Promise<T> {
    const previous = this.requestTails.get(sourceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.requestTails.set(sourceId, tail);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.requestTails.get(sourceId) === tail) this.requestTails.delete(sourceId);
    }
  }

  private liveRequestDue(sourceId: ProviderSourceId, now: Date): boolean {
    const last = this.lastRequestsByJob.get(`${sourceId}:${SyncJobType.LiveMatch}`);
    if (last === undefined) return true;
    const intervalMinutes = sourceId === "bsd" || sourceId === "sp"
      ? this.syncProfile === "test" ? 5 : 2
      : sourceId === "5d" ? this.syncProfile === "test" ? 5 : 3
      : this.syncProfile === "test" ? 10 : 5;
    return now.getTime() - last >= intervalMinutes * 60_000;
  }

  private observeProviderResponse(sourceId: ProviderSourceId, keyId: string, metadata: ProviderResponseMetadata): void {
    this.lastResponseMetadata.set(sourceId, metadata);
    this.keyResponseMetadata.set(`${sourceId}:${keyId}`, metadata);
    const active = this.activeRequestContext.get(sourceId);
    const now = new Date(active?.now ?? Date.now());
    const remaining = sourceId === "fd"
      ? parseNumber(metadata.requests_available_minute)
      : sourceId === "bsd"
        ? parseParameter(metadata.rate_limit, "r")
        : parseNumber(metadata.rate_limit_remaining);
    if (remaining === null) return;
    const resetAt = sourceId === "fd"
      ? secondsFromNow(metadata.request_counter_reset, now)
      : sourceId === "bsd"
        ? secondsFromNow(parseParameter(metadata.rate_limit, "t")?.toString() ?? null, now)
        : sourceId === "5d" || sourceId === "of" || sourceId === "sp"
          ? parseReset(metadata.rate_limit_reset, now)
          : null;
    this.budget?.observeRemoteQuota(sourceId, remaining, resetAt, now, sourceId === "fd" ? keyId : undefined);
  }

  private requestInfo(sourceId: ProviderSourceId, status: number, durationMs: number, now: Date, providerCode?: string | null): ProviderLastRequest {
    const metadata = this.lastResponseMetadata.get(sourceId);
    const remaining = metadata === undefined ? null : sourceId === "fd"
      ? parseNumber(metadata.requests_available_minute)
      : sourceId === "bsd" ? parseParameter(metadata.rate_limit, "r") : parseNumber(metadata.rate_limit_remaining);
    const resetAt = metadata === undefined ? null : sourceId === "fd"
      ? secondsFromNow(metadata.request_counter_reset, now)
      : sourceId === "bsd" ? secondsFromNow(parseParameter(metadata.rate_limit, "t")?.toString() ?? null, now)
      : parseReset(metadata.rate_limit_reset, now);
    return { status, duration_ms: durationMs, at: now.toISOString(), ...(providerCode ? { provider_code: providerCode } : {}), ...(remaining === null ? {} : { quota_remaining: remaining }), ...(resetAt === null ? {} : { quota_reset_at: resetAt.toISOString() }) };
  }
}

function roleForJob(job: ProviderBudgetJob): keyof SourceLeagueEntry["roles"] {
  if (job === SyncJobType.FutureSchedule || job === SyncJobType.FullScheduleVerify) return "schedule";
  if (job === SyncJobType.NearMatch) return "kickoff";
  if (job === SyncJobType.LiveMatch) return "live";
  return "result";
}

function asBudgetJob(value: SyncJobType | undefined): ProviderBudgetJob {
  return value === SyncJobType.PostFinishVerify || value === SyncJobType.LiveMatch ||
    value === SyncJobType.NearMatch || value === SyncJobType.FullScheduleVerify
    ? value
    : SyncJobType.FutureSchedule;
}

function parseNumber(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseParameter(value: string | null, name: string): number | null {
  if (value === null) return null;
  return parseNumber(new RegExp(`(?:^|[;,\\s])${name}\\s*=\\s*([0-9]+)`, "i").exec(value)?.[1] ?? null);
}

function secondsFromNow(value: string | null, now: Date): Date | null {
  const seconds = parseNumber(value);
  return seconds === null ? null : new Date(now.getTime() + seconds * 1000);
}

function parseReset(value: string | null, now: Date): Date | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed > 1_000_000_000_000 ? new Date(parsed) : parsed > 1_000_000_000 ? new Date(parsed * 1000) : new Date(now.getTime() + parsed * 1000);
}

function nextMinute(now: Date): Date {
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(next.getUTCMinutes() + 1);
  return next;
}

function quotaResetAt(sourceId: ProviderSourceId, now: Date, error: ProviderQuotaExceededError): Date {
  if (error.resetAt) return error.resetAt;
  if (sourceId === "bsd" && error.providerCode === "taster_exhausted") {
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    return midnight;
  }
  if (sourceId === "sp") {
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    return midnight;
  }
  if (sourceId === "of") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return nextMinute(now);
}

export function createProviderRegistry(
  config: ProviderSourcesConfig,
  legacyHttp?: LegacyProviderHttpClient,
  fetchImpl?: typeof fetch,
): ProviderRegistry {
  const legacyClient = legacyHttp === undefined ? undefined : new ApiFootballClient(legacyHttp);
  return new ProviderRegistry({ config, ...(fetchImpl ? { fetchImpl } : {}), ...(legacyClient ? { legacyClient } : {}) });
}
