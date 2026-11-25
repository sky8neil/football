import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import {
  GroupMemberStatus,
  GroupStatus,
  MatchScoreValue,
  MatchStatus,
  PeriodType,
  Result,
  ResultSource,
  ScoringRuleVersion,
  SettlementStatus,
} from "../domain/enums.js";
import { calculatePeriodKey, levelSeasonOf } from "../domain/time.js";
import {
  defaultLevelState,
  type Group,
  type GroupMember,
  type Match,
  type MatchResult,
  type Prediction,
  type User,
} from "../domain/types.js";
import { GroupsService } from "../application/groups.js";
import { FirstSettlementService } from "../application/first-settlement-service.js";
import {
  createAtomicSettlementItemWorker,
  SettlementItemApplicationService,
} from "../application/settlement-item-application-service.js";
import { cloudBaseCollectionName } from "./cloudbase-db.js";
import { CloudBaseAppRepository } from "./cloudbase-app-repository.js";
import {
  createPostgresDocumentDb,
  createPostgresQueryFn,
  type PostgresExclusiveClient,
} from "./postgres-document-db.js";
import {
  buildPostgresSchemaPlan,
  qualifiedTable,
  quoteIdent,
} from "./postgres-schema.js";

const DATABASE_URL = process.env.FOOTBALL_TEST_DATABASE_URL ?? "";
const ENABLED = DATABASE_URL.length > 0;
const SCHEMA = "football_slice2_conc";
const NAMESPACE = "s2";
const CONFIG = { schema: SCHEMA, namespace: NAMESPACE };
const CURSOR_SECRET = "slice2-concurrency-cursor";
const ADVISORY_CLASS = 812024;
const ADVISORY_OBJ = 2;
const NOW = new Date("2026-08-09T12:00:00.000Z");
const ANCHOR_A = new Date("2026-08-08T14:00:00.000Z");
const ANCHOR_B = new Date("2026-08-08T18:00:00.000Z");
const FINISH_AT = new Date("2026-08-09T11:00:00.000Z");
const RULE = ScoringRuleVersion.ScoringV1;
const USER_ID = "00000000-0000-4000-8000-000000000001";
const MATCH_A = "00000000-0000-4000-8000-000000000011";
const MATCH_B = "00000000-0000-4000-8000-000000000012";
const PREDICTION_A = "00000000-0000-4000-8000-000000000021";
const PREDICTION_B = "00000000-0000-4000-8000-000000000022";
const OWNER_ID = "00000000-0000-4000-8000-000000000041";
const JOINER_A = "00000000-0000-4000-8000-000000000042";
const JOINER_B = "00000000-0000-4000-8000-000000000043";
const JOINER_C = "00000000-0000-4000-8000-000000000045";
const GROUP_CAP = "00000000-0000-4000-8000-000000000044";
const GROUP_DISSOLVE = "00000000-0000-4000-8000-000000000046";
const HOME_TEAM = "00000000-0000-4000-8000-000000000061";
const AWAY_TEAM = "00000000-0000-4000-8000-000000000062";

const inUse = new Set<number>();
let peakConnections = 0;
let triggerExecute = "FUNCTION";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function physical(collection: string): string {
  return cloudBaseCollectionName(NAMESPACE, collection);
}

