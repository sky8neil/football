import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdminRole,
  AdminStatus,
  MatchStatus,
  SettlementDocStatus,
  SettlementPhase,
  SettlementStatus,
} from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type {
  Admin,
  Match,
  MatchResult,
  Prediction,
  SettlementDoc,
  SettlementItem,
  User,
} from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { FirstSettlementCode } from "./first-settlement.js";
import { AdminRetrySettlementService } from "./admin-retry-settlement.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const FINISH_AT = new Date(NOW.getTime() - 10 * 60 * 1000);
const RULE = "scoring_v1";
const TRUSTED_OPENID = "trusted-admin-openid";

beforeEach(() => vi.useFakeTimers({ now: NOW }));
afterEach(() => vi.useRealTimers());

function makeAdmin(overrides: Partial<Admin> = {}): Admin {
  return {
    schema_version: 1,
    admin_id: "00000000-0000-4000-8000-000000000001",
    openid: TRUSTED_OPENID,
    status: AdminStatus.Active,
    role: AdminRole.Admin,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

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
    settlement_status: SettlementStatus.Failed,
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

function makeResult(matchId: string): MatchResult {
  return {
    schema_version: 1,
    match_id: matchId,
    result_version: 1,
    regular_home_score: 2,
    regular_away_score: 1,
    source: "provider",
    provider_status: "FT",
    admin_id: null,
    reason: null,
    created_at: FINISH_AT,
  };
}

function makeFailedSettlement(matchId: string, overrides: Partial<SettlementDoc> = {}): SettlementDoc {
  return {
    schema_version: 1,
    settlement_id: newUuid(),
    match_id: matchId,
    result_version: 1,
    rule_version: RULE,
    status: SettlementDocStatus.Failed,
    phase: SettlementPhase.ApplyItems,
    is_correction: false,
    started_at: FINISH_AT,
    settled_at: null,
    attempt_count: 1,
    last_error_code: "SETTLEMENT_ITEM_FAILED",
    last_error_message: "item failed",
    created_at: FINISH_AT,
    updated_at: FINISH_AT,
    ...overrides,
  };
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    schema_version: 1,
    user_id: newUuid(),
    openid: `user-${newUuid()}`,
    unionid: null,
    nickname: "User",
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
    ...overrides,
  };
}

function makePrediction(userId: string, matchId: string): Prediction {
  return {
    schema_version: 1,
    prediction_id: newUuid(),
    user_id: userId,
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
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeItem(settlement: SettlementDoc, prediction: Prediction): SettlementItem {
  return {
    schema_version: 1,
    settlement_id: settlement.settlement_id,
    prediction_id: prediction.prediction_id,
    user_id: prediction.user_id,
    old_score: 0,
    new_score: 12,
    score_delta: 12,
    old_wdl_hit: false,
    new_wdl_hit: true,
    old_exact_hit: false,
    new_exact_hit: true,
    valid_prediction_delta: 1,
    source_result_version: settlement.result_version,
    status: "pending",
    applied_at: null,
    attempt_count: 0,
    last_error_code: null,
    last_error_message: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

async function setup(matchOverrides: Partial<Match> = {}) {
  const repo = new InMemoryRepository();
  await repo.admins.insert(makeAdmin());
  const match = makeMatch(matchOverrides);
  await repo.matches.insert(match);
  await repo.matchResults.insert(makeResult(match.match_id));
  const settlement = makeFailedSettlement(match.match_id);
  await repo.settlements.insert(settlement);
  return { repo, match, settlement };
}

describe("AdminRetrySettlementService", () => {
  it("只接受可信 active 管理员，并按 match_id 复用 RetrySettlementService", async () => {
    const { repo, match, settlement } = await setup();
    const service = new AdminRetrySettlementService(repo);

    const outcome = await service.retry(TRUSTED_OPENID, match.match_id, NOW);

    expect(outcome).toMatchObject({
      kind: "settled",
      settlement_id: settlement.settlement_id,
      result_version: 1,
      processed_count: 0,
      skipped_applied_count: 0,
      audit_log: {
        action: "retry_settlement",
        entity_type: "settlement",
        entity_id: settlement.settlement_id,
      },
    });
    expect((await repo.settlements.findById(settlement.settlement_id))?.status).toBe(
      SettlementDocStatus.Settled,
    );
  });

  it("无效 server_now 在 retry 获取事务和锁前 Fail Closed", async () => {
    const { repo, match, settlement } = await setup();
    const worker = vi.fn(async () => {});
    const service = new AdminRetrySettlementService(repo, worker);

    await expect(
      service.retry(TRUSTED_OPENID, match.match_id, new Date("invalid")),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "server_now" },
    });

    expect(await repo.settlements.findById(settlement.settlement_id)).toMatchObject({
      status: SettlementDocStatus.Failed,
      attempt_count: 1,
    });
    expect(await repo.adminAuditLogs.findByEntity("settlement", settlement.settlement_id)).toEqual(
      [],
    );
    expect(worker).not.toHaveBeenCalled();
  });

  it("retry 成功时在同一业务变化中写入有限 retry 审计快照", async () => {
    const { repo, match, settlement } = await setup();
    const outcome = await new AdminRetrySettlementService(repo).retry(
      TRUSTED_OPENID,
      match.match_id,
      NOW,
    );

    expect(outcome.kind).toBe("settled");
    await expect(repo.adminAuditLogs.findByEntity("settlement", settlement.settlement_id))
      .resolves.toEqual([
        expect.objectContaining({
          action: "retry_settlement",
          entity_type: "settlement",
          entity_id: settlement.settlement_id,
          old_value: {
            settlement_status: "failed",
            phase: "apply_items",
            attempt_count: 1,
            failed_item_count: 0,
            pending_item_count: 0,
            applied_item_count: 0,
          },
          new_value: {
            settlement_status: "settled",
            phase: "done",
            attempt_count: 2,
            failed_item_count: 0,
            pending_item_count: 0,
            applied_item_count: 0,
          },
        }),
      ]);
  });

  it("retry 再次失败时审计 new_value 如实记录失败后的状态", async () => {
    const { repo, match, settlement } = await setup();
    const user = makeUser();
    const prediction = makePrediction(user.user_id, match.match_id);
    await repo.users.insert(user);
    await repo.predictions.insert(prediction);
    await repo.settlementItems.insert(makeItem(settlement, prediction));
    const worker = vi.fn(async () => {
      throw new Error("retry failed again");
    });

    const outcome = await new AdminRetrySettlementService(repo, worker).retry(
      TRUSTED_OPENID,
      match.match_id,
      NOW,
    );

    expect(outcome.kind).toBe("failed");
    await expect(repo.adminAuditLogs.findByEntity("settlement", settlement.settlement_id))
      .resolves.toEqual([
        expect.objectContaining({
          old_value: {
            settlement_status: "failed",
            phase: "apply_items",
            attempt_count: 1,
            failed_item_count: 0,
            pending_item_count: 1,
            applied_item_count: 0,
          },
          new_value: {
            settlement_status: "failed",
            phase: "apply_items",
            attempt_count: 2,
            failed_item_count: 1,
            pending_item_count: 0,
            applied_item_count: 0,
          },
        }),
      ]);
  });

  it("retry 补建遗漏 item 后失败时，审计 old_value 仍表示 retry 前状态", async () => {
    const { repo, match, settlement } = await setup();
    const user = makeUser();
    await repo.users.insert(user);
    await repo.predictions.insert(makePrediction(user.user_id, match.match_id));
    const worker = vi.fn(async () => {
      throw new Error("retry failed after item preparation");
    });

    const outcome = await new AdminRetrySettlementService(repo, worker).retry(
      TRUSTED_OPENID,
      match.match_id,
      NOW,
    );

    expect(outcome.kind).toBe("failed");
    await expect(repo.adminAuditLogs.findByEntity("settlement", settlement.settlement_id))
      .resolves.toEqual([
        expect.objectContaining({
          old_value: expect.objectContaining({
            settlement_status: "failed",
            pending_item_count: 0,
            failed_item_count: 0,
            applied_item_count: 0,
          }),
          new_value: expect.objectContaining({
            settlement_status: "failed",
            pending_item_count: 0,
            failed_item_count: 1,
            applied_item_count: 0,
          }),
        }),
      ]);
  });

  it("correction retry 补建遗漏 item 后失败时，审计 old_value 仍表示 retry 前状态", async () => {
    const { repo, match, settlement } = await setup({
      result_version: 2,
      settled_result_version: 1,
    });
    await repo.settlements.update({
      ...settlement,
      status: SettlementDocStatus.Settled,
      phase: SettlementPhase.Done,
      settled_at: NOW,
      last_error_code: null,
      last_error_message: null,
    });
    await repo.matchResults.insert({
      ...makeResult(match.match_id),
      result_version: 2,
      regular_home_score: 1,
      regular_away_score: 1,
    });
    const correctionSettlement = makeFailedSettlement(match.match_id, {
      result_version: 2,
      is_correction: true,
    });
    await repo.settlements.insert(correctionSettlement);

    const user = makeUser();
    await repo.users.insert(user);
    const prediction = makePrediction(user.user_id, match.match_id);
    await repo.predictions.insert({
      ...prediction,
      match_score: 12,
      wdl_hit: true,
      exact_hit: true,
      applied_result_version: 1,
    });
    const worker = vi.fn(async () => {
      throw new Error("correction retry failed after item preparation");
    });

    const outcome = await new AdminRetrySettlementService(repo, worker).retry(
      TRUSTED_OPENID,
      match.match_id,
      NOW,
    );

    expect(outcome.kind).toBe("failed");
    await expect(
      repo.adminAuditLogs.findByEntity("settlement", correctionSettlement.settlement_id),
    ).resolves.toEqual([
      expect.objectContaining({
        old_value: expect.objectContaining({
          settlement_status: "failed",
          pending_item_count: 0,
          failed_item_count: 0,
          applied_item_count: 0,
        }),
        new_value: expect.objectContaining({
          settlement_status: "failed",
          pending_item_count: 0,
          failed_item_count: 1,
          applied_item_count: 0,
        }),
      }),
    ]);
  });

  it("match settlement_status=waiting 但存在 failed settlement 时仍允许重试", async () => {
    const { repo, match, settlement } = await setup({
      settlement_status: SettlementStatus.Waiting,
    });
    const service = new AdminRetrySettlementService(repo);

    const outcome = await service.retry(TRUSTED_OPENID, match.match_id, NOW);

    expect(outcome.kind).toBe("settled");
    expect((await repo.settlements.findById(settlement.settlement_id))?.status).toBe(
      SettlementDocStatus.Settled,
    );
  });

  it("match 处于非法状态（pending）时 admin retry fail closed，抛 MATCH_STATE_CONFLICT", async () => {
    const { repo, match, settlement } = await setup({
      settlement_status: SettlementStatus.Pending,
    });
    const worker = vi.fn(async () => {});
    const service = new AdminRetrySettlementService(repo, worker);

    await expect(service.retry(TRUSTED_OPENID, match.match_id, NOW)).rejects.toMatchObject({
      code: "MATCH_STATE_CONFLICT",
    });
    expect(worker).not.toHaveBeenCalled();
    expect((await repo.settlements.findById(settlement.settlement_id))?.status).toBe(
      SettlementDocStatus.Failed,
    );
  });

  it("结算已完成且不存在 failed settlement 时返回 SETTLEMENT_NOT_READY", async () => {
    const { repo, match, settlement } = await setup();
    const worker = vi.fn(async () => {});
    const service = new AdminRetrySettlementService(repo, worker);

    await service.retry(TRUSTED_OPENID, match.match_id, NOW);
    await expect(service.retry(TRUSTED_OPENID, match.match_id, NOW)).rejects.toMatchObject({
      code: "SETTLEMENT_NOT_READY",
    });
    expect(worker).not.toHaveBeenCalled();
  });

  it("match lock 被占用时返回 already_running 且不推进 settlement", async () => {
    const { repo, match, settlement } = await setup();
    await repo.jobLocks.acquire(
      `settlement:match:${match.match_id}`,
      "other-owner",
      new Date(NOW.getTime() + 60_000),
    );
    const service = new AdminRetrySettlementService(repo);

    const outcome = await service.retry(TRUSTED_OPENID, match.match_id, NOW);

    expect(outcome).toEqual({
      kind: "already_running",
      settlement_id: settlement.settlement_id,
      code: FirstSettlementCode.AlreadyRunning,
    });
    expect((await repo.settlements.findById(settlement.settlement_id))?.status).toBe(
      SettlementDocStatus.Failed,
    );
  });

  it("非 active 管理员或缺少可信 openid 时拒绝，且不写入 settlement", async () => {
    const { repo, match, settlement } = await setup();
    const service = new AdminRetrySettlementService(repo);

    await expect(service.retry("not-trusted", match.match_id, NOW)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await repo.admins.insert(
      makeAdmin({
        admin_id: newUuid(),
        openid: "disabled-admin",
        status: AdminStatus.Disabled,
      }),
    );
    await expect(service.retry("disabled-admin", match.match_id, NOW)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await repo.settlements.findById(settlement.settlement_id))?.status).toBe(
      SettlementDocStatus.Failed,
    );
  });

  it("没有 failed settlement 时 fail closed，不猜测目标 settlement", async () => {
    const { repo, match, settlement } = await setup({
      settlement_status: SettlementStatus.Waiting,
    });
    await repo.settlements.update({
      ...settlement,
      status: SettlementDocStatus.Settled,
      phase: SettlementPhase.Done,
      settled_at: NOW,
    });
    const service = new AdminRetrySettlementService(repo);

    await expect(service.retry(TRUSTED_OPENID, match.match_id, NOW)).rejects.toMatchObject({
      code: "SETTLEMENT_NOT_READY",
    });
  });

  it("match settlement_status=failed 但没有 failed settlement 时返回数据一致性错误", async () => {
    const { repo, match, settlement } = await setup();
    await repo.settlements.update({
      ...settlement,
      status: SettlementDocStatus.Running,
      phase: SettlementPhase.ApplyItems,
    });
    const service = new AdminRetrySettlementService(repo);

    await expect(service.retry(TRUSTED_OPENID, match.match_id, NOW)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
  });

  it("correction settlement 残留 running 时返回 already_running，不重复处理", async () => {
    const { repo, match, settlement } = await setup({
      result_version: 2,
      settled_result_version: 1,
      settlement_status: SettlementStatus.Failed,
    });
    await repo.settlements.update({
      ...settlement,
      status: SettlementDocStatus.Settled,
      phase: SettlementPhase.Done,
      settled_at: NOW,
      last_error_code: null,
      last_error_message: null,
    });
    await repo.matchResults.insert({
      ...makeResult(match.match_id),
      result_version: 2,
      regular_home_score: 1,
      regular_away_score: 1,
    });
    const runningCorrection = makeFailedSettlement(match.match_id, {
      settlement_id: newUuid(),
      result_version: 2,
      is_correction: true,
      status: SettlementDocStatus.Running,
      phase: SettlementPhase.ApplyItems,
      attempt_count: 1,
    });
    await repo.settlements.insert(runningCorrection);
    const worker = vi.fn(async () => {});

    await expect(
      new AdminRetrySettlementService(repo, worker).retry(
        TRUSTED_OPENID,
        match.match_id,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "SETTLEMENT_ALREADY_RUNNING" });
    expect(worker).not.toHaveBeenCalled();
    expect(await repo.settlements.findById(runningCorrection.settlement_id)).toMatchObject({
      status: SettlementDocStatus.Running,
      attempt_count: 1,
    });
  });

  it("默认 retry worker 必须应用 settlement item 账本，而不是只推进 item 状态", async () => {
    const { repo, match, settlement } = await setup({
      period_anchor_at: new Date("2026-08-08T06:00:00Z"),
    });
    const user = makeUser();
    const prediction = makePrediction(user.user_id, match.match_id);
    await repo.users.insert(user);
    await repo.predictions.insert(prediction);
    await repo.settlementItems.insert(makeItem(settlement, prediction));
    const service = new AdminRetrySettlementService(repo);

    await service.retry(TRUSTED_OPENID, match.match_id, NOW);

    expect(await repo.predictions.findById(prediction.prediction_id)).toMatchObject({
      match_score: 12,
      wdl_hit: true,
      exact_hit: true,
      applied_result_version: 1,
    });
    expect(await repo.users.findById(user.user_id)).toMatchObject({
      career_points: 12,
      career_valid_predictions: 1,
      career_wdl_hits: 1,
      career_exact_hits: 1,
    });
  });

  it("failed settlement 不能把已 settled 的比赛非法改回 settling", async () => {
    const { repo, match } = await setup({
      settlement_status: SettlementStatus.Settled,
      settled_result_version: 1,
      settled_at: FINISH_AT,
    });
    const failed = await repo.settlements.findByStatus(SettlementDocStatus.Failed);
    const service = new AdminRetrySettlementService(repo);

    await expect(service.retry(TRUSTED_OPENID, match.match_id, NOW)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    expect((await repo.settlements.findByStatus(SettlementDocStatus.Failed))).toHaveLength(1);
    expect((await repo.matches.findById(match.match_id))?.settlement_status).toBe(
      SettlementStatus.Settled,
    );
    expect(failed).toHaveLength(1);
  });

  it("failed correction settlement 复用原 settlement，并按其 result_version 重试", async () => {
    const { repo, match, settlement } = await setup({
      result_version: 2,
      settled_result_version: 1,
    });
    await repo.matchResults.insert({
      ...makeResult(match.match_id),
      result_version: 2,
      regular_home_score: 1,
      regular_away_score: 1,
    });
    await repo.settlements.update({
      ...settlement,
      status: SettlementDocStatus.Settled,
      phase: SettlementPhase.Done,
      settled_at: NOW,
      last_error_code: null,
      last_error_message: null,
    });
    const correctionSettlement = makeFailedSettlement(match.match_id, {
      settlement_id: newUuid(),
      result_version: 2,
      is_correction: true,
    });
    await repo.settlements.insert(correctionSettlement);
    const service = new AdminRetrySettlementService(repo);

    const outcome = await service.retry(TRUSTED_OPENID, match.match_id, NOW);

    expect(outcome).toMatchObject({
      kind: "settled",
      settlement_id: correctionSettlement.settlement_id,
      result_version: 2,
      settlement_created: false,
      target_result_version: 2,
      processed_count: 0,
      skipped_applied_count: 0,
      audit_log: {
        action: "retry_settlement",
        entity_type: "settlement",
        entity_id: correctionSettlement.settlement_id,
      },
    });
    expect((await repo.settlements.findById(correctionSettlement.settlement_id))?.status).toBe(
      SettlementDocStatus.Settled,
    );
    expect((await repo.matches.findById(match.match_id))?.settled_result_version).toBe(2);
    expect((await repo.matches.findById(match.match_id))?.settlement_status).toBe(
      SettlementStatus.Settled,
    );
  });

  it("correction retry 仍有更高版本时：审计记录中间 correcting，并按 15.9 自动追平到 settled", async () => {
    const { repo, match, settlement } = await setup({
      result_version: 3,
      settled_result_version: 1,
    });
    await repo.matchResults.insert({
      ...makeResult(match.match_id),
      result_version: 2,
      regular_home_score: 1,
      regular_away_score: 1,
    });
    await repo.matchResults.insert({
      ...makeResult(match.match_id),
      result_version: 3,
      regular_home_score: 0,
      regular_away_score: 1,
    });
    await repo.settlements.update({
      ...settlement,
      status: SettlementDocStatus.Settled,
      phase: SettlementPhase.Done,
      settled_at: NOW,
      last_error_code: null,
      last_error_message: null,
    });
    const correctionSettlement = makeFailedSettlement(match.match_id, {
      settlement_id: newUuid(),
      result_version: 2,
      is_correction: true,
    });
    await repo.settlements.insert(correctionSettlement);

    const outcome = await new AdminRetrySettlementService(repo).retry(
      TRUSTED_OPENID,
      match.match_id,
      NOW,
    );

    expect(outcome.kind).toBe("settled");
    expect(await repo.matches.findById(match.match_id)).toMatchObject({
      settled_result_version: 3,
      settlement_status: SettlementStatus.Settled,
    });
    expect(
      await repo.settlements.findByMatchAndVersionAndRule(match.match_id, 3, "scoring_v1"),
    ).toMatchObject({
      status: SettlementDocStatus.Settled,
      is_correction: true,
    });
    // 审计仍只覆盖被 retry 的 settlement；new_value 记录 finalize 时 match 仍为 correcting。
    await expect(repo.adminAuditLogs.findByEntity("settlement", correctionSettlement.settlement_id))
      .resolves.toEqual([
        expect.objectContaining({
          old_value: expect.objectContaining({ settlement_status: "failed" }),
          new_value: expect.objectContaining({ settlement_status: "correcting" }),
        }),
      ]);
  });

  it("已有更高版本 settled settlement 时拒绝重试旧 failed settlement", async () => {
    const { repo, match, settlement } = await setup({
      result_version: 3,
      settled_result_version: 1,
    });
    await repo.matchResults.insert({
      ...makeResult(match.match_id),
      result_version: 2,
      regular_home_score: 1,
      regular_away_score: 1,
    });
    await repo.matchResults.insert({
      ...makeResult(match.match_id),
      result_version: 3,
      regular_home_score: 0,
      regular_away_score: 1,
    });
    await repo.settlements.update({
      ...settlement,
      status: SettlementDocStatus.Settled,
      phase: SettlementPhase.Done,
      settled_at: NOW,
      last_error_code: null,
      last_error_message: null,
    });
    const correctionSettlement = makeFailedSettlement(match.match_id, {
      settlement_id: newUuid(),
      result_version: 2,
      is_correction: true,
    });
    await repo.settlements.insert(correctionSettlement);
    await repo.settlements.insert({
      ...makeFailedSettlement(match.match_id, {
        settlement_id: newUuid(),
        result_version: 3,
        status: SettlementDocStatus.Settled,
        phase: SettlementPhase.Done,
        is_correction: true,
        settled_at: NOW,
        last_error_code: null,
        last_error_message: null,
      }),
    });
    const worker = vi.fn(async () => {});

    await expect(
      new AdminRetrySettlementService(repo, worker).retry(
        TRUSTED_OPENID,
        match.match_id,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(worker).not.toHaveBeenCalled();
    expect(await repo.settlements.findById(correctionSettlement.settlement_id)).toMatchObject({
      status: SettlementDocStatus.Failed,
      result_version: 2,
    });
    expect(await repo.adminAuditLogs.findByEntity("settlement", correctionSettlement.settlement_id)).toEqual([]);
  });
});
