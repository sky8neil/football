import {
  AnomalyType,
  MatchStatus,
  Provider,
  SCHEMA_VERSION,
  SettlementStatus,
} from "../domain/enums.js";
import { internalError, notFoundError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import { decidePredictionClosedAt } from "../domain/prediction-deadline.js";
import { validateMatchTransition } from "../domain/match-state-machine.js";
import { shouldVoidOnCancel, validateSettlementTransition } from "../domain/settlement-state-machine.js";
import { computePredictionDeadline } from "../domain/time.js";
import type { Match, ProviderSnapshot } from "../domain/types.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";
import type { NormalizedFixture } from "../provider/fixture-mapper.js";
import { persistAnomalyInTransaction } from "./anomaly-persistence.js";
import { assertValidServerNow } from "./period-finalize.js";
import { tryParseProviderRoundId } from "./provider-schedule-sync.js";

export type ProviderStatusSyncOutcome =
  | {
      kind: "applied" | "unchanged";
      match_id: string;
      match_status:
        | typeof MatchStatus.Scheduled
        | typeof MatchStatus.Live
        | typeof MatchStatus.Postponed
        | typeof MatchStatus.Cancelled
        | typeof MatchStatus.Abandoned;
    }
  | {
      kind: "conflict";
      match_id: string;
      match_status: Match["match_status"];
      anomaly_type:
        | typeof AnomalyType.ProviderStateConflict
        | typeof AnomalyType.KickoffChangeAfterAnchor;
    }
  | {
      kind: "failed";
      match_id: string;
      match_status: Match["match_status"];
      anomaly_types: [typeof AnomalyType.ProviderDataInvalid];
    };

export type ProviderTeamChangeOutcome =
  | {
      kind: "applied" | "unchanged";
      match_id: string;
      home_team_id: string;
      away_team_id: string;
    }
  | {
      kind: "conflict";
      match_id: string;
      match_status: Match["match_status"];
      anomaly_type: typeof AnomalyType.TeamChangeAfterPrediction;
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
    throw internalError("Provider 状态同步缺少 mapping/snapshot/anomaly repository port");
  }
}

function requireTeamChangePorts(tx: UnitOfWork): asserts tx is UnitOfWork & {
  matchProviderMappings: NonNullable<UnitOfWork["matchProviderMappings"]>;
  teamProviderMappings: NonNullable<UnitOfWork["teamProviderMappings"]>;
  teams: NonNullable<UnitOfWork["teams"]>;
  predictions: NonNullable<UnitOfWork["predictions"]>;
  providerSnapshots: NonNullable<UnitOfWork["providerSnapshots"]>;
  anomalies: NonNullable<UnitOfWork["anomalies"]>;
} {
  requireProviderPorts(tx);
  if (
    tx.teamProviderMappings === undefined ||
    tx.teams === undefined
  ) {
    throw internalError("Provider 球队变更同步缺少 team mapping/teams repository port");
  }
}

function teamChangeDetails(
  fixture: NormalizedFixture,
  match: Match,
  hasPrediction: boolean,
  homeTeamId: string,
  awayTeamId: string,
): Record<string, unknown> {
  return {
    provider_match_id: fixture.providerMatchId,
    provider_home_team_id: fixture.homeTeamProviderId,
    provider_away_team_id: fixture.awayTeamProviderId,
    current_home_team_id: match.home_team_id,
    current_away_team_id: match.away_team_id,
    mapped_home_team_id: homeTeamId,
    mapped_away_team_id: awayTeamId,
    current_match_status: match.match_status,
    has_prediction: hasPrediction,
  };
}

async function saveSnapshot(
  tx: UnitOfWork,
  matchId: string,
  fixture: NormalizedFixture,
  eventType: ProviderSnapshot["event_type"],
  payload: Record<string, unknown>,
  serverNow: Date,
): Promise<void> {
  await tx.providerSnapshots!.insert({
    schema_version: SCHEMA_VERSION,
    snapshot_id: newUuid(),
    provider: Provider.ApiFootball,
    entity_type: "match",
    entity_id: matchId,
    provider_entity_id: fixture.providerMatchId,
    event_type: eventType,
    payload,
    created_at: serverNow,
  });
}

function conflictDetails(fixture: NormalizedFixture, match: Match): Record<string, unknown> {
  return {
    provider_match_id: fixture.providerMatchId,
    provider_status: fixture.rawStatus,
    current_match_status: match.match_status,
  };
}

