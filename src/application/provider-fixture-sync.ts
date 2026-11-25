import { resolveEffectiveMatch } from "./match-identity.js";
import {
  AnomalyType,
  MatchStatus,
  Provider,
  ResultSource,
  SCHEMA_VERSION,
  SettlementStatus,
  SyncJobType,
} from "../domain/enums.js";
import { internalError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import { validateMatchTransition } from "../domain/match-state-machine.js";
import type { ProviderSnapshot } from "../domain/types.js";
import { activeLeagueSeason, findSupportedLeagueByProviderId, type ProviderLeagueRefs } from "../domain/config.js";
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
import { ProviderScheduleSyncService } from "./provider-schedule-sync.js";
import { transitionMatchSettlementStatus } from "./first-settlement-service.js";
import { persistAnomalyInTransaction } from "./anomaly-persistence.js";
import { AnomalyEvaluationService } from "./anomaly-evaluation.js";
import { assertValidServerNow } from "./period-finalize.js";
import { ensureCrossSourceMatchMapping } from "./provider-cross-source.js";
import { decideProviderResultAdoption, type ProviderResultObservation } from "./provider-result-adoption.js";

const SCHEDULE_AUTHORITY_PROVIDERS: ReadonlySet<string> = new Set([
  Provider.ApiFootball,
  Provider.FootballData,
  Provider.Bsd,
]);

export interface ProviderFixtureFailure {
  kind: "failed";
  match_id: string | null;
  anomaly_types: AnomalyType[];
}

export interface ProviderFixturePending {
  kind: "pending";
  match_id: string;
  anomaly_types: AnomalyType[];
}

export interface ProviderFixtureIgnored {
  kind: "unchanged";
  match_id: string;
  match_status: MatchStatus;
  ignored: true;
}

export type ProviderFixtureSyncOutcome =
  | ProviderStatusSyncOutcome
  | ProviderTeamChangeOutcome
  | ProviderResultSyncOutcome
  | ProviderFixtureFailure
  | ProviderFixturePending
  | ProviderFixtureIgnored;

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
  isScheduleAuthority = true,
): Promise<ProviderFixtureFailure> {
  return repo.withTransaction(async (tx) => {
    requireMapperFailurePorts(tx);
    const mapping = await tx.matchProviderMappings.findByProviderAndExternalId(
      provider,
      providerMatchId,
    );
    const match = mapping === null ? null : await resolveEffectiveMatch(tx, mapping.match_id);
    if (mapping !== null && match === null) {
      throw internalError("Provider match mapping 指向不存在的 match");
    }

    const snapshot: ProviderSnapshot = {
      schema_version: SCHEMA_VERSION,
      snapshot_id: newUuid(),
      provider,
      entity_type: "match",
      entity_id: match?.match_id ?? null,
      provider_entity_id: providerMatchId,
      event_type: "provider_error",
      payload,
      created_at: serverNow,
    };
    await tx.providerSnapshots.insert(snapshot);

    const uniqueAnomalies = groupedAnomalies(anomalies);
    if (!isScheduleAuthority) {
      console.warn("[provider_secondary_mapper_failed]", {
        provider,
        provider_match_id: providerMatchId,
        match_id: match?.match_id ?? null,
        raw_status: rawStatus,
        anomalies: uniqueAnomalies.map((anomaly) => anomaly.type),
      });
      return {
        kind: "failed",
        match_id: match?.match_id ?? null,
        anomaly_types: uniqueAnomalies.map((anomaly) => anomaly.type),
      };
    }

    if (match !== null) {
      for (const anomaly of uniqueAnomalies) {
        await persistAnomalyInTransaction(
          tx,
          match.match_id,
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
      match_id: match?.match_id ?? null,
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
    private readonly providerLeagueRefs?: ProviderLeagueRefs,
  ) {
    this.statusSync = new ProviderStatusSyncService(repo);
    this.resultSync = new ProviderResultSyncService(repo);
    this.scheduleSync = new ProviderScheduleSyncService(repo, providerLeagueRefs);
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

    return this.statusSync.applyTeamChange(fixture, payload, serverNow, {
      homeMapping,
      awayMapping,
    });
  }

  applyFixtureForJob(
    rawFixture: ApiFootballFixture,
    payload: Record<string, unknown>,
    serverNow: Date,
    seasonId: string | undefined,
    jobType: SyncJobType,
  ): Promise<ProviderFixtureSyncOutcome> {
    return this.applyFixture(rawFixture, payload, serverNow, seasonId, { jobType });
  }

  async applyFixture(
    rawFixture: ApiFootballFixture,
    payload: Record<string, unknown>,
    serverNow: Date,
    seasonId?: string,
    options?: { jobType?: SyncJobType },
  ): Promise<ProviderFixtureSyncOutcome> {
    assertValidServerNow(serverNow);
    const league = findSupportedLeagueByProviderId(String(rawFixture?.league?.id ?? ""), rawFixture?.provider ?? Provider.ApiFootball, this.providerLeagueRefs);
    const targetSeasonId = seasonId ?? (league === undefined ? undefined : activeLeagueSeason(league, serverNow).season_id);
    const normalized = normalizeFixture(rawFixture, this.providerLeagueRefs, serverNow, targetSeasonId);
    const provider = normalized.fixture.provider ?? Provider.ApiFootball;
    const isScheduleAuthority = SCHEDULE_AUTHORITY_PROVIDERS.has(provider);
    if (normalized.entityFailed) {
      const outcome = await persistMapperFailure(
        this.repo,
        normalized.fixture.providerMatchId,
        normalized.fixture.rawStatus,
        normalized.anomalies,
        payload,
        serverNow,
        normalized.fixture.provider,
        isScheduleAuthority,
      );
      if (isScheduleAuthority) {
        await this.evaluateAfterFixture(
          outcome,
          normalized.fixture.providerMatchId,
          normalized.fixture.provider,
          serverNow,
        );
      }
      return outcome;
    }

    if (normalized.anomalies.length > 0) {
      console.warn("[provider_fixture_mapper_warning]", {
        provider,
        provider_match_id: normalized.fixture.providerMatchId,
        league_id: normalized.fixture.leagueProviderId,
        anomalies: normalized.anomalies.map((item) => ({ type: item.type, details: item.details })),
      });
    }

    let mappedMatchId: string | null = null;
    if (!isScheduleAuthority && ["5dollar", "openfoot", "sportapi"].includes(provider)) {
      const mapping = await ensureCrossSourceMatchMapping(
        this.repo,
        normalized.fixture,
        serverNow,
        undefined,
        this.providerLeagueRefs,
        targetSeasonId,
      );
      if (mapping.match_id === null) {
        if (normalized.anomalies.length > 0) {
          await this.persistMapperWarnings(normalized.fixture, normalized.anomalies, payload, serverNow, null);
        }
        return { kind: "failed", match_id: null, anomaly_types: [AnomalyType.ProviderDataInvalid] };
      }
      mappedMatchId = mapping.match_id;
    }

    if (isScheduleAuthority) {
      const mappings = this.repo.matchProviderMappings;
      if (mappings !== undefined) {
        const existing = await mappings.findByProviderAndExternalId(
          provider,
          normalized.fixture.providerMatchId,
        );
        if (existing === null) {
          const outcome = await this.scheduleSync.discover(
            normalized.fixture,
            payload,
            serverNow,
            targetSeasonId,
          );
          if (normalized.fixture.status.kind === MatchStatus.Scheduled) {
            await this.evaluateAfterFixture(
              outcome,
              normalized.fixture.providerMatchId,
              normalized.fixture.provider,
              serverNow,
            );
            if (normalized.anomalies.length > 0) {
              await this.persistMapperWarnings(normalized.fixture, normalized.anomalies, payload, serverNow, outcome.match_id);
            }
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
        if (normalized.anomalies.length > 0) {
          await this.persistMapperWarnings(normalized.fixture, normalized.anomalies, payload, serverNow, teamChange.match_id);
        }
        return teamChange;
      }
    }

    let ignoredSecondaryObservation = false;
    const outcome = await (async (): Promise<ProviderFixtureSyncOutcome> => {
      if (!isScheduleAuthority) {
        const effective = await this.resolveMappedMatch(provider, normalized.fixture.providerMatchId, mappedMatchId);
        if (normalized.fixture.status.kind === MatchStatus.Finished) {
          return this.applyAdoptableResult(normalized.fixture, payload, serverNow);
        }
        const canApplyFiveDollarLive =
          provider === Provider.FiveDollar &&
          normalized.fixture.status.kind === MatchStatus.Live &&
          (options?.jobType === undefined || options.jobType === SyncJobType.LiveMatch) &&
          effective !== null &&
          (effective.match_status === MatchStatus.Scheduled || effective.match_status === MatchStatus.Live);
        if (canApplyFiveDollarLive) {
          return this.statusSync.applyLiveFixture(normalized.fixture, payload, serverNow);
        }
        // 非赛程/状态权威副源禁止写状态转移、作废比赛或因滞后 LIVE/HT 打开阻塞冲突。
        ignoredSecondaryObservation = true;
        return {
          kind: "unchanged",
          match_id: effective?.match_id ?? mappedMatchId ?? "",
          match_status: effective?.match_status ?? MatchStatus.Scheduled,
          ignored: true,
        };
      }
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
    if (!ignoredSecondaryObservation) {
      await this.evaluateAfterFixture(
        outcome,
        normalized.fixture.providerMatchId,
        normalized.fixture.provider,
        serverNow,
      );
    }
    if (normalized.anomalies.length > 0) {
      await this.persistMapperWarnings(
        normalized.fixture,
        normalized.anomalies,
        payload,
        serverNow,
        outcome.match_id || mappedMatchId || null,
      );
    }
    return outcome;
  }

  private async resolveMappedMatch(
    provider: Provider,
    providerMatchId: string,
    fallbackMatchId: string | null,
  ) {
    const matchId = fallbackMatchId ??
      (await this.repo.matchProviderMappings?.findByProviderAndExternalId(provider, providerMatchId))?.match_id ??
      null;
    if (matchId === null) return null;
    return resolveEffectiveMatch(this.repo, matchId);
  }

  private async persistMapperWarnings(
    fixture: NormalizedFixture,
    anomalies: readonly MapperAnomaly[],
    payload: Record<string, unknown>,
    serverNow: Date,
    matchId: string | null,
  ): Promise<void> {
    const uniqueAnomalies = groupedAnomalies(anomalies);
    await this.repo.withTransaction(async (tx) => {
      await tx.providerSnapshots?.insert({
        schema_version: SCHEMA_VERSION,
        snapshot_id: newUuid(),
        provider: fixture.provider ?? Provider.ApiFootball,
        entity_type: "match",
        entity_id: matchId,
        provider_entity_id: fixture.providerMatchId,
        event_type: "provider_error",
        payload: {
          ...payload,
          mapper_warnings: uniqueAnomalies.map((item) => ({
            type: item.type,
            details: item.details,
          })),
        },
        created_at: serverNow,
      });
      if (matchId !== null && tx.anomalies !== undefined) {
        for (const anomaly of uniqueAnomalies) {
          await persistAnomalyInTransaction(
            tx,
            matchId,
            anomaly.type,
            { open: true, blocking: anomaly.blocking },
            anomalyDetails(fixture.providerMatchId, fixture.rawStatus, anomaly),
            serverNow,
          );
        }
      }
    });
  }

  private async applyAdoptableResult(
    fixture: NormalizedFixture,
    payload: Record<string, unknown>,
    serverNow: Date,
  ): Promise<ProviderResultSyncOutcome | ProviderFixtureFailure | ProviderFixturePending> {
    const provider = (fixture.provider ?? Provider.ApiFootball) as Provider;
    const matchMapping = await this.repo.matchProviderMappings?.findByProviderAndExternalId(provider, fixture.providerMatchId);
    if (!matchMapping) return { kind: "failed", match_id: null, anomaly_types: [AnomalyType.ProviderDataInvalid] };
    const match = await resolveEffectiveMatch(this.repo, matchMapping.match_id);
    if (!match) return { kind: "failed", match_id: matchMapping.match_id, anomaly_types: [AnomalyType.ProviderDataInvalid] };
    if (match.result_source === ResultSource.Admin) {
      // 管理员人工终果优先：不打开阻塞性 ProviderResultConflict，直接收敛为非阻塞 ADMIN_PROVIDER_RESULT_CONFLICT（或一致 unchanged）。
      await this.resolveResultAdoptionAnomaly(match.match_id, serverNow);
      return this.resultSync.applyFinishedFixture(fixture, payload, serverNow);
    }
    const observation = toResultObservation(fixture, provider, serverNow);
    await this.persistResultObservation(match.match_id, fixture.providerMatchId, observation, serverNow);
    const snapshots = await this.repo.providerSnapshots?.findByEntity("match", match.match_id) ?? [];
    const observations = snapshots.flatMap((snapshot) => {
      const parsed = parseProviderResultObservation(snapshot.payload.provider_result_observation);
      return parsed ? [parsed] : [];
    });
    const decision = decideProviderResultAdoption(match.league_id, observations, match.kickoff_at, serverNow);
    if (decision.kind === "wait") {
      await this.persistResultAdoptionAnomaly(match.match_id, AnomalyType.ProviderResultPending, false, {
        reason: decision.reason,
        compared_providers: observations.map((item) => item.provider),
      }, serverNow);
      return { kind: "pending", match_id: match.match_id, anomaly_types: [AnomalyType.ProviderResultPending] };
    }
    if (decision.kind === "anomaly") {
      if ((match.compared_providers?.length ?? 0) >= 2) {
        await this.repo.withTransaction(async (tx) => {
          const findByIdForUpdate = tx.matches.findByIdForUpdate;
          const patchFields = tx.matches.patchFields;
          if (findByIdForUpdate === undefined || patchFields === undefined) {
            throw internalError("applyAdoptableResult 缺少 matches 行锁与局部更新端口");
          }
          const locked = await findByIdForUpdate(match.match_id);
          if (locked !== null && (locked.compared_providers?.length ?? 0) >= 2) {
            await patchFields(locked.match_id, { compared_providers: [], updated_at: serverNow });
          }
        });
      }
      await this.persistResultAdoptionAnomaly(match.match_id, AnomalyType.ProviderResultConflict, true, {
        reason: decision.reason,
        compared_providers: observations.map((item) => item.provider),
      }, serverNow);
      return { kind: "conflict", match_id: match.match_id, result_version: match.result_version, anomaly_type: AnomalyType.ProviderResultConflict };
    }
    await this.resolveResultAdoptionAnomaly(match.match_id, serverNow);
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

  /**
   * 采纳权威赛果后关闭遗留的 RESULT_PENDING 异常。
   *
   * 只传 `open: false` 而不带 `resolve` 时 `persistAnomalyInTransaction` 会走
   * "unchanged" 分支（anomaly-persistence.ts:77），异常永远不会被关闭；这里必须
   * 显式给出 resolve，否则每次等待都会留下一条永远 open 的非阻塞异常。
   */
  private async resolveResultAdoptionAnomaly(matchId: string, serverNow: Date): Promise<void> {
    await this.repo.withTransaction(async (tx) => {
      await persistAnomalyInTransaction(tx, matchId, AnomalyType.ProviderResultPending, {
        open: false,
        blocking: false,
        resolve: { resolution: "provider_result_adopted", resolvedAt: serverNow },
      }, {}, serverNow);
    });
  }

  /** 打开/更新一条 wait/conflict 类异常。关闭异常请走 resolveResultAdoptionAnomaly。 */
  private async persistResultAdoptionAnomaly(
    matchId: string,
    type: AnomalyType,
    blocking: boolean,
    details: Record<string, unknown>,
    serverNow: Date,
  ): Promise<void> {
    await this.repo.withTransaction(async (tx) => {
      await persistAnomalyInTransaction(tx, matchId, type, { open: true, blocking }, details, serverNow);
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

function parseProviderResultObservation(value: unknown): ProviderResultObservation | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Partial<ProviderResultObservation>;
  if (typeof entry.provider !== "string" || typeof entry.status !== "string") return null;
  const observedAt = entry.observed_at instanceof Date
    ? entry.observed_at
    : typeof entry.observed_at === "string"
      ? new Date(entry.observed_at)
      : null;
  if (observedAt === null || !Number.isFinite(observedAt.getTime())) return null;
  return {
    provider: entry.provider,
    status: entry.status,
    score: entry.score ?? null,
    raw_status: entry.raw_status ?? null,
    observed_at: observedAt,
  };
}
