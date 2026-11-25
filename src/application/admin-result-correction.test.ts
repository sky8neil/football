import { describe, expect, it } from "vitest";
import {
  AdminResultCorrectionService,
  type AdminResultCorrectionInput,
} from "./admin-result-correction.js";
import {
  AdminRole,
  AdminStatus,
  AnomalyStatus,
  AnomalyType,
  MatchStatus,
  Result,
  ResultSource,
  SettlementDocStatus,
  SettlementPhase,
  SettlementStatus,
  UserStatus,
} from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { Admin, Anomaly, Match, MatchResult, Prediction, SettlementDoc, User } from "../domain/types.js";
import { defaultLevelState } from "../domain/types.js";
import { FirstSettlementService } from "./first-settlement-service.js";
import { AdminRetrySettlementService } from "./admin-retry-settlement.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");

function makeAdmin(overrides: Partial<Admin> = {}): Admin {
  return {
    schema_version: 1,
    admin_id: "00000000-0000-4000-8000-000000000001",
    openid: "admin-openid",
    status: AdminStatus.Active,
    role: AdminRole.Admin,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeMatch(overrides: Partial<Match> = {}): Match {
  const canonicalMatchIdentity = overrides.match_id ?? ("00000000-0000-4000-8000-000000000010");
  return {
    schema_version: 1,
    match_id: canonicalMatchIdentity,
    canonical_match_id: overrides.canonical_match_id ?? canonicalMatchIdentity,
    superseded_by: overrides.superseded_by ?? null,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: "00000000-0000-4000-8000-000000000011",
    away_team_id: "00000000-0000-4000-8000-000000000012",
    kickoff_at: new Date("2026-08-08T06:00:00.000Z"),
    kickoff_confirmed: true,
    prediction_deadline_at: null,
    prediction_closed_at: NOW,
    period_anchor_at: NOW,
    match_status: MatchStatus.Finished,
    settlement_status: SettlementStatus.Settled,
    regular_home_score: 2,
    regular_away_score: 1,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 1,
    settled_result_version: 1,
    result_source: ResultSource.Provider,
    scoring_rule_version: "scoring_v1",
    finish_detected_at: NOW,
    settled_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeResult(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    schema_version: 1,
    match_id: "00000000-0000-4000-8000-000000000010",
    result_version: 1,
    regular_home_score: 2,
    regular_away_score: 1,
    source: ResultSource.Provider,
    provider_status: "FT",
    admin_id: null,
    reason: null,
    created_at: NOW,
    ...overrides,
  };
}

function correction(overrides: Partial<AdminResultCorrectionInput> = {}): AdminResultCorrectionInput {
  return {
    expected_result_version: 1,
    regular_home_score: 1,
    regular_away_score: 1,
    reason: "Provider 正式比分更正",
    ...overrides,
  };
}

async function seedSettledMatch(
  repo: InMemoryRepository,
  matchOverrides: Partial<Match> = {},
): Promise<Match> {
  const match = makeMatch(matchOverrides);
  await repo.admins.insert(makeAdmin());
  await repo.matches.insert(match);
  await repo.matchResults.insert(makeResult({ match_id: match.match_id }));
  return match;
}

const SETTLEMENT_FIELDS = ["settlement_status", "settled_result_version", "settled_at"] as const;

function watchMatchPatch(repo: InMemoryRepository): {
  repo: AppRepository;
  calls: string[];
  patches: Array<Partial<Match>>;
} {
  const calls: string[] = [];
  const patches: Array<Partial<Match>> = [];
  const guardedRepo = Object.create(repo) as AppRepository;
  Object.defineProperty(guardedRepo, "withTransaction", {
    value: <T>(fn: (tx: UnitOfWork) => Promise<T>) =>
      repo.withTransaction((tx) => {
        const guardedTx = Object.create(tx) as UnitOfWork;
        Object.defineProperty(guardedTx, "matches", {
          value: {
            ...tx.matches,
            findById: async (matchId: string) => {
              calls.push("findById");
              return tx.matches.findById(matchId);
            },
            findByIdForUpdate: async (matchId: string) => {
              calls.push("findByIdForUpdate");
              return tx.matches.findByIdForUpdate!(matchId);
            },
            update: async () => {
              calls.push("update");
              throw new Error("matches.update full document overwrite");
            },
            patchFields: async (matchId: string, fields: Partial<Match>) => {
              calls.push("patchFields");
              for (const key of SETTLEMENT_FIELDS) {
                if (Object.prototype.hasOwnProperty.call(fields, key)) {
                  throw new Error(`patch overwrote ${key}`);
                }
              }
              patches.push(fields);
              return tx.matches.patchFields!(matchId, fields);
            },
            updateSettlementStatus: async (
              matchId: string,
              status: Match["settlement_status"],
              updatedAt: Date,
            ) => {
              calls.push("updateSettlementStatus");
              return tx.matches.updateSettlementStatus(matchId, status, updatedAt);
            },
          },
        });
        return fn(guardedTx);
      }),
  });
  return { repo: guardedRepo, calls, patches };
}

function withSettlementWriteGuard(
  repo: InMemoryRepository,
  writes: Array<{ kind: "update" | "updateSettlementStatus"; value: Partial<Match> }>,
): AppRepository {
  const guardedRepo = Object.create(repo) as AppRepository;
  Object.defineProperty(guardedRepo, "withTransaction", {
    value: <T>(fn: (tx: UnitOfWork) => Promise<T>) =>
      repo.withTransaction((tx) =>
        {
          const guardedTx = Object.create(tx) as UnitOfWork;
          Object.defineProperty(guardedTx, "matches", {
            value: {
              ...tx.matches,
              update: async (updated: Match) => {
                const current = await tx.matches.findById(updated.match_id);
                if (current !== null && current.settlement_status !== updated.settlement_status) {
                  throw new Error("raw settlement_status update");
                }
                writes.push({ kind: "update", value: updated });
                return tx.matches.update(updated);
              },
              updateSettlementStatus: async (
                matchId: string,
                status: Match["settlement_status"],
                updatedAt: Date,
              ) => {
                writes.push({
                  kind: "updateSettlementStatus",
                  value: { match_id: matchId, settlement_status: status, updated_at: updatedAt },
                });
                return tx.matches.updateSettlementStatus(matchId, status, updatedAt);
              },
            },
          });
          return fn(guardedTx);
        },
      ),
  });
  return guardedRepo;
}

describe("AdminResultCorrectionService", () => {
  it("active admin 可修正赛果，并追加 immutable result、排队 correcting 和审计", async () => {
    const repo = new InMemoryRepository();
    const match = await seedSettledMatch(repo);
    const writes: Array<{
      kind: "update" | "updateSettlementStatus";
      value: Partial<Match>;
    }> = [];

    const outcome = await new AdminResultCorrectionService(withSettlementWriteGuard(repo, writes)).correct(
      "admin-openid",
      match.match_id,
      correction(),
      NOW,
    );

    expect(outcome).toMatchObject({
      admin_id: "00000000-0000-4000-8000-000000000001",
      result: {
        match_id: match.match_id,
        result_version: 2,
        regular_home_score: 1,
        regular_away_score: 1,
        source: ResultSource.Admin,
        admin_id: "00000000-0000-4000-8000-000000000001",
        reason: "Provider 正式比分更正",
      },
      match: {
        result_version: 2,
        regular_home_score: 1,
        regular_away_score: 1,
        result_source: ResultSource.Admin,
        settlement_status: SettlementStatus.Correcting,
      },
      audit_log: {
        admin_id: "00000000-0000-4000-8000-000000000001",
        action: "result_correction",
        entity_type: "match",
        entity_id: match.match_id,
        reason: "Provider 正式比分更正",
      },
    });

    expect(await repo.matchResults.findByMatchAndVersion(match.match_id, 1)).toMatchObject({
      regular_home_score: 2,
      regular_away_score: 1,
      source: ResultSource.Provider,
    });
    expect(await repo.matchResults.findByMatchAndVersion(match.match_id, 2)).toBe(
      outcome.result,
    );
    expect(await repo.adminAuditLogs.findByEntity("match", match.match_id)).toEqual([
      outcome.audit_log,
    ]);
    expect(writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "updateSettlementStatus",
          value: expect.objectContaining({
            settlement_status: SettlementStatus.Correcting,
          }),
        }),
      ]),
    );
  });

  it("v0 finished match 可由管理员写入首次正式结果并保持 waiting", async () => {
    const freshRepo = new InMemoryRepository();
    const freshMatch = makeMatch({
      result_version: 0,
      settled_result_version: 0,
      settlement_status: SettlementStatus.Waiting,
      regular_home_score: null,
      regular_away_score: null,
      result_source: null,
    });
    await freshRepo.admins.insert(makeAdmin());
    await freshRepo.matches.insert(freshMatch);

    const outcome = await new AdminResultCorrectionService(freshRepo).correct(
      "admin-openid",
      freshMatch.match_id,
      correction({
        expected_result_version: 0,
        regular_home_score: 0,
        regular_away_score: 2,
      }),
      NOW,
    );

    expect(outcome.match).toMatchObject({
      result_version: 1,
      settled_result_version: 0,
      settlement_status: SettlementStatus.Waiting,
    });
  });

  it("settling + settled_result_version=0：admin 修正比分成功，settlement_status 保持 settling", async () => {
    const repo = new InMemoryRepository();
    const match = await seedSettledMatch(repo, {
      settlement_status: SettlementStatus.Settling,
      settled_result_version: 0,
      settled_at: null,
    });

    const outcome = await new AdminResultCorrectionService(repo).correct(
      "admin-openid",
      match.match_id,
      correction({ expected_result_version: 1, regular_home_score: 3, regular_away_score: 0 }),
      NOW,
    );

    expect(outcome.match).toMatchObject({
      result_version: 2,
      settled_result_version: 0,
      settlement_status: SettlementStatus.Settling,
      regular_home_score: 3,
      regular_away_score: 0,
      result_source: ResultSource.Admin,
    });
    expect(await repo.matchResults.findByMatchAndVersion(match.match_id, 2)).toMatchObject({
      result_version: 2,
      regular_home_score: 3,
      regular_away_score: 0,
      source: ResultSource.Admin,
    });
    expect(await repo.adminAuditLogs.findByEntity("match", match.match_id)).toHaveLength(1);
  });

  it("failed + settled_result_version=0：admin 修正比分成功，settlement_status 保持 failed", async () => {
    const repo = new InMemoryRepository();
    const match = await seedSettledMatch(repo, {
      settlement_status: SettlementStatus.Failed,
      settled_result_version: 0,
      settled_at: null,
    });

    const outcome = await new AdminResultCorrectionService(repo).correct(
      "admin-openid",
      match.match_id,
      correction({ expected_result_version: 1, regular_home_score: 0, regular_away_score: 2 }),
      NOW,
    );

    expect(outcome.match).toMatchObject({
      result_version: 2,
      settled_result_version: 0,
      settlement_status: SettlementStatus.Failed,
      regular_home_score: 0,
      regular_away_score: 2,
    });
    expect(await repo.matchResults.findByMatchAndVersion(match.match_id, 2)).toMatchObject({
      result_version: 2,
      regular_home_score: 0,
      regular_away_score: 2,
    });
  });

  it("voided 状态：admin 修正被拒绝（MATCH_STATE_CONFLICT），不写结果与审计", async () => {
    const repo = new InMemoryRepository();
    const match = await seedSettledMatch(repo, {
      settlement_status: SettlementStatus.Voided,
      settled_result_version: 0,
      settled_at: null,
    });

    await expect(
      new AdminResultCorrectionService(repo).correct(
        "admin-openid",
        match.match_id,
        correction(),
        NOW,
      ),
    ).rejects.toMatchObject({ code: "MATCH_STATE_CONFLICT" });
    expect(await repo.matchResults.findLatestByMatch(match.match_id)).toMatchObject({
      result_version: 1,
    });
    expect(await repo.adminAuditLogs.findByEntity("match", match.match_id)).toEqual([]);
  });

  it("M121 非管理员调用 admin API 时拒绝，且缺少身份返回 AUTH_REQUIRED", async () => {
    const repo = new InMemoryRepository();
    const match = await seedSettledMatch(repo);
    const service = new AdminResultCorrectionService(repo);

    await expect(service.correct(null, match.match_id, correction(), NOW)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    await expect(
      service.correct("unknown-openid", match.match_id, correction(), NOW),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const disabledRepo = new InMemoryRepository();
    const disabledMatch = makeMatch();
    await disabledRepo.admins.insert(makeAdmin({ status: AdminStatus.Disabled }));
    await disabledRepo.matches.insert(disabledMatch);
    await disabledRepo.matchResults.insert(makeResult({ match_id: disabledMatch.match_id }));
    await expect(
      new AdminResultCorrectionService(disabledRepo).correct(
        "admin-openid",
        disabledMatch.match_id,
        correction(),
        NOW,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("expected_result_version 不匹配时 fail closed 且不写结果、比赛或审计", async () => {
    const repo = new InMemoryRepository();
    const match = await seedSettledMatch(repo);

    await expect(
      new AdminResultCorrectionService(repo).correct(
        "admin-openid",
        match.match_id,
        correction({ expected_result_version: 0 }),
        NOW,
      ),
    ).rejects.toMatchObject({ code: "RESULT_VERSION_CONFLICT" });

    expect(await repo.matches.findById(match.match_id)).toEqual(match);
    expect(await repo.matchResults.findLatestByMatch(match.match_id)).toMatchObject({
      result_version: 1,
    });
    expect(await repo.adminAuditLogs.findByEntity("match", match.match_id)).toEqual([]);
  });

  it("无效 server_now 时 fail closed 且不写结果、比赛或审计", async () => {
    const repo = new InMemoryRepository();
    const match = await seedSettledMatch(repo);
    const invalidNow = new Date("invalid");

    await expect(
      new AdminResultCorrectionService(repo).correct(
        "admin-openid",
        match.match_id,
        correction(),
        invalidNow,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "server_now" },
    });

    expect(await repo.matches.findById(match.match_id)).toEqual(match);
    expect(await repo.matchResults.findLatestByMatch(match.match_id)).toMatchObject({
      result_version: 1,
    });
    expect(await repo.adminAuditLogs.findByEntity("match", match.match_id)).toEqual([]);
  });

  it("新比分相同拒绝且保留旧版本", async () => {
    const repo = new InMemoryRepository();
    const match = await seedSettledMatch(repo);

    await expect(
      new AdminResultCorrectionService(repo).correct(
        "admin-openid",
        match.match_id,
        correction({ regular_home_score: 2, regular_away_score: 1 }),
        NOW,
      ),
    ).rejects.toMatchObject({ code: "RESULT_UNCHANGED" });
    expect(await repo.matchResults.findLatestByMatch(match.match_id)).toMatchObject({
      result_version: 1,
    });
    expect(await repo.adminAuditLogs.findByEntity("match", match.match_id)).toEqual([]);
  });

  it("waiting 首次修正先锁后读再局部写入，不覆写结算状态与职责外字段", async () => {
    const repo = new InMemoryRepository();
    const settledAt = new Date("2026-08-08T12:00:00.000Z");
    const match = makeMatch({
      result_version: 0,
      settled_result_version: 0,
      settlement_status: SettlementStatus.Waiting,
      regular_home_score: null,
      regular_away_score: null,
      result_source: null,
      extra_home_score: 4,
      penalty_away_score: 2,
      settled_at: settledAt,
    });
    await repo.admins.insert(makeAdmin());
    await repo.matches.insert(match);
    const watched = watchMatchPatch(repo);

    const outcome = await new AdminResultCorrectionService(watched.repo).correct(
      "admin-openid",
      match.match_id,
      correction({ expected_result_version: 0, regular_home_score: 1, regular_away_score: 0 }),
      NOW,
    );

    expect(outcome.match).toMatchObject({
      result_version: 1,
      settlement_status: SettlementStatus.Waiting,
      settled_result_version: 0,
      settled_at: settledAt,
      extra_home_score: 4,
      penalty_away_score: 2,
    });
    expect(await repo.matches.findById(match.match_id)).toMatchObject({
      result_version: 1,
      regular_home_score: 1,
      regular_away_score: 0,
      result_source: ResultSource.Admin,
      settlement_status: SettlementStatus.Waiting,
      settled_result_version: 0,
      settled_at: settledAt,
      extra_home_score: 4,
      penalty_away_score: 2,
    });
    expect(watched.calls[0]).toBe("findByIdForUpdate");
    expect(watched.calls.indexOf("findById")).toBeGreaterThan(0);
    expect(watched.calls.indexOf("patchFields")).toBeGreaterThan(watched.calls.indexOf("findById"));
    expect(watched.calls).not.toContain("update");
    expect(watched.calls).not.toContain("updateSettlementStatus");
    expect(Object.keys(watched.patches[0] ?? {}).sort()).toEqual([
      "regular_away_score",
      "regular_home_score",
      "result_source",
      "result_version",
      "updated_at",
    ]);
  });

  it("已结算修正先锁再转移状态，局部 patch 保留 settled_at 与 settled_result_version", async () => {
    const repo = new InMemoryRepository();
    const settledAt = new Date("2026-08-08T12:00:00.000Z");
    const match = await seedSettledMatch(repo, {
      extra_home_score: 6,
      settled_at: settledAt,
    });
    const watched = watchMatchPatch(repo);

    const outcome = await new AdminResultCorrectionService(watched.repo).correct(
      "admin-openid",
      match.match_id,
      correction(),
      NOW,
    );

    expect(outcome.match).toMatchObject({
      result_version: 2,
      settlement_status: SettlementStatus.Correcting,
      settled_result_version: 1,
      settled_at: settledAt,
      extra_home_score: 6,
    });
    expect(await repo.matches.findById(match.match_id)).toMatchObject({
      settlement_status: SettlementStatus.Correcting,
      settled_result_version: 1,
      settled_at: settledAt,
      extra_home_score: 6,
      regular_home_score: 1,
      regular_away_score: 1,
      result_version: 2,
    });
    const lockAt = watched.calls.indexOf("findByIdForUpdate");
    const readAt = watched.calls.indexOf("findById");
    const statusAt = watched.calls.indexOf("updateSettlementStatus");
    const patchAt = watched.calls.indexOf("patchFields");
    expect(lockAt).toBe(0);
    expect(readAt).toBeGreaterThan(lockAt);
    expect(statusAt).toBeGreaterThan(readAt);
    expect(patchAt).toBeGreaterThan(statusAt);
    expect(watched.calls).not.toContain("update");
    expect(watched.patches[0]).not.toHaveProperty("settlement_status");
    expect(watched.patches[0]).not.toHaveProperty("settled_result_version");
    expect(watched.patches[0]).not.toHaveProperty("settled_at");
  });

  it("A-S8-03 同事务按白名单自动解除赛果类阻塞异常，并打通阻塞异常 → 修正赛果 → 结算解锁闭环", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch({
      result_version: 0,
      settled_result_version: 0,
      settlement_status: SettlementStatus.Waiting,
      regular_home_score: null,
      regular_away_score: null,
      result_source: null,
      finish_detected_at: new Date("2026-08-08T10:00:00.000Z"),
      settled_at: null,
    });
    await repo.admins.insert(makeAdmin());
    await repo.matches.insert(match);

    const user: User = {
      schema_version: 1,
      user_id: "00000000-0000-4000-8000-000000000091",
      openid: "user-openid-91",
      unionid: null,
      nickname: "Tester",
      favorite_team_id: null,
      status: UserStatus.Active,
      career_points: 0,
      career_valid_predictions: 0,
      career_wdl_hits: 0,
      career_exact_hits: 0,
      career_last_scoring_match_at: null,
      career_level: 1,
      career_best_level: 1,
      career_level_state: defaultLevelState(),
      deleted_at: null,
      created_at: NOW,
      updated_at: NOW,
    };
    await repo.users.insert(user);
    const prediction: Prediction = {
      schema_version: 1,
      prediction_id: "00000000-0000-4000-8000-000000000092",
      user_id: user.user_id,
      match_id: match.match_id,
      canonical_match_id: match.canonical_match_id,
      idempotency_key: newUuid(),
      pred_home_score: 2,
      pred_away_score: 1,
      derived_result: Result.Home,
      submitted_at: new Date("2026-08-08T05:00:00.000Z"),
      scoring_rule_version: "scoring_v1",
      match_score: null,
      wdl_hit: null,
      exact_hit: null,
      applied_result_version: 0,
      created_at: NOW,
      updated_at: NOW,
    };
    await repo.predictions.insert(prediction);

    const blockingStatusAnomaly: Anomaly = {
      schema_version: 1,
      anomaly_id: "00000000-0000-4000-8000-000000000081",
      anomaly_key: `${match.match_id}:${AnomalyType.UnexpectedProviderStatus}`,
      match_id: match.match_id,
      type: AnomalyType.UnexpectedProviderStatus,
      blocking: true,
      status: AnomalyStatus.Open,
      first_seen_at: NOW,
      last_seen_at: NOW,
      occurrence_count: 1,
      details: { raw_status: "INT" },
      resolved_at: null,
      resolution: null,
    };
    const conflictAnomaly: Anomaly = {
      schema_version: 1,
      anomaly_id: "00000000-0000-4000-8000-000000000082",
      anomaly_key: `${match.match_id}:${AnomalyType.AdminProviderResultConflict}`,
      match_id: match.match_id,
      type: AnomalyType.AdminProviderResultConflict,
      blocking: false,
      status: AnomalyStatus.Open,
      first_seen_at: NOW,
      last_seen_at: NOW,
      occurrence_count: 1,
      details: {},
      resolved_at: null,
      resolution: null,
    };
    await repo.anomalies.insert(blockingStatusAnomaly);
    await repo.anomalies.insert(conflictAnomaly);

    // 修正前被阻塞异常拦截，无法启动结算
    const firstSettlement = new FirstSettlementService(repo);
    const blocked = await firstSettlement.start(match.match_id, NOW, true);
    expect(blocked).toEqual({ kind: "not_started", code: "SETTLEMENT_NOT_READY" });

    // 管理员修正赛果后同事务解除白名单异常
    const outcome = await new AdminResultCorrectionService(repo).correct(
      "admin-openid",
      match.match_id,
      correction({ expected_result_version: 0, regular_home_score: 2, regular_away_score: 1 }),
      NOW,
    );
    expect(outcome.resolved_anomaly_ids?.sort()).toEqual([
      blockingStatusAnomaly.anomaly_id,
      conflictAnomaly.anomaly_id,
    ]);
    expect(await repo.anomalies.findOpenBlockingByMatch(match.match_id)).toEqual([]);
    expect(await repo.anomalies.findById!(blockingStatusAnomaly.anomaly_id)).toMatchObject({
      status: AnomalyStatus.Resolved,
      resolved_at: NOW,
      resolution: `admin_result_correction:${outcome.audit_log.audit_id}`,
    });

    // 解锁后结算顺利完成
    const unlocked = await firstSettlement.start(match.match_id, NOW, false);
    expect(unlocked).toMatchObject({ kind: "started", processed_count: 1 });
    expect((await repo.matches.findById(match.match_id))?.settlement_status).toBe(
      SettlementStatus.Settled,
    );
  });

  it("A-S8-03 非赛果白名单阻塞异常（TEAM_CHANGE_AFTER_PREDICTION）不会被赛果修正自动解除，且 failed 结算在修正后可通过 retry 解锁", async () => {
    const repo = new InMemoryRepository();
    const match = await seedSettledMatch(repo, {
      settlement_status: SettlementStatus.Failed,
      settled_result_version: 0,
      settled_at: null,
    });
    const failedSettlement: SettlementDoc = {
      schema_version: 1,
      settlement_id: "00000000-0000-4000-8000-000000000077",
      match_id: match.match_id,
      result_version: 1,
      rule_version: "scoring_v1",
      status: SettlementDocStatus.Failed,
      phase: SettlementPhase.ApplyItems,
      is_correction: false,
      started_at: NOW,
      settled_at: null,
      attempt_count: 1,
      last_error_code: "SETTLEMENT_ITEM_FAILED",
      last_error_message: "transient",
      created_at: NOW,
      updated_at: NOW,
    };
    await repo.settlements.insert(failedSettlement);

    const stateConflict: Anomaly = {
      schema_version: 1,
      anomaly_id: "00000000-0000-4000-8000-000000000083",
      anomaly_key: `${match.match_id}:${AnomalyType.ProviderStateConflict}`,
      match_id: match.match_id,
      type: AnomalyType.ProviderStateConflict,
      blocking: true,
      status: AnomalyStatus.Open,
      first_seen_at: NOW,
      last_seen_at: NOW,
      occurrence_count: 1,
      details: {},
      resolved_at: null,
      resolution: null,
    };
    const teamChange: Anomaly = {
      schema_version: 1,
      anomaly_id: "00000000-0000-4000-8000-000000000084",
      anomaly_key: `${match.match_id}:${AnomalyType.TeamChangeAfterPrediction}`,
      match_id: match.match_id,
      type: AnomalyType.TeamChangeAfterPrediction,
      blocking: true,
      status: AnomalyStatus.Open,
      first_seen_at: NOW,
      last_seen_at: NOW,
      occurrence_count: 1,
      details: {},
      resolved_at: null,
      resolution: null,
    };
    await repo.anomalies.insert(stateConflict);
    await repo.anomalies.insert(teamChange);

    const retryService = new AdminRetrySettlementService(repo);
    await expect(retryService.retry("admin-openid", match.match_id, NOW)).rejects.toMatchObject({
      code: "SETTLEMENT_NOT_READY",
    });

    await new AdminResultCorrectionService(repo).correct(
      "admin-openid",
      match.match_id,
      correction({ expected_result_version: 1, regular_home_score: 3, regular_away_score: 1 }),
      NOW,
    );

    expect(await repo.anomalies.findById!(stateConflict.anomaly_id)).toMatchObject({
      status: AnomalyStatus.Resolved,
    });
    expect(await repo.anomalies.findById!(teamChange.anomaly_id)).toMatchObject({
      status: AnomalyStatus.Open,
    });

    // 非白名单阻塞异常仍在时，retry 仍拒绝；仅当它被解除后才解锁
    await expect(retryService.retry("admin-openid", match.match_id, NOW)).rejects.toMatchObject({
      code: "SETTLEMENT_NOT_READY",
    });
    await repo.anomalies.update({
      ...teamChange,
      status: AnomalyStatus.Resolved,
      resolved_at: NOW,
      resolution: "manual",
    });
    const retried = await retryService.retry("admin-openid", match.match_id, NOW);
    expect(retried).toMatchObject({ kind: "settled" });
  });

  it("[CR-19] 拒绝纯空白 reason", async () => {
    const repo = new InMemoryRepository();
    await repo.admins.insert(makeAdmin());
    await repo.matches.insert(makeMatch());
    await expect(
      new AdminResultCorrectionService(repo).correct(
        "admin-openid",
        "00000000-0000-4000-8000-000000000010",
        correction({ reason: "   \t\n  " }),
        NOW,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("[CR-29] 赛果修正同事务内自动解除 LIVE_TOO_LONG 阻塞异常", async () => {
    const repo = new InMemoryRepository();
    const match = await seedSettledMatch(repo, {
      settlement_status: SettlementStatus.Failed,
      settled_result_version: 0,
      settled_at: null,
    });
    const liveTooLong: Anomaly = {
      schema_version: 1,
      anomaly_id: "00000000-0000-4000-8000-000000000599",
      anomaly_key: `${match.match_id}:${AnomalyType.LiveTooLong}`,
      match_id: match.match_id,
      type: AnomalyType.LiveTooLong,
      blocking: true,
      status: AnomalyStatus.Open,
      first_seen_at: NOW,
      last_seen_at: NOW,
      occurrence_count: 1,
      details: {},
      resolved_at: null,
      resolution: null,
    };
    await repo.anomalies.insert(liveTooLong);

    const outcome = await new AdminResultCorrectionService(repo).correct(
      "admin-openid",
      match.match_id,
      correction({ expected_result_version: 1, regular_home_score: 2, regular_away_score: 0 }),
      NOW,
    );

    expect(outcome.resolved_anomaly_ids).toEqual([liveTooLong.anomaly_id]);
    expect(await repo.anomalies.findById!(liveTooLong.anomaly_id)).toMatchObject({
      status: AnomalyStatus.Resolved,
      resolution: `admin_result_correction:${outcome.audit_log.audit_id}`,
    });
  });
});
