import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MatchStatus,
  SettlementDocStatus,
  SettlementItemStatus,
  SettlementPhase,
  SettlementStatus,
} from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type {
  Match,
  MatchResult,
  Prediction,
  SettlementDoc,
  SettlementItem,
} from "../domain/types.js";
import {
  InMemoryRepository,
  type AppRepository,
  type UnitOfWork,
} from "../infrastructure/repositories.js";
import { FirstSettlementCode } from "./first-settlement.js";
import {
  FirstSettlementService,
  type SettlementItemWorker,
} from "./first-settlement-service.js";
import {
  RetrySettlementService,
  settlementMatchLockKey,
} from "./retry-settlement-service.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const FINISH_AT = new Date(NOW.getTime() - 10 * 60 * 1000);
const RULE = "scoring_v1";

beforeEach(() => vi.useFakeTimers({ now: NOW }));
afterEach(() => vi.useRealTimers());

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    schema_version: 1,
    match_id: newUuid(),
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: newUuid(),
    away_team_id: newUuid(),
    kickoff_at: new Date("2026-08-08T06:00:00Z"),
    kickoff_confirmed: true,
    prediction_deadline_at: new Date("2026-08-08T05:50:00Z"),
    prediction_closed_at: new Date("2026-08-08T05:52:00Z"),
    period_anchor_at: null,
    match_status: MatchStatus.Finished,
    settlement_status: SettlementStatus.Waiting,
    regular_home_score: 2,
    regular_away_score: 1,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 1,
    settled_result_version: 0,
    result_source: "provider",
    scoring_rule_version: RULE,
    finish_detected_at: FINISH_AT,
    settled_at: null,
    created_at: new Date("2026-08-01T00:00:00Z"),
    updated_at: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  } as Match;
}

function makeResult(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    schema_version: 1,
    match_id: newUuid(),
    result_version: 1,
    regular_home_score: 2,
    regular_away_score: 1,
    source: "provider",
    provider_status: "FT",
    admin_id: null,
    reason: null,
    created_at: FINISH_AT,
    ...overrides,
  } as MatchResult;
}

function makeSettlement(overrides: Partial<SettlementDoc> = {}): SettlementDoc {
  return {
    schema_version: 1,
    settlement_id: newUuid(),
    match_id: newUuid(),
    result_version: 1,
    rule_version: RULE,
    status: SettlementDocStatus.Pending,
    phase: SettlementPhase.Prepare,
    is_correction: false,
    started_at: null,
    settled_at: null,
    attempt_count: 0,
    last_error_code: null,
    last_error_message: null,
    created_at: FINISH_AT,
    updated_at: FINISH_AT,
    ...overrides,
  } as SettlementDoc;
}

function makeItem(overrides: Partial<SettlementItem> = {}): SettlementItem {
  return {
    schema_version: 1,
    settlement_id: newUuid(),
    prediction_id: newUuid(),
    user_id: newUuid(),
    old_score: 0,
    new_score: 3,
    score_delta: 3,
    old_wdl_hit: false,
    new_wdl_hit: true,
    old_exact_hit: false,
    new_exact_hit: false,
    valid_prediction_delta: 1,
    source_result_version: 1,
    status: SettlementItemStatus.Pending,
    applied_at: null,
    attempt_count: 0,
    last_error_code: null,
    last_error_message: null,
    created_at: FINISH_AT,
    updated_at: FINISH_AT,
    ...overrides,
  } as SettlementItem;
}

function makePrediction(matchId: string, overrides: Partial<Prediction> = {}): Prediction {
  return {
    schema_version: 1,
    prediction_id: newUuid(),
    user_id: newUuid(),
    match_id: matchId,
    idempotency_key: newUuid(),
    pred_home_score: 2,
    pred_away_score: 1,
    derived_result: "HOME",
    submitted_at: new Date("2026-08-08T05:00:00Z"),
    scoring_rule_version: RULE,
    match_score: null,
    wdl_hit: null,
    exact_hit: null,
    applied_result_version: 0,
    created_at: FINISH_AT,
    updated_at: FINISH_AT,
    ...overrides,
  };
}

