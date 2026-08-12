import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { AnomalyType, MatchStatus } from "../domain/enums.js";
import { notFoundError, validationError } from "../domain/errors.js";
import type { Match } from "../domain/types.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";
import {
  finishedNoScoreDecision,
  liveSyncStaleDecision,
  liveTooLongDecision,
} from "../sync/anomalies.js";
import {
  persistAnomalyInTransaction,
  type AnomalyPersistenceResult,
  type PersistableAnomalyDecision,
} from "./anomaly-persistence.js";

export interface MatchAnomalyEvaluationResult {
  type: AnomalyType;
  result: AnomalyPersistenceResult;
}

export interface MatchAnomalyEvaluationOutcome {
  match_id: string;
  results: MatchAnomalyEvaluationResult[];
}

function assertValidDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw validationError(`${field} 必须是有效时间`, { field });
  }
}

function hasLegalRegularScore(match: Match): boolean {
  const homeScore = match.regular_home_score;
  const awayScore = match.regular_away_score;
  return (
    typeof homeScore === "number" &&
    Number.isInteger(homeScore) &&
    typeof awayScore === "number" &&
    Number.isInteger(awayScore) &&
    homeScore >= FIXED_CONFIG_V1.FINAL_SCORE_MIN &&
    homeScore <= FIXED_CONFIG_V1.FINAL_SCORE_MAX &&
    awayScore >= FIXED_CONFIG_V1.FINAL_SCORE_MIN &&
    awayScore <= FIXED_CONFIG_V1.FINAL_SCORE_MAX
  );
}

function staleDetails(lastSuccessfulSyncAt: Date | null): Record<string, unknown> {
  return {
    last_successful_sync_at: lastSuccessfulSyncAt?.toISOString() ?? null,
  };
}

function liveTooLongDetails(match: Match, serverNow: Date): Record<string, unknown> {
  return {
    period_anchor_at: match.period_anchor_at?.toISOString() ?? null,
    server_now: serverNow.toISOString(),
  };
}

function finishedNoScoreDetails(match: Match, hasLegalScore: boolean): Record<string, unknown> {
  return {
    finish_detected_at: match.finish_detected_at?.toISOString() ?? null,
    regular_home_score: match.regular_home_score,
    regular_away_score: match.regular_away_score,
    has_legal_score: hasLegalScore,
  };
}

async function persistDecision(
  tx: Pick<UnitOfWork, "anomalies">,
  matchId: string,
  type: AnomalyType,
  decision: PersistableAnomalyDecision,
  details: Record<string, unknown>,
  serverNow: Date,
): Promise<MatchAnomalyEvaluationResult> {
  return {
    type,
    result: await persistAnomalyInTransaction(
      tx,
      matchId,
      type,
      decision,
      details,
      serverNow,
    ),
  };
}

/** 将 33.1~33.3 的确定性决策在一次事务内写入既有 match anomaly。 */
export class AnomalyEvaluationService {
  constructor(private readonly repo: AppRepository) {}

  async evaluate(
    matchId: string,
    lastSuccessfulSyncAt: Date | null,
    serverNow: Date,
  ): Promise<MatchAnomalyEvaluationOutcome> {
    assertValidDate(serverNow, "server_now");
    if (lastSuccessfulSyncAt !== null) {
      assertValidDate(lastSuccessfulSyncAt, "last_successful_sync_at");
    }

    return this.repo.withTransaction(async (tx) => {
      const match = await tx.matches.findById(matchId);
      if (match === null) {
        throw notFoundError("MATCH");
      }

      const results: MatchAnomalyEvaluationResult[] = [];
      results.push(
        await persistDecision(
          tx,
          match.match_id,
          AnomalyType.LiveSyncStale,
          liveSyncStaleDecision(match.match_status, lastSuccessfulSyncAt, serverNow),
          staleDetails(lastSuccessfulSyncAt),
          serverNow,
        ),
      );

      const tooLongDecision = liveTooLongDecision(
        match.match_status,
        match.period_anchor_at,
        serverNow,
      );
      if (tooLongDecision !== null) {
        results.push(
          await persistDecision(
            tx,
            match.match_id,
            AnomalyType.LiveTooLong,
            tooLongDecision,
            liveTooLongDetails(match, serverNow),
            serverNow,
          ),
        );
      }

      const hasLegalScore = hasLegalRegularScore(match);
      results.push(
        await persistDecision(
          tx,
          match.match_id,
          AnomalyType.FinishedNoScore,
          finishedNoScoreDecision(
            match.match_status,
            match.finish_detected_at,
            hasLegalScore,
            serverNow,
          ),
          finishedNoScoreDetails(match, hasLegalScore),
          serverNow,
        ),
      );

      return { match_id: match.match_id, results };
    });
  }
}
