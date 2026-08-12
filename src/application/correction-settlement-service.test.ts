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
import type { SettlementItemWorker } from "./first-settlement-service.js";
import {
  CorrectionSettlementCode,
  CorrectionSettlementService,
} from "./correction-settlement-service.js";
import { settlementMatchLockKey } from "./retry-settlement-service.js";

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
    settlement_status: SettlementStatus.Settled,
    regular_home_score: 3,
    regular_away_score: 1,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 2,
    settled_result_version: 1,
    result_source: "provider",
    scoring_rule_version: RULE,
    finish_detected_at: FINISH_AT,
    settled_at: FINISH_AT,
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
    result_version: 2,
    rule_version: RULE,
    status: SettlementDocStatus.Pending,
    phase: SettlementPhase.Prepare,
    is_correction: true,
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
    old_score: 12,
    new_score: 3,
    score_delta: -9,
    old_wdl_hit: true,
    new_wdl_hit: true,
    old_exact_hit: true,
    new_exact_hit: false,
    valid_prediction_delta: 0,
    source_result_version: 2,
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
    match_score: 12,
    wdl_hit: true,
    exact_hit: true,
    applied_result_version: 1,
    created_at: FINISH_AT,
    updated_at: FINISH_AT,
    ...overrides,
  };
}

/** 已结算到 v1、当前为 resultVersion（含 v1..resultVersion 账本）的待修正比赛。 */
async function setupCorrection(options: {
  resultVersion?: number;
  finalHome?: number;
  finalAway?: number;
  settlementStatus?: Match["settlement_status"];
  results?: Array<{ version: number; home: number; away: number }>;
} = {}) {
  const repo = new InMemoryRepository();
  const resultVersion = options.resultVersion ?? 2;
  const results =
    options.results ??
    [
      { version: 1, home: 2, away: 1 },
      { version: 2, home: 3, away: 1 },
    ];
  const last = results[results.length - 1] as { version: number; home: number; away: number };
  const match = makeMatch({
    result_version: resultVersion,
    settled_result_version: 1,
    settlement_status: options.settlementStatus ?? SettlementStatus.Correcting,
    regular_home_score: options.finalHome ?? last.home,
    regular_away_score: options.finalAway ?? last.away,
    settled_at: FINISH_AT,
  });
  await repo.matches.insert(match);
  for (const r of results) {
    await repo.matchResults.insert(
      makeResult({
        match_id: match.match_id,
        result_version: r.version,
        regular_home_score: r.home,
        regular_away_score: r.away,
      }),
    );
  }
  return { repo, match };
}

/** 预置一个 v2 修正 settlement（pending）+ items，用于验证复用与处理。 */
async function seedCorrectionSettlement(
  repo: InMemoryRepository,
  matchId: string,
  items: SettlementItem[],
): Promise<SettlementDoc> {
  const settlement = makeSettlement({
    match_id: matchId,
    result_version: 2,
    status: SettlementDocStatus.Pending,
  });
  await repo.settlements.insert(settlement);
  for (const item of items) {
    await repo.settlementItems.insert({ ...item, settlement_id: settlement.settlement_id });
  }
  return settlement;
}

