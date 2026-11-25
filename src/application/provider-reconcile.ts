import { SCHEMA_VERSION, SyncJobStatus, SyncJobType } from "../domain/enums.js";
import { FIXED_CONFIG_V1, SUPPORTED_LEAGUES, type ProviderLeagueRefs } from "../domain/config.js";
import { newUuid } from "../domain/ids.js";
import type { ProviderReconcileTodo, ProviderSnapshot, SyncLog } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import type { ApiFootballFixturesQuery } from "../provider/http.js";
import type { ApiFootballFixture } from "../provider/types.js";
import type { ProviderSourceId } from "../provider/sources.js";
import { normalizeFixture } from "../provider/fixture-mapper.js";
import { ensureCrossSourceMatchMapping } from "./provider-cross-source.js";
import { resolveEffectiveMatch } from "./match-identity.js";
import { startJobLockRenewal, type JobLockRenewalOptions } from "./provider-sync-job.js";
import { persistAnomalyInTransaction } from "./anomaly-persistence.js";
import { AnomalyType } from "../domain/enums.js";
import { ProviderBudgetDeniedError } from "../provider/budget.js";
import { ProviderError, ProviderQuotaExceededError } from "../provider/http.js";

const DAY_MS = 24 * 60 * 60_000;
const RECONCILE_LOOKBACK_DAYS = 3;

export interface ProviderReconcileClient {
  getFixturesFromSource(sourceId: ProviderSourceId, query: ApiFootballFixturesQuery): Promise<readonly ApiFootballFixture[]>;
}

export type ProviderReconcileOutcome =
  | { kind: "completed"; items_read: number; conflicts: number; skipped: number }
  | { kind: "skipped"; reason: "lock_held" };

export class ProviderReconcileService {
  constructor(
    private readonly repo: AppRepository,
    private readonly client: ProviderReconcileClient,
    private readonly providerLeagueRefs?: ProviderLeagueRefs,
    private readonly lockOptions: { renewal?: JobLockRenewalOptions } = {},
  ) {}

  async run(serverNow: Date): Promise<ProviderReconcileOutcome> {
    const ownerId = newUuid();
    const lockKey = "sync:provider_reconcile";
    const leaseMs = this.lockOptions.renewal?.leaseMs ?? FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60_000;
    const nowClock = this.lockOptions.renewal?.now ?? (() => Math.max(Date.now(), serverNow.getTime()));
    const lockUntil = new Date(nowClock() + leaseMs);
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
    const lockRenewal = startJobLockRenewal(this.repo, lockKey, ownerId, {
      ...this.lockOptions.renewal,
      leaseMs,
      now: nowClock,
    });
    try {
      await lockRenewal.assertHeld();
      await syncLogs?.insert(log);
      const outcome = await this.reconcile(serverNow, lockRenewal.assertHeld);
      await lockRenewal.assertHeld();
      await syncLogs?.update({ ...log, status: SyncJobStatus.Success, finished_at: serverNow, items_read: outcome.items_read, items_failed: outcome.conflicts });
      return outcome;
    } catch (error) {
      const stillHeld = await lockRenewal.assertHeld().then(() => true, () => false);
      if (stillHeld) {
        await syncLogs?.update({
          ...log,
          status: SyncJobStatus.Failed,
          finished_at: serverNow,
          last_error_code: "PROVIDER_RECONCILE_FAILED",
          last_error_message: error instanceof Error ? error.message : "provider reconcile failed",
        });
      }
      throw error;
    } finally {
      lockRenewal.stop();
      await this.repo.jobLocks.release(lockKey, ownerId);
    }
  }

