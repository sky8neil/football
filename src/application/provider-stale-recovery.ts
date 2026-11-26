import { findSupportedLeagueById, type ProviderLeagueRefs } from "../domain/config.js";
import { SyncJobType } from "../domain/enums.js";
import type { Match } from "../domain/types.js";
import type { ActiveWindowCursor, ActiveWindowQuery } from "../infrastructure/active-window-query.js";
import {
  InMemorySchedulerStateStore,
  type SchedulerStateStore,
  type StaleRecoveryGroupProgress,
} from "../infrastructure/cloudbase-scheduler-state.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { ProviderBudgetDeniedError } from "../provider/budget.js";
import { ProviderQuotaExceededError } from "../provider/http.js";
import type { ApiFootballFixture } from "../provider/types.js";
import { ProviderFixtureSyncService } from "./provider-fixture-sync.js";
import {
  ProviderFixtureSyncJobService,
  type ProviderFixtureBatchItem,
  type ProviderFixtureSyncJobOutcome,
  type ProviderFixtureSyncLockOptions,
  type ProviderFixtureSyncRetryOptions,
} from "./provider-sync-job.js";
import { fixturesToItems, type ProviderWindowFixtureClient } from "./provider-window-loader.js";

export const STALE_RECOVERY_ROUND_CAP = 10;
const DAY_MS = 24 * 60 * 60_000;

type StaleRecoveryClient = ProviderWindowFixtureClient & { log?: (entry: Record<string, unknown>) => void };

export interface StaleRecoveryBatchOptions {
  after?: ActiveWindowCursor | null;
  groupProgress?: StaleRecoveryGroupProgress | null;
  onCursorAdvance?: (
    nextCursor: ActiveWindowCursor | null,
    nextGroupProgress?: StaleRecoveryGroupProgress | null,
  ) => Promise<void> | void;
}

function kickoffMs(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime();
  return new Date(value).getTime();
}

function toStaleRecoveryCursor(match: Match): ActiveWindowCursor {
  const kickoff = match.kickoff_at instanceof Date ? match.kickoff_at : new Date(match.kickoff_at);
  return { kickoff_at: kickoff, match_id: match.match_id };
}

function compareStaleCursorOrder(left: Match, right: Match): number {
  const delta = kickoffMs(left.kickoff_at) - kickoffMs(right.kickoff_at);
  if (delta !== 0) return delta;
  if (left.match_id < right.match_id) return -1;
  if (left.match_id > right.match_id) return 1;
  return 0;
}

function matchKickoffDay(match: Match): string {
  return new Date(kickoffMs(match.kickoff_at)).toISOString().slice(0, 10);
}

function candidateDates(matches: readonly Match[]): string[] {
  return [...new Set(matches.flatMap((match) => {
    const day = matchKickoffDay(match);
    return [day, new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10)];
  }))].sort();
}

interface StaleRecoveryDayGroup {
  leagueId: string;
  seasonId: string;
  kickoffDay: string;
  matches: Match[];
}

function groupStaleCandidates(sortedCandidates: readonly Match[]): StaleRecoveryDayGroup[] {
  const groups: StaleRecoveryDayGroup[] = [];
  for (const match of sortedCandidates) {
    const kickoffDay = matchKickoffDay(match);
    const last = groups[groups.length - 1];
    if (
      last !== undefined &&
      last.leagueId === match.league_id &&
      last.seasonId === match.season_id &&
      last.kickoffDay === kickoffDay
    ) {
      last.matches.push(match);
    } else {
      groups.push({
        leagueId: match.league_id,
        seasonId: match.season_id,
        kickoffDay,
        matches: [match],
      });
    }
  }
  return groups;
}

function dateCacheKey(leagueId: string, seasonId: string, date: string): string {
  return `${leagueId}|${seasonId}|${date}`;
}

function groupProgressKey(group: Pick<StaleRecoveryDayGroup, "leagueId" | "seasonId" | "kickoffDay">): string {
  return `${group.leagueId}|${group.seasonId}|${group.kickoffDay}`;
}