describe("CorrectionSettlementService.correct - 成功路径", () => {
  it("无效 server_now 在获取修正结算锁前 Fail Closed", async () => {
    const { repo, match } = await setupCorrection();
    const invalidNow = new Date("invalid");

    await expect(
      new CorrectionSettlementService(repo).correct(match.match_id, invalidNow),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "server_now" },
    });

    expect(await repo.matches.findById(match.match_id)).toEqual(match);
    expect(await repo.settlements.findByStatus(SettlementDocStatus.Pending)).toEqual([]);
  });

  it("v1->v2 修正 12->3 delta：item 应用、settlement settled/done、match settled_result_version=2", async () => {
    const { repo, match } = await setupCorrection();
    const item = makeItem({
      prediction_id: "p1",
      old_score: 12,
      new_score: 3,
      score_delta: -9,
      old_wdl_hit: true,
      new_wdl_hit: true,
      old_exact_hit: true,
      new_exact_hit: false,
      source_result_version: 2,
    });
    const settlement = await seedCorrectionSettlement(repo, match.match_id, [item]);

    const worker = vi.fn<SettlementItemWorker>(async () => {});
    const service = new CorrectionSettlementService(repo, worker);

    const outcome = await service.correct(match.match_id, NOW);

    expect(outcome).toEqual({
      kind: "settled",
      settlement_id: settlement.settlement_id,
      settlement_created: false,
      target_result_version: 2,
      processed_count: 1,
      skipped_applied_count: 0,
    });

    const s = await repo.settlements.findById(settlement.settlement_id);
    expect(s?.status).toBe(SettlementDocStatus.Settled);
    expect(s?.phase).toBe(SettlementPhase.Done);
    expect(s?.is_correction).toBe(true);
    expect(s?.result_version).toBe(2);
    expect(s?.settled_at?.getTime()).toBe(NOW.getTime());

    expect(
      await repo.settlementItems.findBySettlementAndPrediction(settlement.settlement_id, "p1"),
    ).toMatchObject({
      status: SettlementItemStatus.Applied,
      old_score: 12,
      new_score: 3,
      score_delta: -9,
      applied_at: NOW,
    });

    const matchAfter = await repo.matches.findById(match.match_id);
    expect(matchAfter?.settlement_status).toBe(SettlementStatus.Settled);
    expect(matchAfter?.settled_result_version).toBe(2);
    expect(matchAfter?.settled_at?.getTime()).toBe(NOW.getTime());

    expect(worker).toHaveBeenCalledTimes(1);
    expect(worker.mock.calls[0]?.[0]?.prediction_id).toBe("p1");
    expect(worker.mock.calls[0]?.[1]).toMatchObject({
      match_id: match.match_id,
      result_version: 2,
      regular_home_score: 3,
      regular_away_score: 1,
    });
  });

  it("finalize 前重新读取 result_version：v2 处理中出现 v3 时保持 correcting", async () => {
    const { repo, match } = await setupCorrection();
    const settlement = await seedCorrectionSettlement(repo, match.match_id, [makeItem()]);
    const worker = vi.fn<SettlementItemWorker>(async () => {
      await repo.matchResults.insert(
        makeResult({
          match_id: match.match_id,
          result_version: 3,
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
        result_version: 3,
        regular_home_score: 1,
        regular_away_score: 1,
        updated_at: NOW,
      });
    });
    const service = new CorrectionSettlementService(repo, worker);

    const outcome = await service.correct(match.match_id, NOW);

    expect(outcome).toMatchObject({
      kind: "correcting",
      settlement_id: settlement.settlement_id,
      target_result_version: 2,
    });
    const matchAfter = await repo.matches.findById(match.match_id);
    expect(matchAfter).toMatchObject({
      result_version: 3,
      settled_result_version: 2,
      settlement_status: SettlementStatus.Correcting,
    });
  });

  it("v1->v2 修正 3->0 delta：score_delta=-3 的 item 被应用", async () => {
    const { repo, match } = await setupCorrection({
      finalHome: 1,
      finalAway: 1,
      results: [
        { version: 1, home: 2, away: 1 },
        { version: 2, home: 1, away: 1 },
      ],
    });
    const item = makeItem({
      prediction_id: "p1",
      old_score: 3,
      new_score: 0,
      score_delta: -3,
      old_wdl_hit: true,
      new_wdl_hit: false,
      old_exact_hit: false,
      new_exact_hit: false,
      source_result_version: 2,
    });
    const settlement = await seedCorrectionSettlement(repo, match.match_id, [item]);

    const service = new CorrectionSettlementService(repo);
    const outcome = await service.correct(match.match_id, NOW);

    expect(outcome).toEqual({
      kind: "settled",
      settlement_id: settlement.settlement_id,
      settlement_created: false,
      target_result_version: 2,
      processed_count: 1,
      skipped_applied_count: 0,
    });
    expect(
      await repo.settlementItems.findBySettlementAndPrediction(settlement.settlement_id, "p1"),
    ).toMatchObject({
      status: SettlementItemStatus.Applied,
      old_score: 3,
      new_score: 0,
      score_delta: -3,
    });
    const matchAfter = await repo.matches.findById(match.match_id);
    expect(matchAfter?.settlement_status).toBe(SettlementStatus.Settled);
    expect(matchAfter?.settled_result_version).toBe(2);
  });

  it("无 items：创建 is_correction=true 的修正 settlement 并成功 settled", async () => {
    const { repo, match } = await setupCorrection();

    const service = new CorrectionSettlementService(repo);
    const outcome = await service.correct(match.match_id, NOW);

    expect(outcome).toEqual({
      kind: "settled",
      settlement_id: expect.any(String) as string,
      settlement_created: true,
      target_result_version: 2,
      processed_count: 0,
      skipped_applied_count: 0,
    });

    const found = await repo.settlements.findByMatchAndVersionAndRule(
      match.match_id,
      2,
      RULE,
    );
    expect(found).not.toBeNull();
    expect(found?.status).toBe(SettlementDocStatus.Settled);
    expect(found?.is_correction).toBe(true);
    expect(found?.result_version).toBe(2);

    const matchAfter = await repo.matches.findById(match.match_id);
    expect(matchAfter?.settlement_status).toBe(SettlementStatus.Settled);
    expect(matchAfter?.settled_result_version).toBe(2);
  });

  it("修正结算以 prediction 当前 applied 结果生成遗漏 item", async () => {
    const { repo, match } = await setupCorrection();
    const prediction = makePrediction(match.match_id);
    await repo.predictions.insert(prediction);
    const worker = vi.fn<SettlementItemWorker>(async () => {});

    const outcome = await new CorrectionSettlementService(repo, worker).correct(
      match.match_id,
      NOW,
    );

    expect(outcome).toMatchObject({ kind: "settled", processed_count: 1 });
    const settlement = await repo.settlements.findByMatchAndVersionAndRule(
      match.match_id,
      2,
      RULE,
    );
    expect(settlement).not.toBeNull();
    const item = await repo.settlementItems.findBySettlementAndPrediction(
      settlement!.settlement_id,
      prediction.prediction_id,
    );
    expect(item).toMatchObject({
      old_score: 12,
      new_score: 3,
      score_delta: -9,
      old_wdl_hit: true,
      new_wdl_hit: true,
      old_exact_hit: true,
      new_exact_hit: false,
      valid_prediction_delta: 0,
      source_result_version: 2,
      status: SettlementItemStatus.Applied,
    });
    expect(worker).toHaveBeenCalledTimes(1);
  });
});

