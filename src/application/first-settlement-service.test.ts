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
  settlementMatchLockKey,
  type SettlementItemWorker,
} from "./first-settlement-service.js";

const TEN_MINUTES_MS = 10 * 60 * 1000;
const NOW = new Date("2026-08-09T00:00:00.000Z");
const FINISH_AT = new Date(NOW.getTime() - TEN_MINUTES_MS);
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

async function setup(overrides: { match?: Partial<Match> } = {}) {
  const repo = new InMemoryRepository();
  const match = makeMatch(overrides.match);
  await repo.matches.insert(match);
  await repo.matchResults.insert(makeResult({ match_id: match.match_id, result_version: 1 }));
  return { repo, match };
}

describe("FirstSettlementService.start - server_now 边界", () => {
  it("无效 server_now 在获取 match settlement lock 前 Fail Closed", async () => {
    const { repo, match } = await setup();
    const acquire = vi.fn(repo.jobLocks.acquire);
    const guardedRepo = Object.create(repo) as AppRepository;
    Object.defineProperty(guardedRepo, "jobLocks", {
      value: { ...repo.jobLocks, acquire },
    });

    await expect(
      new FirstSettlementService(guardedRepo).start(
        match.match_id,
        new Date("invalid"),
        false,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "server_now" },
    });
    expect(acquire).not.toHaveBeenCalled();
    await expect(repo.matches.findById(match.match_id)).resolves.toEqual(match);
    await expect(repo.settlements.findByStatus(SettlementDocStatus.Pending)).resolves.toEqual([]);
  });
});