async function fetchCachedDateFixtures(
  dates: readonly string[],
  leagueId: string,
  seasonId: string,
  cache: Map<string, readonly ApiFootballFixture[]>,
  fetcher: (date: string) => Promise<readonly ApiFootballFixture[]>,
): Promise<ApiFootballFixture[]> {
  const fixtures: ApiFootballFixture[] = [];
  for (const date of dates) {
    const key = dateCacheKey(leagueId, seasonId, date);
    let rows = cache.get(key);
    if (rows === undefined) {
      rows = await fetcher(date);
      cache.set(key, rows);
    }
    fixtures.push(...rows);
  }
  return fixtures;
}

function collectCachedFixtures(
  dates: readonly string[],
  leagueId: string,
  seasonId: string,
  cache: ReadonlyMap<string, readonly ApiFootballFixture[]>,
): ApiFootballFixture[] {
  const fixtures: ApiFootballFixture[] = [];
  for (const date of dates) {
    const rows = cache.get(dateCacheKey(leagueId, seasonId, date));
    if (rows !== undefined) fixtures.push(...rows);
  }
  return fixtures;
}

function findContiguousLast(sortedCandidates: readonly Match[], processedIds: ReadonlySet<string>): Match | null {
  let contiguousLast: Match | null = null;
  for (const candidate of sortedCandidates) {
    if (!processedIds.has(candidate.match_id)) break;
    contiguousLast = candidate;
  }
  return contiguousLast;
}

