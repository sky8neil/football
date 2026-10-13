import { MatchStatus, SettlementStatus, type SyncJobType } from "../domain/enums.js";
import type { Match } from "../domain/types.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export function activeWindow(
  matches: readonly Match[],
  now: Date,
  jobType: SyncJobType,
): Match[] {
  const current = now.getTime();
  return matches.filter((match) => {
    const kickoff = match.kickoff_at.getTime();
    const elapsed = current - kickoff;
    if (jobType === "near_match") {
      const untilKickoff = kickoff - current;
      return match.match_status === MatchStatus.Scheduled &&
        untilKickoff > 2 * HOUR_MS && untilKickoff <= 24 * HOUR_MS;
    }
    if (jobType === "live_match") {
      return match.match_status === MatchStatus.Live ||
        (match.match_status === MatchStatus.Scheduled && kickoff <= current + 2 * HOUR_MS);
    }
    if (jobType === "post_finish_verify") {
      const awaitingFirstSettlement = match.settlement_status === SettlementStatus.Pending ||
        match.settlement_status === SettlementStatus.Waiting;
      const postFinishDue = match.match_status === MatchStatus.Finished ||
        match.finish_detected_at !== null || elapsed >= 105 * MINUTE_MS;
      const withinHighFrequencyWindow = elapsed <= 24 * HOUR_MS;
      const dailyFallbackTick = elapsed > 24 * HOUR_MS && now.getUTCHours() === 0 && now.getUTCMinutes() === 0;
      return awaitingFirstSettlement && postFinishDue && (withinHighFrequencyWindow || dailyFallbackTick);
    }
    return false;
  });
}