describe("FirstSettlementService.start - 成功路径", () => {
  it("复用 pending settlement：处理 pending/failed items，跳过 applied，最终 match/settlement 置 settled", async () => {
    const { repo, match } = await setup();
    const settlement = makeSettlement({
      match_id: match.match_id,
      result_version: 1,
      status: SettlementDocStatus.Pending,
    });
    await repo.settlements.insert(settlement);

    const itemPending = makeItem({
      settlement_id: settlement.settlement_id,
      prediction_id: "p1",
    });
    const itemApplied = makeItem({
      settlement_id: settlement.settlement_id,
      prediction_id: "p2",
      status: SettlementItemStatus.Applied,
      applied_at: FINISH_AT,
    });
    const itemFailed = makeItem({
      settlement_id: settlement.settlement_id,
      prediction_id: "p3",
      status: SettlementItemStatus.Failed,
    });
    await repo.settlementItems.insert(itemPending);
    await repo.settlementItems.insert(itemApplied);
    await repo.settlementItems.insert(itemFailed);

    const worker = vi.fn<SettlementItemWorker>(async () => {});
    const service = new FirstSettlementService(repo, worker);

    const outcome = await service.start(match.match_id, NOW, false);

    expect(outcome).toEqual({
      kind: "started",
      settlement_id: settlement.settlement_id,
      settlement_created: false,
      processed_count: 2,
      skipped_applied_count: 1,
    });

    const settled = await repo.settlements.findById(settlement.settlement_id);
    expect(settled?.status).toBe(SettlementDocStatus.Settled);
    expect(settled?.phase).toBe(SettlementPhase.Done);
    expect(settled?.settled_at?.getTime()).toBe(NOW.getTime());

    const matchAfter = await repo.matches.findById(match.match_id);
    expect(matchAfter?.settlement_status).toBe(SettlementStatus.Settled);
    expect(matchAfter?.settled_result_version).toBe(1);
    expect(matchAfter?.settled_at?.getTime()).toBe(NOW.getTime());

    expect(
      (await repo.settlementItems.findBySettlementAndPrediction(settlement.settlement_id, "p1"))
        ?.status,
    ).toBe(SettlementItemStatus.Applied);
    expect(
      (await repo.settlementItems.findBySettlementAndPrediction(settlement.settlement_id, "p2"))
        ?.status,
    ).toBe(SettlementItemStatus.Applied);
    expect(
      (await repo.settlementItems.findBySettlementAndPrediction(settlement.settlement_id, "p3"))
        ?.status,
    ).toBe(SettlementItemStatus.Applied);

    expect(worker).toHaveBeenCalledTimes(2);
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

  it("无已有 settlement 与 items：创建 settlement 并成功 settled", async () => {
    const { repo, match } = await setup();
    const service = new FirstSettlementService(repo);

    const outcome = await service.start(match.match_id, NOW, false);

    expect(outcome).toMatchObject({
      kind: "started",
      settlement_created: true,
      processed_count: 0,
      skipped_applied_count: 0,
    });

    const found = await repo.settlements.findByMatchAndVersionAndRule(match.match_id, 1, RULE);
    expect(found).not.toBeNull();
    expect(found?.status).toBe(SettlementDocStatus.Settled);
    expect(found?.phase).toBe(SettlementPhase.Done);

    const matchAfter = await repo.matches.findById(match.match_id);
    expect(matchAfter?.settlement_status).toBe(SettlementStatus.Settled);
    expect(matchAfter?.settled_result_version).toBe(1);
    expect(matchAfter?.settled_at?.getTime()).toBe(NOW.getTime());
  });

  it("首次结算为每个 prediction 幂等创建并应用 settlement item", async () => {
    const { repo, match } = await setup();
    const prediction = makePrediction(match.match_id);
    await repo.predictions.insert(prediction);
    const worker = vi.fn<SettlementItemWorker>(async () => {});

    const outcome = await new FirstSettlementService(repo, worker).start(
      match.match_id,
      NOW,
      false,
    );

    expect(outcome).toMatchObject({
      kind: "started",
      processed_count: 1,
      skipped_applied_count: 0,
    });
    const settlement = await repo.settlements.findByMatchAndVersionAndRule(
      match.match_id,
      1,
      RULE,
    );
    expect(settlement).not.toBeNull();
    const item = await repo.settlementItems.findBySettlementAndPrediction(
      settlement!.settlement_id,
      prediction.prediction_id,
    );
    expect(item).toMatchObject({
      user_id: prediction.user_id,
      old_score: 0,
      new_score: 12,
      score_delta: 12,
      old_wdl_hit: false,
      new_wdl_hit: true,
      old_exact_hit: false,
      new_exact_hit: true,
      valid_prediction_delta: 1,
      source_result_version: 1,
      status: SettlementItemStatus.Applied,
    });
    expect(worker).toHaveBeenCalledWith(
      expect.objectContaining({ prediction_id: prediction.prediction_id }),
      expect.objectContaining({ result_version: 1 }),
      expect.anything(),
    );
  });

  it("读取 match_results 最新版本：存在 v1/v2 时以 v2 结算", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch({ result_version: 2, regular_home_score: 3, regular_away_score: 1 });
    await repo.matches.insert(match);
    await repo.matchResults.insert(
      makeResult({ match_id: match.match_id, result_version: 1, regular_home_score: 1, regular_away_score: 0 }),
    );
    await repo.matchResults.insert(
      makeResult({ match_id: match.match_id, result_version: 2, regular_home_score: 3, regular_away_score: 1 }),
    );

    const worker = vi.fn<SettlementItemWorker>(async () => {});
    const service = new FirstSettlementService(repo, worker);

    const outcome = await service.start(match.match_id, NOW, false);

    expect(outcome).toMatchObject({ kind: "started", settlement_created: true });
    const found = await repo.settlements.findByMatchAndVersionAndRule(match.match_id, 2, RULE);
    expect(found?.status).toBe(SettlementDocStatus.Settled);
    const matchAfter = await repo.matches.findById(match.match_id);
    expect(matchAfter?.settled_result_version).toBe(2);
  });

  it("finalize 顺序：先写 settled_result_version=v + settled_at（settlement_status 未变），再走状态分支", async () => {
    const { repo, match } = await setup();
    const settlement = makeSettlement({ match_id: match.match_id, result_version: 1 });
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

    const service = new FirstSettlementService(guardedRepo);
    await service.start(match.match_id, NOW, false);

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

  it("起态 waiting -> settling 走 transitionMatchSettlementStatus（updateSettlementStatus），无仅改状态的 raw update", async () => {
    const { repo, match } = await setup();
    const settlement = makeSettlement({ match_id: match.match_id, result_version: 1 });
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

    const service = new FirstSettlementService(guardedRepo);
    await service.start(match.match_id, NOW, false);

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
    const settlement = makeSettlement({ match_id: match.match_id, result_version: 1 });
    await repo.settlements.insert(settlement);
    await repo.settlementItems.insert(makeItem({ settlement_id: settlement.settlement_id }));

    const service = new FirstSettlementService(repo, async () => {
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

    await expect(service.start(match.match_id, NOW, false)).rejects.toMatchObject({
      code: "MATCH_STATE_CONFLICT",
    });

    const matchAfter = await repo.matches.findById(match.match_id);
    expect(matchAfter?.settlement_status).toBe(SettlementStatus.Pending);
    expect(matchAfter?.settled_result_version).toBe(0);
    expect(matchAfter?.settled_at).toBeNull();
    expect(
      (await repo.settlements.findByMatchAndVersionAndRule(match.match_id, 1, RULE))?.status,
    ).toBe(SettlementDocStatus.Pending);
  });

  it("finalize 前重新读取 result_version：处理 v1 期间出现 v2 时保持 correcting", async () => {
    const { repo, match } = await setup();
    const settlement = makeSettlement({ match_id: match.match_id, result_version: 1 });
    await repo.settlements.insert(settlement);
    await repo.settlementItems.insert(makeItem({ settlement_id: settlement.settlement_id }));
    const worker = vi.fn<SettlementItemWorker>(async () => {
      await repo.matchResults.insert(
        makeResult({
          match_id: match.match_id,
          result_version: 2,
          regular_home_score: 3,
          regular_away_score: 1,
        }),
      );
      const latest = await repo.matches.findById(match.match_id);
      if (latest === null) {
        throw new Error("match disappeared");
      }
      await repo.matches.update({
        ...latest,
        result_version: 2,
        regular_home_score: 3,
        regular_away_score: 1,
        updated_at: NOW,
      });
    });
    const service = new FirstSettlementService(repo, worker);

    const outcome = await service.start(match.match_id, NOW, false);

    expect(outcome).toMatchObject({
      kind: "started",
      settlement_created: false,
      settlement_id: settlement.settlement_id,
    });
    const settled = await repo.settlements.findByMatchAndVersionAndRule(
      match.match_id,
      1,
      RULE,
    );
    expect(settled?.status).toBe(SettlementDocStatus.Settled);
    expect(settled?.phase).toBe(SettlementPhase.Done);
    const matchAfter = await repo.matches.findById(match.match_id);
    expect(matchAfter).toMatchObject({
      result_version: 2,
      settled_result_version: 1,
      settlement_status: SettlementStatus.Correcting,
    });
  });
});

describe("FirstSettlementService.start - 已结算重复调用", () => {
  it("match 已 settled：重复调用不创建新 settlement，返回已完成", async () => {
    const { repo, match } = await setup({
      match: {
        settlement_status: SettlementStatus.Settled,
        settled_result_version: 1,
        settled_at: NOW,
      },
    });
    const settlement = makeSettlement({
      match_id: match.match_id,
      result_version: 1,
      status: SettlementDocStatus.Settled,
      phase: SettlementPhase.Done,
      settled_at: NOW,
    });
    await repo.settlements.insert(settlement);

    const service = new FirstSettlementService(repo);
    const outcome = await service.start(match.match_id, NOW, false);

    expect(outcome).toEqual({
      kind: "already_settled",
      settlement_id: settlement.settlement_id,
      processed_count: 0,
      skipped_applied_count: 0,
    });
    expect(await repo.settlements.findByStatus(SettlementDocStatus.Settled)).toHaveLength(1);
  });

  it("settlement 已 settled 但 match 仍 waiting：复用已完成 settlement，不创建、不触碰 match", async () => {
    const { repo, match } = await setup();
    const settlement = makeSettlement({
      match_id: match.match_id,
      result_version: 1,
      status: SettlementDocStatus.Settled,
      phase: SettlementPhase.Done,
      settled_at: NOW,
    });
    await repo.settlements.insert(settlement);

    const service = new FirstSettlementService(repo);
    const outcome = await service.start(match.match_id, NOW, false);

    expect(outcome).toEqual({
      kind: "already_settled",
      settlement_id: settlement.settlement_id,
      processed_count: 0,
      skipped_applied_count: 0,
    });
    const matchAfter = await repo.matches.findById(match.match_id);
    expect(matchAfter?.settlement_status).toBe(SettlementStatus.Waiting);
  });
});

describe("FirstSettlementService.start - 并发锁", () => {
  it("两个并发首次结算请求只运行一个 worker，竞争请求返回 SETTLEMENT_ALREADY_RUNNING", async () => {
    const { repo, match } = await setup();
    const lockedRepo: AppRepository = {
      users: repo.users,
      deletedOpenidMappings: repo.deletedOpenidMappings,
      matches: repo.matches,
      predictions: repo.predictions,
      matchResults: repo.matchResults,
      settlements: repo.settlements,
      settlementItems: repo.settlementItems,
      unlocks: repo.unlocks,
      jobLocks: repo.jobLocks,
      withTransaction: (fn) =>
        repo.withTransaction((tx) =>
          fn({
            users: tx.users,
            deletedOpenidMappings: tx.deletedOpenidMappings,
            matches: tx.matches,
            predictions: tx.predictions,
            matchResults: tx.matchResults,
            settlements: {
              ...tx.settlements,
              insert: async (newSettlement) => {
                await tx.settlements.insert(newSettlement);
                await tx.settlementItems.insert(
                  makeItem({ settlement_id: newSettlement.settlement_id }),
                );
              },
            },
            settlementItems: tx.settlementItems,
            unlocks: tx.unlocks,
          }),
        ),
    };

    let releaseWorker!: () => void;
    let markWorkerStarted!: () => void;
    const workerFinished = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    const workerStarted = new Promise<void>((resolve) => {
      markWorkerStarted = resolve;
    });
    const worker = vi.fn<SettlementItemWorker>(async () => {
      markWorkerStarted();
      await workerFinished;
    });
    const service = new FirstSettlementService(lockedRepo, worker);

    const requests = [
      service.start(match.match_id, NOW, false),
      service.start(match.match_id, NOW, false),
    ];
    await workerStarted;
    releaseWorker();

    const outcomes = await Promise.all(requests);

    expect(outcomes[0]).toMatchObject({
      kind: "started",
      settlement_created: true,
      processed_count: 1,
    });
    expect(outcomes[1]).toEqual({
      kind: "not_started",
      code: FirstSettlementCode.AlreadyRunning,
    });
    expect(worker).toHaveBeenCalledTimes(1);
    expect(await repo.settlements.findByStatus(SettlementDocStatus.Settled)).toHaveLength(1);
    expect(
      await repo.jobLocks.acquire(
        settlementMatchLockKey(match.match_id),
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
      const settlement = makeSettlement({ match_id: match.match_id, result_version: 1 });
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
      const service = new FirstSettlementService(repo, worker);

      operation = service.start(match.match_id, NOW, false);
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

  it("续租失败：当前结算失败退出，不继续 finalize", async () => {
    vi.useFakeTimers({ now: NOW });
    let releaseWorker = () => {};
    let operation: Promise<unknown> | undefined;

    try {
      const { repo, match } = await setup();
      const settlement = makeSettlement({ match_id: match.match_id, result_version: 1 });
      await repo.settlements.insert(settlement);
      await repo.settlementItems.insert(makeItem({ settlement_id: settlement.settlement_id }));

      const baseLocks = repo.jobLocks;
      const failingRenewRepo: AppRepository = {
        users: repo.users,
      deletedOpenidMappings: repo.deletedOpenidMappings,
        matches: repo.matches,
        predictions: repo.predictions,
        matchResults: repo.matchResults,
        settlements: repo.settlements,
        settlementItems: repo.settlementItems,
        unlocks: repo.unlocks,
        jobLocks: {
          acquire: baseLocks.acquire,
          renew: async () => false,
          release: baseLocks.release,
        },
        withTransaction: (fn) => repo.withTransaction(fn),
      };

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
      const service = new FirstSettlementService(failingRenewRepo, worker);

      operation = service.start(match.match_id, NOW, false);
      await workerStarted;
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      releaseWorker();

      await expect(operation).rejects.toMatchObject({
        code: FirstSettlementCode.AlreadyRunning,
      });
      expect(
        (await repo.settlementItems.findBySettlement(settlement.settlement_id))[0]?.status,
      ).toBe(SettlementItemStatus.Pending);
      expect((await repo.matches.findById(match.match_id))?.settlement_status).not.toBe(
        SettlementStatus.Settled,
      );
    } finally {
      releaseWorker();
      if (operation !== undefined) {
        await operation.catch(() => undefined);
      }
      vi.useRealTimers();
    }
  });
});

describe("FirstSettlementService.start - itemWorker 失败", () => {
  it("worker 失败前 match 已产生新赛果：失败收尾保留最新 result_version 与正式比分", async () => {
    const { repo, match } = await setup();
    await repo.settlementItems.insert(
      makeItem({ settlement_id: "settlement_new_result", prediction_id: "p_fail" }),
    );
    await repo.settlements.insert(
      makeSettlement({
        settlement_id: "settlement_new_result",
        match_id: match.match_id,
        result_version: 1,
      }),
    );

    const boom = new Error("apply item boom");
    const service = new FirstSettlementService(repo, async () => {
      await repo.matchResults.insert(
        makeResult({
          match_id: match.match_id,
          result_version: 2,
          regular_home_score: 1,
          regular_away_score: 1,
        }),
      );
      const latest = await repo.matches.findById(match.match_id);
      if (latest === null) {
        throw new Error("match disappeared");
      }
      await repo.matches.update({
        ...latest,
        result_version: 2,
        regular_home_score: 1,
        regular_away_score: 1,
        updated_at: NOW,
      });
      throw boom;
    });

    await expect(service.start(match.match_id, NOW, false)).rejects.toBe(boom);
    expect(await repo.matches.findById(match.match_id)).toMatchObject({
      result_version: 2,
      regular_home_score: 1,
      regular_away_score: 1,
      settlement_status: SettlementStatus.Failed,
    });
  });

  it("itemWorker 失败：settlement -> failed/apply_items，已 applied 不回滚，match -> failed，抛出原错误", async () => {
    const { repo, match } = await setup();
    const settlement = makeSettlement({
      match_id: match.match_id,
      result_version: 1,
      status: SettlementDocStatus.Pending,
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
    const service = new FirstSettlementService(repo, async (item: SettlementItem) => {
      if (item.prediction_id === "p_fail") {
        throw boom;
      }
    });

    await expect(service.start(match.match_id, NOW, false)).rejects.toBe(boom);

    const s = await repo.settlements.findById(settlement.settlement_id);
    expect(s?.status).toBe(SettlementDocStatus.Failed);
    expect(s?.phase).toBe(SettlementPhase.ApplyItems);
    expect(s?.last_error_code).toBe("SETTLEMENT_ITEM_FAILED");
    expect(s?.last_error_message).toBe("apply item boom");

    expect(
      (await repo.settlementItems.findBySettlementAndPrediction(settlement.settlement_id, "p_ok"))
        ?.status,
    ).toBe(SettlementItemStatus.Applied);
    expect(
      (await repo.settlementItems.findBySettlementAndPrediction(settlement.settlement_id, "p_fail"))
    ).toMatchObject({
      status: SettlementItemStatus.Failed,
      attempt_count: 1,
      last_error_code: "SETTLEMENT_ITEM_FAILED",
      last_error_message: "apply item boom",
    });
    expect(
      (await repo.settlementItems.findBySettlementAndPrediction(settlement.settlement_id, "p_applied"))
        ?.status,
    ).toBe(SettlementItemStatus.Applied);

    const matchAfter = await repo.matches.findById(match.match_id);
    expect(matchAfter?.settlement_status).toBe(SettlementStatus.Failed);
  });

  it.each([null, undefined] as const)(
    "worker throw %s：仍记录失败并向调用方抛出该值",
    async (workerError) => {
      const { repo, match } = await setup();
      const settlement = makeSettlement({ match_id: match.match_id });
      await repo.settlements.insert(settlement);
      await repo.settlementItems.insert(makeItem({ settlement_id: settlement.settlement_id }));

      const service = new FirstSettlementService(repo, async () => {
        throw workerError;
      });

      await expect(service.start(match.match_id, NOW, false)).rejects.toBe(workerError);
      expect((await repo.settlements.findById(settlement.settlement_id))?.status).toBe(
        SettlementDocStatus.Failed,
      );
      expect((await repo.matches.findById(match.match_id))?.settlement_status).toBe(
        SettlementStatus.Failed,
      );
    },
  );
});

describe("FirstSettlementService.start - 不满足条件", () => {
  it("match 不存在 -> 抛 MATCH_NOT_FOUND", async () => {
    const repo = new InMemoryRepository();
    const service = new FirstSettlementService(repo);
    await expect(service.start(newUuid(), NOW, false)).rejects.toMatchObject({
      code: "MATCH_NOT_FOUND",
    });
  });

  it("未到 10 分钟保护期 -> not_started SETTLEMENT_NOT_READY，无写入", async () => {
    const { repo, match } = await setup();
    const service = new FirstSettlementService(repo);
    const early = new Date(FINISH_AT.getTime() + TEN_MINUTES_MS - 1000);

    const outcome = await service.start(match.match_id, early, false);

    expect(outcome).toEqual({ kind: "not_started", code: FirstSettlementCode.NotReady });
    expect(await repo.settlements.findByMatchAndVersionAndRule(match.match_id, 1, RULE)).toBeNull();
    const matchAfter = await repo.matches.findById(match.match_id);
    expect(matchAfter?.settlement_status).toBe(SettlementStatus.Waiting);
  });

  it("存在阻塞异常 -> not_started SETTLEMENT_NOT_READY", async () => {
    const { repo, match } = await setup();
    const service = new FirstSettlementService(repo);
    const outcome = await service.start(match.match_id, NOW, true);
    expect(outcome).toEqual({ kind: "not_started", code: FirstSettlementCode.NotReady });
  });

  it("match settlement_status=settling -> not_started SETTLEMENT_ALREADY_RUNNING", async () => {
    const { repo, match } = await setup({
      match: { settlement_status: SettlementStatus.Settling },
    });
    const service = new FirstSettlementService(repo);
    const outcome = await service.start(match.match_id, NOW, false);
    expect(outcome).toEqual({ kind: "not_started", code: FirstSettlementCode.AlreadyRunning });
  });
});