export async function* loadStaleRecoveryBatches(
  repo: AppRepository,
  client: StaleRecoveryClient,
  serverNow: Date,
  providerLeagueRefs?: ProviderLeagueRefs,
  log: ((entry: Record<string, unknown>) => void) | undefined = client.log,
  options?: StaleRecoveryBatchOptions,
): AsyncGenerator<readonly ProviderFixtureBatchItem[]> {
  let activeAfter: ActiveWindowCursor | null = options?.after ?? null;
  let pendingGroupProgress: StaleRecoveryGroupProgress | null = options?.groupProgress ?? null;
  let query: ActiveWindowQuery = {
    jobType: "stale_recovery",
    now: serverNow,
    limit: STALE_RECOVERY_ROUND_CAP,
    ...(activeAfter === null ? {} : { after: activeAfter }),
  };
  let candidates = await repo.matches.findActiveWindow(query);
  if (candidates.length === 0 && activeAfter !== null) {
    // 游标越过队尾时同轮回卷到队首，避免浪费一轮空扫描
    activeAfter = null;
    pendingGroupProgress = null;
    query = { jobType: "stale_recovery", now: serverNow, limit: STALE_RECOVERY_ROUND_CAP };
    candidates = await repo.matches.findActiveWindow(query);
  }
  if (candidates.length === 0) {
    await options?.onCursorAdvance?.(null, null);
    return;
  }
  if (candidates.length === STALE_RECOVERY_ROUND_CAP) log?.({ event: "provider_stale_recovery_capped", cap: STALE_RECOVERY_ROUND_CAP });
  const sortedCandidates = [...candidates].sort(compareStaleCursorOrder);
  const candidateIds = new Set(candidates.map((match) => match.match_id));
  const processedIds = new Set<string>();
  const primaryCache = new Map<string, readonly ApiFootballFixture[]>();
  const secondaryCache = new Map<string, readonly ApiFootballFixture[]>();
  let secondaryExhausted = false;

  for (const group of groupStaleCandidates(sortedCandidates)) {
    const league = findSupportedLeagueById(group.leagueId);
    if (!league) {
      for (const match of group.matches) processedIds.add(match.match_id);
      continue;
    }
    const season = group.seasonId.split("_")[0]!;
    const groupMatchIds = new Set(group.matches.map((match) => match.match_id));
    const currentGroupKey = groupProgressKey(group);
    const allPrimaryDates = candidateDates(group.matches);
    const priorCompletedPrimaryDates =
      pendingGroupProgress !== null && pendingGroupProgress.group_key === currentGroupKey
        ? new Set(pendingGroupProgress.completed_primary_dates)
        : new Set<string>();
    pendingGroupProgress = null;
    let source: "primary" | "of" = "primary";
    let activePhaseDates = allPrimaryDates.filter((date) => !priorCompletedPrimaryDates.has(date));
    let activeTargetIds = groupMatchIds;
    let fetchingPhase: "primary" | "of" | null = null;
    try {
      fetchingPhase = "primary";
      const primaryFixtures = await fetchCachedDateFixtures(
        activePhaseDates,
        group.leagueId,
        group.seasonId,
        primaryCache,
        (date) => client.getFixtures({
          dateFrom: date,
          dateTo: date,
          leagueId: league.api_football_league_id,
          season,
          seasonId: group.seasonId,
          jobType: SyncJobType.StaleRecovery,
          serverNow,
        }),
      );
      fetchingPhase = null;
      const primaryItems = await fixturesToItems(
        repo,
        primaryFixtures,
        groupMatchIds,
        serverNow,
        providerLeagueRefs,
        group.seasonId,
      );
      if (primaryItems.length > 0) {
        yield primaryItems;
      }
      if (!client.getFixturesFromSource || secondaryExhausted) {
        for (const match of group.matches) processedIds.add(match.match_id);
        continue;
      }
      const remaining = (await repo.matches.findActiveWindow(query)).filter((match) =>
        groupMatchIds.has(match.match_id),
      );
      const remainingIds = new Set(remaining.map((match) => match.match_id));
      for (const match of group.matches) {
        if (!remainingIds.has(match.match_id)) processedIds.add(match.match_id);
      }
      if (remaining.length === 0) {
        continue;
      }
      source = "of";
      activePhaseDates = candidateDates(remaining);
      activeTargetIds = remainingIds;
      fetchingPhase = "of";
      const getFromSource = client.getFixturesFromSource.bind(client);
      const secondaryFixtures = await fetchCachedDateFixtures(
        activePhaseDates,
        group.leagueId,
        group.seasonId,
        secondaryCache,
        (date) => getFromSource("of", {
          dateFrom: date,
          dateTo: date,
          leagueId: league.api_football_league_id,
          season,
          seasonId: group.seasonId,
          jobType: SyncJobType.StaleRecovery,
          serverNow,
        }),
      );
      fetchingPhase = null;
      const secondaryItems = await fixturesToItems(
        repo,
        secondaryFixtures,
        remainingIds,
        serverNow,
        providerLeagueRefs,
        group.seasonId,
      );
      if (secondaryItems.length > 0) {
        yield secondaryItems;
      }
      for (const match of group.matches) processedIds.add(match.match_id);
    } catch (error) {
      const partialPhase = fetchingPhase;
      fetchingPhase = null;
      if (partialPhase !== null) {
        const activeCache = partialPhase === "of" ? secondaryCache : primaryCache;
        const partialFixtures = collectCachedFixtures(
          activePhaseDates,
          group.leagueId,
          group.seasonId,
          activeCache,
        );
        if (partialFixtures.length > 0) {
          const partialItems = await fixturesToItems(
            repo,
            partialFixtures,
            activeTargetIds,
            serverNow,
            providerLeagueRefs,
            group.seasonId,
          );
          if (partialItems.length > 0) {
            yield partialItems;
          }
        }
      }
      if (error instanceof ProviderBudgetDeniedError || error instanceof ProviderQuotaExceededError) {
        if (source === "of") {
          secondaryExhausted = true;
          log?.({
            event: "provider_stale_recovery_secondary_exhausted",
            league_id: group.leagueId,
            kickoff_day: group.kickoffDay,
          });
          for (const match of group.matches) processedIds.add(match.match_id);
          continue;
        }
        const activeMatches = await repo.matches.findActiveWindow(query);
        const activeIds = new Set(activeMatches.map((match) => match.match_id));
        for (const matchId of activeTargetIds) {
          if (!activeIds.has(matchId)) processedIds.add(matchId);
        }
        const remaining = activeMatches.filter((match) => candidateIds.has(match.match_id)).length;
        log?.({ event: "provider_stale_recovery_exhausted", remaining });
        const contiguousLast = findContiguousLast(sortedCandidates, processedIds);
        const hasUnprocessedInGroup = group.matches.some((match) => !processedIds.has(match.match_id));
        const shouldPersistGroupProgress =
          hasUnprocessedInGroup &&
          (contiguousLast === null ||
            group.matches.some((match) => match.match_id === contiguousLast.match_id));
        const completedPrimaryDates = shouldPersistGroupProgress
          ? allPrimaryDates.filter(
            (date) =>
              priorCompletedPrimaryDates.has(date) ||
              primaryCache.has(dateCacheKey(group.leagueId, group.seasonId, date)),
          )
          : [];
        const nextGroupProgress: StaleRecoveryGroupProgress | null =
          shouldPersistGroupProgress &&
          completedPrimaryDates.length > 0 &&
          completedPrimaryDates.length < allPrimaryDates.length
            ? { group_key: currentGroupKey, completed_primary_dates: completedPrimaryDates }
            : null;
        if (contiguousLast !== null) {
          await options?.onCursorAdvance?.(toStaleRecoveryCursor(contiguousLast), nextGroupProgress);
        } else if (nextGroupProgress !== null) {
          await options?.onCursorAdvance?.(activeAfter, nextGroupProgress);
        }
        return;
      }
      client.recordComparisonSkipped?.(
        source === "of" ? "of" : group.leagueId === "chinese_super_league" ? "bsd" : "fd",
        group.leagueId,
        error,
      );
      for (const match of group.matches) processedIds.add(match.match_id);
    }
  }
  const nextCursor = candidates.length >= STALE_RECOVERY_ROUND_CAP
    ? toStaleRecoveryCursor(sortedCandidates[sortedCandidates.length - 1]!)
    : null;
  await options?.onCursorAdvance?.(nextCursor, null);
}