function kickoffConflictDetails(
  fixture: NormalizedFixture,
  match: Match,
): Record<string, unknown> {
  return {
    ...conflictDetails(fixture, match),
    current_kickoff_at: match.kickoff_at.toISOString(),
    provider_kickoff_at: fixture.kickoffAt?.toISOString() ?? null,
  };
}

/**
 * 第 5.3 节：创建后 round_id immutable；Provider 后续 round 与内部值冲突时
 * 记录 PROVIDER_DATA_INVALID anomaly 与冲突快照，不覆盖 round_id。
 */
async function recordImmutableRoundConflict(
  tx: UnitOfWork,
  match: Match,
  fixture: NormalizedFixture,
  payload: Record<string, unknown>,
  serverNow: Date,
): Promise<void> {
  const providerRoundId = tryParseProviderRoundId(fixture.round);
  if (providerRoundId === null || providerRoundId === match.round_id) {
    return;
  }
  await saveSnapshot(
    tx,
    match.match_id,
    fixture,
    "provider_conflict",
    payload,
    serverNow,
  );
  await persistAnomalyInTransaction(
    tx,
    match.match_id,
    AnomalyType.ProviderDataInvalid,
    { open: true, blocking: false },
    {
      ...conflictDetails(fixture, match),
      field: "round_id",
      current_round_id: match.round_id,
      provider_round_id: providerRoundId,
      provider_round: fixture.round,
    },
    serverNow,
  );
}

/** 应用 mapper 已验证的 Provider 状态；不连接真实 Provider，也不启动结算。 */
export class ProviderStatusSyncService {
  constructor(private readonly repo: AppRepository) {}

