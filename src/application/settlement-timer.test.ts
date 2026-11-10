import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MatchStatus,
  SettlementDocStatus,
  SettlementPhase,
  SettlementStatus,
} from "../domain/enums.js";
import type { Match, SettlementDoc } from "../domain/types.js";
import { InMemorySchedulerStateStore } from "../infrastructure/cloudbase-scheduler-state.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { SettlementOrchestrationService } from "./settlement-orchestration-service.js";
import { runSettlementTimer } from "./settlement-timer.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const T1 = new Date("2026-08-08T12:00:00.000Z");
const T2 = new Date("2026-08-08T13:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    schema_version: 1,
    match_id: "m1",
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: "home",
    away_team_id: "away",
    kickoff_at: T1,
    kickoff_confirmed: true,
    prediction_deadline_at: T1,
    prediction_closed_at: T1,
    period_anchor_at: T1,
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
    finish_detected_at: T1,
    settled_at: null,
    created_at: T1,
    updated_at: T1,
    ...overrides,
  } as Match;
}

function makeSettlement(overrides: Partial<SettlementDoc> = {}): SettlementDoc {
  return {
    schema_version: 1,
    settlement_id: "s1",
    match_id: "m1",
    result_version: 1,
    rule_version: "scoring_v1",
    status: SettlementDocStatus.Failed,
    phase: SettlementPhase.ApplyItems,
    is_correction: false,
    started_at: T1,
    settled_at: null,
    attempt_count: 1,
    last_error_code: "ERR",
    last_error_message: "fail",
    created_at: T1,
    updated_at: T1,
    ...overrides,
  };
}

type StoreHolder = { store: { matchesById: Map<string, Match> } };

