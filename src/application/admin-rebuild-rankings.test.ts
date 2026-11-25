import { describe, expect, it, vi } from "vitest";
import type { UnitOfWork } from "../infrastructure/repositories.js";
import { rankingPeriodLockKey } from "./settlement-item-application-service.js";
import {
  AdminRole,
  AdminStatus,
  MatchScoreValue,
  MatchStatus,
  PeriodType,
  RankingBoard,
  Result,
  SettlementDocStatus,
  SettlementItemStatus,
  SettlementPhase,
  SettlementStatus,
} from "../domain/enums.js";
import type {
  Admin,
  Match,
  MatchResult,
  Prediction,
  RankingEntry,
  SettlementDoc,
  SettlementItem,
  User,
  UserSeasonStats,
} from "../domain/types.js";
import { defaultLevelState } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import {
  AdminRebuildRankingsService,
} from "./admin-rebuild-rankings.js";
import {
  periodRankingsRebuildLockKey,
  RebuildPeriodRankingsService,
} from "./ranking-rebuild-service.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const ANCHOR = new Date("2026-08-05T12:00:00.000Z");
const ADMIN_ID = "00000000-0000-4000-8000-000000000001";

function makeAdmin(overrides: Partial<Admin> = {}): Admin {
  return {
    schema_version: 1,
    admin_id: ADMIN_ID,
    openid: "admin-openid",
    status: AdminStatus.Active,
    role: AdminRole.Admin,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeRankUser(userId: string): User {
  return {
    schema_version: 1,
    user_id: userId,
    openid: `openid-${userId}`,
    unionid: null,
    nickname: userId,
    favorite_team_id: null,
    status: "active",
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
}

function makeSeasonStats(
  userId: string,
  points: number,
  levelSeasonId = "2026_2027",
): UserSeasonStats {
  return {
    schema_version: 1,
    user_id: userId,
    level_season_id: levelSeasonId,
    points,
    valid_predictions: 1,
    wdl_hits: 1,
    exact_hits: 1,
    last_scoring_match_at: ANCHOR,
    level: 1,
    best_level: 1,
    level_state: defaultLevelState(),
    is_level_frozen: false,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeMatch(overrides: Partial<Match> = {}): Match {
  const canonicalMatchIdentity = overrides.match_id ?? ("match-1");
  return {
    schema_version: 1,
    match_id: canonicalMatchIdentity,
    canonical_match_id: overrides.canonical_match_id ?? canonicalMatchIdentity,
    superseded_by: overrides.superseded_by ?? null,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: "home-1",
    away_team_id: "away-1",
    kickoff_at: ANCHOR,
    kickoff_confirmed: true,
    prediction_deadline_at: NOW,
    prediction_closed_at: NOW,
    period_anchor_at: ANCHOR,
    match_status: MatchStatus.Finished,
    settlement_status: SettlementStatus.Settled,
    regular_home_score: 1,
    regular_away_score: 0,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 1,
    settled_result_version: 1,
    result_source: "provider",
    scoring_rule_version: "scoring_v1",
    finish_detected_at: NOW,
    settled_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makePrediction(): Prediction {
  return {
    schema_version: 1,
    prediction_id: "prediction-1",
    user_id: "user-1",
    match_id: "match-1",
    canonical_match_id: "match-1",
    idempotency_key: "prediction-key-1",
    pred_home_score: 1,
    pred_away_score: 0,
    derived_result: Result.Home,
    submitted_at: NOW,
    scoring_rule_version: "scoring_v1",
    match_score: null,
    wdl_hit: null,
    exact_hit: null,
    applied_result_version: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeResult(): MatchResult {
  return {
    schema_version: 1,
    match_id: "match-1",
    result_version: 1,
    regular_home_score: 1,
    regular_away_score: 0,
    source: "provider",
    provider_status: "FT",
    admin_id: null,
    reason: null,
    created_at: NOW,
  };
}

function makeSettlement(): SettlementDoc {
  return {
    schema_version: 1,
    settlement_id: "settlement-1",
    match_id: "match-1",
    result_version: 1,
    rule_version: "scoring_v1",
    status: SettlementDocStatus.Settled,
    phase: SettlementPhase.Done,
    is_correction: false,
    started_at: NOW,
    settled_at: NOW,
    attempt_count: 1,
    last_error_code: null,
    last_error_message: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeItem(): SettlementItem {
  return {
    schema_version: 1,
    settlement_id: "settlement-1",
    prediction_id: "prediction-1",
    user_id: "user-1",
    old_score: MatchScoreValue.Miss,
    new_score: MatchScoreValue.ExactHit,
    score_delta: 12,
    old_wdl_hit: false,
    new_wdl_hit: true,
    old_exact_hit: false,
    new_exact_hit: true,
    valid_prediction_delta: 1,
    source_result_version: 1,
    status: SettlementItemStatus.Applied,
    applied_at: NOW,
    attempt_count: 1,
    last_error_code: null,
    last_error_message: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeRanking(overrides: Partial<RankingEntry> = {}): RankingEntry {
  return {
    schema_version: 1,
    period_type: PeriodType.Week,
    period_key: "2026-W32",
    user_id: "user-1",
    period_score: 99,
    valid_predictions: 9,
    wdl_hits: 9,
    exact_hits: 9,
    last_scoring_match_at: new Date("2026-08-01T00:00:00.000Z"),
    global_rank: 1,
    is_final: false,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

async function seedAdmin(repo: InMemoryRepository, admin = makeAdmin()): Promise<void> {
  await repo.admins.insert(admin);
}

async function seedAppliedFact(repo: InMemoryRepository): Promise<void> {
  await repo.matches.insert(makeMatch());
  await repo.predictions.insert(makePrediction());
  await repo.matchResults.insert(makeResult());
  await repo.settlements.insert(makeSettlement());
  await repo.settlementItems.insert(makeItem());
}

describe("AdminRebuildRankingsService", () => {
  it("无效 server_now 在获取维护锁和写入审计前 Fail Closed", async () => {
    const repo = new InMemoryRepository();
    await seedAdmin(repo);

    await expect(
      new AdminRebuildRankingsService(repo).rebuild(
        "admin-openid",
        PeriodType.Week,
        "2026-W32",
        "一致性修复",
        new Date("invalid"),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "server_now" },
    });
    await expect(
      repo.adminAuditLogs.findByEntity("ranking_period", "week-2026-W32"),
    ).resolves.toEqual([]);
  });

  it("通过 trusted active admin 从 applied ledger 重建并保留 is_final，同时原子追加审计", async () => {
    const repo = new InMemoryRepository();
    await seedAdmin(repo);
    await seedAppliedFact(repo);
    await repo.rankings.insert(makeRanking({ is_final: true }));

    const outcome = await new AdminRebuildRankingsService(repo).rebuild(
      "admin-openid",
      PeriodType.Week,
      "2026-W32",
      "一致性修复",
      NOW,
    );

    expect(outcome.admin_id).toBe(ADMIN_ID);
    expect(outcome.rankings).toEqual([
      expect.objectContaining({
        period_score: 12,
        valid_predictions: 1,
        wdl_hits: 1,
        exact_hits: 1,
        global_rank: 1,
        is_final: true,
      }),
    ]);
    expect(outcome.audit_log).toMatchObject({
      admin_id: ADMIN_ID,
      action: "rebuild_rankings",
      entity_type: "ranking_period",
      entity_id: "week-2026-W32",
      reason: "一致性修复",
      old_value: {
        board: RankingBoard.Week,
        entry_count: 1,
        ranked_entry_count: 1,
        total_period_score: 99,
        max_global_rank: 1,
        is_final: true,
      },
      new_value: {
        board: RankingBoard.Week,
        entry_count: 1,
        ranked_entry_count: 1,
        total_period_score: 12,
        max_global_rank: 1,
        is_final: true,
      },
    });
    await expect(repo.adminAuditLogs.findByEntity("ranking_period", "week-2026-W32"))
      .resolves.toHaveLength(1);
  });

  it("全量重建会把目标周期已无事实的旧 ranking 缓存归零并保留 is_final", async () => {
    const repo = new InMemoryRepository();
    await seedAdmin(repo);
    await seedAppliedFact(repo);
    await repo.rankings.insert(
      makeRanking({
        user_id: "stale-user",
        period_score: 77,
        valid_predictions: 7,
        wdl_hits: 6,
        exact_hits: 4,
        last_scoring_match_at: ANCHOR,
        global_rank: 1,
        is_final: true,
      }),
    );

    const outcome = await new AdminRebuildRankingsService(repo).rebuild(
      "admin-openid",
      PeriodType.Week,
      "2026-W32",
      "一致性修复",
      NOW,
    );

    expect(outcome.rankings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        user_id: "stale-user",
        period_score: 0,
        valid_predictions: 0,
        wdl_hits: 0,
        exact_hits: 0,
        last_scoring_match_at: null,
        global_rank: null,
        is_final: true,
      }),
    ]));
    await expect(
      repo.rankings.findByPeriodAndUser(PeriodType.Week, "2026-W32", "stale-user"),
    ).resolves.toMatchObject({
      period_score: 0,
      valid_predictions: 0,
      wdl_hits: 0,
      exact_hits: 0,
      last_scoring_match_at: null,
      global_rank: null,
      is_final: true,
    });
  });

  it("只允许 active admin，未知或 disabled 身份不写入审计", async () => {
    const repo = new InMemoryRepository();
    await seedAdmin(repo, makeAdmin({ status: AdminStatus.Disabled }));

    await expect(
      new AdminRebuildRankingsService(repo).rebuild(
        "admin-openid",
        PeriodType.Week,
        "2026-W32",
        "一致性修复",
        NOW,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      new AdminRebuildRankingsService(repo).rebuild(
        "unknown-openid",
        PeriodType.Week,
        "2026-W32",
        "一致性修复",
        NOW,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(repo.adminAuditLogs.findByEntity("ranking_period", "week-2026-W32"))
      .resolves.toEqual([]);
  });

  it("维护锁已占用时仍先拒绝未知管理员", async () => {
    const repo = new InMemoryRepository();
    const lockKey = periodRankingsRebuildLockKey(PeriodType.Week, "2026-W32");
    await repo.jobLocks.acquire(
      lockKey,
      "existing-owner",
      new Date(Date.now() + 60 * 60 * 1000),
    );

    await expect(
      new AdminRebuildRankingsService(repo).rebuild(
        "unknown-openid",
        PeriodType.Week,
        "2026-W32",
        "一致性修复",
        NOW,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await repo.jobLocks.release(lockKey, "existing-owner");
  });

  it("目标周期存在 settling/correcting match 时拒绝重建且不写审计", async () => {
    const repo = new InMemoryRepository();
    await seedAdmin(repo);
    await repo.matches.insert(
      makeMatch({ settlement_status: SettlementStatus.Correcting }),
    );

    await expect(
      new AdminRebuildRankingsService(repo).rebuild(
        "admin-openid",
        PeriodType.Week,
        "2026-W32",
        "一致性修复",
        NOW,
      ),
    ).rejects.toMatchObject({ code: "SETTLEMENT_ALREADY_RUNNING" });
    await expect(repo.adminAuditLogs.findByEntity("ranking_period", "week-2026-W32"))
      .resolves.toEqual([]);
  });

  it("使用目标周期 maintenance lock，且 reason 不能为空白", async () => {
    const repo = new InMemoryRepository();
    await seedAdmin(repo);
    const lockKey = periodRankingsRebuildLockKey(PeriodType.Week, "2026-W32");
    await repo.jobLocks.acquire(
      lockKey,
      "existing-owner",
      new Date(Date.now() + 60 * 60 * 1000),
    );

    await expect(
      new AdminRebuildRankingsService(repo).rebuild(
        "admin-openid",
        PeriodType.Week,
        "2026-W32",
        "一致性修复",
        NOW,
      ),
    ).rejects.toMatchObject({ code: "RANKING_REBUILD_ALREADY_RUNNING" });
    await repo.jobLocks.release(lockKey, "existing-owner");

    for (const reason of ["", "   ", "\n\t"]) {
      await expect(
        new AdminRebuildRankingsService(repo).rebuild(
          "admin-openid",
          PeriodType.Week,
          "2026-W32",
          reason,
          NOW,
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
  });

  it("ranking 周期锁被占用时返回 RANKING_REBUILD_ALREADY_RUNNING 且不写审计", async () => {
    const repo = new InMemoryRepository();
    await seedAdmin(repo);
    const lockKey = rankingPeriodLockKey(PeriodType.Week, "2026-W32");
    await repo.jobLocks.acquire(
      lockKey,
      "existing-owner",
      new Date(Date.now() + 60 * 60 * 1000),
    );

    await expect(
      new AdminRebuildRankingsService(repo).rebuild(
        "admin-openid",
        PeriodType.Week,
        "2026-W32",
        "一致性修复",
        NOW,
      ),
    ).rejects.toMatchObject({ code: "RANKING_REBUILD_ALREADY_RUNNING" });
    await expect(repo.adminAuditLogs.findByEntity("ranking_period", "week-2026-W32"))
      .resolves.toEqual([]);
    await repo.jobLocks.release(lockKey, "existing-owner");
  });

  it("career snapshot rebuild 使用 board 审计标识并全量生成快照", async () => {
    const repo = new InMemoryRepository();
    await seedAdmin(repo);
    await repo.users.insert({
      schema_version: 1,
      user_id: "user-career",
      openid: "openid-user-career",
      unionid: null,
      nickname: "Career User",
      favorite_team_id: null,
      status: "active",
      career_points: 36,
      career_valid_predictions: 3,
      career_wdl_hits: 2,
      career_exact_hits: 2,
      career_last_scoring_match_at: ANCHOR,
      career_level: 1,
      career_best_level: 1,
      career_level_state: {
        below_count: 0,
        week_base_level: null,
        week_base_below_count: null,
        week_base_as_of: null,
        last_eval_as_of: null,
        last_eval_n: 0,
        last_eval_score_sum: 0,
        last_eval_b_points: 0,
        last_eval_rule_version: null,
      },
      deleted_at: null,
      created_at: NOW,
      updated_at: NOW,
    });

    const outcome = await new AdminRebuildRankingsService(repo).rebuild(
      "admin-openid",
      RankingBoard.Career,
      null,
      "一致性修复",
      NOW,
    );

    expect(outcome).toMatchObject({
      board: RankingBoard.Career,
      period_key: null,
      rebuilt_entry_count: 1,
      audit_log: {
        entity_id: "career-snapshot",
        old_value: { board: RankingBoard.Career, entry_count: 0, total_career_points: 0 },
        new_value: { board: RankingBoard.Career, entry_count: 1, total_career_points: 36 },
      },
    });
    await expect(repo.boardSnapshots.findByBoardAndSnapshotAt(RankingBoard.Career, NOW))
      .resolves.toHaveLength(1);
  });

  it("season snapshot rebuild audits total_season_points", async () => {
    const repo = new InMemoryRepository();
    await seedAdmin(repo);
    await repo.users.insert(makeRankUser("old-season-user"));
    await repo.userSeasonStats.insert(makeSeasonStats("old-season-user", 40, "2025_2026"));
    await new RebuildPeriodRankingsService(repo).rebuildBoardSnapshot(
      RankingBoard.Season,
      new Date("2026-06-30T10:00:00.000Z"),
    );
    await repo.users.insert(makeRankUser("user-season"));
    await repo.userSeasonStats.insert(makeSeasonStats("user-season", 36));

    const outcome = await new AdminRebuildRankingsService(repo).rebuild(
      "admin-openid",
      RankingBoard.Season,
      null,
      "赛季榜回填",
      NOW,
    );

    expect(outcome).toMatchObject({
      board: RankingBoard.Season,
      period_key: null,
      rebuilt_entry_count: 1,
      audit_log: {
        entity_id: "season-snapshot",
        old_value: { board: RankingBoard.Season, entry_count: 0, total_season_points: 0 },
        new_value: { board: RankingBoard.Season, entry_count: 1, total_season_points: 36 },
      },
    });
    await expect(repo.boardSnapshots.findByBoardAndSnapshotAt(RankingBoard.Season, NOW))
      .resolves.toHaveLength(1);
  });

  it("career/strength snapshot rebuild 遇到活跃结算比赛返回 409", async () => {
    const repo = new InMemoryRepository();
    await seedAdmin(repo);
    await repo.matches.insert(makeMatch({ settlement_status: SettlementStatus.Settling }));

    await expect(new AdminRebuildRankingsService(repo).rebuild(
      "admin-openid",
      RankingBoard.Career,
      null,
      "一致性修复",
      NOW,
    )).rejects.toMatchObject({ code: "SETTLEMENT_ALREADY_RUNNING" });
    await expect(repo.boardSnapshots.findLatestByBoard(RankingBoard.Career)).resolves.toEqual([]);
  });

  it("A-S5-03 week 重建的 ranking 周期锁在 withTransaction 之前已持有，结束后释放", async () => {
    const repo = new InMemoryRepository();
    await seedAdmin(repo);
    const rankingLockKey = rankingPeriodLockKey(PeriodType.Week, "2026-W32");
    let lockHeldAtTransactionStart = false;
    const repoProxy = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "withTransaction") {
          return (fn: (tx: UnitOfWork) => Promise<unknown>) =>
            target.withTransaction(async (tx) => {
              lockHeldAtTransactionStart = await target.jobLocks.isHeld(rankingLockKey, NOW);
              return fn(tx);
            });
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    await new AdminRebuildRankingsService(repoProxy).rebuild(
      "admin-openid",
      RankingBoard.Week,
      "2026-W32",
      "一致性修复",
      NOW,
    );

    expect(lockHeldAtTransactionStart).toBe(true);
    await expect(repo.jobLocks.isHeld(rankingLockKey, NOW)).resolves.toBe(false);
    await expect(repo.adminAuditLogs.findByEntity("ranking_period", "week-2026-W32"))
      .resolves.toHaveLength(1);
  });

  it("A-S5-03 事务中止后 tx.jobLocks.release 的 25P02 不掩盖原始错误且不写审计", async () => {
    const repo = new InMemoryRepository();
    await seedAdmin(repo);
    const originalBoom = new Error("rank original boom");
    const aborted = Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
    const repoProxy = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "withTransaction") {
          return (fn: (tx: UnitOfWork) => Promise<unknown>) =>
            target.withTransaction((tx) => {
              const failingTx = new Proxy(tx, {
                get(txTarget, txProp, txReceiver) {
                  if (txProp === "users") {
                    const users = Reflect.get(txTarget, txProp, txReceiver) as UnitOfWork["users"];
                    return {
                      ...users,
                      findAll: async () => {
                        throw originalBoom;
                      },
                    };
                  }
                  if (txProp === "jobLocks") {
                    const locks = Reflect.get(txTarget, txProp, txReceiver) as NonNullable<UnitOfWork["jobLocks"]>;
                    return {
                      ...locks,
                      release: async () => {
                        throw aborted;
                      },
                    };
                  }
                  return Reflect.get(txTarget, txProp, txReceiver);
                },
              });
              return fn(failingTx);
            });
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    await expect(
      new AdminRebuildRankingsService(repoProxy).rebuild(
        "admin-openid",
        RankingBoard.Week,
        "2026-W32",
        "一致性修复",
        NOW,
      ),
    ).rejects.toBe(originalBoom);
    await expect(repo.adminAuditLogs.findByEntity("ranking_period", "week-2026-W32"))
      .resolves.toEqual([]);
  });

  it("A-S5-03 ranking 锁在事务外释放失败时不掩盖原始错误", async () => {
    const repo = new InMemoryRepository();
    await seedAdmin(repo);
    const originalBoom = new Error("rank original boom");
    const repoProxy = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "jobLocks") {
          const locks = target.jobLocks;
          return {
            ...locks,
            release: async (lockKey: string, ownerId: string) => {
              if (lockKey.startsWith("ranking:")) throw new Error("release boom");
              return locks.release(lockKey, ownerId);
            },
          };
        }
        if (prop === "withTransaction") {
          return (fn: (tx: UnitOfWork) => Promise<unknown>) =>
            target.withTransaction((tx) => {
              const failingTx = new Proxy(tx, {
                get(txTarget, txProp, txReceiver) {
                  if (txProp === "users") {
                    const users = Reflect.get(txTarget, txProp, txReceiver) as UnitOfWork["users"];
                    return {
                      ...users,
                      findAll: async () => {
                        throw originalBoom;
                      },
                    };
                  }
                  return Reflect.get(txTarget, txProp, txReceiver);
                },
              });
              return fn(failingTx);
            });
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    await expect(
      new AdminRebuildRankingsService(repoProxy).rebuild(
        "admin-openid",
        RankingBoard.Week,
        "2026-W32",
        "一致性修复",
        NOW,
      ),
    ).rejects.toBe(originalBoom);
  });

  it("[Slice 3] 落后墙钟的 serverNow 时外层与 ranking 周期锁租约仍晚于 Date.now()", async () => {
    const repo = new InMemoryRepository();
    await seedAdmin(repo);
    const jobLocks = repo.jobLocks;
    const acquireSpy = vi.spyOn(jobLocks, "acquire");
    const repoProxy = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "jobLocks") return jobLocks;
        return Reflect.get(target, prop, receiver);
      },
    });
    const staleNow = new Date(Date.now() - 15 * 60 * 1000);
    const wallClockBefore = Date.now();

    await new AdminRebuildRankingsService(repoProxy).rebuild(
      "admin-openid",
      RankingBoard.Week,
      "2026-W32",
      "一致性修复",
      staleNow,
    );

    for (const key of [
      periodRankingsRebuildLockKey(PeriodType.Week, "2026-W32"),
      rankingPeriodLockKey(PeriodType.Week, "2026-W32"),
    ]) {
      const leaseUntil = acquireSpy.mock.calls.find(([lockKey]) => lockKey === key)?.[2] as Date;
      expect(leaseUntil.getTime()).toBeGreaterThan(wallClockBefore);
      expect(leaseUntil.getTime()).toBeGreaterThan(Date.now());
    }
  });
});
