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
  it("selects only the T-2h and T-30m pre-match checkpoints", () => {
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
      twoHourCheckpoint,
      twoHourCheckpointTail,
      thirtyMinuteCheckpoint,
    ]);
  });

  it("selects from ten minutes before kickoff through three hours after kickoff", () => {
    expect(activeWindow([
      match(new Date(NOW.getTime() + 10 * 60_000)),
      match(new Date(NOW.getTime() - 3 * 60 * 60_000), MatchStatus.Live),
      match(new Date(NOW.getTime() + 10 * 60_000 + 1)),
      match(new Date(NOW.getTime() - 3 * 60 * 60_000 - 1), MatchStatus.Live),
    ], NOW, SyncJobType.LiveMatch)).toHaveLength(2);
  });

  it("selects unsettled finished matches and only the daily tick after 24 hours", () => {
    const finished = match(new Date(NOW.getTime() - 2 * 60 * 60_000), MatchStatus.Finished);
    finished.finish_detected_at = NOW;
    const overdue = match(new Date(NOW.getTime() - 25 * 60 * 60_000), MatchStatus.Finished);
    overdue.finish_detected_at = NOW;
    expect(activeWindow([finished, overdue], NOW, SyncJobType.PostFinishVerify)).toEqual([finished]);
    expect(activeWindow([overdue], new Date("2026-10-12T00:00:00.000Z"), SyncJobType.PostFinishVerify)).toEqual([overdue]);
    overdue.settlement_status = SettlementStatus.Settled;
    expect(activeWindow([overdue], new Date("2026-10-12T00:00:00.000Z"), SyncJobType.PostFinishVerify)).toEqual([]);
  });
});