  private async reconcile(
    serverNow: Date,
    assertHeld: () => Promise<void>,
  ): Promise<Extract<ProviderReconcileOutcome, { kind: "completed" }>> {
    const todoRepo = this.repo.providerReconcileTodos;
    if (!todoRepo) throw new Error("provider reconcile todo repository unavailable");
    let itemsRead = 0;
    let conflicts = 0;
    let skipped = 0;
    for (let daysAgo = 1; daysAgo <= RECONCILE_LOOKBACK_DAYS; daysAgo += 1) {
      await assertHeld();
      const day = new Date(serverNow.getTime() - daysAgo * DAY_MS).toISOString().slice(0, 10);
      for (const match of await this.repo.matches.findFinishedSettledOnDay(day)) {
        if (SUPPORTED_LEAGUES.some((league) => league.league_id === match.league_id)) {
          const sourceId = match.league_id === "chinese_super_league" ? "sp" : "of";
          await todoRepo.upsert({
            todo_id: newUuid(), match_id: match.match_id, canonical_match_id: match.canonical_match_id,
            league_id: match.league_id, season_id: match.season_id, source_id: sourceId,
            target_result_version: match.result_version, kickoff_at: match.kickoff_at, status: "pending", attempts: 0,
            last_error_code: null, last_attempt_at: null, completed_at: null, created_at: serverNow, updated_at: serverNow,
            schema_version: SCHEMA_VERSION,
          });
        }
      }
    }
    const todos: ProviderReconcileTodo[] = [];
    for (;;) {
      const page = await todoRepo.findPending(100, todos.length);
      todos.push(...page);
      if (page.length < 100) break;
    }
    const groups = new Map<string, ProviderReconcileTodo[]>();
    for (const todo of todos) {
      const key = JSON.stringify([todo.source_id, todo.league_id, todo.season_id, todo.kickoff_at.toISOString().slice(0, 10)]);
      const group = groups.get(key) ?? [];
      group.push(todo);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      await assertHeld();
      const first = group[0]!;
      const league = SUPPORTED_LEAGUES.find((row) => row.league_id === first.league_id);
      if (!league) {
        for (const todo of group) await todoRepo.recordFailure(todo.todo_id, "LEAGUE_NOT_FOUND", serverNow);
        skipped += group.length;
        continue;
      }
      const sourceProvider = first.source_id === "sp" ? "sportapi" : "openfoot";
      const day = first.kickoff_at.toISOString().slice(0, 10);
      const season = first.season_id.split("_")[0]!;
      let fixtures: readonly ApiFootballFixture[];
      try {
        fixtures = await this.client.getFixturesFromSource(first.source_id, {
          dateFrom: day,
          dateTo: day,
          leagueId: league.api_football_league_id,
          season,
          seasonId: first.season_id,
          jobType: SyncJobType.ProviderReconcile,
          serverNow,
        });
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : "PROVIDER_REQUEST_FAILED";
        for (const todo of group) await todoRepo.recordFailure(todo.todo_id, code, serverNow);
        skipped += group.length;
        if (error instanceof ProviderBudgetDeniedError || error instanceof ProviderQuotaExceededError) break;
        continue;
      }
      const remaining = new Map(group.map((todo) => [todo.todo_id, todo]));
      let mappingFailed = false;
      for (const fixture of fixtures) {
        const normalized = normalizeFixture(fixture, this.providerLeagueRefs, serverNow, first.season_id);
        if (normalized.entityFailed || normalized.fixture.fulltime === null || normalized.fixture.provider !== sourceProvider) continue;
        const mapping = await ensureCrossSourceMatchMapping(
          this.repo,
          normalized.fixture,
          serverNow,
          new Set(group.map((todo) => todo.match_id)),
          this.providerLeagueRefs,
          first.season_id,
        );
        if (!mapping.match_id) { mappingFailed = true; continue; }
        const matchedTodos = [...remaining.values()].filter((todo) => todo.match_id === mapping.match_id);
        if (matchedTodos.length === 0) continue;
        const match = await resolveEffectiveMatch(this.repo, mapping.match_id);
        if (!match) continue;
        itemsRead += 1;
        if (match.regular_home_score === normalized.fixture.fulltime.home && match.regular_away_score === normalized.fixture.fulltime.away) {
          for (const todo of matchedTodos) {
            await todoRepo.markDone(todo.todo_id, serverNow);
            remaining.delete(todo.todo_id);
          }
          continue;
        }
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
        for (const todo of matchedTodos) {
          await todoRepo.markDone(todo.todo_id, serverNow);
          remaining.delete(todo.todo_id);
        }
      }
      for (const todo of remaining.values()) await todoRepo.recordFailure(todo.todo_id, mappingFailed ? "MATCH_MAPPING_UNRESOLVED" : "MATCH_NOT_OBSERVED", serverNow);
      skipped += remaining.size;
    }
    return { kind: "completed", items_read: itemsRead, conflicts, skipped };
  }
}
