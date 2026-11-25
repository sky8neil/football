import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import {
  AdminAuditAction,
  AdminAuditEntityType,
  AdminRole,
  AdminStatus,
  GroupMemberStatus,
  GroupStatus,
  MatchScoreValue,
  MatchStatus,
  PeriodType,
  Result,
  ResultSource,
  SCHEMA_VERSION,
  ScoringRuleVersion,
  SettlementStatus,
  UserStatus,
} from "../domain/enums.js";
import { calculatePeriodKey, levelSeasonOf, periodEndAt } from "../domain/time.js";
import {
  defaultLevelState,
  type Admin,
  type AdminAuditLog,
  type Group,
  type GroupMember,
  type Match,
  type MatchResult,
  type Prediction,
  type User,
} from "../domain/types.js";
import { AdminAuditLogsService } from "../application/admin-audit-logs.js";
import { FirstSettlementService } from "../application/first-settlement-service.js";
import { PeriodFinalizeService } from "../application/period-finalize-service.js";
import { ProfileMutationService } from "../application/profile-mutation.js";
import { RebuildPeriodRankingsService } from "../application/ranking-rebuild-service.js";
import {
  createAtomicSettlementItemWorker,
  SettlementItemApplicationService,
} from "../application/settlement-item-application-service.js";
import { WeeklyLevelEvalService } from "../application/weekly-level-eval.js";
import {
  createPostgresAppRepository,
  createPostgresDocumentDbFromPool,
} from "../gateway/repository-factory.js";
import {
  createPostgresAdminConsumedJtiStore,
  createPostgresAuthSessionStore,
} from "./postgres-auth-sessions.js";
import { createPostgresQueryFn } from "./postgres-document-db.js";
import {
  ADMIN_LOGIN_CONSUMED_JTIS_TABLE,
  AUTH_SESSIONS_TABLE,
  applyPostgresSchema,
  buildPostgresSchemaPlan,
  qualifiedTable,
  quoteIdent,
} from "./postgres-schema.js";
import type { CloudBaseAppRepository } from "./cloudbase-app-repository.js";

const DATABASE_URL = process.env.FOOTBALL_TEST_DATABASE_URL ?? "";
const ENABLED = DATABASE_URL.length > 0;
const SCHEMA = "football_slice10_pg_acceptance";
const NAMESPACE = "s10";
const CURSOR_SECRET = "slice10-pg-cursor-secret";
const NOW = new Date("2026-08-08T12:00:00.000Z");
const ANCHOR_A = new Date("2026-08-08T14:00:00.000Z");
const ANCHOR_B = new Date("2026-08-08T18:00:00.000Z");
const FINISH_AT = new Date("2026-08-09T11:00:00.000Z");
const WEEK_KEY = calculatePeriodKey(PeriodType.Week, ANCHOR_A); // 2026-W32
const FINALIZE_AT = new Date(periodEndAt(PeriodType.Week, WEEK_KEY).getTime() + 60_000);
const LEVEL_EVAL_RUN_AT = new Date("2026-08-10T02:10:00.000Z");
const LEVEL_FIRST_EVAL_AS_OF = new Date("2026-06-29T02:00:00.000Z");

const USER_A = "00000000-0000-4000-8000-000000001001";
const USER_B = "00000000-0000-4000-8000-000000001002";
const MATCH_1 = "00000000-0000-4000-8000-000000002001";
const MATCH_2 = "00000000-0000-4000-8000-000000002002";
const HOME_TEAM = "00000000-0000-4000-8000-000000003001";
const AWAY_TEAM = "00000000-0000-4000-8000-000000003002";