export class ProviderStaleRecoveryService {
  private readonly fixtureJob: ProviderFixtureSyncJobService;
  private readonly schedulerState: Pick<
    SchedulerStateStore,
    "getStaleRecoveryCursor" | "upsertStaleRecoveryCursor"
  >;

  constructor(
    private readonly repo: AppRepository,
    private readonly client: StaleRecoveryClient,
    retryOptions: ProviderFixtureSyncRetryOptions = {},
    lockOptions: ProviderFixtureSyncLockOptions = {},
    private readonly providerLeagueRefs?: ProviderLeagueRefs,
    private readonly log?: (entry: Record<string, unknown>) => void,
    schedulerState: Pick<
      SchedulerStateStore,
      "getStaleRecoveryCursor" | "upsertStaleRecoveryCursor"
    > = new InMemorySchedulerStateStore(),
  ) {
    this.fixtureJob = new ProviderFixtureSyncJobService(repo, new ProviderFixtureSyncService(repo, undefined, providerLeagueRefs), retryOptions, lockOptions);
    this.schedulerState = schedulerState;
  }

  async run(serverNow: Date): Promise<ProviderFixtureSyncJobOutcome> {
    let pendingCursor: {
      hasUpdate: boolean;
      cursor: ActiveWindowCursor | null;
      groupProgress: StaleRecoveryGroupProgress | null;
    } = {
      hasUpdate: false,
      cursor: null,
      groupProgress: null,
    };
    const outcome = await this.fixtureJob.run(
      SyncJobType.StaleRecovery,
      (now) => this.loadRoundBatches(now, (nextCursor, nextGroupProgress = null) => {
        pendingCursor = {
          hasUpdate: true,
          cursor: nextCursor,
          groupProgress: nextGroupProgress,
        };
      }),
      serverNow,
    );
    if (outcome.kind === "completed" && pendingCursor.hasUpdate) {
      await this.schedulerState.upsertStaleRecoveryCursor({
        cursor_kickoff_at: pendingCursor.cursor?.kickoff_at ?? null,
        cursor_match_id: pendingCursor.cursor?.match_id ?? null,
        ...(pendingCursor.groupProgress === null ? {} : { group_progress: pendingCursor.groupProgress }),
        last_run_at: serverNow,
        updated_at: serverNow,
      });
    }
    return outcome;
  }

  private async *loadRoundBatches(
    serverNow: Date,
    onCursorAdvance: (
      nextCursor: ActiveWindowCursor | null,
      nextGroupProgress?: StaleRecoveryGroupProgress | null,
    ) => void,
  ): AsyncGenerator<readonly ProviderFixtureBatchItem[]> {
    const saved = await this.schedulerState.getStaleRecoveryCursor();
    const after =
      saved?.cursor_kickoff_at != null && saved.cursor_match_id != null
        ? { kickoff_at: saved.cursor_kickoff_at, match_id: saved.cursor_match_id }
        : null;
    const groupProgress = saved?.group_progress ?? null;
    yield* loadStaleRecoveryBatches(
      this.repo,
      this.client,
      serverNow,
      this.providerLeagueRefs,
      this.log ?? this.client.log,
      { after, groupProgress, onCursorAdvance },
    );
  }
}