  async applyScheduledFixture(
    fixture: NormalizedFixture,
    payload: Record<string, unknown>,
    serverNow: Date,
  ): Promise<ProviderStatusSyncOutcome> {
    assertValidServerNow(serverNow);
    return this.repo.withTransaction(async (tx) => {
      requireProviderPorts(tx);
      if (fixture.status.kind !== MatchStatus.Scheduled) {
        throw internalError("Provider 状态同步只接受 mapper 已验证的 scheduled 状态");
      }

      const mapping = await tx.matchProviderMappings.findByProviderAndExternalId(
        Provider.ApiFootball,
        fixture.providerMatchId,
      );
      if (mapping === null) {
        throw notFoundError("MATCH");
      }
      const match = await tx.matches.findById(mapping.match_id);
      if (match === null) {
        throw internalError("Provider match mapping 指向不存在的 match");
      }

      await recordImmutableRoundConflict(tx, match, fixture, payload, serverNow);

      if (fixture.kickoffAt === null || !Number.isFinite(fixture.kickoffAt.getTime())) {
        await saveSnapshot(
          tx,
          match.match_id,
          fixture,
          "provider_error",
          payload,
          serverNow,
        );
        await persistAnomalyInTransaction(
          tx,
          match.match_id,
          AnomalyType.ProviderDataInvalid,
          { open: true, blocking: false },
          {
            ...conflictDetails(fixture, match),
            field: "kickoff",
          },
          serverNow,
        );
        return {
          kind: "failed",
          match_id: match.match_id,
          match_status: match.match_status,
          anomaly_types: [AnomalyType.ProviderDataInvalid],
        };
      }

      const sameStatus = match.match_status === MatchStatus.Scheduled;
      if (!sameStatus && !validateMatchTransition(match.match_status, MatchStatus.Scheduled)) {
        await saveSnapshot(
          tx,
          match.match_id,
          fixture,
          "provider_conflict",
          payload,
          serverNow,
        );
        await persistAnomalyInTransaction(
          tx,
          match.match_id,
          AnomalyType.ProviderStateConflict,
          { open: true, blocking: true },
          conflictDetails(fixture, match),
          serverNow,
        );
        return {
          kind: "conflict",
          match_id: match.match_id,
          match_status: match.match_status,
          anomaly_type: AnomalyType.ProviderStateConflict,
        };
      }

      const kickoffChanged = fixture.kickoffAt.getTime() !== match.kickoff_at.getTime();
      if (match.period_anchor_at !== null && kickoffChanged) {
        await saveSnapshot(
          tx,
          match.match_id,
          fixture,
          "provider_conflict",
          payload,
          serverNow,
        );
        await persistAnomalyInTransaction(
          tx,
          match.match_id,
          AnomalyType.KickoffChangeAfterAnchor,
          { open: true, blocking: true },
          kickoffConflictDetails(fixture, match),
          serverNow,
        );
        return {
          kind: "conflict",
          match_id: match.match_id,
          match_status: match.match_status,
          anomaly_type: AnomalyType.KickoffChangeAfterAnchor,
        };
      }

      const closedAtBeforeSchedule =
        decidePredictionClosedAt(
          {
            prediction_closed_at: match.prediction_closed_at,
            prediction_deadline_at: match.prediction_deadline_at,
            match_status: match.match_status,
          },
          MatchStatus.Scheduled,
          serverNow,
        ) ?? match.prediction_closed_at;
      const nextDeadline =
        closedAtBeforeSchedule === null
          ? computePredictionDeadline(fixture.kickoffAt, fixture.kickoffConfirmed)
          : match.prediction_deadline_at;
      const nextClosedAt =
        closedAtBeforeSchedule ??
        (nextDeadline !== null && serverNow.getTime() >= nextDeadline.getTime()
          ? nextDeadline
          : null);
      const deadlineChanged =
        nextDeadline?.getTime() !== match.prediction_deadline_at?.getTime();
      const closedAtChanged =
        nextClosedAt?.getTime() !== match.prediction_closed_at?.getTime();
      const confirmedChanged = fixture.kickoffConfirmed !== match.kickoff_confirmed;
      const changed =
        !sameStatus ||
        kickoffChanged ||
        confirmedChanged ||
        deadlineChanged ||
        closedAtChanged;

      if (!changed) {
        return {
          kind: "unchanged",
          match_id: match.match_id,
          match_status: MatchStatus.Scheduled,
        };
      }

      await tx.matches.update({
        ...match,
        match_status: MatchStatus.Scheduled,
        kickoff_at: fixture.kickoffAt,
        kickoff_confirmed: fixture.kickoffConfirmed,
        prediction_deadline_at: nextDeadline,
        prediction_closed_at: nextClosedAt,
        updated_at: serverNow,
      });
      if (kickoffChanged) {
        await saveSnapshot(
          tx,
          match.match_id,
          fixture,
          "kickoff_changed",
          payload,
          serverNow,
        );
      }
      if (!sameStatus) {
        await saveSnapshot(
          tx,
          match.match_id,
          fixture,
          "status_changed",
          payload,
          serverNow,
        );
      }
      return {
        kind: "applied",
        match_id: match.match_id,
        match_status: MatchStatus.Scheduled,
      };
    });
  }

  async applyTeamChange(
    fixture: NormalizedFixture,
    payload: Record<string, unknown>,
    serverNow: Date,
  ): Promise<ProviderTeamChangeOutcome> {
    assertValidServerNow(serverNow);
    return this.repo.withTransaction(async (tx) => {
      requireTeamChangePorts(tx);

      const matchMapping = await tx.matchProviderMappings.findByProviderAndExternalId(
        Provider.ApiFootball,
        fixture.providerMatchId,
      );
      if (matchMapping === null) {
        throw notFoundError("MATCH");
      }
      const match = await tx.matches.findById(matchMapping.match_id);
      if (match === null) {
        throw internalError("Provider match mapping 指向不存在的 match");
      }

      await recordImmutableRoundConflict(tx, match, fixture, payload, serverNow);

      const [homeMapping, awayMapping] = await Promise.all([
        tx.teamProviderMappings.findByProviderAndExternalId(
          Provider.ApiFootball,
          fixture.homeTeamProviderId,
        ),
        tx.teamProviderMappings.findByProviderAndExternalId(
          Provider.ApiFootball,
          fixture.awayTeamProviderId,
        ),
      ]);
      if (homeMapping === null || awayMapping === null) {
        throw internalError("Provider team mapping 缺失，拒绝更新比赛主客队");
      }
      const [homeTeam, awayTeam] = await Promise.all([
        tx.teams.findById(homeMapping.team_id),
        tx.teams.findById(awayMapping.team_id),
      ]);
      if (homeTeam === null || awayTeam === null) {
        throw internalError("Provider team mapping 指向不存在的 team");
      }

      const changed =
        match.home_team_id !== homeMapping.team_id ||
        match.away_team_id !== awayMapping.team_id;
      if (!changed) {
        return {
          kind: "unchanged",
          match_id: match.match_id,
          home_team_id: match.home_team_id,
          away_team_id: match.away_team_id,
        };
      }

      const hasPrediction = (await tx.predictions.findByMatch(match.match_id)).length > 0;
      const providerHasStarted = fixture.status.kind !== MatchStatus.Scheduled;
      if (hasPrediction || match.match_status !== MatchStatus.Scheduled || providerHasStarted) {
        await saveSnapshot(
          tx,
          match.match_id,
          fixture,
          "provider_conflict",
          payload,
          serverNow,
        );
        await persistAnomalyInTransaction(
          tx,
          match.match_id,
          AnomalyType.TeamChangeAfterPrediction,
          { open: true, blocking: true },
          teamChangeDetails(
            fixture,
            match,
            hasPrediction,
            homeMapping.team_id,
            awayMapping.team_id,
          ),
          serverNow,
        );
        return {
          kind: "conflict",
          match_id: match.match_id,
          match_status: match.match_status,
          anomaly_type: AnomalyType.TeamChangeAfterPrediction,
        };
      }

      await tx.matches.update({
        ...match,
        home_team_id: homeMapping.team_id,
        away_team_id: awayMapping.team_id,
        updated_at: serverNow,
      });
      return {
        kind: "applied",
        match_id: match.match_id,
        home_team_id: homeMapping.team_id,
        away_team_id: awayMapping.team_id,
      };
    });
  }