function makeFailedSettlement(overrides: Partial<SettlementDoc> = {}): SettlementDoc {
  return makeSettlement({
    status: SettlementDocStatus.Failed,
    phase: SettlementPhase.ApplyItems,
    last_error_code: "SETTLEMENT_ITEM_FAILED",
    last_error_message: "apply item boom",
    ...overrides,
  });
}

async function setup() {
  const repo = new InMemoryRepository();
  const match = makeMatch();
  await repo.matches.insert(match);
  await repo.matchResults.insert(makeResult({ match_id: match.match_id, result_version: 1 }));
  return { repo, match };
}

describe("RetrySettlementService.retry - 成功路径", () => {
  it("failed settlement：只处理 pending/failed items，跳过 applied，settlement/match 置 settled", async () => {
    const { repo, match } = await setup();
    const settlement = makeFailedSettlement({ match_id: match.match_id, result_version: 1 });
    await repo.settlements.insert(settlement);

    const itemPending = makeItem({
      settlement_id: settlement.settlement_id,
      prediction_id: "p1",
    });
    const itemFailed = makeItem({
      settlement_id: settlement.settlement_id,
      prediction_id: "p2",
      status: SettlementItemStatus.Failed,
    });
    const itemApplied = makeItem({
      settlement_id: settlement.settlement_id,
      prediction_id: "p3",
      status: SettlementItemStatus.Applied,
      applied_at: FINISH_AT,
    });
    await repo.settlementItems.insert(itemPending);
    await repo.settlementItems.insert(itemFailed);
    await repo.settlementItems.insert(itemApplied);

    const worker = vi.fn<SettlementItemWorker>(async () => {});
    const service = new RetrySettlementService(repo, worker);

    const outcome = await service.retry(settlement.settlement_id, NOW);

    expect(outcome).toEqual({
      kind: "settled",
      settlement_id: settlement.settlement_id,
      processed_count: 2,
      skipped_applied_count: 1,
    });

    const s = await repo.settlements.findById(settlement.settlement_id);
    expect(s?.status).toBe(SettlementDocStatus.Settled);
    expect(s?.phase).toBe(SettlementPhase.Done);
    expect(s?.settled_at?.getTime()).toBe(NOW.getTime());
    expect(s?.attempt_count).toBe(1);

    const matchAfter = await repo.matches.findById(match.match_id);
    expect(matchAfter?.settlement_status).toBe(SettlementStatus.Settled);
    expect(matchAfter?.settled_result_version).toBe(1);
    expect(matchAfter?.settled_at?.getTime()).toBe(NOW.getTime());

    expect(worker).toHaveBeenCalledTimes(2);
    const calledPredictionIds = worker.mock.calls
      .map((call) => call[0].prediction_id)
      .sort();
    expect(calledPredictionIds).toEqual(["p1", "p2"]);
    expect(worker.mock.calls.some((call) => call[0].prediction_id === "p3")).toBe(false);

    for (const pid of ["p1", "p2", "p3"]) {
      expect(
        (await repo.settlementItems.findBySettlementAndPrediction(settlement.settlement_id, pid))
          ?.status,
      ).toBe(SettlementItemStatus.Applied);
    }
    for (const call of worker.mock.calls) {
      expect(call[0].settlement_id).toBe(settlement.settlement_id);
      expect(call[1]).toMatchObject({
        match_id: match.match_id,
        result_version: 1,
        regular_home_score: 2,
        regular_away_score: 1,
      });
    }
  });

  it("无 items：retry 直接成功 settled", async () => {
    const { repo, match } = await setup();
    const settlement = makeFailedSettlement({ match_id: match.match_id, result_version: 1 });
    await repo.settlements.insert(settlement);

    const service = new RetrySettlementService(repo);
    const outcome = await service.retry(settlement.settlement_id, NOW);

    expect(outcome).toEqual({
      kind: "settled",
      settlement_id: settlement.settlement_id,
      processed_count: 0,
      skipped_applied_count: 0,
    });
    const matchAfter = await repo.matches.findById(match.match_id);
    expect(matchAfter?.settlement_status).toBe(SettlementStatus.Settled);
    expect(matchAfter?.settled_result_version).toBe(1);
  });

  it("retry 为遗漏 prediction 补建 settlement item 后再处理", async () => {
    const { repo, match } = await setup();
    const settlement = makeFailedSettlement({ match_id: match.match_id, result_version: 1 });
    await repo.settlements.insert(settlement);
    const prediction = makePrediction(match.match_id);
    await repo.predictions.insert(prediction);
    const worker = vi.fn<SettlementItemWorker>(async () => {});

    const outcome = await new RetrySettlementService(repo, worker).retry(
      settlement.settlement_id,
      NOW,
    );

    expect(outcome).toMatchObject({ kind: "settled", processed_count: 1 });
    const item = await repo.settlementItems.findBySettlementAndPrediction(
      settlement.settlement_id,
      prediction.prediction_id,
    );
    expect(item).toMatchObject({
      old_score: 0,
      new_score: 12,
      score_delta: 12,
      valid_prediction_delta: 1,
      source_result_version: 1,
      status: SettlementItemStatus.Applied,
    });
    expect(worker).toHaveBeenCalledTimes(1);
  });

  it("finalize 顺序：先写 settled_result_version=v + settled_at（settlement_status 未变），再走状态分支", async () => {
    const { repo, match } = await setup();
    const settlement = makeFailedSettlement({ match_id: match.match_id, result_version: 1 });
    await repo.settlements.insert(settlement);
    await repo.settlementItems.insert(makeItem({ settlement_id: settlement.settlement_id }));

    const matchWrites: Array<{
      kind: "update" | "updateSettlementStatus";
      value: Partial<Match>;
    }> = [];
    const guardedRepo = Object.create(repo) as AppRepository;
    Object.defineProperty(guardedRepo, "withTransaction", {
      value: (fn: (tx: UnitOfWork) => Promise<unknown>) =>
        repo.withTransaction((tx) =>
          fn({
            users: tx.users,
            deletedOpenidMappings: tx.deletedOpenidMappings,
            matches: {
              ...tx.matches,
              update: async (updated: Match) => {
                matchWrites.push({ kind: "update", value: updated });
                await tx.matches.update(updated);
              },
              updateSettlementStatus: async (mid, status, updatedAt) => {
                matchWrites.push({
                  kind: "updateSettlementStatus",
                  value: { match_id: mid, settlement_status: status, updated_at: updatedAt },
                });
                await tx.matches.updateSettlementStatus(mid, status, updatedAt);
              },
            },
            predictions: tx.predictions,
            matchResults: tx.matchResults,
            settlements: tx.settlements,
            settlementItems: tx.settlementItems,
            unlocks: tx.unlocks,
          }),
        ),
    });

    const service = new RetrySettlementService(guardedRepo);
    await service.retry(settlement.settlement_id, NOW);

    const versionWrite = matchWrites.findIndex(
      (write) =>
        write.value.settled_result_version === 1 &&
        write.value.settled_at?.getTime() === NOW.getTime(),
    );
    const statusWrite = matchWrites.findIndex(
      (write) => write.value.settlement_status === SettlementStatus.Settled,
    );
    expect(versionWrite).toBeGreaterThanOrEqual(0);
    expect(statusWrite).toBeGreaterThan(versionWrite);
    expect(matchWrites[versionWrite]?.value.settlement_status).toBe(SettlementStatus.Settling);
    expect(matchWrites[statusWrite]?.value.settled_result_version).toBeUndefined();
  });

  it("起态 failed -> settling 走 transitionMatchSettlementStatus（updateSettlementStatus），无仅改状态的 raw update", async () => {
    const { repo, match } = await setup();
    const settlement = makeFailedSettlement({ match_id: match.match_id, result_version: 1 });
    await repo.settlements.insert(settlement);

    const matchWrites: Array<{
      kind: "update" | "updateSettlementStatus";
      value: Partial<Match>;
    }> = [];
    const guardedRepo = Object.create(repo) as AppRepository;
    Object.defineProperty(guardedRepo, "withTransaction", {
      value: (fn: (tx: UnitOfWork) => Promise<unknown>) =>
        repo.withTransaction((tx) =>
          fn({
            users: tx.users,
            deletedOpenidMappings: tx.deletedOpenidMappings,
            matches: {
              ...tx.matches,
              update: async (updated: Match) => {
                matchWrites.push({ kind: "update", value: updated });
                await tx.matches.update(updated);
              },
              updateSettlementStatus: async (mid, status, updatedAt) => {
                matchWrites.push({
                  kind: "updateSettlementStatus",
                  value: { match_id: mid, settlement_status: status, updated_at: updatedAt },
                });
                await tx.matches.updateSettlementStatus(mid, status, updatedAt);
              },
            },
            predictions: tx.predictions,
            matchResults: tx.matchResults,
            settlements: tx.settlements,
            settlementItems: tx.settlementItems,
            unlocks: tx.unlocks,
          }),
        ),
    });

    const service = new RetrySettlementService(guardedRepo);
    await service.retry(settlement.settlement_id, NOW);

    expect(
      matchWrites.find(
        (w) =>
          w.kind === "updateSettlementStatus" &&
          w.value.settlement_status === SettlementStatus.Settling,
      ),
    ).toBeDefined();
    expect(
      matchWrites.find(
        (w) =>
          w.kind === "update" &&
          w.value.settlement_status === SettlementStatus.Settling &&
          w.value.settled_result_version === undefined &&
          w.value.settled_at === undefined,
      ),
    ).toBeUndefined();
  });

  it("finalize 时 match 已处于非法状态：Fail Closed，抛 MATCH_STATE_CONFLICT，不写 settled", async () => {
    const { repo, match } = await setup();
    const settlement = makeFailedSettlement({ match_id: match.match_id, result_version: 1 });
    await repo.settlements.insert(settlement);
    await repo.settlementItems.insert(makeItem({ settlement_id: settlement.settlement_id }));

    const service = new RetrySettlementService(repo, async () => {
      const latest = await repo.matches.findById(match.match_id);
      if (latest === null) {
        throw new Error("match disappeared");
      }
      await repo.matches.update({
        ...latest,
        settlement_status: SettlementStatus.Pending,
        updated_at: NOW,
      });
    });

    await expect(service.retry(settlement.settlement_id, NOW)).rejects.toMatchObject({
      code: "MATCH_STATE_CONFLICT",
    });

    const matchAfter = await repo.matches.findById(match.match_id);
    expect(matchAfter?.settlement_status).toBe(SettlementStatus.Pending);
    expect(matchAfter?.settled_result_version).toBe(0);
    expect(matchAfter?.settled_at).toBeNull();
    expect((await repo.settlements.findById(settlement.settlement_id))?.status).toBe(
      SettlementDocStatus.Failed,
    );
  });

  it("重试旧版本成功但已有更高结果版本时，保留 correcting 继续排队", async () => {
    const { repo, match } = await setup();
    const settlement = makeFailedSettlement({ match_id: match.match_id, result_version: 1 });
    await repo.settlements.insert(settlement);

    await repo.matchResults.insert(
      makeResult({
        match_id: match.match_id,
        result_version: 2,
        regular_home_score: 1,
        regular_away_score: 1,
      }),
    );
    await repo.matches.update({
      ...match,
      result_version: 2,
      regular_home_score: 1,
      regular_away_score: 1,
      settlement_status: SettlementStatus.Failed,
      updated_at: NOW,
    });

    const outcome = await new RetrySettlementService(repo).retry(
      settlement.settlement_id,
      NOW,
    );

    expect(outcome).toEqual({
      kind: "settled",
      settlement_id: settlement.settlement_id,
      processed_count: 0,
      skipped_applied_count: 0,
    });
    expect(await repo.matches.findById(match.match_id)).toMatchObject({
      result_version: 2,
      settled_result_version: 1,
      settlement_status: SettlementStatus.Correcting,
    });
  });
});

