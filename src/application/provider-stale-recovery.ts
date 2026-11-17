import { findSupportedLeagueById, SUPPORTED_LEAGUES, type ProviderLeagueRefs } from "../domain/config.js";
import { SyncJobType } from "../domain/enums.js";
import type { Match } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { ProviderBudgetDeniedError } from "../provider/budget.js";
import { ProviderQuotaExceededError } from "../provider/http.js";
import type { ApiFootballFixture } from "../provider/types.js";
import { ProviderFixtureSyncService } from "./provider-fixture-sync.js";
import { ProviderFixtureSyncJobService, type ProviderFixtureBatchItem, type ProviderFixtureSyncJobOutcome, type ProviderFixtureSyncLockOptions, type ProviderFixtureSyncRetryOptions } from "./provider-sync-job.js";
import { fixturesToItems, type ProviderWindowFixtureClient } from "./provider-window-loader.js";

export const STALE_RECOVERY_ROUND_CAP = 10;
const DAY_MS = 24 * 60 * 60_000;

type StaleRecoveryClient = ProviderWindowFixtureClient & { log?: (entry: Record<string, unknown>) => void };

function candidateDates(matches: readonly Match[]): string[] {
  return [...new Set(matches.flatMap((match) => {
    const day = match.kickoff_at.toISOString().slice(0, 10);
    return [day, new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10)];
  }))].sort();
}

export async function* loadStaleRecoveryBatches(
  repo: AppRepository,
  client: StaleRecoveryClient,
  serverNow: Date,
  providerLeagueRefs?: ProviderLeagueRefs,
  log: ((entry: Record<string, unknown>) => void) | undefined = client.log,
): AsyncGenerator<readonly ProviderFixtureBatchItem[]> {
  const query = { jobType: "stale_recovery" as const, now: serverNow, limit: STALE_RECOVERY_ROUND_CAP };
  const candidates = await repo.matches.findActiveWindow(query);
  if (candidates.length === 0) return;
  if (candidates.length === STALE_RECOVERY_ROUND_CAP) log?.({ event: "provider_stale_recovery_capped", cap: STALE_RECOVERY_ROUND_CAP });
  const candidateIds = new Set(candidates.map((match) => match.match_id));
  const leagueIds = SUPPORTED_LEAGUES.map((league) => league.league_id).filter((id) => candidates.some((match) => match.league_id === id));
  const orderedIds = client.orderLeagues ? await client.orderLeagues(leagueIds, SyncJobType.StaleRecovery, serverNow) : leagueIds;
  for (const leagueId of orderedIds) {
    const league = findSupportedLeagueById(leagueId);
    if (!league) continue;
    const leagueMatches = candidates.filter((match) => match.league_id === leagueId);
    const seasonIds = [...new Set(leagueMatches.map((match) => match.season_id))];
    for (const seasonId of seasonIds) {
      const matches = leagueMatches.filter((match) => match.season_id === seasonId);
      const season = seasonId.split("_")[0]!;
      let source: "primary" | "of" = "primary";
      try {
        const fixtures: ApiFootballFixture[] = [];
        for (const date of candidateDates(matches)) {
          fixtures.push(...await client.getFixtures({ dateFrom: date, dateTo: date, leagueId: league.api_football_league_id, season, seasonId, jobType: SyncJobType.StaleRecovery, serverNow }));
        }
        yield await fixturesToItems(repo, fixtures, new Set(matches.map((match) => match.match_id)), serverNow, providerLeagueRefs, seasonId);
        if (!client.getFixturesFromSource) continue;
        const remaining = (await repo.matches.findActiveWindow(query)).filter((match) => match.league_id === leagueId && match.season_id === seasonId && candidateIds.has(match.match_id));
        if (remaining.length === 0) continue;
        source = "of";
        const secondary: ApiFootballFixture[] = [];
        for (const date of candidateDates(remaining)) {
          secondary.push(...await client.getFixturesFromSource("of", { dateFrom: date, dateTo: date, leagueId: league.api_football_league_id, season, seasonId, jobType: SyncJobType.StaleRecovery, serverNow }));
        }
        yield await fixturesToItems(repo, secondary, new Set(remaining.map((match) => match.match_id)), serverNow, providerLeagueRefs, seasonId);
      } catch (error) {
        if (error instanceof ProviderBudgetDeniedError || error instanceof ProviderQuotaExceededError) {
          const remaining = (await repo.matches.findActiveWindow(query)).filter((match) => candidateIds.has(match.match_id)).length;
          log?.({ event: "provider_stale_recovery_exhausted", remaining });
          return;
        }
        client.recordComparisonSkipped?.(source === "of" ? "of" : leagueId === "chinese_super_league" ? "bsd" : "fd", leagueId, error);
      }
    }
  }
}

export class ProviderStaleRecoveryService {
  private readonly fixtureJob: ProviderFixtureSyncJobService;

  constructor(
    private readonly repo: AppRepository,
    private readonly client: StaleRecoveryClient,
    retryOptions: ProviderFixtureSyncRetryOptions = {},
    lockOptions: ProviderFixtureSyncLockOptions = {},
    private readonly providerLeagueRefs?: ProviderLeagueRefs,
    private readonly log?: (entry: Record<string, unknown>) => void,
  ) {
    this.fixtureJob = new ProviderFixtureSyncJobService(repo, new ProviderFixtureSyncService(repo, undefined, providerLeagueRefs), retryOptions, lockOptions);
  }

  run(serverNow: Date): Promise<ProviderFixtureSyncJobOutcome> {
    return this.fixtureJob.run(SyncJobType.StaleRecovery, (now) => loadStaleRecoveryBatches(this.repo, this.client, now, this.providerLeagueRefs, this.log ?? this.client.log), serverNow);
  }
}