describe("CorrectionSettlementService.correct - 版本推进", () => {
  it("settled match 未追平当前 result_version 时 Fail Closed", async () => {
    const match = makeMatch({
      settlement_status: SettlementStatus.Settled,
    });
    const repo = {
      matches: {
        findById: async () => match,
      },
    } as unknown as AppRepository;
    const worker = vi.fn<SettlementItemWorker>(async () => {});

    await expect(
      new CorrectionSettlementService(repo, worker).correct(match.match_id, NOW),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

    expect(worker).not.toHaveBeenCalled();
  });

  it("非法 match settlement_status 不得绕过 correcting 状态机", async () => {
    const { repo, match } = await setupCorrection({
      settlementStatus: SettlementStatus.Waiting,
    });
    const worker = vi.fn<SettlementItemWorker>(async () => {});

    await expect(
      new CorrectionSettlementService(repo, worker).correct(match.match_id, NOW),
    ).rejects.toMatchObject({ code: "MATCH_STATE_CONFLICT" });

    expect(worker).not.toHaveBeenCalled();
    await expect(repo.settlements.findByStatus(SettlementDocStatus.Pending)).resolves.toEqual([]);
    await expect(repo.matches.findById(match.match_id)).resolves.toMatchObject({
      settlement_status: SettlementStatus.Waiting,
      settled_result_version: 1,
    });
  });

  it("起态 failed -> correcting 走 transitionMatchSettlementStatus（updateSettlementStatus），无仅改状态的 raw update", async () => {
    const { repo, match } = await setupCorrection({
      settlementStatus: SettlementStatus.Failed,
    });
    await seedCorrectionSettlement(repo, match.match_id, []);

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

    const service = new CorrectionSettlementService(guardedRepo);
    await service.correct(match.match_id, NOW);

    expect(
      matchWrites.find(
        (w) =>
          w.kind === "updateSettlementStatus" &&
          w.value.settlement_status === SettlementStatus.Correcting,
      ),
    ).toBeDefined();
    expect(
      matchWrites.find(
        (w) =>
          w.kind === "update" &&
          w.value.settlement_status === SettlementStatus.Correcting &&
          w.value.settled_result_version === undefined &&
          w.value.settled_at === undefined,
      ),
    ).toBeUndefined();
  });

  it("v3 已存在且 v1 已结算：只能先选 v2，成功后 match 保持 correcting", async () => {
    const { repo, match } = await setupCorrection({
      resultVersion: 3,
      results: [
        { version: 1, home: 2, away: 1 },
        { version: 2, home: 3, away: 1 },
        { version: 3, home: 1, away: 1 },
      ],
    });

    const service = new CorrectionSettlementService(repo);
    const outcome = await service.correct(match.match_id, NOW);

    expect(outcome).toMatchObject({
      kind: "correcting",
      settlement_created: true,
      target_result_version: 2,
    });

    const v2 = await repo.settlements.findByMatchAndVersionAndRule(match.match_id, 2, RULE);
    expect(v2?.status).toBe(SettlementDocStatus.Settled);
    const v3 = await repo.settlements.findByMatchAndVersionAndRule(match.match_id, 3, RULE);
    expect(v3).toBeNull();

    const matchAfter = await repo.matches.findById(match.match_id);
    expect(matchAfter?.settlement_status).toBe(SettlementStatus.Correcting);
    expect(matchAfter?.settled_result_version).toBe(2);
  });

  it("targetResultVersion 指定跳到最新版本 -> 拒绝 RESULT_VERSION_SKIPPED，无任何写入", async () => {
    const { repo, match } = await setupCorrection({
      resultVersion: 3,
      results: [
        { version: 1, home: 2, away: 1 },
        { version: 2, home: 3, away: 1 },
        { version: 3, home: 1, away: 1 },
      ],
    });

    const service = new CorrectionSettlementService(repo);
    await expect(service.correct(match.match_id, NOW, 3)).rejects.toMatchObject({
      code: CorrectionSettlementCode.VersionSkipped,
    });

    expect(await repo.settlements.findByStatus(SettlementDocStatus.Settled)).toHaveLength(0);
    const matchAfter = await repo.matches.findById(match.match_id);
    expect(matchAfter?.settled_result_version).toBe(1);
  });
});

describe("CorrectionSettlementService.correct - 重复调用与复用", () => {
  it("已追平后重复调用：拒绝 SETTLEMENT_NOTHING_TO_CORRECT，不重复创建 settlement", async () => {
    const { repo, match } = await setupCorrection();

    const service = new CorrectionSettlementService(repo);
    const first = await service.correct(match.match_id, NOW);
    expect(first).toMatchObject({ kind: "settled", target_result_version: 2 });

    await expect(service.correct(match.match_id, NOW)).rejects.toMatchObject({
      code: CorrectionSettlementCode.NothingToCorrect,
    });

    const all = await repo.settlements.findByStatus(SettlementDocStatus.Settled);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ match_id: match.match_id, result_version: 2 });
  });

  it("复用已有 settlement：不重复创建（settlement_created=false）", async () => {
    const { repo, match } = await setupCorrection();
    const item = makeItem({ prediction_id: "p1" });
    const settlement = await seedCorrectionSettlement(repo, match.match_id, [item]);

    const service = new CorrectionSettlementService(repo);
    const outcome = await service.correct(match.match_id, NOW);

    expect(outcome).toMatchObject({
      kind: "settled",
      settlement_id: settlement.settlement_id,
      settlement_created: false,
    });

    expect(
      await repo.settlements.findByMatchAndVersionAndRule(match.match_id, 2, RULE),
    ).toMatchObject({ settlement_id: settlement.settlement_id });
  });

  it("复用已有 settlement 的 is_correction 冲突时 Fail Closed", async () => {
    const { repo, match } = await setupCorrection();
    const settlement = await seedCorrectionSettlement(repo, match.match_id, []);
    await repo.settlements.update({ ...settlement, is_correction: false });
    const worker = vi.fn<SettlementItemWorker>(async () => {});

    await expect(
      new CorrectionSettlementService(repo, worker).correct(match.match_id, NOW),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

    expect(worker).not.toHaveBeenCalled();
    expect(await repo.settlements.findById(settlement.settlement_id)).toMatchObject({
      status: SettlementDocStatus.Pending,
      is_correction: false,
      attempt_count: 0,
    });
    expect(await repo.matches.findById(match.match_id)).toMatchObject({
      settlement_status: SettlementStatus.Correcting,
      settled_result_version: 1,
    });
  });

  it("已有 running correction settlement 时 Fail Closed，不重复执行", async () => {
    const { repo, match } = await setupCorrection();
    const settlement = await seedCorrectionSettlement(repo, match.match_id, []);
    await repo.settlements.update({
      ...settlement,
      status: SettlementDocStatus.Running,
      phase: SettlementPhase.ApplyItems,
      started_at: NOW,
      attempt_count: 1,
    });
    const worker = vi.fn<SettlementItemWorker>(async () => {});

    const outcome = await new CorrectionSettlementService(repo, worker).correct(
      match.match_id,
      NOW,
    );

    expect(outcome).toEqual({
      kind: "already_running",
      settlement_id: settlement.settlement_id,
      code: CorrectionSettlementCode.AlreadyRunning,
    });
    expect(worker).not.toHaveBeenCalled();
    expect(await repo.settlements.findById(settlement.settlement_id)).toMatchObject({
      status: SettlementDocStatus.Running,
      attempt_count: 1,
    });
  });
});