describe("RetrySettlementService.retry - itemWorker 失败", () => {
  it("itemWorker 失败：item -> failed(attempt+1/last_error)，settlement -> failed，已 applied 保留，match -> failed", async () => {
    const { repo, match } = await setup();
    const settlement = makeFailedSettlement({
      match_id: match.match_id,
      result_version: 1,
      attempt_count: 2,
    });
    await repo.settlements.insert(settlement);

    const itemOk = makeItem({ settlement_id: settlement.settlement_id, prediction_id: "p_ok" });
    const itemFail = makeItem({
      settlement_id: settlement.settlement_id,
      prediction_id: "p_fail",
    });
    const itemApplied = makeItem({
      settlement_id: settlement.settlement_id,
      prediction_id: "p_applied",
      status: SettlementItemStatus.Applied,
      applied_at: FINISH_AT,
    });
    await repo.settlementItems.insert(itemOk);
    await repo.settlementItems.insert(itemFail);
    await repo.settlementItems.insert(itemApplied);

    const boom = new Error("apply item boom");
    const service = new RetrySettlementService(repo, async (item: SettlementItem) => {
      if (item.prediction_id === "p_fail") {
        throw boom;
      }
    });

    const outcome = await service.retry(settlement.settlement_id, NOW);

    expect(outcome).toEqual({
      kind: "failed",
      settlement_id: settlement.settlement_id,
      processed_count: 1,
      skipped_applied_count: 0,
    });

    const s = await repo.settlements.findById(settlement.settlement_id);
    expect(s?.status).toBe(SettlementDocStatus.Failed);
    expect(s?.phase).toBe(SettlementPhase.ApplyItems);
    expect(s?.last_error_code).toBe("SETTLEMENT_ITEM_FAILED");
    expect(s?.last_error_message).toBe("apply item boom");
    expect(s?.attempt_count).toBe(3);

    expect(
      (await repo.settlementItems.findBySettlementAndPrediction(settlement.settlement_id, "p_ok"))
        ?.status,
    ).toBe(SettlementItemStatus.Applied);
    expect(
      await repo.settlementItems.findBySettlementAndPrediction(settlement.settlement_id, "p_fail"),
    ).toMatchObject({
      status: SettlementItemStatus.Failed,
      attempt_count: 1,
      last_error_code: "SETTLEMENT_ITEM_FAILED",
      last_error_message: "apply item boom",
    });
    expect(
      (await repo.settlementItems.findBySettlementAndPrediction(
        settlement.settlement_id,
        "p_applied",
      ))?.status,
    ).toBe(SettlementItemStatus.Applied);

    const matchAfter = await repo.matches.findById(match.match_id);
    expect(matchAfter?.settlement_status).toBe(SettlementStatus.Failed);
  });
});