function makeUser(userId: string, nickname = "Sky"): User {
  return {
    schema_version: 1,
    user_id: userId,
    openid: `openid-${userId}`,
    unionid: null,
    nickname,
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

function makeMatch(
  matchId: string,
  anchor: Date,
  home: number,
  away: number,
): Match {
  return {
    schema_version: 1,
    match_id: matchId,
    canonical_match_id: matchId,
    superseded_by: null,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: HOME_TEAM,
    away_team_id: AWAY_TEAM,
    kickoff_at: anchor,
    kickoff_confirmed: true,
    prediction_deadline_at: new Date(anchor.getTime() - 600_000),
    prediction_closed_at: new Date(anchor.getTime() - 600_000),
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
    scoring_rule_version: RULE,
    finish_detected_at: FINISH_AT,
    settled_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeResult(matchId: string, home: number, away: number): MatchResult {
  return {
    schema_version: 1,
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
  matchId: string,
  idempotencyKey: string,
  home: number,
  away: number,
): Prediction {
  return {
    schema_version: 1,
    prediction_id: predictionId,
    user_id: USER_ID,
    match_id: matchId,
    canonical_match_id: matchId,
    idempotency_key: idempotencyKey,
    pred_home_score: home,
    pred_away_score: away,
    derived_result: Result.Home,
    submitted_at: NOW,
    scoring_rule_version: RULE,
    match_score: null,
    wdl_hit: null,
    exact_hit: null,
    applied_result_version: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeGroup(groupId: string, inviteCode: string, memberCount: number): Group {
  return {
    schema_version: 1,
    group_id: groupId,
    owner_user_id: OWNER_ID,
    invite_code: inviteCode,
    status: GroupStatus.Active,
    member_count: memberCount,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeMember(groupId: string, userId: string): GroupMember {
  return {
    schema_version: 1,
    group_id: groupId,
    user_id: userId,
    status: GroupMemberStatus.Active,
    joined_at: NOW,
    left_at: null,
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

function groupsService(repo: CloudBaseAppRepository): GroupsService {
  return new GroupsService(repo, { cursorSecret: CURSOR_SECRET });
}

describe.skipIf(!ENABLED)("Slice 2 PostgreSQL READ COMMITTED 两连接并发", () => {
  let poolA!: pg.Pool;
  let poolB!: pg.Pool;
  let repoA!: CloudBaseAppRepository;
  let repoB!: CloudBaseAppRepository;

  function track(pid: number): () => void {
    inUse.add(pid);
    peakConnections = Math.max(peakConnections, inUse.size);
    return () => {
      inUse.delete(pid);
    };
  }

  async function checkout(target: pg.Pool): Promise<PostgresExclusiveClient> {
    const client = await target.connect();
    try {
      await client.query("SET default_transaction_isolation TO 'read committed'");
      const iso = await client.query("SHOW transaction_isolation");
      if (iso.rows[0]?.transaction_isolation !== "read committed") {
        throw new Error(`expected READ COMMITTED, got ${String(iso.rows[0]?.transaction_isolation)}`);
      }
      const pid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
      const releasePid = track(pid);
      return {
        query: createPostgresQueryFn(client),
        release: (err?: Error) => {
          releasePid();
          client.release(err);
        },
      };
    } catch (error) {
      client.release(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  function makeRepo(target: pg.Pool): CloudBaseAppRepository {
    const db = createPostgresDocumentDb(createPostgresQueryFn(target), CONFIG, {
      connect: () => checkout(target),
    });
    return new CloudBaseAppRepository({ resource_namespace: NAMESPACE }, db);
  }

  async function activitySnapshot(): Promise<string> {
    const result = await poolB.query(
      `SELECT pid, wait_event_type, wait_event, left(query, 180) AS query
       FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    );
    return JSON.stringify(result.rows);
  }

  async function waitFor(label: string, predicate: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await delay(25);
    }
    throw new Error(`timed out waiting for ${label}: ${await activitySnapshot()}`);
  }

  async function waitingOnTable(collection: string): Promise<number> {
    const result = await poolB.query(
      `SELECT count(*)::int AS n
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock'
         AND strpos(query, $1) > 0`,
      [qualifiedTable(SCHEMA, physical(collection))],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async function advisoryWaiters(): Promise<number> {
    const result = await poolB.query(
      `SELECT count(*)::int AS n
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock'
         AND wait_event = 'advisory'`,
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async function withRowGate<T>(
    collection: string,
    id: string,
    waiters: number,
    run: () => Promise<T>,
  ): Promise<T> {
    const client = await poolA.connect();
    let open = true;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const iso = await client.query("SHOW transaction_isolation");
      if (iso.rows[0]?.transaction_isolation !== "read committed") {
        throw new Error(`expected READ COMMITTED, got ${String(iso.rows[0]?.transaction_isolation)}`);
      }
      await client.query(
        `SELECT document FROM ${qualifiedTable(SCHEMA, physical(collection))} WHERE _id = $1 FOR UPDATE`,
        [id],
      );
      const pending = run();
      try {
        await waitFor(`${waiters} lock waiters on ${collection}`, async () =>
          (await waitingOnTable(collection)) >= waiters);
      } catch (error) {
        await client.query("COMMIT");
        open = false;
        await pending.catch(() => undefined);
        throw error;
      }
      await client.query("COMMIT");
      open = false;
      return await pending;
    } finally {
      if (open) await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }

  async function resetTables(): Promise<void> {
    const tables = await poolA.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = $1",
      [SCHEMA],
    );
    if (tables.rows.length === 0) return;
    const list = tables.rows
      .map((row) => qualifiedTable(SCHEMA, String(row.tablename)))
      .join(", ");
    await poolA.query(`TRUNCATE ${list}`);
  }

  async function installJoinGate(): Promise<void> {
    const members = qualifiedTable(SCHEMA, physical("group_members"));
    const fn = qualifiedTable(SCHEMA, "slice2_join_gate");
    await poolA.query(
      `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger
       LANGUAGE plpgsql AS $fn$
       BEGIN
         PERFORM pg_catalog.pg_advisory_lock(${ADVISORY_CLASS}, ${ADVISORY_OBJ});
         PERFORM pg_catalog.pg_advisory_unlock(${ADVISORY_CLASS}, ${ADVISORY_OBJ});
         RETURN NEW;
       END;
       $fn$`,
    );
    await poolA.query(`DROP TRIGGER IF EXISTS slice2_join_gate ON ${members}`);
    await poolA.query(
      `CREATE TRIGGER slice2_join_gate
       BEFORE INSERT ON ${members}
       FOR EACH ROW EXECUTE ${triggerExecute} ${fn}()`,
    );
  }

  async function dropJoinGate(): Promise<void> {
    const members = qualifiedTable(SCHEMA, physical("group_members"));
    await poolA.query(`DROP TRIGGER IF EXISTS slice2_join_gate ON ${members}`);
  }

  beforeAll(async () => {
    const poolOptions = {
      connectionString: DATABASE_URL,
      max: 4,
      statement_timeout: 25_000,
      application_name: "slice2-concurrency",
    };
    poolA = new pg.Pool(poolOptions);
    poolB = new pg.Pool(poolOptions);
    repoA = makeRepo(poolA);
    repoB = makeRepo(poolB);
    await poolA.query(`DROP SCHEMA IF EXISTS ${quoteIdent(SCHEMA)} CASCADE`);
    const plan = buildPostgresSchemaPlan(NAMESPACE, SCHEMA);
    await poolA.query(`CREATE SCHEMA ${quoteIdent(SCHEMA)}`);
    for (const fn of plan.functions) await poolA.query(fn.sql);
    for (const table of plan.tables) await poolA.query(table.sql);
    await poolA.query(plan.authSessions.sql);
    for (const index of [...plan.indexes, ...plan.authSessions.indexes]) {
      await poolA.query(index.sql);
    }
    const version = Number(
      (await poolA.query("SHOW server_version_num")).rows[0]?.server_version_num,
    );
    triggerExecute = version >= 140000 ? "FUNCTION" : "PROCEDURE";
  });

  afterAll(async () => {
    if (poolA !== undefined) {
      await poolA.query(`DROP SCHEMA IF EXISTS ${quoteIdent(SCHEMA)} CASCADE`).catch(() => undefined);
      await poolA.end();
    }
    if (poolB !== undefined) await poolB.end();
  });

  it("同用户不同场次并发结算不丢积分", async () => {
    expect(calculatePeriodKey(PeriodType.Week, ANCHOR_A)).toBe(
      calculatePeriodKey(PeriodType.Week, ANCHOR_B),
    );
    expect(levelSeasonOf(ANCHOR_A)).toBe(levelSeasonOf(ANCHOR_B));
    if (inUse.size !== 0) throw new Error(`connections still checked out: ${inUse.size}`);
    peakConnections = 0;
    await resetTables();
    await repoA.users.insert(makeUser(USER_ID));
    await repoA.matches.insert(makeMatch(MATCH_A, ANCHOR_A, 2, 1));
    await repoA.matches.insert(makeMatch(MATCH_B, ANCHOR_B, 1, 0));
    await repoA.matchResults.insert(makeResult(MATCH_A, 2, 1));
    await repoA.matchResults.insert(makeResult(MATCH_B, 1, 0));
    await repoA.predictions.insert(makePrediction(
      PREDICTION_A,
      MATCH_A,
      "00000000-0000-4000-8000-000000000031",
      2,
      1,
    ));
    await repoA.predictions.insert(makePrediction(
      PREDICTION_B,
      MATCH_B,
      "00000000-0000-4000-8000-000000000032",
      2,
      0,
    ));

    const settled = await withRowGate("users", USER_ID, 2, () => Promise.allSettled([
      settlementService(repoA).start(MATCH_A, NOW, false),
      settlementService(repoB).start(MATCH_B, NOW, false),
    ]));
    expect(peakConnections).toBeGreaterThanOrEqual(2);
    expect(settled[0]).toMatchObject({
      status: "fulfilled",
      value: { kind: "started", processed_count: 1 },
    });
    expect(settled[1]).toMatchObject({
      status: "fulfilled",
      value: { kind: "started", processed_count: 1 },
    });

    const user = await repoA.users.findById(USER_ID);
    const seasonId = levelSeasonOf(ANCHOR_A);
    const season = await repoA.userSeasonStats.findByUserAndSeason(USER_ID, seasonId);
    const periodKey = calculatePeriodKey(PeriodType.Week, ANCHOR_A);
    const ranking = await repoA.rankings.findByPeriodAndUser(PeriodType.Week, periodKey, USER_ID);
    const expectedPoints = MatchScoreValue.ExactHit + MatchScoreValue.WdlHit;
    expect(user).toMatchObject({
      career_points: expectedPoints,
      career_valid_predictions: 2,
      career_wdl_hits: 2,
      career_exact_hits: 1,
    });
    expect(season).toMatchObject({
      points: expectedPoints,
      valid_predictions: 2,
      wdl_hits: 2,
      exact_hits: 1,
    });
    expect(ranking).toMatchObject({
      period_score: expectedPoints,
      valid_predictions: 2,
      wdl_hits: 2,
      exact_hits: 1,
    });
  }, 30_000);

  it("最后名额并发加入不会超过群人数上限", async () => {
    if (inUse.size !== 0) throw new Error(`connections still checked out: ${inUse.size}`);
    peakConnections = 0;
    await resetTables();
    await repoA.users.insert(makeUser(OWNER_ID, "Owner"));
    await repoA.users.insert(makeUser(JOINER_A, "Ace"));
    await repoA.users.insert(makeUser(JOINER_B, "Bay"));
    const group = makeGroup(GROUP_CAP, "ABCDEFGH", FIXED_CONFIG_V1.GROUP_MAX_MEMBERS - 1);
    await repoA.groups.insert(group);
    await repoA.groupMembers.insert(makeMember(group.group_id, OWNER_ID));

    const raced = await withRowGate("groups", group.group_id, 2, () => Promise.allSettled([
      groupsService(repoA).joinGroup(JOINER_A, group.invite_code, NOW),
      groupsService(repoB).joinGroup(JOINER_B, group.invite_code, NOW),
    ]));
    expect(peakConnections).toBeGreaterThanOrEqual(2);
    const fulfilled = raced.filter((result) => result.status === "fulfilled");
    const rejected = raced.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: { code: "GROUP_MEMBER_LIMIT_REACHED" },
    });

    const stored = await repoA.groups.findById(group.group_id);
    const active = (await repoA.groupMembers.findByGroup(group.group_id))
      .filter((member) => member.status === GroupMemberStatus.Active);
    expect(stored?.member_count).toBe(FIXED_CONFIG_V1.GROUP_MAX_MEMBERS);
    expect(stored?.status).toBe(GroupStatus.Active);
    expect(active).toHaveLength(2);
  }, 30_000);

  it("并发解散与加入后群保持解散且不复活", async () => {
    if (inUse.size !== 0) throw new Error(`connections still checked out: ${inUse.size}`);
    peakConnections = 0;
    await resetTables();
    await repoA.users.insert(makeUser(OWNER_ID, "Owner"));
    await repoA.users.insert(makeUser(JOINER_C, "Cleo"));
    const group = makeGroup(GROUP_DISSOLVE, "JKLMNPQR", 1);
    await repoA.groups.insert(group);
    await repoA.groupMembers.insert(makeMember(group.group_id, OWNER_ID));
    await installJoinGate();
    const gate = await poolA.connect();
    let locked = false;
    try {
      await gate.query("SELECT pg_catalog.pg_advisory_lock($1, $2)", [ADVISORY_CLASS, ADVISORY_OBJ]);
      locked = true;
      const joinPromise = groupsService(repoA).joinGroup(JOINER_C, group.invite_code, NOW);
      await waitFor("join blocked before writing the group", async () => (await advisoryWaiters()) >= 1);
      let dissolveDone = false;
      const dissolvePromise = groupsService(repoB)
        .dissolveGroup(OWNER_ID, group.group_id, NOW)
        .finally(() => {
          dissolveDone = true;
        });
      await waitFor("dissolve queued behind the group lock or finished", async () =>
        dissolveDone || (await waitingOnTable("groups")) >= 1);
      await gate.query("SELECT pg_catalog.pg_advisory_unlock($1, $2)", [ADVISORY_CLASS, ADVISORY_OBJ]);
      locked = false;
      const [joinResult, dissolveResult] = await Promise.allSettled([joinPromise, dissolvePromise]);
      expect(peakConnections).toBeGreaterThanOrEqual(2);
      expect(dissolveResult.status).toBe("fulfilled");
      if (joinResult.status === "rejected") {
        expect(joinResult.reason).toMatchObject({ code: "GROUP_DISSOLVED" });
      }
      const stored = await repoA.groups.findById(group.group_id);
      const active = (await repoA.groupMembers.findByGroup(group.group_id))
        .filter((member) => member.status === GroupMemberStatus.Active);
      expect(stored).toMatchObject({
        status: GroupStatus.Dissolved,
        member_count: 0,
      });
      expect(active).toHaveLength(0);
    } finally {
      if (locked) {
        await gate.query("SELECT pg_catalog.pg_advisory_unlock($1, $2)", [ADVISORY_CLASS, ADVISORY_OBJ])
          .catch(() => undefined);
      }
      gate.release();
      await dropJoinGate();
    }
  }, 30_000);
});