  async applyPostponedFixture(
    fixture: NormalizedFixture,
    payload: Record<string, unknown>,
    serverNow: Date,
  ): Promise<ProviderStatusSyncOutcome> {
    assertValidServerNow(serverNow);
    return this.repo.withTransaction(async (tx) => {
      requireProviderPorts(tx);
      if (fixture.status.kind !== MatchStatus.Postponed) {
        throw internalError("Provider 状态同步只接受 mapper 已验证的 postponed 状态");
      }

      const mapping = await tx.matchProviderMappings.findByProviderAndExternalId(
        Provider.ApiFootball,
        fixture.providerMatchId,
      );
      if (mapping === null) {
        throw notFoundError("MATCH");
      }
      const match = await tx.matches.findById(mapping.match_id);
      if (match === null) {
        throw internalError("Provider match mapping 指向不存在的 match");
      }

      await recordImmutableRoundConflict(tx, match, fixture, payload, serverNow);

      if (fixture.kickoffAt === null || !Number.isFinite(fixture.kickoffAt.getTime())) {
        await saveSnapshot(
          tx,
          match.match_id,
          fixture,
          "provider_error",
          payload,
          serverNow,
        );
        await persistAnomalyInTransaction(
          tx,
          match.match_id,
          AnomalyType.ProviderDataInvalid,
          { open: true, blocking: false },
          {
            ...conflictDetails(fixture, match),
            field: "kickoff",
          },
          serverNow,
        );
        return {
          kind: "failed",
          match_id: match.match_id,
          match_status: match.match_status,
          anomaly_types: [AnomalyType.ProviderDataInvalid],
        };
      }

      const sameStatus = match.match_status === MatchStatus.Postponed;
      if (!sameStatus && !validateMatchTransition(match.match_status, MatchStatus.Postponed)) {
        await saveSnapshot(
          tx,
          match.match_id,
          fixture,
          "provider_conflict",
          payload,
          serverNow,
        );
        await persistAnomalyInTransaction(
          tx,
          match.match_id,
          AnomalyType.ProviderStateConflict,
          { open: true, blocking: true },
          conflictDetails(fixture, match),
          serverNow,
        );
        return {
          kind: "conflict",
          match_id: match.match_id,
          match_status: match.match_status,
          anomaly_type: AnomalyType.ProviderStateConflict,
        };
      }

      const kickoffChanged = fixture.kickoffAt.getTime() !== match.kickoff_at.getTime();
      if (match.period_anchor_at !== null && kickoffChanged) {
        await saveSnapshot(
          tx,
          match.match_id,
          fixture,
          "provider_conflict",
          payload,
          serverNow,
        );
        await persistAnomalyInTransaction(
          tx,
          match.match_id,
          AnomalyType.KickoffChangeAfterAnchor,
          { open: true, blocking: true },
          kickoffConflictDetails(fixture, match),
          serverNow,
        );
        return {
          kind: "conflict",
          match_id: match.match_id,
          match_status: match.match_status,
          anomaly_type: AnomalyType.KickoffChangeAfterAnchor,
        };
      }

      const closedAtBeforePostponement = decidePredictionClosedAt(
        {
          prediction_closed_at: match.prediction_closed_at,
          prediction_deadline_at: match.prediction_deadline_at,
          match_status: match.match_status,
        },
        MatchStatus.Postponed,
        serverNow,
      );
      const nextPredictionClosedAt =
        closedAtBeforePostponement ?? match.prediction_closed_at;
      const nextKickoffAt = kickoffChanged ? fixture.kickoffAt : match.kickoff_at;
      const nextDeadline =
        nextPredictionClosedAt === null
          ? computePredictionDeadline(nextKickoffAt, fixture.kickoffConfirmed)
          : match.prediction_deadline_at;
      const confirmedChanged = fixture.kickoffConfirmed !== match.kickoff_confirmed;
      const changed =
        !sameStatus ||
        kickoffChanged ||
        confirmedChanged ||
        nextDeadline?.getTime() !== match.prediction_deadline_at?.getTime() ||
        nextPredictionClosedAt?.getTime() !== match.prediction_closed_at?.getTime();

      if (!changed) {
        return {
          kind: "unchanged",
          match_id: match.match_id,
          match_status: MatchStatus.Postponed,
        };
      }

      await tx.matches.update({
        ...match,
        match_status: MatchStatus.Postponed,
        kickoff_at: nextKickoffAt,
        kickoff_confirmed: fixture.kickoffConfirmed,
        prediction_deadline_at: nextDeadline,
        prediction_closed_at: nextPredictionClosedAt,
        updated_at: serverNow,
      });
      if (kickoffChanged) {
        await saveSnapshot(
          tx,
          match.match_id,
          fixture,
          "kickoff_changed",
          payload,
          serverNow,
        );
      }
      if (!sameStatus) {
        await saveSnapshot(
          tx,
          match.match_id,
          fixture,
          "status_changed",
          payload,
          serverNow,
        );
      }
      return {
        kind: "applied",
        match_id: match.match_id,
        match_status: MatchStatus.Postponed,
      };
    });
  }

