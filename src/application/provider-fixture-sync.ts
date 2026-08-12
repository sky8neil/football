import {
  AnomalyType,
  MatchStatus,
  Provider,
  SCHEMA_VERSION,
} from "../domain/enums.js";
import { internalError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import type { ProviderSnapshot } from "../domain/types.js";
import type { ApiFootballFixture } from "../provider/types.js";
import { normalizeFixture, type MapperAnomaly } from "../provider/fixture-mapper.js";
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
import { ProviderScheduleSyncService } from "./provider-schedule-sync.js";
import { persistAnomalyInTransaction } from "./anomaly-persistence.js";
import { AnomalyEvaluationService } from "./anomaly-evaluation.js";
import { assertValidServerNow } from "./period-finalize.js";

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
): Promise<ProviderFixtureFailure> {
  return repo.withTransaction(async (tx) => {
    requireMapperFailurePorts(tx);
    const mapping = await tx.matchProviderMappings.findByProviderAndExternalId(
      Provider.ApiFootball,
      providerMatchId,
    );
    if (mapping !== null && (await tx.matches.findById(mapping.match_id)) === null) {
      throw internalError("Provider match mapping 指向不存在的 match");
    }

    const snapshot: ProviderSnapshot = {
      schema_version: SCHEMA_VERSION,
      snapshot_id: newUuid(),
      provider: Provider.ApiFootball,
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
    }

    return {
      kind: "failed",
      match_id: mapping?.match_id ?? null,
      anomaly_types: uniqueAnomalies.map((anomaly) => anomaly.type),
    };
  });
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

  private async evaluateSuccessfulFixture(
    outcome: ProviderFixtureSyncOutcome,
    serverNow: Date,
  ): Promise<void> {
    if (outcome.kind === "failed" || outcome.kind === "conflict") {
      return;
    }
    await this.repo.withTransaction(async (tx) => {
      await persistAnomalyInTransaction(
        tx,
        outcome.match_id,
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
    await this.anomalyEvaluation.evaluate(outcome.match_id, serverNow, serverNow);
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
      mappings.findByProviderAndExternalId(Provider.ApiFootball, fixture.homeTeamProviderId),
      mappings.findByProviderAndExternalId(Provider.ApiFootball, fixture.awayTeamProviderId),
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
      return persistMapperFailure(
        this.repo,
        normalized.fixture.providerMatchId,
        normalized.fixture.rawStatus,
        normalized.anomalies,
        payload,
        serverNow,
      );
    }

    if (normalized.fixture.status.kind === MatchStatus.Scheduled) {
      const mappings = this.repo.matchProviderMappings;
      if (mappings !== undefined) {
        const existing = await mappings.findByProviderAndExternalId(
          Provider.ApiFootball,
          normalized.fixture.providerMatchId,
        );
        if (existing === null) {
          const outcome = await this.scheduleSync.discover(
            normalized.fixture,
            payload,
            serverNow,
          );
          await this.evaluateSuccessfulFixture(outcome, serverNow);
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
        return this.resultSync.applyFinishedFixture(
          normalized.fixture,
          payload,
          serverNow,
        );
      default:
        throw internalError("Provider fixture 状态未通过 mapper 校验");
      }
    })();
    await this.evaluateSuccessfulFixture(outcome, serverNow);
    return outcome;
  }
}
