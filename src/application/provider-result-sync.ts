import {
  AnomalyType,
  MatchStatus,
  ResultSource,
  SCHEMA_VERSION,
  SettlementStatus,
} from "../domain/enums.js";
import { internalError, notFoundError } from "../domain/errors.js";
import { assertMatchResultVersionInvariants } from "../domain/invariants.js";
import { newUuid } from "../domain/ids.js";
import { validateMatchTransition } from "../domain/match-state-machine.js";
import { validateSettlementTransition } from "../domain/settlement-state-machine.js";
import type { Match, MatchResult, ProviderSnapshot } from "../domain/types.js";
import type { Provider } from "../domain/enums.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";
import { persistAnomalyInTransaction } from "./anomaly-persistence.js";
import { transitionMatchSettlementStatus } from "./first-settlement-service.js";
import { assertValidServerNow } from "./period-finalize.js";

export interface ProviderResultFixture {
  provider?: "api_football" | "football_data" | "bsd" | "5dollar" | "openfoot" | "sportapi";
  providerMatchId: string;
  status: { kind: string };
  fulltime: { home: number; away: number } | null;
  rawStatus: string | null;
  resultProvider?: Provider;
  comparedProviders?: Provider[];
}

export type ProviderResultSyncOutcome =
  | {
      kind: "applied" | "unchanged";
      match_id: string;
      result_version: number;
      settlement_status: Match["settlement_status"];
    }
  | {
      kind: "conflict";
      match_id: string;
      result_version: number;
      anomaly_type: AnomalyType;
    };

function requireProviderPorts(tx: UnitOfWork): asserts tx is UnitOfWork & {
  matchProviderMappings: NonNullable<UnitOfWork["matchProviderMappings"]>;
  providerSnapshots: NonNullable<UnitOfWork["providerSnapshots"]>;
  anomalies: NonNullable<UnitOfWork["anomalies"]>;
} {
  if (
    tx.matchProviderMappings === undefined ||
    tx.providerSnapshots === undefined ||
    tx.anomalies === undefined
  ) {
    throw internalError("Provider 赛果同步缺少 mapping/snapshot/anomaly repository port");
  }
}

function assertResultLedger(match: Match, latest: MatchResult | null): void {
  assertMatchResultVersionInvariants(match);
  if (match.result_version === 0) {
    if (
      latest !== null ||
      match.regular_home_score !== null ||
      match.regular_away_score !== null ||
      match.result_source !== null
    ) {
      throw internalError("match 初始结果与 match_results 账本不一致");
    }
    return;
  }

  if (
    latest === null ||
    latest.result_version !== match.result_version ||
    latest.regular_home_score !== match.regular_home_score ||
    latest.regular_away_score !== match.regular_away_score ||
    latest.source !== match.result_source
  ) {
    throw internalError("match 当前结果与 match_results 最新版本不一致");
  }
}

async function saveSnapshot(
  tx: UnitOfWork,
  matchId: string,
  fixture: ProviderResultFixture,
  eventType: ProviderSnapshot["event_type"],
  payload: Record<string, unknown>,
  serverNow: Date,
): Promise<void> {
  const snapshots = tx.providerSnapshots;
  if (snapshots === undefined) {
    throw internalError("Provider 赛果同步缺少 provider_snapshots repository port");
  }
  await snapshots.insert({
    schema_version: SCHEMA_VERSION,
    snapshot_id: newUuid(),
    provider: fixture.provider ?? "api_football",
    entity_type: "match",
    entity_id: matchId,
    provider_entity_id: fixture.providerMatchId,
    event_type: eventType,
    payload,
    created_at: serverNow,
  });
}

function providerScoreDetails(
  fixture: ProviderResultFixture,
  match: Match,
): Record<string, unknown> {
  return {
    provider_match_id: fixture.providerMatchId,
    provider_status: fixture.rawStatus,
    provider_regular_home_score: fixture.fulltime?.home ?? null,
    provider_regular_away_score: fixture.fulltime?.away ?? null,
    current_regular_home_score: match.regular_home_score,
    current_regular_away_score: match.regular_away_score,
  };
}