describe("RetrySettlementService.retry - 状态约束", () => {
  it("无效 server_now 在获取 match 锁前 Fail Closed，不修改 settlement 或 match", async () => {
    const { repo, match } = await setup();
    const settlement = makeFailedSettlement({ match_id: match.match_id, result_version: 1 });
    await repo.settlements.insert(settlement);
    const worker = vi.fn<SettlementItemWorker>(async () => {});

    await expect(
      new RetrySettlementService(repo, worker).retry(
        settlement.settlement_id,
        new Date("invalid"),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "server_now" },
    });

    expect(worker).not.toHaveBeenCalled();
    expect(await repo.settlements.findById(settlement.settlement_id)).toEqual(settlement);
    expect(await repo.matches.findById(match.match_id)).toEqual(match);
  });

  it("failed settlement 低于已结算版本时 fail closed，不回退 settled_result_version", async () => {
    const { repo, match } = await setup();
    await repo.matchResults.insert(
      makeResult({
        match_id: match.match_id,
        result_version: 2,
        regular_home_score: 1,
        regular_away_score: 1,
      }),
    );
    await repo.matchResults.insert(
      makeResult({
        match_id: match.match_id,
        result_version: 3,
        regular_home_score: 0,
        regular_away_score: 1,
      }),
    );
    const inconsistentMatch = {
      ...match,
      result_version: 3,
      regular_home_score: 0,
      regular_away_score: 1,
      settled_result_version: 2,
      settlement_status: SettlementStatus.Failed,
      updated_at: NOW,
    };
    await repo.matches.update(inconsistentMatch);
    const settlement = makeFailedSettlement({
      match_id: match.match_id,
      result_version: 1,
    });
    await repo.settlements.insert(settlement);
    const worker = vi.fn<SettlementItemWorker>(async () => {});

    await expect(
      new RetrySettlementService(repo, worker).retry(settlement.settlement_id, NOW),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

    expect(worker).not.toHaveBeenCalled();
    expect(await repo.settlements.findById(settlement.settlement_id)).toMatchObject({
      status: SettlementDocStatus.Failed,
      attempt_count: 0,
    });
    expect(await repo.matches.findById(match.match_id)).toMatchObject({
      result_version: 3,
      settled_result_version: 2,
      settlement_status: SettlementStatus.Failed,
    });
  });

  it("settlement 不存在 -> SETTLEMENT_NOT_FOUND", async () => {
    const repo = new InMemoryRepository();
    const service = new RetrySettlementService(repo);
    await expect(service.retry(newUuid(), NOW)).rejects.toMatchObject({
      code: "SETTLEMENT_NOT_FOUND",
    });
  });

  it("settlement 已 settled：返回 already_settled，不调用 worker、不触碰 items", async () => {
    const { repo, match } = await setup();
    const settlement = makeFailedSettlement({
      match_id: match.match_id,
      result_version: 1,
      status: SettlementDocStatus.Settled,
      phase: SettlementPhase.Done,
      settled_at: NOW,
    });
    await repo.settlements.insert(settlement);
    const itemPending = makeItem({
      settlement_id: settlement.settlement_id,
      prediction_id: "p1",
    });
    await repo.settlementItems.insert(itemPending);

    const worker = vi.fn<SettlementItemWorker>(async () => {});
    const service = new RetrySettlementService(repo, worker);

    const outcome = await service.retry(settlement.settlement_id, NOW);

    expect(outcome).toEqual({
      kind: "already_settled",
      settlement_id: settlement.settlement_id,
    });
    expect(worker).not.toHaveBeenCalled();
    expect(
      (await repo.settlementItems.findBySettlementAndPrediction(
        settlement.settlement_id,
        "p1",
      ))?.status,
    ).toBe(SettlementItemStatus.Pending);
    const matchAfter = await repo.matches.findById(match.match_id);
    expect(matchAfter?.settlement_status).toBe(SettlementStatus.Waiting);
  });

  it("settlement status=running -> already_running，不调用 worker", async () => {
    const { repo, match } = await setup();
    const settlement = makeFailedSettlement({
      match_id: match.match_id,
      result_version: 1,
      status: SettlementDocStatus.Running,
      phase: SettlementPhase.ApplyItems,
    });
    await repo.settlements.insert(settlement);

    const worker = vi.fn<SettlementItemWorker>(async () => {});
    const service = new RetrySettlementService(repo, worker);

    const outcome = await service.retry(settlement.settlement_id, NOW);

    expect(outcome).toEqual({
      kind: "already_running",
      settlement_id: settlement.settlement_id,
      code: FirstSettlementCode.AlreadyRunning,
    });
    expect(worker).not.toHaveBeenCalled();
  });

  it("settlement status=pending -> not_retryable，不调用 worker", async () => {
    const { repo, match } = await setup();
    const settlement = makeFailedSettlement({
      match_id: match.match_id,
      result_version: 1,
      status: SettlementDocStatus.Pending,
      phase: SettlementPhase.Prepare,
    });
    await repo.settlements.insert(settlement);

    const worker = vi.fn<SettlementItemWorker>(async () => {});
    const service = new RetrySettlementService(repo, worker);

    const outcome = await service.retry(settlement.settlement_id, NOW);

    expect(outcome).toEqual({
      kind: "not_retryable",
      settlement_id: settlement.settlement_id,
      status: SettlementDocStatus.Pending,
    });
    expect(worker).not.toHaveBeenCalled();
  });

  it("is_correction=true 的 failed settlement 不走普通 retry，保留给 correction 入口", async () => {
    const { repo, match } = await setup();
    const settlement = makeFailedSettlement({
      match_id: match.match_id,
      result_version: 1,
      is_correction: true,
    });
    await repo.settlements.insert(settlement);
    const item = makeItem({ settlement_id: settlement.settlement_id });
    await repo.settlementItems.insert(item);

    const worker = vi.fn<SettlementItemWorker>(async () => {});
    const service = new RetrySettlementService(repo, worker);

    const outcome = await service.retry(settlement.settlement_id, NOW);

    expect(outcome).toEqual({
      kind: "not_retryable",
      settlement_id: settlement.settlement_id,
      status: SettlementDocStatus.Failed,
    });
    expect(worker).not.toHaveBeenCalled();
    expect(
      (await repo.settlementItems.findBySettlementAndPrediction(
        settlement.settlement_id,
        item.prediction_id,
      ))?.status,
    ).toBe(SettlementItemStatus.Pending);
    expect((await repo.matches.findById(match.match_id))?.settlement_status).toBe(
      SettlementStatus.Waiting,
    );
  });
});

