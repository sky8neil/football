import { describe, expect, it } from "vitest";
import { MatchStatus, SettlementStatus, SyncJobType } from "../domain/enums.js";
import type { Match } from "../domain/types.js";
import { activeWindow } from "./provider-active-window.js";

const NOW = new Date("2026-10-11T12:00:00.000Z");

function match(kickoffAt: Date, status: Match["match_status"] = MatchStatus.Scheduled): Match {
  return {
    kickoff_at: kickoffAt,
    match_status: status,
    settlement_status: SettlementStatus.Pending,
    finish_detected_at: null,
  } as Match;
}

describe("activeWindow", () => {
  it("selects scheduled fixtures between T-24h and T-2h", () => {
    const twoHourCheckpoint = match(new Date(NOW.getTime() + 2 * 60 * 60_000));
    const twoHourCheckpointTail = match(new Date(NOW.getTime() + 2 * 60 * 60_000 + 59_999));
    const outsideTwoHourCheckpoint = match(new Date(NOW.getTime() + 2 * 60 * 60_000 + 60_000));
    const thirtyMinuteCheckpoint = match(new Date(NOW.getTime() + 30 * 60_000));
    const outsideThirtyMinuteCheckpoint = match(new Date(NOW.getTime() + 30 * 60_000 + 60_000));

    expect(activeWindow([
      twoHourCheckpoint,
      twoHourCheckpointTail,
      outsideTwoHourCheckpoint,
      thirtyMinuteCheckpoint,
      outsideThirtyMinuteCheckpoint,
    ], NOW, SyncJobType.NearMatch)).toEqual([
      twoHourCheckpointTail,
      outsideTwoHourCheckpoint,
    ]);
  });

  it("includes live and scheduled matches only from kickoff T-6h through T+2h", () => {
    const scheduledSevenHoursAgo = match(new Date(NOW.getTime() - 7 * 60 * 60_000));
    const scheduledFiveHoursAgo = match(new Date(NOW.getTime() - 5 * 60 * 60_000));
    const liveSevenHoursAgo = match(new Date(NOW.getTime() - 7 * 60 * 60_000), MatchStatus.Live);
    const liveThreeHoursAgo = match(new Date(NOW.getTime() - 3 * 60 * 60_000), MatchStatus.Live);
    const lowerBoundary = match(new Date(NOW.getTime() - 6 * 60 * 60_000));
    const upperBoundary = match(new Date(NOW.getTime() + 2 * 60 * 60_000));
    const outsideUpperBoundary = match(new Date(NOW.getTime() + 2 * 60 * 60_000 + 60_000));

    expect(activeWindow([
      scheduledSevenHoursAgo,
      scheduledFiveHoursAgo,
      liveSevenHoursAgo,
      liveThreeHoursAgo,
      lowerBoundary,
      upperBoundary,
      outsideUpperBoundary,
    ], NOW, SyncJobType.LiveMatch)).toEqual([
      scheduledFiveHoursAgo,
      liveThreeHoursAgo,
      lowerBoundary,
      upperBoundary,
    ]);
  });

  it("keeps near_match selection independent of the live window cutoff", () => {
    const staleScheduled = match(new Date(NOW.getTime() - 7 * 60 * 60_000));
    expect(activeWindow([staleScheduled], NOW, SyncJobType.NearMatch)).toEqual([]);
  });

  it("selects unsettled finished matches and only the daily tick after 24 hours", () => {
    const finished = match(new Date(NOW.getTime() - 2 * 60 * 60_000), MatchStatus.Finished);
    finished.finish_detected_at = NOW;
    const overdue = match(new Date(NOW.getTime() - 25 * 60 * 60_000), MatchStatus.Finished);
    overdue.finish_detected_at = NOW;
    expect(activeWindow([finished, overdue], NOW, SyncJobType.PostFinishVerify)).toEqual([finished]);
    const staleLive = match(new Date(NOW.getTime() - 7 * 60 * 60_000), MatchStatus.Live);
    expect(activeWindow([staleLive], NOW, SyncJobType.PostFinishVerify)).toEqual([staleLive]);
    expect(activeWindow([overdue], new Date("2026-10-12T00:00:00.000Z"), SyncJobType.PostFinishVerify)).toEqual([overdue]);
    overdue.settlement_status = SettlementStatus.Settled;
    expect(activeWindow([overdue], new Date("2026-10-12T00:00:00.000Z"), SyncJobType.PostFinishVerify)).toEqual([]);
  });
});
