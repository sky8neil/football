import { SUPPORTED_LEAGUES } from "../domain/config.js";
import {
  MatchStatus,
  SettlementDocStatus,
  SettlementStatus,
} from "../domain/enums.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { SettlementOrchestrationService } from "./settlement-orchestration-service.js";

/** 每次定时触发都推进结算，独立于 Provider 是否有同步配额。 */
export async function runSettlementTimer(repo: AppRepository, now: Date) {
  const service = new SettlementOrchestrationService(repo);
  const ids = new Set<string>();
  for (const season of new Set(
    SUPPORTED_LEAGUES.map((league) => league.season_id),
  )) {
    for (const match of await repo.matches.findBySeason(season)) {
      if (
        match.match_status === MatchStatus.Finished &&
        match.settlement_status !== SettlementStatus.Voided
      )
        ids.add(match.match_id);
    }
  }
  for (const status of [
    SettlementDocStatus.Running,
    SettlementDocStatus.Failed,
  ]) {
    for (const settlement of await repo.settlements.findByStatus(status))
      ids.add(settlement.match_id);
  }
  const outcomes: { match_id: string; outcome: unknown }[] = [];
  for (const matchId of ids) {
    try {
      const match = await repo.matches.findById(matchId);
      if (!match || match.match_status !== MatchStatus.Finished) continue;
      if ((await repo.anomalies?.findOpenBlockingByMatch(matchId))?.length)
        continue;
      const outstanding = (await repo.settlements.findByMatch(matchId))
        .filter(
          (row) =>
            row.status === SettlementDocStatus.Running ||
            row.status === SettlementDocStatus.Failed,
        )
        .sort((a, b) => a.result_version - b.result_version)[0];
      const outcome = outstanding
        ? await service.retry(outstanding.settlement_id, now)
        : match.settled_result_version > 0 &&
            match.result_version > match.settled_result_version
          ? await service.correct(matchId, now)
          : await service.startFirst(matchId, now, false);
      outcomes.push({ match_id: matchId, outcome });
    } catch (error) {
      outcomes.push({
        match_id: matchId,
        outcome: {
          kind: "failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  return outcomes;
}