describe("RetrySettlementService.retry - 锁", () => {
  it("match 锁被占用：无法获取锁 -> already_running，不调用 worker", async () => {
    const { repo, match } = await setup();
    const settlement = makeFailedSettlement({ match_id: match.match_id, result_version: 1 });
    await repo.settlements.insert(settlement);

    const lockKey = settlementMatchLockKey(match.match_id);
    await repo.jobLocks.acquire(
      lockKey,
      "other_owner",
      new Date("2026-08-09T00:01:00.000Z"),
    );

    const worker = vi.fn<SettlementItemWorker>(async () => {});
    const service = new RetrySettlementService(repo, worker);

    const outcome = await service.retry(settlement.settlement_id, NOW);

    expect(outcome).toEqual({
      kind: "already_running",
      settlement_id: settlement.settlement_id,
      code: FirstSettlementCode.AlreadyRunning,
    });
    expect(worker).not.toHaveBeenCalled();
    const s = await repo.settlements.findById(settlement.settlement_id);
    expect(s?.status).toBe(SettlementDocStatus.Failed);
    expect(s?.attempt_count).toBe(0);
  });

  it("retry 结束后 finally 释放 match 锁", async () => {
    const { repo, match } = await setup();
    const settlement = makeFailedSettlement({ match_id: match.match_id, result_version: 1 });
    await repo.settlements.insert(settlement);

    const service = new RetrySettlementService(repo);
    await service.retry(settlement.settlement_id, NOW);

    const lockKey = settlementMatchLockKey(match.match_id);
    expect(
      await repo.jobLocks.acquire(
        lockKey,
        "next_owner",
        new Date("2026-08-09T00:01:00.000Z"),
      ),
    ).toBe(true);
  });

  it("长时间 itemWorker 执行期间续租 match 锁", async () => {
    vi.useFakeTimers({ now: NOW });
    let releaseWorker = () => {};
    let operation: Promise<unknown> | undefined;

    try {
      const { repo, match } = await setup();
      const settlement = makeFailedSettlement({ match_id: match.match_id, result_version: 1 });
      await repo.settlements.insert(settlement);
      await repo.settlementItems.insert(makeItem({ settlement_id: settlement.settlement_id }));

      let markWorkerStarted!: () => void;
      const workerStarted = new Promise<void>((resolve) => {
        markWorkerStarted = resolve;
      });
      const workerFinished = new Promise<void>((resolve) => {
        releaseWorker = resolve;
      });
      const worker = vi.fn<SettlementItemWorker>(async () => {
        markWorkerStarted();
        await workerFinished;
      });
      const service = new RetrySettlementService(repo, worker);

      operation = service.retry(settlement.settlement_id, NOW);
      await workerStarted;
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

      expect(
        await repo.jobLocks.acquire(
          settlementMatchLockKey(match.match_id),
          "other_owner",
          new Date("2026-08-09T00:01:00.000Z"),
        ),
      ).toBe(false);

      releaseWorker();
      await operation;
    } finally {
      releaseWorker();
      if (operation !== undefined) {
        await operation.catch(() => undefined);
      }
      vi.useRealTimers();
    }
  });
});