  async applyLiveFixture(
    fixture: NormalizedFixture,
    payload: Record<string, unknown>,
    serverNow: Date,
  ): Promise<ProviderStatusSyncOutcome> {
    assertValidServerNow(serverNow);
    return this.repo.withTransaction(async (tx) => {
      requireProviderPorts(tx);
      if (fixture.status.kind !== MatchStatus.Live) {
        throw internalError("Provider 状态同步只接受 mapper 已验证的 live 状态");
      }

      const mapping = await tx.matchProviderMappings.findByProviderAndExternalId(
        Provider.ApiFootball,
        fixture.providerMatchId,
      );
      if (mapping === null) {
        throw notFoundError("MATCH");
      }
      const match = await tx.matches.findById(mapping.match_id);
      if (match === null) {
        throw internalError("Provider match mapping 指向不存在的 match");
      }

      await recordImmutableRoundConflict(tx, match, fixture, payload, serverNow);

      const sameStatus = match.match_status === MatchStatus.Live;
      if (!sameStatus && !validateMatchTransition(match.match_status, MatchStatus.Live)) {
        await saveSnapshot(
          tx,
          match.match_id,
          fixture,
          "provider_conflict",
          payload,
          serverNow,
        );
        await persistAnomalyInTransaction(
          tx,
          match.match_id,
          AnomalyType.ProviderStateConflict,
          { open: true, blocking: true },
          conflictDetails(fixture, match),
          serverNow,
        );
        return {
          kind: "conflict",
          match_id: match.match_id,
          match_status: match.match_status,
          anomaly_type: AnomalyType.ProviderStateConflict,
        };
      }

      const kickoffChanged =
        fixture.kickoffAt !== null &&
        fixture.kickoffAt.getTime() !== match.kickoff_at.getTime();
      if (match.period_anchor_at !== null && kickoffChanged) {
        await saveSnapshot(
          tx,
          match.match_id,
          fixture,
          "provider_conflict",
          payload,
          serverNow,
        );
        await persistAnomalyInTransaction(
          tx,
          match.match_id,
          AnomalyType.KickoffChangeAfterAnchor,
          { open: true, blocking: true },
          kickoffConflictDetails(fixture, match),
          serverNow,
        );
        return {
          kind: "conflict",
          match_id: match.match_id,
          match_status: match.match_status,
          anomaly_type: AnomalyType.KickoffChangeAfterAnchor,
        };
      }

      const predictionClosedAt = decidePredictionClosedAt(
        {
          prediction_closed_at: match.prediction_closed_at,
          prediction_deadline_at: match.prediction_deadline_at,
          match_status: match.match_status,
        },
        MatchStatus.Live,
        serverNow,
      );
      const nextPredictionClosedAt = predictionClosedAt ?? match.prediction_closed_at;
      const canUpdateKickoff =
        match.period_anchor_at === null &&
        (match.match_status === MatchStatus.Scheduled ||
          match.match_status === MatchStatus.Postponed) &&
        fixture.kickoffAt !== null;
      const nextKickoffAt = canUpdateKickoff && fixture.kickoffAt !== null
        ? fixture.kickoffAt
        : match.kickoff_at;
      const nextKickoffConfirmed = fixture.kickoffConfirmed;
      const nextPredictionDeadlineAt =
        match.prediction_closed_at === null
          ? computePredictionDeadline(nextKickoffAt, nextKickoffConfirmed)
          : match.prediction_deadline_at;
      const nextPeriodAnchorAt = match.period_anchor_at ?? nextKickoffAt;
      const changed =
        !sameStatus ||
        nextKickoffAt.getTime() !== match.kickoff_at.getTime() ||
        nextKickoffConfirmed !== match.kickoff_confirmed ||
        nextPredictionDeadlineAt?.getTime() !== match.prediction_deadline_at?.getTime() ||
        nextPredictionClosedAt?.getTime() !== match.prediction_closed_at?.getTime() ||
        nextPeriodAnchorAt.getTime() !== match.period_anchor_at?.getTime();

      if (!changed) {
        return {
          kind: "unchanged",
          match_id: match.match_id,
          match_status: MatchStatus.Live,
        };
      }

      await tx.matches.update({
        ...match,
        match_status: MatchStatus.Live,
        kickoff_at: nextKickoffAt,
        kickoff_confirmed: nextKickoffConfirmed,
        prediction_deadline_at: nextPredictionDeadlineAt,
        prediction_closed_at: nextPredictionClosedAt,
        period_anchor_at: nextPeriodAnchorAt,
        updated_at: serverNow,
      });
      if (!sameStatus) {
        await saveSnapshot(
          tx,
          match.match_id,
          fixture,
          "status_changed",
          payload,
          serverNow,
        );
      }
      return {
        kind: "applied",
        match_id: match.match_id,
        match_status: MatchStatus.Live,
      };
    });
  }

