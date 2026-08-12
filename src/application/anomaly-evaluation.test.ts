import { describe, expect, it } from "vitest";
import {
  AnomalyStatus,
  AnomalyType,
  MatchStatus,
  SettlementStatus,
} from "../domain/enums.js";
import type { Match } from "../domain/types.js";
import { newUuid } from "../domain/ids.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { AnomalyEvaluationService } from "./anomaly-evaluation.js";

const NOW = new Date("2026-08-09T03:00:00.000Z");

function makeMatch(overrides: Partial<Match> = {}): Match {
  const kickoffAt = new Date("2026-08-08T00:00:00.000Z");
  return {
    schema_version: 1,
    match_id: newUuid(),
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: newUuid(),
    away_team_id: newUuid(),
    kickoff_at: kickoffAt,
    kickoff_confirmed: true,
    prediction_deadline_at: new Date(kickoffAt.getTime() - 10 * 60 * 1000),
    prediction_closed_at: kickoffAt,
    period_anchor_at: kickoffAt,
    match_status: MatchStatus.Live,
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
    scoring_rule_version: "scoring_v1",
    finish_detected_at: null,
    settled_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe("AnomalyEvaluationService", () => {
  it("持久化 live stale、live too long 与 finished no score 的确定性异常", async () => {
    const repo = new InMemoryRepository();
    const liveMatch = makeMatch();
    const finishedMatch = makeMatch({
      match_status: MatchStatus.Finished,
      period_anchor_at: null,
      finish_detected_at: new Date("2026-08-09T02:30:00.000Z"),
    });
    await repo.matches.insert(liveMatch);
    await repo.matches.insert(finishedMatch);

    const service = new AnomalyEvaluationService(repo);

    await service.evaluate(liveMatch.match_id, null, NOW);
    await service.evaluate(finishedMatch.match_id, null, NOW);

    await expect(
      repo.anomalies.findByKey(`${liveMatch.match_id}:${AnomalyType.LiveSyncStale}`),
    ).resolves.toMatchObject({
      status: AnomalyStatus.Open,
      blocking: false,
      details: { last_successful_sync_at: null },
    });
    await expect(
      repo.anomalies.findByKey(`${liveMatch.match_id}:${AnomalyType.LiveTooLong}`),
    ).resolves.toMatchObject({ status: AnomalyStatus.Open, blocking: true });
    await expect(
      repo.anomalies.findByKey(`${finishedMatch.match_id}:${AnomalyType.FinishedNoScore}`),
    ).resolves.toMatchObject({ status: AnomalyStatus.Open, blocking: true });
  });

  it("触发条件消失时按确定性规则 resolve，且不创建不存在的 anomaly", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch();
    await repo.matches.insert(match);
    const service = new AnomalyEvaluationService(repo);

    await service.evaluate(match.match_id, null, NOW);
    await repo.matches.update({
      ...match,
      match_status: MatchStatus.Finished,
      updated_at: NOW,
    });
    const opened = await service.evaluate(
      match.match_id,
      new Date("2026-08-09T02:55:00.000Z"),
      NOW,
    );

    expect(opened.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: AnomalyType.LiveSyncStale,
        result: expect.objectContaining({ kind: "resolved" }),
      }),
      expect.objectContaining({
        type: AnomalyType.LiveTooLong,
        result: expect.objectContaining({ kind: "resolved" }),
      }),
    ]));
    await expect(
      repo.anomalies.findByKey(`${match.match_id}:${AnomalyType.LiveSyncStale}`),
    ).resolves.toMatchObject({ status: AnomalyStatus.Resolved });
    await expect(
      repo.anomalies.findByKey(`${match.match_id}:${AnomalyType.LiveTooLong}`),
    ).resolves.toMatchObject({ status: AnomalyStatus.Resolved });
    await expect(
      repo.anomalies.findByKey(`${match.match_id}:${AnomalyType.FinishedNoScore}`),
    ).resolves.toBeNull();
  });
});
