import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnomalyStatus,
  AnomalyType,
  MatchStatus,
  SettlementStatus,
} from "../domain/enums.js";
import type { Anomaly, Match } from "../domain/types.js";
import {
  InMemoryRepository,
  type MatchRepository,
} from "../infrastructure/repositories.js";
import { SettlementOrchestrationService } from "./settlement-orchestration-service.js";
import { runSettlementTimer } from "./settlement-timer.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const BASE = new Date("2026-08-01T12:00:00.000Z");

function kickoff(offsetMinutes: number): Date {
  return new Date(BASE.getTime() + offsetMinutes * 60_000);
}

function makeMatch(matchId: string, kickoffAt: Date): Match {
  return {
    schema_version: 1,
    match_id: matchId,
    canonical_match_id: matchId,
    superseded_by: null,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: "home",
    away_team_id: "away",
    kickoff_at: kickoffAt,
    kickoff_confirmed: true,
    prediction_deadline_at: kickoffAt,
    prediction_closed_at: kickoffAt,
    period_anchor_at: kickoffAt,
    match_status: MatchStatus.Finished,
    settlement_status: SettlementStatus.Pending,
    regular_home_score: 1,
    regular_away_score: 0,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 1,
    settled_result_version: 0,
    result_source: "provider",
    scoring_rule_version: "scoring_v1",
    finish_detected_at: kickoffAt,
    settled_at: null,
    created_at: kickoffAt,
    updated_at: kickoffAt,
  } as Match;
}

function makeBlockingAnomaly(matchId: string): Anomaly {
  return {
    schema_version: 1,
    anomaly_id: `anomaly-${matchId}`,
    anomaly_key: `${matchId}:${AnomalyType.UnexpectedProviderStatus}`,
    match_id: matchId,
    type: AnomalyType.UnexpectedProviderStatus,
    blocking: true,
    status: AnomalyStatus.Open,
    first_seen_at: BASE,
    last_seen_at: BASE,
    occurrence_count: 1,
    details: {},
    resolved_at: null,
    resolution: null,
  };
}

function padded(index: number): string {
  return String(index).padStart(2, "0");
}

function pinMatches(repo: InMemoryRepository): MatchRepository {
  const matches = repo.matches;
  Object.defineProperty(repo, "matches", {
    configurable: true,
    get: () => matches,
  });
  return matches;
}

async function seedBlocked(
  repo: InMemoryRepository,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const matchId = `blocked-${padded(index)}`;
    await repo.matches.insert(makeMatch(matchId, kickoff(index)));
    await repo.anomalies.insert(makeBlockingAnomaly(matchId));
  }
}

async function seedFresh(
  repo: InMemoryRepository,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await repo.matches.insert(
      makeMatch(`fresh-${padded(index)}`, kickoff(100 + index)),
    );
  }
}

function spyOrchestration() {
  const startFirst = vi
    .spyOn(SettlementOrchestrationService.prototype, "startFirst")
    .mockResolvedValue({
      kind: "started",
      settlement_id: "s-first",
      settlement_created: true,
      processed_count: 0,
      skipped_applied_count: 0,
    });
  const correct = vi
    .spyOn(SettlementOrchestrationService.prototype, "correct")
    .mockResolvedValue({ kind: "already_settled" } as never);
  const retry = vi
    .spyOn(SettlementOrchestrationService.prototype, "retry")
    .mockResolvedValue({ kind: "already_settled" } as never);
  return { startFirst, correct, retry };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runSettlementTimer 阻塞异常续扫", () => {
  it("首批被阻塞异常占满时沿游标续扫，由后页新完场填满可执行配额", async () => {
    const repo = new InMemoryRepository();
    const findTodos = vi.spyOn(pinMatches(repo), "findSettlementTodos");
    await seedBlocked(repo, 12);
    await seedFresh(repo, 7);
    const spies = spyOrchestration();

    const outcomes = await runSettlementTimer(repo, NOW, {
      env: { FOOTBALL_SETTLEMENT_TODO_BATCH: "5" },
    });

    expect(spies.startFirst).toHaveBeenCalledTimes(5);
    expect(spies.startFirst.mock.calls.map(([matchId]) => matchId)).toEqual([
      "fresh-00",
      "fresh-01",
      "fresh-02",
      "fresh-03",
      "fresh-04",
    ]);
    expect(spies.correct).not.toHaveBeenCalled();
    expect(spies.retry).not.toHaveBeenCalled();
    expect(outcomes).toHaveLength(5);
    expect(findTodos.mock.calls.length).toBeGreaterThan(1);
    expect(findTodos.mock.calls[1]?.[0].after).toEqual({
      kickoff_at: kickoff(4),
      match_id: "blocked-04",
    });
  });

  it("全部待办均被阻塞异常占满时终止扫描，不调用结算服务也不死循环", async () => {
    const repo = new InMemoryRepository();
    const findTodos = vi.spyOn(pinMatches(repo), "findSettlementTodos");
    await seedBlocked(repo, 12);
    const spies = spyOrchestration();

    const outcomes = await runSettlementTimer(repo, NOW, {
      env: { FOOTBALL_SETTLEMENT_TODO_BATCH: "5" },
    });

    expect(outcomes).toEqual([]);
    expect(spies.startFirst).not.toHaveBeenCalled();
    expect(spies.correct).not.toHaveBeenCalled();
    expect(spies.retry).not.toHaveBeenCalled();
    expect(findTodos).toHaveBeenCalledTimes(3);
    expect(findTodos.mock.calls.map(([query]) => query.after)).toEqual([
      null,
      { kickoff_at: kickoff(4), match_id: "blocked-04" },
      { kickoff_at: kickoff(9), match_id: "blocked-09" },
    ]);
  });

  it("阻塞与新完场同页混排时只计可执行场次，继续补扫到配额", async () => {
    const repo = new InMemoryRepository();
    await seedBlocked(repo, 2);
    await seedFresh(repo, 4);
    for (let index = 0; index < 2; index += 1) {
      await repo.matches.insert(
        makeMatch(`middle-${padded(index)}`, kickoff(50 + index)),
      );
    }
    const spies = spyOrchestration();

    await runSettlementTimer(repo, NOW, {
      env: { FOOTBALL_SETTLEMENT_TODO_BATCH: "3" },
    });

    expect(spies.startFirst).toHaveBeenCalledTimes(3);
    expect(spies.startFirst.mock.calls.map(([matchId]) => matchId)).toEqual([
      "middle-00",
      "middle-01",
      "fresh-00",
    ]);
  });
});