  async applyCancelledFixture(
    fixture: NormalizedFixture,
    payload: Record<string, unknown>,
    serverNow: Date,
  ): Promise<ProviderStatusSyncOutcome> {
    assertValidServerNow(serverNow);
    return this.repo.withTransaction(async (tx) => {
      requireProviderPorts(tx);
      if (fixture.status.kind !== MatchStatus.Cancelled) {
        throw internalError("Provider 状态同步只接受 mapper 已验证的 cancelled 状态");
      }

      const mapping = await tx.matchProviderMappings.findByProviderAndExternalId(
        Provider.ApiFootball,
        fixture.providerMatchId,
      );
      if (mapping === null) {
        throw notFoundError("MATCH");
      }
      const match = await tx.matches.findById(mapping.match_id);
      if (match === null) {
        throw internalError("Provider match mapping 指向不存在的 match");
      }

      await recordImmutableRoundConflict(tx, match, fixture, payload, serverNow);

      const sameStatus = match.match_status === MatchStatus.Cancelled;
      if (
        !shouldVoidOnCancel(MatchStatus.Cancelled, match.settlement_status) ||
        (!sameStatus && !validateMatchTransition(match.match_status, MatchStatus.Cancelled))
      ) {
        await saveSnapshot(
          tx,
          match.match_id,
          fixture,
          "provider_conflict",
          payload,
          serverNow,
        );
        await persistAnomalyInTransaction(
          tx,
          match.match_id,
          AnomalyType.ProviderStateConflict,
          { open: true, blocking: true },
          conflictDetails(fixture, match),
          serverNow,
        );
        return {
          kind: "conflict",
          match_id: match.match_id,
          match_status: match.match_status,
          anomaly_type: AnomalyType.ProviderStateConflict,
        };
      }

      const nextSettlementStatus =
        match.settlement_status === SettlementStatus.Voided
          ? SettlementStatus.Voided
          : validateSettlementTransition(
                match.settlement_status,
                SettlementStatus.Voided,
              )
            ? SettlementStatus.Voided
            : null;
      if (nextSettlementStatus === null) {
        await saveSnapshot(
          tx,
          match.match_id,
          fixture,
          "provider_conflict",
          payload,
          serverNow,
        );
        await persistAnomalyInTransaction(
          tx,
          match.match_id,
          AnomalyType.ProviderStateConflict,
          { open: true, blocking: true },
          conflictDetails(fixture, match),
          serverNow,
        );
        return {
          kind: "conflict",
          match_id: match.match_id,
          match_status: match.match_status,
          anomaly_type: AnomalyType.ProviderStateConflict,
        };
      }

      const changed =
        !sameStatus || match.settlement_status !== nextSettlementStatus;
      if (!changed) {
        return {
          kind: "unchanged",
          match_id: match.match_id,
          match_status: MatchStatus.Cancelled,
        };
      }

      await tx.matches.update({
        ...match,
        match_status: MatchStatus.Cancelled,
        settlement_status: nextSettlementStatus,
        updated_at: serverNow,
      });
      if (!sameStatus) {
        await saveSnapshot(
          tx,
          match.match_id,
          fixture,
          "status_changed",
          payload,
          serverNow,
        );
      }
      return {
        kind: "applied",
        match_id: match.match_id,
        match_status: MatchStatus.Cancelled,
      };
    });
  }

