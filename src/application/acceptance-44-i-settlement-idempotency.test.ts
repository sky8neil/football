/**
 * 第 44 节 I. 结算幂等验收矩阵（I60-I65）。
 *
 * 覆盖规范第 15 节 settlement 幂等语义，复用真实结算编排服务：
 * - I60 同 settlement 执行两次积分只变化一次
 * - I61 同 settlement_item applied 后再次处理无业务变化
 * - I62 1000 人结算第 488 条失败，前 487 条不重复
 * - I63 retry 从 failed/pending item 继续
 * - I64 无预测比赛也能最终 settled
 * - I65 settlement running 时第二个同 match worker 无法取得锁
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MatchScoreValue,
  MatchStatus,
  SettlementDocStatus,
  SettlementItemStatus,
  SettlementStatus,
} from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type {
  Match,
  MatchResult,
  Prediction,
  SettlementItem,
  User,
} from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { FirstSettlementCode } from "./first-settlement.js";
import {
  FirstSettlementService,
  settlementMatchLockKey,
  type SettlementItemWorker,
} from "./first-settlement-service.js";
import { RetrySettlementService } from "./retry-settlement-service.js";
import {
  createAtomicSettlementItemWorker,
  SettlementItemApplicationService,
} from "./settlement-item-application-service.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const ANCHOR = new Date("2026-08-08T14:00:00.000Z");
const FINISH_AT = new Date(NOW.getTime() - 10 * 60 * 1000);
const RULE = "scoring_v1";
const MATCH_ID = "00000000-0000-4000-8000-000000000060";

beforeEach(() => vi.useFakeTimers({ now: NOW }));
afterEach(() => vi.useRealTimers());

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    schema_version: 1,
    match_id: MATCH_ID,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: newUuid(),
    away_team_id: newUuid(),
    kickoff_at: ANCHOR,
    kickoff_confirmed: true,
    prediction_deadline_at: new Date(ANCHOR.getTime() - 600_000),
    prediction_closed_at: new Date(ANCHOR.getTime() - 600_000),
    period_anchor_at: ANCHOR,
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
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeResult(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    schema_version: 1,
    match_id: MATCH_ID,
    result_version: 1,
    regular_home_score: 2,
    regular_away_score: 1,
    source: "provider",
    provider_status: "FT",
    admin_id: null,
    reason: null,
    created_at: FINISH_AT,
    ...overrides,
  };
}

function makeUser(index: number): User {
  return {
    schema_version: 1,
    user_id: `00000000-0000-4000-8000-0000000${String(index).padStart(5, "0")}`,
    openid: `openid_i${index}`,
    unionid: null,
    nickname: `User${index}`,
    favorite_team_id: null,
    status: "active",
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_level: 1,
    career_best_level: 1,
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
  } as User;
}

function makePrediction(userId: string, index: number): Prediction {
  return {
    schema_version: 1,
    prediction_id: `00000000-0000-4000-8000-0000000${String(index).padStart(5, "0")}`,
    user_id: userId,
    match_id: MATCH_ID,
    idempotency_key: `idem_i${index}`,
    pred_home_score: 2,
    pred_away_score: 1,
    derived_result: "HOME",
    submitted_at: NOW,
    scoring_rule_version: RULE,
    match_score: null,
    wdl_hit: null,
    exact_hit: null,
    applied_result_version: 0,
    created_at: NOW,
    updated_at: NOW,
  } as Prediction;
}

async function setup(options: {
  predictionCount?: number;
} = {}) {
  const repo = new InMemoryRepository();
  const count = options.predictionCount ?? 1;
  await repo.matches.insert(makeMatch());
  await repo.matchResults.insert(makeResult());
  const users: User[] = [];
  for (let index = 0; index < count; index += 1) {
    const user = makeUser(index);
    users.push(user);
    await repo.users.insert(user);
    await repo.predictions.insert(makePrediction(user.user_id, index));
  }
  return { repo, users };
}

function atomicWorker(repo: InMemoryRepository): SettlementItemWorker {
  return createAtomicSettlementItemWorker(new SettlementItemApplicationService(repo));
}

describe("I. 结算幂等（规范 44-I）", () => {
  it("I60 同 settlement 执行两次积分只变化一次", async () => {
    const { repo } = await setup();
    const service = new FirstSettlementService(repo, atomicWorker(repo));

    const first = await service.start(MATCH_ID, NOW, false);
    expect(first).toMatchObject({ kind: "started", settlement_created: true });

    const user = await repo.users.findById(makeUser(0).user_id);
    expect(user).not.toBeNull();
    const pointsAfterFirst = user!.career_points;
    expect(pointsAfterFirst).toBe(MatchScoreValue.ExactHit);

    const second = await service.start(MATCH_ID, NOW, false);
    expect(second).toMatchObject({ kind: "already_settled" });

    const userAfterSecond = await repo.users.findById(user!.user_id);
    expect(userAfterSecond?.career_points).toBe(pointsAfterFirst);
  });

  it("I61 同 settlement_item applied 后再次处理无业务变化", async () => {
    const { repo } = await setup();
    const application = new SettlementItemApplicationService(repo);
    const service = new FirstSettlementService(repo, atomicWorker(repo));

    await service.start(MATCH_ID, NOW, false);

    const settlement = await repo.settlements.findByMatchAndVersionAndRule(MATCH_ID, 1, RULE);
    expect(settlement).not.toBeNull();
    const items = await repo.settlementItems.findBySettlement(settlement!.settlement_id);
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe(SettlementItemStatus.Applied);

    const userBefore = await repo.users.findById(items[0]!.user_id);

    const replay = await application.apply(settlement!.settlement_id, items[0]!.prediction_id, NOW);
    expect(replay).toMatchObject({ kind: "already_applied" });

    const userAfter = await repo.users.findById(items[0]!.user_id);
    expect(userAfter).toEqual(userBefore);
    expect((await repo.settlementItems.findBySettlementAndPrediction(
      settlement!.settlement_id,
      items[0]!.prediction_id,
    ))?.attempt_count).toBe(1);
  });

  it("I62 1000 人结算第 488 条失败，前 487 条不重复", async () => {
    const { repo } = await setup({ predictionCount: 1000 });
    const base = atomicWorker(repo);
    let callCount = 0;
    const failingWorker: SettlementItemWorker = async (item, result, context) => {
      callCount += 1;
      if (callCount === 488) {
        throw new Error("I62 fail at 488");
      }
      return base(item, result, context);
    };

    const firstService = new FirstSettlementService(repo, failingWorker);
    await expect(firstService.start(MATCH_ID, NOW, false)).rejects.toThrow("I62 fail at 488");

    const settlement = await repo.settlements.findByMatchAndVersionAndRule(MATCH_ID, 1, RULE);
    expect(settlement?.status).toBe(SettlementDocStatus.Failed);
    const matchAfterFail = await repo.matches.findById(MATCH_ID);
    expect(matchAfterFail?.settlement_status).toBe(SettlementStatus.Failed);

    const items = await repo.settlementItems.findBySettlement(settlement!.settlement_id);
    expect(items).toHaveLength(1000);
    const appliedCount = items.filter((item) => item.status === SettlementItemStatus.Applied).length;
    expect(appliedCount).toBe(487);

    const failedItems = items.filter((item) => item.status === SettlementItemStatus.Failed);
    expect(failedItems).toHaveLength(1);
    const pendingItems = items.filter((item) => item.status === SettlementItemStatus.Pending);
    expect(pendingItems).toHaveLength(512);

    const firstUser = (await repo.users.findById(items[0]!.user_id))!;
    expect(firstUser.career_points).toBe(MatchScoreValue.ExactHit);

    const retry = new RetrySettlementService(repo, base);
    const outcome = await retry.retry(settlement!.settlement_id, NOW);
    expect(outcome).toMatchObject({ kind: "settled", processed_count: 513, skipped_applied_count: 487 });

    const firstUserAfter = await repo.users.findById(items[0]!.user_id);
    expect(firstUserAfter?.career_points).toBe(MatchScoreValue.ExactHit);
    const lastUser = await repo.users.findById(items[999]!.user_id);
    expect(lastUser?.career_points).toBe(MatchScoreValue.ExactHit);
    expect((await repo.matches.findById(MATCH_ID))?.settlement_status).toBe(SettlementStatus.Settled);
  });

  it("I63 retry 从 failed/pending item 继续", async () => {
    const { repo } = await setup({ predictionCount: 5 });
    const base = atomicWorker(repo);
    let callCount = 0;
    const failingWorker: SettlementItemWorker = async (item, result, context) => {
      callCount += 1;
      if (callCount === 2) {
        throw new Error("I63 fail at 2");
      }
      return base(item, result, context);
    };

    const firstService = new FirstSettlementService(repo, failingWorker);
    await expect(firstService.start(MATCH_ID, NOW, false)).rejects.toThrow("I63 fail at 2");

    const settlement = await repo.settlements.findByMatchAndVersionAndRule(MATCH_ID, 1, RULE);
    const before = await repo.settlementItems.findBySettlement(settlement!.settlement_id);
    expect(before[0]?.status).toBe(SettlementItemStatus.Applied);
    expect(before[1]?.status).toBe(SettlementItemStatus.Failed);

    const workerCalls: string[] = [];
    const trackingWorker: SettlementItemWorker = async (item, result, context) => {
      workerCalls.push(item.prediction_id);
      return base(item, result, context);
    };
    const outcome = await new RetrySettlementService(repo, trackingWorker).retry(
      settlement!.settlement_id,
      NOW,
    );

    expect(outcome).toMatchObject({ kind: "settled", processed_count: 4, skipped_applied_count: 1 });
    expect(workerCalls).toHaveLength(4);
    expect(workerCalls).not.toContain(before[0]!.prediction_id);
    const after = await repo.settlementItems.findBySettlement(settlement!.settlement_id);
    for (const item of after) {
      expect(item.status).toBe(SettlementItemStatus.Applied);
    }
    expect((await repo.matches.findById(MATCH_ID))?.settlement_status).toBe(SettlementStatus.Settled);
  });

  it("I64 无预测比赛也能最终 settled", async () => {
    const { repo } = await setup({ predictionCount: 0 });
    const service = new FirstSettlementService(repo, atomicWorker(repo));

    const outcome = await service.start(MATCH_ID, NOW, false);
    expect(outcome).toMatchObject({ kind: "started", settlement_created: true, processed_count: 0 });

    const match = await repo.matches.findById(MATCH_ID);
    expect(match).toMatchObject({
      settlement_status: SettlementStatus.Settled,
      settled_result_version: 1,
    });
    const settlement = await repo.settlements.findByMatchAndVersionAndRule(MATCH_ID, 1, RULE);
    expect(settlement?.status).toBe(SettlementDocStatus.Settled);
  });

  it("I65 settlement running 时第二个同 match worker 无法取得锁", async () => {
    const { repo } = await setup();
    const lockKey = settlementMatchLockKey(MATCH_ID);
    const acquired = await repo.jobLocks.acquire(
      lockKey,
      "other_owner",
      new Date(NOW.getTime() + 600_000),
    );
    expect(acquired).toBe(true);

    const worker = () => Promise.reject(new Error("should not be called"));
    const service = new FirstSettlementService(repo, worker);
    const outcome = await service.start(MATCH_ID, NOW, false);

    expect(outcome).toEqual({ kind: "not_started", code: FirstSettlementCode.AlreadyRunning });
    expect(await repo.settlements.findByMatchAndVersionAndRule(MATCH_ID, 1, RULE)).toBeNull();
    expect((await repo.matches.findById(MATCH_ID))?.settlement_status).toBe(SettlementStatus.Waiting);
  });
});
