import { MatchStatus, SCHEMA_VERSION, SettlementStatus, SyncJobStatus, SyncJobType } from "../domain/enums.js";
import { SUPPORTED_LEAGUES } from "../domain/config.js";
import { newUuid } from "../domain/ids.js";
import type { ProviderSnapshot, SyncLog } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import type { ApiFootballFixturesQuery } from "../provider/http.js";
import type { ApiFootballFixture } from "../provider/types.js";
import type { ProviderSourceId } from "../provider/sources.js";
import { normalizeFixture } from "../provider/fixture-mapper.js";
import { ensureCrossSourceMatchMapping } from "./provider-cross-source.js";
import { persistAnomalyInTransaction } from "./anomaly-persistence.js";
import { AnomalyType } from "../domain/enums.js";

export interface ProviderReconcileClient {
  getFixturesFromSource(sourceId: ProviderSourceId, query: ApiFootballFixturesQuery): Promise<readonly ApiFootballFixture[]>;
}

export type ProviderReconcileOutcome =
  | { kind: "completed"; items_read: number; conflicts: number; skipped: number }
  | { kind: "skipped"; reason: "lock_held" };

export class ProviderReconcileService {
  constructor(private readonly repo: AppRepository, private readonly client: ProviderReconcileClient) {}

  async run(serverNow: Date): Promise<ProviderReconcileOutcome> {
    const ownerId = newUuid();
    const lockKey = "sync:provider_reconcile";
    const lockUntil = new Date(serverNow.getTime() + 10 * 60_000);
    if (!await this.repo.jobLocks.acquire(lockKey, ownerId, lockUntil)) return { kind: "skipped", reason: "lock_held" };
    const syncLogs = this.repo.syncLogs;
    const log: SyncLog = {
      schema_version: SCHEMA_VERSION,
      sync_job_id: newUuid(),
      job_type: SyncJobType.ProviderReconcile,
      status: SyncJobStatus.Running,
      started_at: serverNow,
      finished_at: null,
      attempt_count: 1,
      items_read: 0,
      items_changed: 0,
      items_failed: 0,
      last_error_code: null,
      last_error_message: null,
      created_at: serverNow,
    };
    try {
      await syncLogs?.insert(log);
      const outcome = await this.reconcile(serverNow);
      await syncLogs?.update({ ...log, status: SyncJobStatus.Success, finished_at: serverNow, items_read: outcome.items_read, items_failed: outcome.conflicts });
      return outcome;
    } catch (error) {
      await syncLogs?.update({
        ...log,
        status: SyncJobStatus.Failed,
        finished_at: serverNow,
        last_error_code: "PROVIDER_RECONCILE_FAILED",
        last_error_message: error instanceof Error ? error.message : "provider reconcile failed",
      });
      throw error;
    } finally {
      await this.repo.jobLocks.release(lockKey, ownerId);
    }
  }

  private async reconcile(serverNow: Date): Promise<Extract<ProviderReconcileOutcome, { kind: "completed" }>> {
    const yesterday = new Date(serverNow.getTime() - 24 * 60 * 60_000).toISOString().slice(0, 10);
    let itemsRead = 0;
    let conflicts = 0;
    let skipped = 0;
    for (const league of SUPPORTED_LEAGUES) {
      const sourceId: ProviderSourceId = league.league_id === "chinese_super_league" ? "sp" : "of";
      const sourceProvider = sourceId === "sp" ? "sportapi" : "openfoot";
      const matches = (await this.repo.matches.findBySeason(league.season_id)).filter((match) =>
        match.league_id === league.league_id &&
        match.settlement_status === SettlementStatus.Settled &&
        match.match_status === MatchStatus.Finished &&
        match.kickoff_at.toISOString().slice(0, 10) === yesterday,
      );
      if (matches.length === 0) continue;
      let fixtures: readonly ApiFootballFixture[];
      try {
        fixtures = await this.client.getFixturesFromSource(sourceId, {
          dateFrom: yesterday,
          dateTo: yesterday,
          leagueId: league.api_football_league_id,
          season: league.api_football_season,
          jobType: SyncJobType.FullScheduleVerify,
          serverNow,
        });
      } catch {
        skipped += matches.length;
        continue;
      }
      for (const fixture of fixtures) {
        const normalized = normalizeFixture(fixture);
        if (normalized.entityFailed || normalized.fixture.fulltime === null) continue;
        const mapping = await ensureCrossSourceMatchMapping(this.repo, normalized.fixture, serverNow, new Set(matches.map((match) => match.match_id)));
        if (!mapping.match_id) continue;
        const match = matches.find((candidate) => candidate.match_id === mapping.match_id);
        if (!match) continue;
        itemsRead += 1;
        if (match.regular_home_score === normalized.fixture.fulltime.home && match.regular_away_score === normalized.fixture.fulltime.away) continue;
        conflicts += 1;
        const snapshot: ProviderSnapshot = {
          schema_version: SCHEMA_VERSION,
          snapshot_id: newUuid(),
          provider: sourceProvider,
          entity_type: "match",
          entity_id: match.match_id,
          provider_entity_id: normalized.fixture.providerMatchId,
          event_type: "provider_conflict",
          payload: {
            diag_code: "DIAG_PROVIDER_RESULT_CONFLICT",
            reconcile_only: true,
            stored_score: { home: match.regular_home_score, away: match.regular_away_score },
            observed_score: normalized.fixture.fulltime,
          },
          created_at: serverNow,
        };
        await this.repo.providerSnapshots?.insert(snapshot);
        await this.repo.withTransaction(async (tx) => {
          await persistAnomalyInTransaction(tx, match.match_id, AnomalyType.ProviderResultConflict, { open: true, blocking: false }, {
            reconcile_only: true,
            provider: sourceProvider,
            provider_match_id: normalized.fixture.providerMatchId,
            stored_score: { home: match.regular_home_score, away: match.regular_away_score },
            observed_score: normalized.fixture.fulltime,
          }, serverNow);
        });
      }
    }
    return { kind: "completed", items_read: itemsRead, conflicts, skipped };
  }
}
