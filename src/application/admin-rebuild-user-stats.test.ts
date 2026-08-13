import { describe, expect, it } from "vitest";
import { AdminRole, AdminStatus, MatchStatus, Result, SettlementStatus } from "../domain/enums.js";
import type { Admin, Match, Prediction, User, UserSeasonStats } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import {
  ADMIN_REBUILD_USER_STATS_AUDIT_REASON,
  AdminRebuildUserStatsService,
} from "./admin-rebuild-user-stats.js";
import { userStatsRebuildLockKey } from "./stats-rebuild-service.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const USER_ID = "00000000-0000-4000-8000-000000000010";
const ADMIN_ID = "00000000-0000-4000-8000-000000000001";

function makeUser(): User {
  return {
    schema_version: 1,
    user_id: USER_ID,
    openid: "user-openid",
    unionid: null,
    nickname: "user",
    favorite_team_id: null,
    status: "active",
    career_points: 99,
    career_valid_predictions: 9,
    career_wdl_hits: 9,
    career_exact_hits: 9,
    career_level: 2,
    career_best_level: 2,
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

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

function makeActiveSettlementMatch(): Match {
  return {
    schema_version: 1,
    match_id: "00000000-0000-4000-8000-000000000011",
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: "00000000-0000-4000-8000-000000000012",
    away_team_id: "00000000-0000-4000-8000-000000000013",
    kickoff_at: NOW,
    kickoff_confirmed: true,
    prediction_deadline_at: NOW,
    prediction_closed_at: NOW,
    period_anchor_at: NOW,
    match_status: MatchStatus.Finished,
    settlement_status: SettlementStatus.Settling,
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
    finish_detected_at: NOW,
    settled_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makePrediction(matchId: string): Prediction {
  return {
    schema_version: 1,
    prediction_id: "00000000-0000-4000-8000-000000000014",
    user_id: USER_ID,
    match_id: matchId,
    idempotency_key: "00000000-0000-4000-8000-000000000015",
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

async function seedAdminAndUser(repo: InMemoryRepository, admin: Admin = makeAdmin()): Promise<void> {
  await repo.users.insert(makeUser());
  await repo.admins.insert(admin);
}

function makeSeasonStats(): UserSeasonStats {
  return {
    schema_version: 1,
    user_id: USER_ID,
    season_id: "2026_2027",
    points: 88,
    valid_predictions: 8,
    wdl_hits: 7,
    exact_hits: 6,
    level: 3,
    best_level: 4,
    created_at: NOW,
    updated_at: NOW,
  };
}

describe("AdminRebuildUserStatsService", () => {
  it("使用冻结的固定系统审计 reason", () => {
    expect(ADMIN_REBUILD_USER_STATS_AUDIT_REASON).toBe("管理员用户统计重建");
  });

  it("无效 server_now 在获取 maintenance lock 前 Fail Closed", async () => {
    const repo = new InMemoryRepository();
    await seedAdminAndUser(repo);
    const invalidNow = new Date("invalid");

    await expect(
      new AdminRebuildUserStatsService(repo).rebuild(
        "admin-openid",
        USER_ID,
        invalidNow,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "server_now" },
    });

    expect(await repo.users.findById(USER_ID)).toMatchObject({
      career_points: 99,
      career_valid_predictions: 9,
    });
    expect(await repo.adminAuditLogs.findByEntity("user", USER_ID)).toEqual([]);
    expect(
      await repo.jobLocks.acquire(
        userStatsRebuildLockKey(USER_ID),
        "probe-owner",
        new Date(NOW.getTime() + 60_000),
      ),
    ).toBe(true);
    await repo.jobLocks.release(userStatsRebuildLockKey(USER_ID), "probe-owner");
  });

  it("active admin 通过 trusted openid 重建用户并追加审计", async () => {
    const repo = new InMemoryRepository();
    await seedAdminAndUser(repo);
    await repo.userSeasonStats.insert(makeSeasonStats());
    await repo.unlocks.insert({
      schema_version: 1,
      unlock_id: "00000000-0000-4000-8000-000000000016",
      user_id: USER_ID,
      unlock_code: "profile_card_style_1",
      threshold_points: 30,
      source_version: "unlock_v1",
      unlocked_at: NOW,
    });

    const outcome = await new AdminRebuildUserStatsService(repo).rebuild(
      "admin-openid",
      USER_ID,
      NOW,
    );

    expect(outcome.admin_id).toBe(ADMIN_ID);
    expect(outcome.user).toMatchObject({
      user_id: USER_ID,
      career_points: 0,
      career_valid_predictions: 0,
      career_wdl_hits: 0,
      career_exact_hits: 0,
    });
    expect(outcome.audit_log).toMatchObject({
      admin_id: ADMIN_ID,
      action: "rebuild_user_stats",
      entity_type: "user",
      entity_id: USER_ID,
      reason: ADMIN_REBUILD_USER_STATS_AUDIT_REASON,
      old_value: {
        career_points: 99,
        career_valid_predictions: 9,
        career_wdl_hits: 9,
        career_exact_hits: 9,
        career_level: 2,
        career_best_level: 2,
        season_stats_changed_count: 0,
      },
      new_value: {
        career_points: 0,
        career_valid_predictions: 0,
        career_wdl_hits: 0,
        career_exact_hits: 0,
        career_level: 1,
        career_best_level: 2,
        season_stats_changed_count: 1,
      },
    });
    await expect(repo.adminAuditLogs.findByEntity("user", USER_ID)).resolves.toHaveLength(1);
    await expect(repo.unlocks.findByUser(USER_ID)).resolves.toHaveLength(1);
  });

  it("只接受 active admin，拒绝未知或 disabled trusted openid", async () => {
    const repo = new InMemoryRepository();
    await seedAdminAndUser(repo, makeAdmin({ status: AdminStatus.Disabled }));

    await expect(
      new AdminRebuildUserStatsService(repo).rebuild("admin-openid", USER_ID, NOW),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      new AdminRebuildUserStatsService(repo).rebuild("unknown-openid", USER_ID, NOW),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await repo.adminAuditLogs.findByEntity("user", USER_ID)).toEqual([]);
    await expect(repo.users.findById(USER_ID)).resolves.toMatchObject({ career_points: 99 });
  });

  it("目标用户存在 settling/correcting match 时拒绝重建且不写审计", async () => {
    const repo = new InMemoryRepository();
    await seedAdminAndUser(repo);
    const match = makeActiveSettlementMatch();
    await repo.matches.insert(match);
    await repo.predictions.insert(makePrediction(match.match_id));

    await expect(
      new AdminRebuildUserStatsService(repo).rebuild("admin-openid", USER_ID, NOW),
    ).rejects.toMatchObject({ code: "SETTLEMENT_ALREADY_RUNNING" });
    expect(await repo.adminAuditLogs.findByEntity("user", USER_ID)).toEqual([]);
    await expect(repo.users.findById(USER_ID)).resolves.toMatchObject({ career_points: 99 });
  });

  it("使用与普通 rebuild 相同的 user maintenance lock", async () => {
    const repo = new InMemoryRepository();
    await seedAdminAndUser(repo);
    const lockKey = userStatsRebuildLockKey(USER_ID);
    await repo.jobLocks.acquire(
      lockKey,
      "existing-owner",
      new Date(Date.now() + 60 * 60 * 1000),
    );

    await expect(
      new AdminRebuildUserStatsService(repo).rebuild("admin-openid", USER_ID, NOW),
    ).rejects.toMatchObject({ code: "SETTLEMENT_ALREADY_RUNNING" });
    await repo.jobLocks.release(lockKey, "existing-owner");
  });

  it("在 maintenance lock 已占用时仍先拒绝未知管理员", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser());
    const lockKey = userStatsRebuildLockKey(USER_ID);
    await repo.jobLocks.acquire(
      lockKey,
      "existing-owner",
      new Date(Date.now() + 60 * 60 * 1000),
    );

    await expect(
      new AdminRebuildUserStatsService(repo).rebuild("unknown-openid", USER_ID, NOW),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await repo.jobLocks.release(lockKey, "existing-owner");
  });
});