describe("RetrySettlementService.retry - 部分失败恢复集成", () => {
  it("first-settlement 失败后 retry 恢复：applied 不重复 worker，重复 retry settled 无副作用", async () => {
    const { repo, match } = await setup();
    const settlement = makeSettlement({ match_id: match.match_id, result_version: 1 });
    await repo.settlements.insert(settlement);
    const itemOk = makeItem({ settlement_id: settlement.settlement_id, prediction_id: "p_ok" });
    const itemFail = makeItem({
      settlement_id: settlement.settlement_id,
      prediction_id: "p_fail",
    });
    await repo.settlementItems.insert(itemOk);
    await repo.settlementItems.insert(itemFail);

    const firstService = new FirstSettlementService(repo, async (item: SettlementItem) => {
      if (item.prediction_id === "p_fail") {
        throw new Error("boom first");
      }
    });
    await expect(firstService.start(match.match_id, NOW, false)).rejects.toThrow("boom first");

    const failed = await repo.settlements.findById(settlement.settlement_id);
    expect(failed?.status).toBe(SettlementDocStatus.Failed);
    const matchAfterFail = await repo.matches.findById(match.match_id);
    expect(matchAfterFail?.settlement_status).toBe(SettlementStatus.Failed);
    expect(
      (await repo.settlementItems.findBySettlementAndPrediction(
        settlement.settlement_id,
        "p_ok",
      ))?.status,
    ).toBe(SettlementItemStatus.Applied);

    const workerCalls: string[] = [];
    const retryService = new RetrySettlementService(repo, async (item: SettlementItem) => {
      workerCalls.push(item.prediction_id);
    });
    const outcome = await retryService.retry(settlement.settlement_id, NOW);

    expect(outcome).toEqual({
      kind: "settled",
      settlement_id: settlement.settlement_id,
      processed_count: 1,
      skipped_applied_count: 1,
    });
    expect(workerCalls).toEqual(["p_fail"]);
    expect(
      (await repo.settlementItems.findBySettlementAndPrediction(
        settlement.settlement_id,
        "p_fail",
      ))?.status,
    ).toBe(SettlementItemStatus.Applied);
    const matchAfter = await repo.matches.findById(match.match_id);
    expect(matchAfter?.settlement_status).toBe(SettlementStatus.Settled);
    expect(matchAfter?.settled_result_version).toBe(1);

    const again = await retryService.retry(settlement.settlement_id, NOW);
    expect(again).toEqual({
      kind: "already_settled",
      settlement_id: settlement.settlement_id,
    });
    expect(workerCalls).toEqual(["p_fail"]);
  });
});