function plantLeak(repo: InMemoryRepository, match: Match): void {
  (repo as unknown as StoreHolder).store.matchesById.set(match.match_id, match);
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
  const correct = vi.spyOn(SettlementOrchestrationService.prototype, "correct").mockResolvedValue({
    kind: "already_settled",
    settlement_id: "s-correct",
    processed_count: 0,
    skipped_applied_count: 0,
  } as never);
  const retry = vi.spyOn(SettlementOrchestrationService.prototype, "retry").mockResolvedValue({
    kind: "already_settled",
    settlement_id: "s-retry",
    processed_count: 0,
    skipped_applied_count: 0,
  } as never);
  return { startFirst, correct, retry };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runSettlementTimer", () => {
  it("已结算且 settled_result_version >= result_version：跳过且不调用任何 service", async () => {
    const repo = new InMemoryRepository();
    await repo.matches.insert(
      makeMatch({
        match_id: "caught-up",
        settlement_status: SettlementStatus.Settled,
        result_version: 2,
        settled_result_version: 2,
        settled_at: T1,
      }),
    );
    await repo.settlements.insert(
      makeSettlement({
        settlement_id: "s-failed",
        match_id: "caught-up",
        status: SettlementDocStatus.Failed,
      }),
    );
    const spies = spyOrchestration();

    const outcomes = await runSettlementTimer(repo, NOW, {});

    expect(outcomes).toEqual([{ match_id: "caught-up", outcome: { kind: "skipped" } }]);
    expect(spies.startFirst).not.toHaveBeenCalled();
    expect(spies.correct).not.toHaveBeenCalled();
    expect(spies.retry).not.toHaveBeenCalled();
  });

  it("新完场 pending：调用 startFirst", async () => {
    const repo = new InMemoryRepository();
    await repo.matches.insert(
      makeMatch({ match_id: "fresh", settlement_status: SettlementStatus.Pending }),
    );
    const spies = spyOrchestration();

    await runSettlementTimer(repo, NOW, {});

    expect(spies.startFirst).toHaveBeenCalledWith("fresh", NOW, false);
    expect(spies.correct).not.toHaveBeenCalled();
    expect(spies.retry).not.toHaveBeenCalled();
  });

  it("correcting 且 result_version > settled_result_version：调用 correct", async () => {
    const repo = new InMemoryRepository();
    await repo.matches.insert(
      makeMatch({
        match_id: "corr",
        settlement_status: SettlementStatus.Correcting,
        result_version: 3,
        settled_result_version: 1,
        settled_at: T1,
      }),
    );
    const spies = spyOrchestration();

    await runSettlementTimer(repo, NOW, {});

    expect(spies.correct).toHaveBeenCalledWith("corr", NOW);
    expect(spies.startFirst).not.toHaveBeenCalled();
    expect(spies.retry).not.toHaveBeenCalled();
  });

  it("failed 且存在未完成 settlement：调用 retry", async () => {
    const repo = new InMemoryRepository();
    await repo.matches.insert(
      makeMatch({ match_id: "fail", settlement_status: SettlementStatus.Failed }),
    );
    await repo.settlements.insert(
      makeSettlement({
        settlement_id: "s-open",
        match_id: "fail",
        status: SettlementDocStatus.Failed,
      }),
    );
    const spies = spyOrchestration();

    await runSettlementTimer(repo, NOW, {});

    expect(spies.retry).toHaveBeenCalledWith("s-open", NOW);
    expect(spies.startFirst).not.toHaveBeenCalled();
    expect(spies.correct).not.toHaveBeenCalled();
  });

  it("待办批量上限：100 条候选、batch=50，本轮最多处理 50 条", async () => {
    const repo = new InMemoryRepository();
    for (let index = 0; index < 100; index += 1) {
      await repo.matches.insert(
        makeMatch({
          match_id: `todo-${String(index).padStart(3, "0")}`,
          kickoff_at: new Date(T1.getTime() + index * 60_000),
          settlement_status: SettlementStatus.Pending,
        }),
      );
    }
    const spies = spyOrchestration();

    const outcomes = await runSettlementTimer(repo, NOW, {
      env: { FOOTBALL_SETTLEMENT_TODO_BATCH: "50" },
    });

    expect(spies.startFirst).toHaveBeenCalledTimes(50);
    expect(outcomes).toHaveLength(50);
  });

  it("兜底未到期（last_run_at 1 小时前）：不发起兜底分页查询", async () => {
    const repo = new InMemoryRepository();
    const matches = repo.matches;
    const fallbackPage = vi.spyOn(matches, "findSettlementFallbackPage");
    Object.defineProperty(repo, "matches", { configurable: true, get: () => matches });
    const schedulerState = new InMemorySchedulerStateStore();
    await schedulerState.upsertSettlementFallback({
      cursor_kickoff_at: null,
      cursor_match_id: null,
      last_run_at: new Date(NOW.getTime() - HOUR),
      updated_at: new Date(NOW.getTime() - HOUR),
    });
    spyOrchestration();

    await runSettlementTimer(repo, NOW, { schedulerState });

    expect(fallbackPage).not.toHaveBeenCalled();
    const after = await schedulerState.getSettlementFallback();
    expect(after?.last_run_at).toEqual(new Date(NOW.getTime() - HOUR));
  });

  it("兜底到期：分页命中 settled 但 result_version 更大的漏标 → correct，且游标推进", async () => {
    const repo = new InMemoryRepository();
    const legalA = makeMatch({
      match_id: "leak-a",
      kickoff_at: T1,
      settlement_status: SettlementStatus.Settled,
      result_version: 1,
      settled_result_version: 1,
      settled_at: T1,
    });
    const legalB = makeMatch({
      match_id: "leak-b",
      kickoff_at: T2,
      settlement_status: SettlementStatus.Settled,
      result_version: 1,
      settled_result_version: 1,
      settled_at: T1,
    });
    await repo.matches.insert(legalA);
    await repo.matches.insert(legalB);
    plantLeak(repo, { ...legalA, result_version: 2 });
    plantLeak(repo, { ...legalB, result_version: 2 });
    const schedulerState = new InMemorySchedulerStateStore();
    const spies = spyOrchestration();

    await runSettlementTimer(repo, NOW, {
      env: { FOOTBALL_SETTLEMENT_TODO_BATCH: "1" },
      schedulerState,
    });

    expect(spies.correct).toHaveBeenCalledWith("leak-a", NOW);
    expect(spies.startFirst).not.toHaveBeenCalled();
    const after = await schedulerState.getSettlementFallback();
    expect(after?.cursor_match_id).toBe("leak-a");
    expect(after?.cursor_kickoff_at).toEqual(T1);
    expect(after?.last_run_at).toEqual(NOW);
  });

  it("分页不足 limit 时游标被清空", async () => {
    const repo = new InMemoryRepository();
    await repo.matches.insert(
      makeMatch({
        match_id: "tail",
        kickoff_at: T2,
        settlement_status: SettlementStatus.Settled,
        result_version: 1,
        settled_result_version: 1,
        settled_at: T1,
      }),
    );
    const schedulerState = new InMemorySchedulerStateStore();
    await schedulerState.upsertSettlementFallback({
      cursor_kickoff_at: T1,
      cursor_match_id: "earlier",
      last_run_at: NOW,
      updated_at: NOW,
    });
    spyOrchestration();

    await runSettlementTimer(repo, NOW, {
      env: { FOOTBALL_SETTLEMENT_TODO_BATCH: "50" },
      schedulerState,
    });

    const after = await schedulerState.getSettlementFallback();
    expect(after?.cursor_kickoff_at).toBeNull();
    expect(after?.cursor_match_id).toBeNull();
  });
});
