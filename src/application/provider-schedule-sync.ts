import { FIXED_CONFIG_V1, MVP_SEASON } from "../domain/config.js";
import {
  MatchStatus,
  Provider,
  SCHEMA_VERSION,
  SettlementStatus,
  TeamStatus,
} from "../domain/enums.js";
import { internalError, validationError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import { decidePredictionClosedAt } from "../domain/prediction-deadline.js";
import { computePredictionDeadline } from "../domain/time.js";
import type { Match, ProviderSnapshot } from "../domain/types.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";
import { ProviderDataError } from "../provider/http.js";
import type { NormalizedFixture as ProviderFixture } from "../provider/fixture-mapper.js";

export type ProviderScheduleSyncOutcome = {
  kind: "applied";
  match_id: string;
  match_status: typeof MatchStatus.Scheduled;
};

type ScheduleSyncUnitOfWork = UnitOfWork & {
  teams: NonNullable<UnitOfWork["teams"]>;
  teamProviderMappings: NonNullable<UnitOfWork["teamProviderMappings"]>;
  matchProviderMappings: NonNullable<UnitOfWork["matchProviderMappings"]>;
  providerSnapshots: NonNullable<UnitOfWork["providerSnapshots"]>;
};

function requirePorts(tx: UnitOfWork): asserts tx is ScheduleSyncUnitOfWork {
  if (
    tx.teams === undefined ||
    tx.teamProviderMappings === undefined ||
    tx.matchProviderMappings === undefined ||
    tx.providerSnapshots === undefined
  ) {
    throw internalError("Provider 赛程发现缺少 teams/mapping/snapshot repository port");
  }
}

function assertValidServerNow(serverNow: Date): void {
  if (!(serverNow instanceof Date) || Number.isNaN(serverNow.getTime())) {
    throw validationError("server_now 必须是有效时间", { field: "server_now" });
  }
}

/** 解析 Provider round 为 01..38；无法解析时返回 null（不抛错）。 */
export function tryParseProviderRoundId(round: string | null): string | null {
  if (typeof round !== "string") {
    return null;
  }
  const match = /(\d{1,2})$/.exec(round.trim());
  if (match === null) {
    return null;
  }
  const number = Number(match[1]);
  if (!Number.isInteger(number) || number < 1 || number > 38) {
    return null;
  }
  return String(number).padStart(2, "0");
}

function parseRoundId(round: string | null): string {
  const parsed = tryParseProviderRoundId(round);
  if (parsed === null) {
    if (typeof round !== "string") {
      throw new ProviderDataError("provider fixture round is missing");
    }
    const match = /(\d{1,2})$/.exec(round.trim());
    if (match === null) {
      throw new ProviderDataError("provider fixture round is not a numbered round");
    }
    throw new ProviderDataError("provider fixture round is outside 1..38");
  }
  return parsed;
}

function buildMatch(
  fixture: ProviderFixture,
  homeTeamId: string,
  awayTeamId: string,
  serverNow: Date,
): Match {
  if (fixture.status.kind !== MatchStatus.Scheduled || fixture.kickoffAt === null) {
    throw internalError("Provider 赛程发现只接受 mapper 已验证的 scheduled kickoff");
  }

  const predictionDeadlineAt = computePredictionDeadline(
    fixture.kickoffAt,
    fixture.kickoffConfirmed,
  );
  const predictionClosedAt = decidePredictionClosedAt(
    {
      prediction_closed_at: null,
      prediction_deadline_at: predictionDeadlineAt,
      match_status: MatchStatus.Scheduled,
    },
    MatchStatus.Scheduled,
    serverNow,
  );

  return {
    schema_version: SCHEMA_VERSION,
    match_id: newUuid(),
    league_id: MVP_SEASON.league_id,
    season_id: MVP_SEASON.season_id,
    round_id: parseRoundId(fixture.round),
    home_team_id: homeTeamId,
    away_team_id: awayTeamId,
    kickoff_at: fixture.kickoffAt,
    kickoff_confirmed: fixture.kickoffConfirmed,
    prediction_deadline_at: predictionDeadlineAt,
    prediction_closed_at: predictionClosedAt,
    period_anchor_at: null,
    match_status: MatchStatus.Scheduled,
    settlement_status: SettlementStatus.Pending,
    regular_home_score: null,
    regular_away_score: null,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 0,
    settled_result_version: 0,
    result_source: null,
    scoring_rule_version: FIXED_CONFIG_V1.SCORING_RULE_VERSION,
    finish_detected_at: null,
    settled_at: null,
    created_at: serverNow,
    updated_at: serverNow,
  };
}

function discoveredSnapshot(
  matchId: string,
  fixture: ProviderFixture,
  payload: Record<string, unknown>,
  serverNow: Date,
): ProviderSnapshot {
  return {
    schema_version: SCHEMA_VERSION,
    snapshot_id: newUuid(),
    provider: Provider.ApiFootball,
    entity_type: "match",
    entity_id: matchId,
    provider_entity_id: fixture.providerMatchId,
    event_type: "discovered",
    payload,
    created_at: serverNow,
  };
}

/** 首次发现合法 scheduled fixture 时建立内部 match 与 Provider mapping。 */
export class ProviderScheduleSyncService {
  constructor(private readonly repo: AppRepository) {}

  async discover(
    fixture: ProviderFixture,
    payload: Record<string, unknown>,
    serverNow: Date,
  ): Promise<ProviderScheduleSyncOutcome> {
    assertValidServerNow(serverNow);
    return this.repo.withTransaction(async (tx) => {
      requirePorts(tx);
      if (fixture.status.kind !== MatchStatus.Scheduled || fixture.kickoffAt === null) {
        throw internalError("Provider 赛程发现只接受 mapper 已验证的 scheduled kickoff");
      }

      const existing = await tx.matchProviderMappings.findByProviderAndExternalId(
        Provider.ApiFootball,
        fixture.providerMatchId,
      );
      if (existing !== null) {
        throw internalError("Provider 赛程发现不应重复处理已有 match mapping");
      }

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
        throw internalError("Provider 赛程发现缺少球队 mapping");
      }

      const [homeTeam, awayTeam] = await Promise.all([
        tx.teams.findById(homeMapping.team_id),
        tx.teams.findById(awayMapping.team_id),
      ]);
      if (
        homeTeam === null ||
        awayTeam === null ||
        homeTeam.status !== TeamStatus.Active ||
        awayTeam.status !== TeamStatus.Active
      ) {
        throw internalError("Provider 赛程发现的球队 mapping 不指向 active team");
      }

      const match = buildMatch(
        fixture,
        homeMapping.team_id,
        awayMapping.team_id,
        serverNow,
      );
      await tx.matches.insert(match);
      await tx.matchProviderMappings.insert({
        schema_version: SCHEMA_VERSION,
        match_id: match.match_id,
        provider: Provider.ApiFootball,
        provider_match_id: fixture.providerMatchId,
        created_at: serverNow,
        updated_at: serverNow,
      });
      await tx.providerSnapshots.insert(
        discoveredSnapshot(match.match_id, fixture, payload, serverNow),
      );

      return {
        kind: "applied" as const,
        match_id: match.match_id,
        match_status: MatchStatus.Scheduled,
      };
    });
  }
}