  async applyAbandonedFixture(
    fixture: NormalizedFixture,
    payload: Record<string, unknown>,
    serverNow: Date,
  ): Promise<ProviderStatusSyncOutcome> {
    assertValidServerNow(serverNow);
    return this.repo.withTransaction(async (tx) => {
      requireProviderPorts(tx);
      if (fixture.status.kind !== MatchStatus.Abandoned) {
        throw internalError("Provider 状态同步只接受 mapper 已验证的 abandoned 状态");
      }

      const mapping = await tx.matchProviderMappings.findByProviderAndExternalId(
        Provider.ApiFootball,
        fixture.providerMatchId,
      );
      if (mapping === null) {
        throw notFoundError("MATCH");
      }
      const match = await tx.matches.findById(mapping.match_id);
      if (match === null) {
        throw internalError("Provider match mapping 指向不存在的 match");
      }

      await recordImmutableRoundConflict(tx, match, fixture, payload, serverNow);

      const sameStatus = match.match_status === MatchStatus.Abandoned;
      const invalidTransition =
        !sameStatus && !validateMatchTransition(match.match_status, MatchStatus.Abandoned);
      const invalidSettlement = match.settlement_status !== SettlementStatus.Pending;
      if (invalidTransition || invalidSettlement) {
        await saveSnapshot(
          tx,
          match.match_id,
          fixture,
          "provider_conflict",
          payload,
          serverNow,
        );
        await persistAnomalyInTransaction(
          tx,
          match.match_id,
          AnomalyType.ProviderStateConflict,
          { open: true, blocking: true },
          {
            ...conflictDetails(fixture, match),
            expected_settlement_status: SettlementStatus.Pending,
          },
          serverNow,
        );
        return {
          kind: "conflict",
          match_id: match.match_id,
          match_status: match.match_status,
          anomaly_type: AnomalyType.ProviderStateConflict,
        };
      }

      if (sameStatus) {
        return {
          kind: "unchanged",
          match_id: match.match_id,
          match_status: MatchStatus.Abandoned,
        };
      }

      await tx.matches.update({
        ...match,
        match_status: MatchStatus.Abandoned,
        settlement_status: SettlementStatus.Pending,
        updated_at: serverNow,
      });
      await saveSnapshot(
        tx,
        match.match_id,
        fixture,
        "status_changed",
        payload,
        serverNow,
      );
      return {
        kind: "applied",
        match_id: match.match_id,
        match_status: MatchStatus.Abandoned,
      };
    });
  }
}