async function persistConflict(
  tx: UnitOfWork,
  match: Match,
  fixture: ProviderResultFixture,
  payload: Record<string, unknown>,
  anomalyType: AnomalyType,
  blocking: boolean,
  serverNow: Date,
): Promise<void> {
  await saveSnapshot(tx, match.match_id, fixture, "provider_conflict", payload, serverNow);
  await persistAnomalyInTransaction(
    tx,
    match.match_id,
    anomalyType,
    { open: true, blocking },
    providerScoreDetails(fixture, match),
    serverNow,
  );
}

async function resolveInvalidFinalScoreAnomaly(
  tx: UnitOfWork,
  match: Match,
  fixture: ProviderResultFixture,
  serverNow: Date,
): Promise<void> {
  await persistAnomalyInTransaction(
    tx,
    match.match_id,
    AnomalyType.InvalidFinalScore,
    {
      open: false,
      blocking: true,
      resolve: {
        resolution: "provider_valid_final_score",
        resolvedAt: serverNow,
      },
    },
    providerScoreDetails(fixture, match),
    serverNow,
  );
}

function requireMatchPatchPorts(matches: UnitOfWork["matches"]): {
  findByIdForUpdate: (matchId: string) => Promise<Match | null>;
  patchFields: (matchId: string, fields: Partial<Match>) => Promise<void>;
} {
  const { findByIdForUpdate, patchFields } = matches;
  if (findByIdForUpdate === undefined || patchFields === undefined) {
    throw internalError("matches 行锁与局部更新端口未配置");
  }
  return { findByIdForUpdate, patchFields };
}

async function lockEffectiveMatch(
  findByIdForUpdate: (matchId: string) => Promise<Match | null>,
  matchId: string,
): Promise<Match | null> {
  const visited = new Set<string>();
  let currentId = matchId;
  for (let hops = 0; hops <= 3; hops += 1) {
    if (visited.has(currentId)) throw internalError("比赛取代关系存在环");
    visited.add(currentId);
    const match = await findByIdForUpdate(currentId);
    if (match === null || match.superseded_by === null) return match;
    if (hops === 3) throw internalError("比赛取代关系超过三跳");
    currentId = match.superseded_by;
  }
  throw internalError("比赛取代关系异常");
}

function providerResultFields(
  match: Match,
  result: MatchResult,
  fixture: ProviderResultFixture,
  serverNow: Date,
): Partial<Match> {
  const fields: Partial<Match> = {
    match_status: MatchStatus.Finished,
    regular_home_score: result.regular_home_score,
    regular_away_score: result.regular_away_score,
    result_version: result.result_version,
    result_source: ResultSource.Provider,
    result_provider: fixture.resultProvider ?? (fixture.provider as Provider | undefined) ?? null,
    compared_providers: fixture.comparedProviders ?? [(fixture.provider as Provider | undefined) ?? "api_football"],
    updated_at: serverNow,
  };
  if (match.period_anchor_at === null) fields.period_anchor_at = match.kickoff_at;
  if (match.prediction_closed_at === null) fields.prediction_closed_at = serverNow;
  if (match.finish_detected_at === null) fields.finish_detected_at = serverNow;
  return fields;
}

function settlementStatusAfterProviderResult(match: Match): SettlementStatus {
  if (match.settled_result_version > 0) {
    if (match.settlement_status === SettlementStatus.Correcting) {
      return SettlementStatus.Correcting;
    }
    if (!validateSettlementTransition(match.settlement_status, SettlementStatus.Correcting)) {
      throw internalError("Provider 赛果修正不能绕过结算状态机");
    }
    return SettlementStatus.Correcting;
  }

  if (match.settlement_status === SettlementStatus.Pending) {
    return SettlementStatus.Waiting;
  }
  if (
    match.settlement_status === SettlementStatus.Waiting ||
    match.settlement_status === SettlementStatus.Settling ||
    match.settlement_status === SettlementStatus.Failed
  ) {
    return match.settlement_status;
  }
  throw internalError("Provider 首次正式赛果与当前结算状态不一致");
}

/** 应用 mapper 已验证的 FT regular score；不连接 Provider，也不启动结算。 */
export class ProviderResultSyncService {
  constructor(private readonly repo: AppRepository) {}