function makeUser(userId: string, openid: string, nickname: string): User {
  return {
    schema_version: SCHEMA_VERSION,
    user_id: userId,
    openid,
    unionid: null,
    nickname,
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
}

function makeMatch(matchId: string, anchor: Date, home: number, away: number): Match {
  return {
    schema_version: SCHEMA_VERSION,
    match_id: matchId,
    canonical_match_id: matchId,
    superseded_by: null,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: HOME_TEAM,
    away_team_id: AWAY_TEAM,
    kickoff_at: new Date(anchor.getTime() - 2 * 60 * 60_000),
    kickoff_confirmed: true,
    prediction_deadline_at: new Date(anchor.getTime() - 2 * 60 * 60_000 - 5 * 60_000),
    prediction_closed_at: new Date(anchor.getTime() - 2 * 60 * 60_000),
    period_anchor_at: anchor,
    match_status: MatchStatus.Finished,
    settlement_status: SettlementStatus.Waiting,
    regular_home_score: home,
    regular_away_score: away,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 1,
    settled_result_version: 0,
    result_source: ResultSource.Provider,
    scoring_rule_version: ScoringRuleVersion.ScoringV1,
    finish_detected_at: FINISH_AT,
    settled_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeResult(matchId: string, home: number, away: number): MatchResult {
  return {
    schema_version: SCHEMA_VERSION,
    match_id: matchId,
    result_version: 1,
    regular_home_score: home,
    regular_away_score: away,
    source: ResultSource.Provider,
    provider_status: "FT",
    admin_id: null,
    reason: null,
    created_at: FINISH_AT,
  };
}

function makePrediction(
  predictionId: string,
  userId: string,
  matchId: string,
  idempotencyKey: string,
  home: number,
  away: number,
): Prediction {
  return {
    schema_version: SCHEMA_VERSION,
    prediction_id: predictionId,
    user_id: userId,
    match_id: matchId,
    canonical_match_id: matchId,
    idempotency_key: idempotencyKey,
    pred_home_score: home,
    pred_away_score: away,
    derived_result: home > away ? Result.Home : home < away ? Result.Away : Result.Draw,
    submitted_at: NOW,
    scoring_rule_version: ScoringRuleVersion.ScoringV1,
    match_score: null,
    wdl_hit: null,
    exact_hit: null,
    applied_result_version: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

function settlementService(repo: CloudBaseAppRepository): FirstSettlementService {
  return new FirstSettlementService(
    repo,
    createAtomicSettlementItemWorker(new SettlementItemApplicationService(repo)),
  );
}

describe.skipIf(!ENABLED)("Slice 10 PostgreSQL 真库并发、注销闭环、JTI 防重放与审计分页验收", () => {
  let poolA!: pg.Pool;
  let poolB!: pg.Pool;
  let poolC!: pg.Pool;
  let repoA!: CloudBaseAppRepository;
  let repoB!: CloudBaseAppRepository;
  let repoC!: CloudBaseAppRepository;
  const plan = buildPostgresSchemaPlan(NAMESPACE, SCHEMA);

  async function clearAllData(): Promise<void> {
    const tables = [
      ...plan.tables.map((t) => qualifiedTable(SCHEMA, t.table)),
      qualifiedTable(SCHEMA, AUTH_SESSIONS_TABLE),
      qualifiedTable(SCHEMA, ADMIN_LOGIN_CONSUMED_JTIS_TABLE),
    ];
    await poolA.query(`TRUNCATE TABLE ${tables.join(", ")}`);
  }

  beforeAll(async () => {
    const database = new URL(DATABASE_URL).pathname.replace(/^\//, "");
    if (database !== "football_test") {
      throw new Error(`refusing database ${database}`);
    }
    const opts = { connectionString: DATABASE_URL, max: 4, connectionTimeoutMillis: 2_000 };
    poolA = new pg.Pool(opts);
    poolB = new pg.Pool(opts);
    poolC = new pg.Pool(opts);
    const current = await poolA.query("SELECT current_database() AS name");
    if (current.rows[0]?.name !== "football_test") {
      throw new Error(`connected to ${String(current.rows[0]?.name)}`);
    }
    await poolA.query(`DROP SCHEMA IF EXISTS ${quoteIdent(SCHEMA)} CASCADE`);
    await applyPostgresSchema(createPostgresQueryFn(poolA), plan);

    const pgConfig = {
      database_url: DATABASE_URL,
      database_schema: SCHEMA,
      resource_namespace: NAMESPACE,
    };
    repoA = createPostgresAppRepository(poolA, pgConfig, createPostgresDocumentDbFromPool(poolA, pgConfig)) as CloudBaseAppRepository;
    repoB = createPostgresAppRepository(poolB, pgConfig, createPostgresDocumentDbFromPool(poolB, pgConfig)) as CloudBaseAppRepository;
    repoC = createPostgresAppRepository(poolC, pgConfig, createPostgresDocumentDbFromPool(poolC, pgConfig)) as CloudBaseAppRepository;
  });

  beforeEach(async () => {
    await clearAllData();
  });

  afterAll(async () => {
    await poolA?.query(`DROP SCHEMA IF EXISTS ${quoteIdent(SCHEMA)} CASCADE`).catch(() => undefined);
    await Promise.all([
      poolA?.end().catch(() => undefined),
      poolB?.end().catch(() => undefined),
      poolC?.end().catch(() => undefined),
    ]);
  });

  it("READ COMMITTED 下封板、单场结算、等级评估与榜单重建交叉竞争不死锁、不丢分且终态排名一致", async () => {
    await repoA.users.insert(makeUser(USER_A, "openid-a", "Alice"));
    await repoA.users.insert(makeUser(USER_B, "openid-b", "Bob"));
    await repoA.matches.insert(makeMatch(MATCH_1, ANCHOR_A, 2, 1));
    await repoA.matches.insert(makeMatch(MATCH_2, ANCHOR_B, 1, 0));
    await repoA.matchResults.insert(makeResult(MATCH_1, 2, 1));
    await repoA.matchResults.insert(makeResult(MATCH_2, 1, 0));

    // USER_A: MATCH_1 exact (12) + MATCH_2 exact (12) = 24
    // USER_B: MATCH_1 wdl (3) + MATCH_2 miss (0) = 3
    await repoA.predictions.insert(
      makePrediction("00000000-0000-4000-8000-000000004001", USER_A, MATCH_1, "00000000-0000-4000-8000-000000005001", 2, 1),
    );
    await repoA.predictions.insert(
      makePrediction("00000000-0000-4000-8000-000000004002", USER_B, MATCH_1, "00000000-0000-4000-8000-000000005002", 3, 1),
    );
    await repoA.predictions.insert(
      makePrediction("00000000-0000-4000-8000-000000004003", USER_A, MATCH_2, "00000000-0000-4000-8000-000000005003", 1, 0),
    );
    await repoA.predictions.insert(
      makePrediction("00000000-0000-4000-8000-000000004004", USER_B, MATCH_2, "00000000-0000-4000-8000-000000005004", 0, 1),
    );

    // 先结算 MATCH_1（使用晚于 FINISH_AT 的合法结算时间）确保周榜已存在条目，再让 MATCH_2 结算、封板、等级评估三方在真实多连接 READ COMMITTED 下交叉竞争
    const settleMatch1At = new Date(FINISH_AT.getTime() + 10 * 60_000);
    const m1Outcome = await settlementService(repoA).start(MATCH_1, settleMatch1At, false);
    expect(m1Outcome).toMatchObject({ kind: "started", processed_count: 2 });

    const raceA = await Promise.allSettled([
      settlementService(repoA).start(MATCH_2, LEVEL_EVAL_RUN_AT, false),
      new PeriodFinalizeService(repoB).finalize(PeriodType.Week, WEEK_KEY, FINALIZE_AT),
      new WeeklyLevelEvalService(repoC, LEVEL_FIRST_EVAL_AS_OF).run(LEVEL_EVAL_RUN_AT),
    ]);
    for (const outcome of raceA) {
      if (outcome.status === "rejected") {
        expect(outcome.reason).toMatchObject({ code: "RANKING_REBUILD_ALREADY_RUNNING" });
      }
    }

    // 确认封板与榜单重建并发竞争无死锁（同周期锁互斥返回 skipped 或 SETTLEMENT_ALREADY_RUNNING）
    const raceB = await Promise.allSettled([
      new PeriodFinalizeService(repoA).finalize(PeriodType.Week, WEEK_KEY, FINALIZE_AT),
      new RebuildPeriodRankingsService(repoB).rebuildPeriodRankings(PeriodType.Week, WEEK_KEY, LEVEL_EVAL_RUN_AT),
    ]);
    for (const outcome of raceB) {
      if (outcome.status === "rejected") {
        expect(outcome.reason).toMatchObject({ code: "SETTLEMENT_ALREADY_RUNNING" });
      }
    }

    // 若 MATCH_2 在 RebuildRanks 阶段因周期锁被 PeriodFinalize 占用而退避退出，锁释放后可幂等收尾
    const match2After = await repoA.matches.findById(MATCH_2);
    if (match2After?.settlement_status !== SettlementStatus.Settled) {
      await settlementService(repoA).start(MATCH_2, LEVEL_EVAL_RUN_AT, false);
    }

    // 重建并封板收尾，验证多轮竞态后积分不丢且 global_rank 准确
    await new RebuildPeriodRankingsService(repoA).rebuildPeriodRankings(PeriodType.Week, WEEK_KEY, LEVEL_EVAL_RUN_AT);
    const finalized = await new PeriodFinalizeService(repoB).finalize(PeriodType.Week, WEEK_KEY, FINALIZE_AT);
    expect(finalized.due).toBe(true);
    expect(finalized.skipped).toBe(false);
    expect(finalized.finalized_count + finalized.skipped_count).toBe(2);

    const storedA = await repoA.users.findById(USER_A);
    const storedB = await repoA.users.findById(USER_B);
    const seasonId = levelSeasonOf(ANCHOR_A);
    const seasonA = await repoA.userSeasonStats.findByUserAndSeason(USER_A, seasonId);
    const seasonB = await repoA.userSeasonStats.findByUserAndSeason(USER_B, seasonId);
    const rankA = await repoA.rankings.findByPeriodAndUser(PeriodType.Week, WEEK_KEY, USER_A);
    const rankB = await repoA.rankings.findByPeriodAndUser(PeriodType.Week, WEEK_KEY, USER_B);

    expect(storedA?.career_points).toBe(MatchScoreValue.ExactHit * 2);
    expect(storedB?.career_points).toBe(MatchScoreValue.WdlHit);
    expect(seasonA?.points).toBe(MatchScoreValue.ExactHit * 2);
    expect(seasonB?.points).toBe(MatchScoreValue.WdlHit);
    expect(rankA).toMatchObject({ period_score: 24, is_final: true, global_rank: 1 });
    expect(rankB).toMatchObject({ period_score: 3, is_final: true, global_rank: 2 });
  }, 30_000);

  it("PostgreSQL 真库下账号注销全链路闭环：吊销会话、退全群减计数、禁用同名管理员并重算封榜排名", async () => {
    const sessions = createPostgresAuthSessionStore(createPostgresQueryFn(poolA), SCHEMA);
    const aliceOpenid = "wx-openid-s10-alice";
    const bobOpenid = "wx-openid-s10-bob";
    await repoA.users.insert(makeUser(USER_A, aliceOpenid, "Alice"));
    await repoA.users.insert(makeUser(USER_B, bobOpenid, "Bob"));

    const aliceAdmin: Admin = {
      schema_version: SCHEMA_VERSION,
      admin_id: "00000000-0000-4000-8000-000000006001",
      openid: aliceOpenid,
      role: AdminRole.Admin,
      status: AdminStatus.Active,
      created_at: NOW,
      updated_at: NOW,
    };
    const bobAdmin: Admin = {
      schema_version: SCHEMA_VERSION,
      admin_id: "00000000-0000-4000-8000-000000006002",
      openid: bobOpenid,
      role: AdminRole.Admin,
      status: AdminStatus.Active,
      created_at: NOW,
      updated_at: NOW,
    };
    await repoA.admins.insert(aliceAdmin);
    await repoA.admins.insert(bobAdmin);

    const sessionTtlSeconds = 48 * 60 * 60;
    const aliceSessA = await sessions.create({ openid: aliceOpenid, now: NOW, ttlSeconds: sessionTtlSeconds });
    const aliceSessB = await sessions.create({ openid: aliceOpenid, now: NOW, ttlSeconds: sessionTtlSeconds });
    const bobSess = await sessions.create({ openid: bobOpenid, now: NOW, ttlSeconds: sessionTtlSeconds });

    const group1: Group = {
      schema_version: SCHEMA_VERSION,
      group_id: "00000000-0000-4000-8000-000000007001",
      owner_user_id: USER_B,
      invite_code: "SLICE10A",
      status: GroupStatus.Active,
      member_count: 2,
      created_at: NOW,
      updated_at: NOW,
    };
    const group2: Group = {
      schema_version: SCHEMA_VERSION,
      group_id: "00000000-0000-4000-8000-000000007002",
      owner_user_id: USER_A,
      invite_code: "SLICE10B",
      status: GroupStatus.Active,
      member_count: 2,
      created_at: NOW,
      updated_at: NOW,
    };
    const member = (groupId: string, userId: string): GroupMember => ({
      schema_version: SCHEMA_VERSION,
      group_id: groupId,
      user_id: userId,
      status: GroupMemberStatus.Active,
      joined_at: NOW,
      left_at: null,
      created_at: NOW,
      updated_at: NOW,
    });
    await repoA.groups.insert(group1);
    await repoA.groups.insert(group2);
    await repoA.groupMembers.insert(member(group1.group_id, USER_B));
    await repoA.groupMembers.insert(member(group1.group_id, USER_A));
    await repoA.groupMembers.insert(member(group2.group_id, USER_A));
    await repoA.groupMembers.insert(member(group2.group_id, USER_B));

    // 两人在 2026-W32 已有排名：Alice 12 分领先 Bob 3 分
    await repoA.rankings.insert({
      schema_version: SCHEMA_VERSION,
      period_type: PeriodType.Week,
      period_key: WEEK_KEY,
      user_id: USER_A,
      period_score: 12,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
      last_scoring_match_at: ANCHOR_A,
      global_rank: null,
      is_final: false,
      created_at: NOW,
      updated_at: NOW,
    });
    await repoA.rankings.insert({
      schema_version: SCHEMA_VERSION,
      period_type: PeriodType.Week,
      period_key: WEEK_KEY,
      user_id: USER_B,
      period_score: 3,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 0,
      last_scoring_match_at: ANCHOR_A,
      global_rank: null,
      is_final: false,
      created_at: NOW,
      updated_at: NOW,
    });

    const deleteAt = new Date(periodEndAt(PeriodType.Week, WEEK_KEY).getTime() - 10_000);
    await new ProfileMutationService(repoA).deleteMyProfile(USER_A, deleteAt);

    expect(await sessions.findActiveByToken({ token: aliceSessA.token, now: deleteAt })).toBeNull();
    expect(await sessions.findActiveByToken({ token: aliceSessB.token, now: deleteAt })).toBeNull();
    expect(await sessions.findActiveByToken({ token: bobSess.token, now: deleteAt })).not.toBeNull();

    expect(await repoA.admins.findByOpenid(aliceOpenid)).toMatchObject({
      admin_id: aliceAdmin.admin_id,
      status: AdminStatus.Disabled,
    });
    expect(await repoA.admins.findByOpenid(bobOpenid)).toMatchObject({
      admin_id: bobAdmin.admin_id,
      status: AdminStatus.Active,
    });

    expect(await repoA.groups.findById(group1.group_id)).toMatchObject({
      status: GroupStatus.Active,
      member_count: 1,
    });
    expect(await repoA.groups.findById(group2.group_id)).toMatchObject({
      status: GroupStatus.Active,
      member_count: 1,
    });
    expect(await repoA.groupMembers.findByGroupAndUser(group1.group_id, USER_A)).toMatchObject({
      status: GroupMemberStatus.Left,
    });
    expect(await repoA.groupMembers.findByGroupAndUser(group2.group_id, USER_A)).toMatchObject({
      status: GroupMemberStatus.Left,
    });

    // 封榜后已注销的 Alice global_rank 为 null，Bob 顺位升为第 1 名
    await new PeriodFinalizeService(repoA).finalize(PeriodType.Week, WEEK_KEY, FINALIZE_AT);
    expect(await repoA.rankings.findByPeriodAndUser(PeriodType.Week, WEEK_KEY, USER_A)).toMatchObject({
      is_final: true,
      global_rank: null,
      period_score: 12,
    });
    expect(await repoA.rankings.findByPeriodAndUser(PeriodType.Week, WEEK_KEY, USER_B)).toMatchObject({
      is_final: true,
      global_rank: 1,
      period_score: 3,
    });
  }, 30_000);

  it("admin_login_consumed_jtis 并发原子防重放且 findAuditLogPage PG 下推游标分页稳定无遗漏", async () => {
    const jtiStoreA = createPostgresAdminConsumedJtiStore(createPostgresQueryFn(poolA), SCHEMA);
    const jtiStoreB = createPostgresAdminConsumedJtiStore(createPostgresQueryFn(poolB), SCHEMA);
    const jti = "00000000-0000-4000-8000-000000008001";
    const expiresAt = new Date(NOW.getTime() + 300_000);

    const results = await Promise.all([
      jtiStoreA.consume({ jti, expiresAt, now: NOW }),
      jtiStoreB.consume({ jti, expiresAt, now: NOW }),
      jtiStoreA.consume({ jti, expiresAt, now: NOW }),
      jtiStoreB.consume({ jti, expiresAt, now: NOW }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((v) => !v)).toHaveLength(3);

    // 过期后允许重新清理并在新周期清理后不误删未过期记录
    const futureJti = "00000000-0000-4000-8000-000000008002";
    const futureExpires = new Date(NOW.getTime() + 900_000);
    expect(await jtiStoreA.consume({ jti: futureJti, expiresAt: futureExpires, now: NOW })).toBe(true);
    expect(await jtiStoreA.deleteExpiredBefore!(new Date(expiresAt.getTime() + 1_000))).toBe(1);

    // 审计日志 PG 下推分页（同时间戳倒序 tie-break + 组合过滤 + 翻页完整遍历）
    const adminOpenid = "wx-admin-audit-pg";
    const adminId = "00000000-0000-4000-8000-000000009001";
    await repoA.admins.insert({
      schema_version: SCHEMA_VERSION,
      admin_id: adminId,
      openid: adminOpenid,
      role: AdminRole.Admin,
      status: AdminStatus.Active,
      created_at: NOW,
      updated_at: NOW,
    });
    const logs: AdminAuditLog[] = [
      {
        schema_version: SCHEMA_VERSION,
        audit_id: "00000000-0000-4000-8000-00000000a001",
        admin_id: adminId,
        action: AdminAuditAction.ResolveAnomaly,
        entity_type: AdminAuditEntityType.Anomaly,
        entity_id: "00000000-0000-4000-8000-00000000b001",
        old_value: { status: "open" },
        new_value: { status: "resolved" },
        reason: "r1",
        created_at: NOW,
      },
      {
        schema_version: SCHEMA_VERSION,
        audit_id: "00000000-0000-4000-8000-00000000a003",
        admin_id: adminId,
        action: AdminAuditAction.ResolveAnomaly,
        entity_type: AdminAuditEntityType.Anomaly,
        entity_id: "00000000-0000-4000-8000-00000000b002",
        old_value: { status: "open" },
        new_value: { status: "resolved" },
        reason: "r3",
        created_at: NOW,
      },
      {
        schema_version: SCHEMA_VERSION,
        audit_id: "00000000-0000-4000-8000-00000000a002",
        admin_id: adminId,
        action: AdminAuditAction.ResolveAnomaly,
        entity_type: AdminAuditEntityType.Anomaly,
        entity_id: "00000000-0000-4000-8000-00000000b003",
        old_value: { status: "open" },
        new_value: { status: "resolved" },
        reason: "r2",
        created_at: new Date(NOW.getTime() + 5_000),
      },
      {
        schema_version: SCHEMA_VERSION,
        audit_id: "00000000-0000-4000-8000-00000000a004",
        admin_id: adminId,
        action: AdminAuditAction.ResultCorrection,
        entity_type: AdminAuditEntityType.Match,
        entity_id: MATCH_1,
        old_value: { result_version: 0 },
        new_value: { result_version: 1 },
        reason: "r4",
        created_at: new Date(NOW.getTime() + 10_000),
      },
    ];
    for (const log of logs) {
      await repoA.adminAuditLogs.insert(log);
    }

    const service = new AdminAuditLogsService(repoA, CURSOR_SECRET);
    const page1 = await service.list(adminOpenid, {
      action: AdminAuditAction.ResolveAnomaly,
      target_type: AdminAuditEntityType.Anomaly,
      target_id: null,
      limit: 2,
      cursor: null,
    });
    expect(page1.items.map((item) => item.audit_id)).toEqual([
      "00000000-0000-4000-8000-00000000a002",
      "00000000-0000-4000-8000-00000000a003",
    ]);
    expect(page1.has_more).toBe(true);

    const page2 = await service.list(adminOpenid, {
      action: AdminAuditAction.ResolveAnomaly,
      target_type: AdminAuditEntityType.Anomaly,
      target_id: null,
      limit: 2,
      cursor: page1.next_cursor,
    });
    expect(page2.items.map((item) => item.audit_id)).toEqual([
      "00000000-0000-4000-8000-00000000a001",
    ]);
    expect(page2.has_more).toBe(false);
    expect(page2.next_cursor).toBeNull();
  }, 30_000);
});
