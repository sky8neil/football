import {
  AnomalyType,
  MatchStatus,
  Provider,
  SCHEMA_VERSION,
  SettlementStatus,
} from "../domain/enums.js";
import { internalError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import { validateMatchTransition } from "../domain/match-state-machine.js";
import type { ProviderSnapshot } from "../domain/types.js";
import type { ApiFootballFixture } from "../provider/types.js";
import { normalizeFixture, type MapperAnomaly, type NormalizedFixture } from "../provider/fixture-mapper.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";
import {
  ProviderResultSyncService,
  type ProviderResultSyncOutcome,
} from "./provider-result-sync.js";
import {
  ProviderStatusSyncService,
  type ProviderTeamChangeOutcome,
  type ProviderStatusSyncOutcome,
} from "./provider-status-sync.js";
import { ProviderScheduleSyncService } from "./provider-schedule-sync.js";import { transitionMatchSettlementStatus } from "./first-settlement-service.js";
import { persistAnomalyInTransaction } from "./anomaly-persistence.js";
import { AnomalyEvaluationService } from "./anomaly-evaluation.js";
import { assertValidServerNow } from "./period-finalize.js";
import { ensureCrossSourceMatchMapping } from "./provider-cross-source.js";
import { decideProviderResultAdoption, type ProviderResultObservation } from "./provider-result-adoption.js";

export interface ProviderFixtureFailure {
  kind: "failed";
  match_id: string | null;
  anomaly_types: AnomalyType[];
}

export type ProviderFixtureSyncOutcome =
  | ProviderStatusSyncOutcome
  | ProviderTeamChangeOutcome
  | ProviderResultSyncOutcome
  | ProviderFixtureFailure;

type MapperFailureUnitOfWork = UnitOfWork & {
  matchProviderMappings: NonNullable<UnitOfWork["matchProviderMappings"]>;
  providerSnapshots: NonNullable<UnitOfWork["providerSnapshots"]>;
  anomalies: NonNullable<UnitOfWork["anomalies"]>;
};

function requireMapperFailurePorts(tx: UnitOfWork): asserts tx is MapperFailureUnitOfWork {
  if (
    tx.matchProviderMappings === undefined ||
    tx.providerSnapshots === undefined ||
    tx.anomalies === undefined
  ) {
    throw internalError("Provider fixture 同步缺少 mapping/snapshot/anomaly repository port");
  }
}

function groupedAnomalies(anomalies: readonly MapperAnomaly[]): MapperAnomaly[] {
  const grouped = new Map<AnomalyType, MapperAnomaly>();
  for (const anomaly of anomalies) {
    const current = grouped.get(anomaly.type);
    if (current === undefined) {
      grouped.set(anomaly.type, { ...anomaly });
      continue;
    }
    grouped.set(anomaly.type, {
      type: anomaly.type,
      blocking: current.blocking || anomaly.blocking,
      details: {
        observations: [current.details, anomaly.details],
      },
    });
  }
  return [...grouped.values()];
}

function anomalyDetails(
  providerMatchId: string,
  rawStatus: string | null,
  mapperAnomaly: MapperAnomaly,
): Record<string, unknown> {
  return {
    provider_match_id: providerMatchId,
    provider_status: rawStatus,
    ...mapperAnomaly.details,
  };
}

/** 将 mapper 的 fail-closed 结果写入快照与既有 match anomaly。 */
async function persistMapperFailure(
  repo: AppRepository,
  providerMatchId: string,
  rawStatus: string | null,
  anomalies: readonly MapperAnomaly[],
  payload: Record<string, unknown>,
  serverNow: Date,
  provider: NormalizedFixture["provider"] = Provider.ApiFootball,
): Promise<ProviderFixtureFailure> {
  return repo.withTransaction(async (tx) => {
    requireMapperFailurePorts(tx);
    const mapping = await tx.matchProviderMappings.findByProviderAndExternalId(
      provider,
      providerMatchId,
    );
    if (mapping !== null && (await tx.matches.findById(mapping.match_id)) === null) {
      throw internalError("Provider match mapping 指向不存在的 match");
    }

    const snapshot: ProviderSnapshot = {
      schema_version: SCHEMA_VERSION,
      snapshot_id: newUuid(),
      provider,
      entity_type: "match",
      entity_id: mapping?.match_id ?? null,
      provider_entity_id: providerMatchId,
      event_type: "provider_error",
      payload,
      created_at: serverNow,
    };
    await tx.providerSnapshots.insert(snapshot);

    const uniqueAnomalies = groupedAnomalies(anomalies);
    if (mapping !== null) {
      for (const anomaly of uniqueAnomalies) {
        await persistAnomalyInTransaction(
          tx,
          mapping.match_id,
          anomaly.type,
          { open: true, blocking: anomaly.blocking },
          anomalyDetails(providerMatchId, rawStatus, anomaly),
          serverNow,
        );
      }

      // P0-2（33.3）：首次观察到 finished（FT）但无合法分时，只要状态机允许就把
      // match 标记为 finished + finish_detected_at，不写比分/result_version，
      // 使 FINISHED_NO_SCORE 的时间谓词（finish_detected_at + 20min）可被触发。
      // 与合法 FT 路径对齐：首次 finished 时补 period_anchor_at / prediction_closed_at。
      if (uniqueAnomalies.some((anomaly) => anomaly.type === AnomalyType.InvalidFinalScore)) {
        const match = await tx.matches.findById(mapping.match_id);
        if (
          match !== null &&
          validateMatchTransition(match.match_status, MatchStatus.Finished)
        ) {
          await tx.matches.update({
            ...match,
            match_status: MatchStatus.Finished,
            finish_detected_at: match.finish_detected_at ?? serverNow,
            period_anchor_at: match.period_anchor_at ?? match.kickoff_at,
            prediction_closed_at: match.prediction_closed_at ?? serverNow,
            updated_at: serverNow,
          });

          // C-P1（13.2）：首次 finished 即使无合法分也要经状态机入口 pending -> waiting；
          // 不写比分、不升 result_version；已 waiting 时 transition 内部 no-op。
          const reloaded = await tx.matches.findById(match.match_id);
          if (reloaded !== null && reloaded.settlement_status === SettlementStatus.Pending) {
            await transitionMatchSettlementStatus(
              tx,
              match.match_id,
              SettlementStatus.Waiting,
              serverNow,
            );
          }
        }
      }
    }

    return {
      kind: "failed",
      match_id: mapping?.match_id ?? null,
      anomaly_types: uniqueAnomalies.map((anomaly) => anomaly.type),
    };
  });
}

/** 读取该 match 最近一次成功 Provider 同步时间（方案 A：复用 provider_snapshots）。 */
async function readLastSuccessfulSyncAt(
  repo: AppRepository,
  matchId: string,
): Promise<Date | null> {
  const snapshots = repo.providerSnapshots;
  if (snapshots === undefined) {
    return null;
  }
  const latest = await snapshots.findLatestSuccessByEntity("match", matchId);
  return latest?.created_at ?? null;
}

/** 单 fixture 的 Provider application 入口；不负责 HTTP、调度或真实凭证。 */
export class ProviderFixtureSyncService {
  private readonly statusSync: ProviderStatusSyncService;
  private readonly resultSync: ProviderResultSyncService;
  private readonly scheduleSync: ProviderScheduleSyncService;
  private readonly anomalyEvaluation: AnomalyEvaluationService;

  constructor(
    private readonly repo: AppRepository,
    anomalyEvaluation?: AnomalyEvaluationService,
  ) {
    this.statusSync = new ProviderStatusSyncService(repo);
    this.resultSync = new ProviderResultSyncService(repo);
    this.scheduleSync = new ProviderScheduleSyncService(repo);
    this.anomalyEvaluation = anomalyEvaluation ?? new AnomalyEvaluationService(repo);
  }

  /**
   * P0-1（33.1）通用入口：成功/unchanged 刷新最近成功同步时间后 evaluate；
   * failed/conflict（带 match_id）不刷新，用仓储旧值（或 null）评估，使
   * LIVE_SYNC_STALE 在连续 10 分钟无成功同步时 open、恢复成功后 resolve。
   * 禁止继续把 lastSuccessfulSyncAt 一律传 serverNow。
   */
  private async evaluateAfterFixture(
    outcome: ProviderFixtureSyncOutcome,
    providerMatchId: string,
    provider: NormalizedFixture["provider"],
    serverNow: Date,
  ): Promise<void> {
    const matchId = outcome.match_id;
    if (matchId === null) {
      return;
    }

    if (outcome.kind !== "failed" && outcome.kind !== "conflict") {
      await this.markSuccessfulProviderSync(matchId, providerMatchId, provider, serverNow);
      await this.repo.withTransaction(async (tx) => {
        await persistAnomalyInTransaction(
          tx,
          matchId,
          AnomalyType.ProviderDataInvalid,
          {
            open: false,
            blocking: true,
            resolve: {
              resolution: "provider data valid",
              resolvedAt: serverNow,
            },
          },
          {},
          serverNow,
        );
      });
    }

    const lastOk = await readLastSuccessfulSyncAt(this.repo, matchId);
    await this.anomalyEvaluation.evaluate(matchId, lastOk, serverNow);
  }

  /** 成功 apply 后写入一条成功类 snapshot，作为该 match 的最近成功同步时间事实。 */
  private async markSuccessfulProviderSync(
    matchId: string,
    providerMatchId: string,
    provider: NormalizedFixture["provider"],
    serverNow: Date,
  ): Promise<void> {
    const snapshots = this.repo.providerSnapshots;
    if (snapshots === undefined) {
      return;
    }
    await snapshots.insert({
      schema_version: SCHEMA_VERSION,
      snapshot_id: newUuid(),
      provider: provider ?? Provider.ApiFootball,
      entity_type: "match",
      entity_id: matchId,
      provider_entity_id: providerMatchId,
      // 复用既有成功类 event_type 作为同步成功标记（provider_snapshots event_type 枚举冻结）。
      event_type: "status_changed",
      payload: { sync: "success" },
      created_at: serverNow,
    });
  }

  /**
   * 33.1 job 级 live 巡检：对库内仍为 live 的 match 用最近成功同步时间评估 stale，
   * 覆盖"Provider 不再返回该场"时本批未触达的 match。返回被巡检的 live 场次数。
   */
  async patrolLiveMatches(serverNow: Date): Promise<number> {
    const liveMatches = await this.repo.matches.findLive();
    for (const match of liveMatches) {
      const lastOk = await readLastSuccessfulSyncAt(this.repo, match.match_id);
      await this.anomalyEvaluation.evaluate(match.match_id, lastOk, serverNow);
    }
    return liveMatches.length;
  }

  private async applyMappedTeamChange(
    fixture: ReturnType<typeof normalizeFixture>["fixture"],
    payload: Record<string, unknown>,
    serverNow: Date,
  ): Promise<ProviderTeamChangeOutcome | null> {
    const mappings = this.repo.teamProviderMappings;
    if (mappings === undefined) {
      return null;
    }

    const [homeMapping, awayMapping] = await Promise.all([
      mappings.findByProviderAndExternalId(fixture.provider ?? Provider.ApiFootball, fixture.homeTeamProviderId),
      mappings.findByProviderAndExternalId(fixture.provider ?? Provider.ApiFootball, fixture.awayTeamProviderId),
    ]);
    if (homeMapping === null || awayMapping === null) {
      return null;
    }

    return this.statusSync.applyTeamChange(fixture, payload, serverNow);
  }

  async applyFixture(
    rawFixture: ApiFootballFixture,
    payload: Record<string, unknown>,
    serverNow: Date,
  ): Promise<ProviderFixtureSyncOutcome> {
    assertValidServerNow(serverNow);
    const normalized = normalizeFixture(rawFixture);
    if (normalized.entityFailed) {
      const outcome = await persistMapperFailure(
        this.repo,
        normalized.fixture.providerMatchId,
        normalized.fixture.rawStatus,
        normalized.anomalies,
        payload,
        serverNow,
        normalized.fixture.provider,
      );
      await this.evaluateAfterFixture(
        outcome,
        normalized.fixture.providerMatchId,
        normalized.fixture.provider,
        serverNow,
      );
      return outcome;
    }

    if (["5dollar", "openfoot", "sportapi"].includes(normalized.fixture.provider ?? "")) {
      const mapping = await ensureCrossSourceMatchMapping(this.repo, normalized.fixture, serverNow);
      if (mapping.match_id === null) {
        return { kind: "failed", match_id: null, anomaly_types: [AnomalyType.ProviderDataInvalid] };
      }
    }

    if (normalized.fixture.status.kind === MatchStatus.Scheduled) {
      const mappings = this.repo.matchProviderMappings;
      if (mappings !== undefined) {
        const existing = await mappings.findByProviderAndExternalId(
          normalized.fixture.provider ?? Provider.ApiFootball,
          normalized.fixture.providerMatchId,
        );
        if (existing === null) {
          const outcome = await this.scheduleSync.discover(
            normalized.fixture,
            payload,
            serverNow,
          );
          await this.evaluateAfterFixture(
            outcome,
            normalized.fixture.providerMatchId,
            normalized.fixture.provider,
            serverNow,
          );
          return outcome;
        }
      }
    }

    const teamChange = await this.applyMappedTeamChange(
      normalized.fixture,
      payload,
      serverNow,
    );
    if (teamChange?.kind === "conflict") {
      await this.evaluateAfterFixture(
        teamChange,
        normalized.fixture.providerMatchId,
        normalized.fixture.provider,
        serverNow,
      );
      return teamChange;
    }

    const outcome = await (async (): Promise<ProviderFixtureSyncOutcome> => {
      switch (normalized.fixture.status.kind) {
      case MatchStatus.Scheduled:
        return this.statusSync.applyScheduledFixture(
          normalized.fixture,
          payload,
          serverNow,
        );
      case MatchStatus.Postponed:
        return this.statusSync.applyPostponedFixture(
          normalized.fixture,
          payload,
          serverNow,
        );
      case MatchStatus.Live:
        return this.statusSync.applyLiveFixture(normalized.fixture, payload, serverNow);
      case MatchStatus.Cancelled:
        return this.statusSync.applyCancelledFixture(
          normalized.fixture,
          payload,
          serverNow,
        );
      case MatchStatus.Abandoned:
        return this.statusSync.applyAbandonedFixture(
          normalized.fixture,
          payload,
          serverNow,
        );
      case MatchStatus.Finished:
        return this.applyAdoptableResult(normalized.fixture, payload, serverNow);
      default:
        throw internalError("Provider fixture 状态未通过 mapper 校验");
      }
    })();
    await this.evaluateAfterFixture(
      outcome,
      normalized.fixture.providerMatchId,
      normalized.fixture.provider,
      serverNow,
    );
    return outcome;
  }

  private async applyAdoptableResult(
    fixture: NormalizedFixture,
    payload: Record<string, unknown>,
    serverNow: Date,
  ): Promise<ProviderResultSyncOutcome | ProviderFixtureFailure> {
    const provider = (fixture.provider ?? Provider.ApiFootball) as Provider;
    const matchMapping = await this.repo.matchProviderMappings?.findByProviderAndExternalId(provider, fixture.providerMatchId);
    if (!matchMapping) return { kind: "failed", match_id: null, anomaly_types: [AnomalyType.ProviderDataInvalid] };
    const match = await this.repo.matches.findById(matchMapping.match_id);
    if (!match) return { kind: "failed", match_id: matchMapping.match_id, anomaly_types: [AnomalyType.ProviderDataInvalid] };
    const observation = toResultObservation(fixture, provider, serverNow);
    await this.persistResultObservation(match.match_id, fixture.providerMatchId, observation, serverNow);
    const snapshots = await this.repo.providerSnapshots?.findByEntity("match", match.match_id) ?? [];
    const observations = snapshots.flatMap((snapshot) => {
      const raw = snapshot.payload.provider_result_observation;
      return isProviderResultObservation(raw) ? [raw] : [];
    });
    const decision = decideProviderResultAdoption(match.league_id, observations, match.kickoff_at, serverNow);
    if (decision.kind === "wait") {
      await this.persistResultAdoptionAnomaly(match.match_id, AnomalyType.ProviderResultPending, false, {
        reason: decision.reason,
        compared_providers: observations.map((item) => item.provider),
      }, serverNow);
      return { kind: "failed", match_id: match.match_id, anomaly_types: [AnomalyType.ProviderResultPending] };
    }
    if (decision.kind === "anomaly") {
      await this.persistResultAdoptionAnomaly(match.match_id, AnomalyType.ProviderResultConflict, true, {
        reason: decision.reason,
        compared_providers: observations.map((item) => item.provider),
      }, serverNow);
      return { kind: "conflict", match_id: match.match_id, result_version: match.result_version, anomaly_type: AnomalyType.ProviderResultConflict };
    }
    await this.persistResultAdoptionAnomaly(match.match_id, AnomalyType.ProviderResultPending, false, {}, serverNow, false);
    return this.resultSync.applyFinishedFixture({
      ...fixture,
      resultProvider: decision.provider,
      comparedProviders: decision.compared_providers,
    }, payload, serverNow);
  }

  private async persistResultObservation(
    matchId: string,
    providerMatchId: string,
    observation: ProviderResultObservation,
    serverNow: Date,
  ): Promise<void> {
    await this.repo.providerSnapshots?.insert({
      schema_version: SCHEMA_VERSION,
      snapshot_id: newUuid(),
      provider: observation.provider,
      entity_type: "match",
      entity_id: matchId,
      provider_entity_id: providerMatchId,
      event_type: "result_observed",
      payload: { provider_result_observation: observation },
      created_at: serverNow,
    });
  }

  private async persistResultAdoptionAnomaly(
    matchId: string,
    type: AnomalyType,
    blocking: boolean,
    details: Record<string, unknown>,
    serverNow: Date,
    open = true,
  ): Promise<void> {
    await this.repo.withTransaction(async (tx) => {
      await persistAnomalyInTransaction(tx, matchId, type, { open, blocking }, details, serverNow);
    });
  }
}

function toResultObservation(fixture: NormalizedFixture, provider: Provider, observedAt: Date): ProviderResultObservation {
  const status = fixture.status.kind === "finished" ? "finished"
    : fixture.status.kind === "live" ? "live"
    : fixture.status.kind === "unexpected" || fixture.status.kind === "missing" ? "unknown" : "other";
  return {
    provider,
    status,
    score: fixture.fulltime,
    raw_status: fixture.rawStatus,
    observed_at: observedAt,
  };
}

function isProviderResultObservation(value: unknown): value is ProviderResultObservation {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<ProviderResultObservation>;
  return typeof entry.provider === "string" && typeof entry.status === "string" && entry.observed_at instanceof Date;
}