  async applyFinishedFixture(
    fixture: ProviderResultFixture,
    payload: Record<string, unknown>,
    serverNow: Date,
  ): Promise<ProviderResultSyncOutcome> {
    assertValidServerNow(serverNow);
    return this.repo.withTransaction(async (tx) => {
      requireProviderPorts(tx);
      if (
        fixture.status.kind !== "finished" ||
        fixture.rawStatus !== "FT" ||
        fixture.fulltime === null
      ) {
        throw internalError("Provider 赛果同步只接受 mapper 已验证的 FT regular score");
      }

      const mapping = await tx.matchProviderMappings.findByProviderAndExternalId(
        fixture.provider ?? "api_football",
        fixture.providerMatchId,
      );
      if (mapping === null) {
        throw notFoundError("MATCH");
      }
      const { findByIdForUpdate, patchFields } = requireMatchPatchPorts(tx.matches);
      const match = await lockEffectiveMatch(findByIdForUpdate, mapping.match_id);
      if (match === null) {
        throw internalError("Provider match mapping 指向不存在的 match");
      }

      const latest = await tx.matchResults.findLatestByMatch(match.match_id);
      assertResultLedger(match, latest);
      await resolveInvalidFinalScoreAnomaly(tx, match, fixture, serverNow);

      if (
        match.match_status !== MatchStatus.Finished &&
        !validateMatchTransition(match.match_status, MatchStatus.Finished)
      ) {
        await persistConflict(
          tx,
          match,
          fixture,
          payload,
          AnomalyType.ProviderStateConflict,
          true,
          serverNow,
        );
        return {
          kind: "conflict",
          match_id: match.match_id,
          result_version: match.result_version,
          anomaly_type: AnomalyType.ProviderStateConflict,
        };
      }

      const sameScore =
        match.regular_home_score === fixture.fulltime.home &&
        match.regular_away_score === fixture.fulltime.away;
      if (sameScore) {
        if (match.result_source === ResultSource.Provider && fixture.comparedProviders !== undefined &&
          JSON.stringify(match.compared_providers ?? []) !== JSON.stringify(fixture.comparedProviders)) {
          await patchFields(match.match_id, {
            compared_providers: fixture.comparedProviders,
            updated_at: serverNow,
          });
        }
        await saveSnapshot(tx, match.match_id, fixture, "result_observed", payload, serverNow);
        return {
          kind: "unchanged",
          match_id: match.match_id,
          result_version: match.result_version,
          settlement_status: match.settlement_status,
        };
      }

      if (match.result_source === ResultSource.Admin) {
        await persistConflict(
          tx,
          match,
          fixture,
          payload,
          AnomalyType.AdminProviderResultConflict,
          false,
          serverNow,
        );
        return {
          kind: "conflict",
          match_id: match.match_id,
          result_version: match.result_version,
          anomaly_type: AnomalyType.AdminProviderResultConflict,
        };
      }

      const resultVersion = match.result_version + 1;
      const result: MatchResult = {
        schema_version: SCHEMA_VERSION,
        match_id: match.match_id,
        result_version: resultVersion,
        regular_home_score: fixture.fulltime.home,
        regular_away_score: fixture.fulltime.away,
        source: ResultSource.Provider,
        provider_source: fixture.resultProvider ?? (fixture.provider as Provider | undefined) ?? null,
        compared_providers: fixture.comparedProviders ?? [(fixture.provider as Provider | undefined) ?? "api_football"],
        provider_status: fixture.rawStatus,
        admin_id: null,
        reason: null,
        created_at: serverNow,
      };
      const settlementStatus = settlementStatusAfterProviderResult(match);
      await tx.matchResults.insert(result);
      await transitionMatchSettlementStatus(
        tx,
        match.match_id,
        settlementStatus,
        serverNow,
      );
      const fields = providerResultFields(match, result, fixture, serverNow);
      assertMatchResultVersionInvariants({
        ...match,
        ...fields,
        settlement_status: settlementStatus,
      });
      await patchFields(match.match_id, fields);
      await saveSnapshot(
        tx,
        match.match_id,
        fixture,
        resultVersion === 1 ? "result_observed" : "result_changed",
        payload,
        serverNow,
      );

      return {
        kind: "applied",
        match_id: match.match_id,
        result_version: resultVersion,
        settlement_status: settlementStatus,
      };
    });
  }
}