describe("CorrectionSettlementService.correct - 锁", () => {
  it("match 锁被占用：返回 SETTLEMENT_ALREADY_RUNNING，不创建 settlement、不调用 worker", async () => {
    const { repo, match } = await setupCorrection();

    const lockKey = settlementMatchLockKey(match.match_id);
    await repo.jobLocks.acquire(
      lockKey,
      "other_owner",
      new Date("2026-08-09T00:01:00.000Z"),
    );

    const worker = vi.fn<SettlementItemWorker>(async () => {});
    const service = new CorrectionSettlementService(repo, worker);

    const outcome = await service.correct(match.match_id, NOW);

    expect(outcome).toEqual({
      kind: "already_running",
      settlement_id: null,
      code: CorrectionSettlementCode.AlreadyRunning,
    });
    expect(worker).not.toHaveBeenCalled();
    expect(
      await repo.settlements.findByMatchAndVersionAndRule(match.match_id, 2, RULE),
    ).toBeNull();
    const matchAfter = await repo.matches.findById(match.match_id);
    expect(matchAfter?.settlement_status).toBe(SettlementStatus.Correcting);
  });

  it("correct 结束后 finally 释放 match 锁", async () => {
    const { repo, match } = await setupCorrection();

    const service = new CorrectionSettlementService(repo);
    await service.correct(match.match_id, NOW);

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
      const { repo, match } = await setupCorrection();
      const settlement = await seedCorrectionSettlement(repo, match.match_id, [makeItem()]);

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
      const service = new CorrectionSettlementService(repo, worker);

      operation = service.correct(match.match_id, NOW);
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

describe("CorrectionSettlementService.correct - 部分失败恢复", () => {
  it("worker 失败收尾存在读写竞态时仍保留新 result_version", async () => {
    const { repo, match } = await setupCorrection({
      resultVersion: 2,
      results: [
        { version: 1, home: 2, away: 1 },
        { version: 2, home: 3, away: 1 },
      ],
    });
    const settlement = await seedCorrectionSettlement(repo, match.match_id, [makeItem()]);
    let race = false;

    const commitNewResult = async () => {
      await repo.matchResults.insert(
        makeResult({
          match_id: match.match_id,
          result_version: 3,
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
        result_version: 3,
        regular_home_score: 1,
        regular_away_score: 1,
        updated_at: NOW,
      });
    };

    const racingRepo: AppRepository = {
      users: repo.users,
      matches: repo.matches,
      predictions: repo.predictions,
      matchResults: repo.matchResults,
      settlements: repo.settlements,
      settlementItems: repo.settlementItems,
      unlocks: repo.unlocks,
      jobLocks: repo.jobLocks,
      withTransaction: <T>(fn: (tx: UnitOfWork) => Promise<T>) =>
        repo.withTransaction((tx) => {
          const matches = {
            ...tx.matches,
            findById: async (matchId: string) => {
              const current = await tx.matches.findById(matchId);
              if (race) {
                race = false;
                await commitNewResult();
              }
              return current;
            },
            updateSettlementStatus: async (
              matchId: string,
              settlementStatus: Match["settlement_status"],
              updatedAt: Date,
            ) => {
              if (race) {
                race = false;
                await commitNewResult();
              }
              await tx.matches.updateSettlementStatus(matchId, settlementStatus, updatedAt);
            },
          };
          return fn({
            users: tx.users,
            matches,
            predictions: tx.predictions,
            matchResults: tx.matchResults,
            settlements: tx.settlements,
            settlementItems: tx.settlementItems,
            unlocks: tx.unlocks,
          });
        }),
    };

    const service = new CorrectionSettlementService(racingRepo, async () => {
      race = true;
      throw new Error("apply correction boom");
    });

    const outcome = await service.correct(match.match_id, NOW);

    expect(outcome).toMatchObject({
      kind: "failed",
      settlement_id: settlement.settlement_id,
      target_result_version: 2,
    });
    expect(await repo.matches.findById(match.match_id)).toMatchObject({
      result_version: 3,
      regular_home_score: 1,
      regular_away_score: 1,
      settlement_status: SettlementStatus.Failed,
    });
  });

  it("worker 失败前 match 已产生新赛果：失败收尾保留最新 result_version 与正式比分", async () => {
    const { repo, match } = await setupCorrection({
      resultVersion: 2,
      results: [
        { version: 1, home: 2, away: 1 },
        { version: 2, home: 3, away: 1 },
      ],
    });
    const settlement = await seedCorrectionSettlement(repo, match.match_id, [makeItem()]);

    const service = new CorrectionSettlementService(repo, async () => {
      await repo.matchResults.insert(
        makeResult({
          match_id: match.match_id,
          result_version: 3,
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
        result_version: 3,
        regular_home_score: 1,
        regular_away_score: 1,
        updated_at: NOW,
      });
      throw new Error("apply correction boom");
    });

    const outcome = await service.correct(match.match_id, NOW);

    expect(outcome).toMatchObject({
      kind: "failed",
      settlement_id: settlement.settlement_id,
      target_result_version: 2,
    });
    expect(await repo.matches.findById(match.match_id)).toMatchObject({
      result_version: 3,
      regular_home_score: 1,
      regular_away_score: 1,
      settlement_status: SettlementStatus.Failed,
    });
  });

  it("itemWorker 失败：item failed、settlement failed/apply_items、已 applied 保留、match 回退 failed；再次 correct 恢复", async () => {
    const { repo, match } = await setupCorrection({
      resultVersion: 3,
      results: [
        { version: 1, home: 2, away: 1 },
        { version: 2, home: 3, away: 1 },
        { version: 3, home: 1, away: 1 },
      ],
    });
    const itemOk = makeItem({ prediction_id: "p_ok" });
    const itemFail = makeItem({ prediction_id: "p_fail" });
    const settlement = await seedCorrectionSettlement(repo, match.match_id, [itemOk, itemFail]);

    const workerCalls: string[] = [];
    const failingWorker = async (item: SettlementItem) => {
      workerCalls.push(item.prediction_id);
      if (item.prediction_id === "p_fail") {
        throw new Error("apply correction boom");
      }
    };
    const service = new CorrectionSettlementService(repo, failingWorker);

    const first = await service.correct(match.match_id, NOW);

    expect(first).toEqual({
      kind: "failed",
      settlement_id: settlement.settlement_id,
      settlement_created: false,
      target_result_version: 2,
      processed_count: 1,
      skipped_applied_count: 0,
    });

    const failed = await repo.settlements.findById(settlement.settlement_id);
    expect(failed?.status).toBe(SettlementDocStatus.Failed);
    expect(failed?.phase).toBe(SettlementPhase.ApplyItems);
    expect(failed?.last_error_code).toBe("SETTLEMENT_ITEM_FAILED");
    expect(failed?.last_error_message).toBe("apply correction boom");
    expect(failed?.attempt_count).toBe(1);

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
    });

    const matchAfterFail = await repo.matches.findById(match.match_id);
    expect(matchAfterFail?.settlement_status).toBe(SettlementStatus.Failed);
    expect(matchAfterFail?.settled_result_version).toBe(1);

    const retryService = new CorrectionSettlementService(repo, async (item: SettlementItem) => {
      workerCalls.push(item.prediction_id);
    });
    const second = await retryService.correct(match.match_id, NOW);

    expect(second).toEqual({
      kind: "correcting",
      settlement_id: settlement.settlement_id,
      settlement_created: false,
      target_result_version: 2,
      processed_count: 1,
      skipped_applied_count: 1,
    });
    expect(workerCalls).toEqual(["p_ok", "p_fail", "p_fail"]);

    expect(
      (await repo.settlementItems.findBySettlementAndPrediction(
        settlement.settlement_id,
        "p_fail",
      ))?.status,
    ).toBe(SettlementItemStatus.Applied);
    expect(
      (await repo.settlements.findById(settlement.settlement_id))?.status,
    ).toBe(SettlementDocStatus.Settled);

    const matchAfter = await repo.matches.findById(match.match_id);
    expect(matchAfter?.settlement_status).toBe(SettlementStatus.Correcting);
    expect(matchAfter?.settled_result_version).toBe(2);
  });
});
