import { SCHEMA_VERSION, SettlementItemStatus } from "../domain/enums.js";
import { internalError } from "../domain/errors.js";
import type {
  Admin,
  AdminAuditLog,
  Anomaly,
  BoardSnapshot,
  DeletedOpenidMapping,
  Group,
  GroupMember,
  JobLock,
  LevelHistoryEntry,
  Match,
  MatchProviderMapping,
  MatchResult,
  Prediction,
  ProviderSnapshot,
  RankingEntry,
  SettlementDoc,
  SettlementItem,
  SyncLog,
  Team,
  TeamProviderMapping,
  Unlock,
  User,
  UserSeasonStats,
} from "../domain/types.js";
import {
  assertBoardSnapshotInvariants,
  assertGroupInvariants,
  assertGroupMemberInvariants,
  assertLevelHistoryInvariants,
  assertMatchResultVersionInvariants,
  assertPredictionClosedAtImmutable,
  assertPredictionInvariants,
  assertPeriodAnchorImmutable,
  assertFinishDetectedImmutable,
  assertRankingInvariants,
  assertSettlementDocumentInvariant,
  assertSettlementItemInvariant,
  assertSeasonStatsInvariants,
  assertUserCareerInvariants,
} from "../domain/invariants.js";
import {
  CloudBaseDocumentNotFoundError,
  CloudBaseDuplicateKeyError,
  cloudBaseCollectionName,
  type CloudBaseDb,
  type CloudBaseDocument,
  type CloudBaseRepositoryConfig,
} from "./cloudbase-db.js";
import {
  DocumentNotFoundError,
  StaleResultVersionError,
  UniqueConstraintError,
  type AdminRepository,
  type AdminAuditLogRepository,
  type AdminAnomalyPageQuery,
  type AdminAnomalyPage,
  type AnomalyRepository,
  type AppRepository,
  type BoardSnapshotRepository,
  type DeletedOpenidMappingRepository,
  type GroupMemberRepository,
  type GroupRepository,
  type JobLockRepository,
  type LevelHistoryRepository,
  type MatchProviderMappingRepository,
  type MatchRepository,
  type MatchResultRepository,
  type PredictionRepository,
  type ProviderSnapshotRepository,
  type RankingRepository,
  type SettlementItemRepository,
  type SettlementRepository,
  type SyncLogRepository,
  type TeamProviderMappingRepository,
  type TeamRepository,
  type UnlockRepository,
  type UnitOfWork,
  type UserRepository,
  type UserSeasonStatsRepository,
} from "./repositories.js";

type EntityDoc = { schema_version: number };

const PROVIDER_SUCCESS_EVENTS = new Set<ProviderSnapshot["event_type"]>([
  "discovered",
  "status_changed",
  "kickoff_changed",
  "result_observed",
  "result_changed",
]);

const DETERMINISTIC_ID_INDEXES: Record<string, { name: string; fields: readonly string[] }> = {
  deleted_openid_mappings: { name: "uk_deleted_openid", fields: ["original_openid"] },
  team_provider_mappings: { name: "uk_provider_team", fields: ["provider", "provider_team_id"] },
  match_provider_mappings: { name: "uk_provider_match", fields: ["provider", "provider_match_id"] },
  match_results: { name: "uk_match_result_version", fields: ["match_id", "result_version"] },
  settlement_items: { name: "uk_settlement_prediction", fields: ["settlement_id", "prediction_id"] },
  user_season_stats: { name: "uk_user_season", fields: ["user_id", "level_season_id"] },
  board_snapshots: { name: "uk_board_snapshot_user", fields: ["board", "snapshot_at", "user_id"] },
  group_members: { name: "uk_group_user", fields: ["group_id", "user_id"] },
  rankings: { name: "uk_period_user", fields: ["period_type", "period_key", "user_id"] },
  job_locks: { name: "uk_lock_key", fields: ["lock_key"] },
};

function compositeId(...parts: (string | number)[]): string {
  return `key_${Buffer.from(JSON.stringify(parts), "utf8").toString("base64url")}`;
}

function withoutId<T>(document: CloudBaseDocument): T {
  const { _id: _ignored, ...fields } = document;
  return fields as T;
}

function compareDateDesc<T>(field: keyof T, idField?: keyof T) {
  return (left: T, right: T): number => {
    const leftDate = left[field] instanceof Date ? (left[field] as Date).getTime() : 0;
    const rightDate = right[field] instanceof Date ? (right[field] as Date).getTime() : 0;
    if (leftDate !== rightDate) return rightDate - leftDate;
    if (idField === undefined) return 0;
    const a = String(left[idField]);
    const b = String(right[idField]);
    return a === b ? 0 : a < b ? 1 : -1;
  };
}

function compareDateAsc<T>(field: keyof T): (left: T, right: T) => number {
  return (left, right) => {
    const a = left[field] instanceof Date ? (left[field] as Date).getTime() : 0;
    const b = right[field] instanceof Date ? (right[field] as Date).getTime() : 0;
    return a - b;
  };
}

function assertSchemaVersionOne(doc: EntityDoc): void {
  if (doc.schema_version !== SCHEMA_VERSION) {
    throw internalError("schema_version 必须为 1");
  }
}

/** 所有 collection 字段沿用 schema 的 snake_case；这里只映射 CloudBase `_id`。 */
export class CloudBaseAppRepository implements AppRepository {
  readonly users: UserRepository;
  readonly deletedOpenidMappings: DeletedOpenidMappingRepository;
  readonly teams: TeamRepository;
  readonly teamProviderMappings: TeamProviderMappingRepository;
  readonly matchProviderMappings: MatchProviderMappingRepository;
  readonly providerSnapshots: ProviderSnapshotRepository;
  readonly admins: AdminRepository;
  readonly adminAuditLogs: AdminAuditLogRepository;
  readonly anomalies: AnomalyRepository;
  readonly syncLogs: SyncLogRepository;
  readonly matches: MatchRepository;
  readonly predictions: PredictionRepository;
  readonly matchResults: MatchResultRepository;
  readonly settlements: SettlementRepository;
  readonly settlementItems: SettlementItemRepository;
  readonly unlocks: UnlockRepository;
  readonly userSeasonStats: UserSeasonStatsRepository;
  readonly rankings: RankingRepository;
  readonly levelHistory: LevelHistoryRepository;
  readonly boardSnapshots: BoardSnapshotRepository;
  readonly groups: GroupRepository;
  readonly groupMembers: GroupMemberRepository;
  readonly jobLocks: JobLockRepository;

  constructor(
    private readonly config: CloudBaseRepositoryConfig,
    private readonly db: CloudBaseDb,
  ) {
    this.users = {
      findByOpenid: async (openid) => this.one<User>("users", { openid }),
      findById: async (userId) => this.byId<User>("users", userId),
      findAll: async () => this.all<User>("users"),
      insert: async (user) => {
        assertUserCareerInvariants(user);
        assertSchemaVersionOne(user);
        await this.add("users", user.user_id, user);
      },
      update: async (user) => {
        assertUserCareerInvariants(user);
        assertSchemaVersionOne(user);
        const old = await this.byId<User>("users", user.user_id);
        if (old === null) throw new DocumentNotFoundError("users", user.user_id);
        if (user.career_best_level < old.career_best_level) throw internalError("career_best_level 只增不减");
        await this.update("users", user.user_id, user);
      },
    };

    this.deletedOpenidMappings = {
      findByOriginalOpenid: async (openid) => this.one<DeletedOpenidMapping>("deleted_openid_mappings", { original_openid: openid }),
      findByDeletedUserId: async (userId) => this.one<DeletedOpenidMapping>("deleted_openid_mappings", { deleted_user_id: userId }),
      upsert: async (mapping) => {
        const id = compositeId(mapping.original_openid);
        await this.db.transaction(async (txDb) => {
          const repo = new CloudBaseAppRepository(this.config, txDb);
          const current = await repo.byId<DeletedOpenidMapping>("deleted_openid_mappings", id);
          if (current === null) await repo.add("deleted_openid_mappings", id, mapping);
          else await repo.update("deleted_openid_mappings", id, mapping);
        });
      },
    };

    this.teams = {
      findById: async (id) => this.byId<Team>("teams", id),
      insert: async (team) => this.add("teams", team.team_id, team),
    };
    this.teamProviderMappings = {
      findByProviderAndExternalId: async (provider, externalId) => this.one<TeamProviderMapping>("team_provider_mappings", { provider, provider_team_id: externalId }),
      findByTeamId: async (teamId) => this.where<TeamProviderMapping>("team_provider_mappings", { team_id: teamId }),
      insert: async (mapping) => this.add("team_provider_mappings", compositeId(mapping.provider, mapping.provider_team_id), mapping),
    };
    this.matchProviderMappings = {
      findByProviderAndExternalId: async (provider, externalId) => this.one<MatchProviderMapping>("match_provider_mappings", { provider, provider_match_id: externalId }),
      findByMatchId: async (matchId) => this.where<MatchProviderMapping>("match_provider_mappings", { match_id: matchId }),
      insert: async (mapping) => this.add("match_provider_mappings", compositeId(mapping.provider, mapping.provider_match_id), mapping),
    };
    this.providerSnapshots = {
      findByEntity: async (entityType, entityId) => this.where<ProviderSnapshot>("provider_snapshots", { entity_type: entityType, entity_id: entityId }),
      findLatestSuccessByEntity: async (entityType, entityId) => {
        const snapshots = await this.providerSnapshots.findByEntity(entityType, entityId);
        return snapshots.filter((item) => PROVIDER_SUCCESS_EVENTS.has(item.event_type)).sort(compareDateDesc<ProviderSnapshot>("created_at"))[0] ?? null;
      },
      insert: async (snapshot) => this.add("provider_snapshots", snapshot.snapshot_id, snapshot),
    };
    this.admins = {
      findByOpenid: async (openid) => this.one<Admin>("admins", { openid }),
      insert: async (admin) => this.add("admins", admin.admin_id, admin),
    };
    this.adminAuditLogs = {
      findByEntity: async (entityType, entityId) => this.where<AdminAuditLog>("admin_audit_logs", { entity_type: entityType, entity_id: entityId }),
      insert: async (log) => this.add("admin_audit_logs", log.audit_id, log),
    };
    this.anomalies = {
      findByKey: async (key) => this.one<Anomaly>("anomalies", { anomaly_key: key }),
      findOpenBlockingByMatch: async (matchId) => (await this.where<Anomaly>("anomalies", { match_id: matchId, status: "open", blocking: true })),
      findPage: async (query) => this.findAnomalyPage(query),
      insert: async (anomaly) => this.add("anomalies", anomaly.anomaly_id, anomaly),
      update: async (anomaly) => this.update("anomalies", anomaly.anomaly_id, anomaly),
    };
    this.syncLogs = {
      insert: async (log) => this.add("sync_logs", log.sync_job_id, log),
      update: async (log) => this.update("sync_logs", log.sync_job_id, log),
    };
    this.matches = {
      findById: async (id) => this.byId<Match>("matches", id),
      findBySeason: async (seasonId) => this.where<Match>("matches", { season_id: seasonId }),
      findByLeagueSeasonRound: async (leagueId, seasonId, roundId) => this.where<Match>("matches", { league_id: leagueId, season_id: seasonId, round_id: roundId }),
      findLive: async () => this.where<Match>("matches", { match_status: "live" }),
      insert: async (match) => {
        assertMatchResultVersionInvariants(match);
        await this.add("matches", match.match_id, match);
      },
      update: async (match) => {
        const old = await this.byId<Match>("matches", match.match_id);
        if (old === null) throw new DocumentNotFoundError("matches", match.match_id);
        if (old.league_id !== match.league_id || old.season_id !== match.season_id ||
          old.round_id !== match.round_id || old.scoring_rule_version !== match.scoring_rule_version) {
          throw internalError("match 的固定身份字段不可修改");
        }
        assertPredictionClosedAtImmutable(old.prediction_closed_at, match.prediction_closed_at);
        assertPeriodAnchorImmutable(old.period_anchor_at, match.period_anchor_at);
        assertFinishDetectedImmutable(old.finish_detected_at, match.finish_detected_at);
        if (match.result_version < old.result_version || match.settled_result_version < old.settled_result_version) {
          throw internalError("match 版本号不得回退");
        }
        assertMatchResultVersionInvariants(match);
        await this.update("matches", match.match_id, match);
      },
      updateSettlementStatus: async (matchId, settlementStatus, updatedAt) => {
        const match = await this.byId<Match>("matches", matchId);
        if (match === null) throw new DocumentNotFoundError("matches", matchId);
        await this.update("matches", matchId, { ...match, settlement_status: settlementStatus, updated_at: updatedAt });
      },
    };
    this.predictions = {
      findById: async (id) => this.byId<Prediction>("predictions", id),
      findByUserAndMatch: async (userId, matchId) => this.one<Prediction>("predictions", { user_id: userId, match_id: matchId }),
      findByUserAndIdempotencyKey: async (userId, key) => this.one<Prediction>("predictions", { user_id: userId, idempotency_key: key }),
      findByUser: async (userId) => this.where<Prediction>("predictions", { user_id: userId }),
      findByMatch: async (matchId) => this.where<Prediction>("predictions", { match_id: matchId }),
      insert: async (prediction) => {
        assertPredictionInvariants(prediction);
        await this.add("predictions", prediction.prediction_id, prediction);
      },
      update: async (prediction) => {
        const old = await this.byId<Prediction>("predictions", prediction.prediction_id);
        if (old === null) throw new DocumentNotFoundError("predictions", prediction.prediction_id);
        if (old.user_id !== prediction.user_id || old.match_id !== prediction.match_id ||
          old.idempotency_key !== prediction.idempotency_key ||
          old.pred_home_score !== prediction.pred_home_score || old.pred_away_score !== prediction.pred_away_score ||
          old.derived_result !== prediction.derived_result || old.submitted_at.getTime() !== prediction.submitted_at.getTime() ||
          old.scoring_rule_version !== prediction.scoring_rule_version || old.created_at.getTime() !== prediction.created_at.getTime()) {
          throw internalError("prediction 提交事实字段不可修改");
        }
        if (prediction.applied_result_version < old.applied_result_version) throw internalError("prediction.applied_result_version 不得回退");
        assertPredictionInvariants(prediction);
        await this.update("predictions", prediction.prediction_id, prediction);
      },
    };
    this.jobLocks = {
      acquire: async (lockKey, ownerId, leaseUntil) => this.db.transaction(async (txDb) => {
        const repo = new CloudBaseAppRepository(this.config, txDb);
        const current = await repo.byId<JobLock>("job_locks", lockKey);
        if (current && current.lease_until.getTime() > Date.now()) return false;
        const next: JobLock = {
          schema_version: SCHEMA_VERSION,
          lock_key: lockKey,
          owner_id: ownerId,
          lease_until: leaseUntil,
          updated_at: new Date(),
        };
        if (current) await repo.update("job_locks", lockKey, next);
        else await repo.add("job_locks", lockKey, next);
        return true;
      }),
      isHeld: async (lockKey, asOf) => {
        const lock = await this.byId<JobLock>("job_locks", lockKey);
        return lock !== null && lock.lease_until.getTime() > asOf.getTime();
      },
      renew: async (lockKey, ownerId, leaseUntil) => this.db.transaction(async (txDb) => {
        const repo = new CloudBaseAppRepository(this.config, txDb);
        const current = await repo.byId<JobLock>("job_locks", lockKey);
        const now = Date.now();
        if (!current || current.owner_id !== ownerId || current.lease_until.getTime() <= now) return false;
        await repo.update("job_locks", lockKey, { ...current, lease_until: leaseUntil, updated_at: new Date() });
        return true;
      }),
      release: async (lockKey, ownerId) => this.db.transaction(async (txDb) => {
        const repo = new CloudBaseAppRepository(this.config, txDb);
        const current = await repo.byId<JobLock>("job_locks", lockKey);
        if (current?.owner_id === ownerId) {
          await repo.update("job_locks", lockKey, { ...current, lease_until: new Date(0), updated_at: new Date() });
        }
      }),
    };
    this.matchResults = {
      findByMatchAndVersion: async (matchId, version) => this.byId<MatchResult>("match_results", compositeId(matchId, version)),
      findLatestByMatch: async (matchId) => {
        const items = await this.where<MatchResult>("match_results", { match_id: matchId });
        return items.sort((a, b) => b.result_version - a.result_version)[0] ?? null;
      },
      insert: async (result) => this.db.transaction(async (txDb) => {
        assertSchemaVersionOne(result);
        const txRepo = new CloudBaseAppRepository(this.config, txDb);
        const latest = await txRepo.matchResults.findLatestByMatch(result.match_id);
        if (latest && result.result_version < latest.result_version) {
          throw new StaleResultVersionError(result.match_id, latest.result_version, result.result_version);
        }
        await txRepo.add("match_results", compositeId(result.match_id, result.result_version), result);
      }),
    };
    this.settlements = {
      findById: async (id) => this.byId<SettlementDoc>("settlements", id),
      findByMatch: async (matchId) => (await this.where<SettlementDoc>("settlements", { match_id: matchId })).sort((a, b) => a.result_version - b.result_version),
      findByMatchAndVersionAndRule: async (matchId, resultVersion, ruleVersion) => this.one<SettlementDoc>("settlements", { match_id: matchId, result_version: resultVersion, rule_version: ruleVersion }),
      findByStatus: async (status) => this.where<SettlementDoc>("settlements", { status }),
      insert: async (settlement) => { assertSettlementDocumentInvariant(settlement); await this.add("settlements", settlement.settlement_id, settlement); },
      update: async (settlement) => { assertSettlementDocumentInvariant(settlement); await this.update("settlements", settlement.settlement_id, settlement); },
    };
    this.settlementItems = {
      findBySettlementAndPrediction: async (settlementId, predictionId) => this.one<SettlementItem>("settlement_items", { settlement_id: settlementId, prediction_id: predictionId }),
      findBySettlement: async (settlementId) => this.where<SettlementItem>("settlement_items", { settlement_id: settlementId }),
      findBySettlementAndStatus: async (settlementId, status) => this.where<SettlementItem>("settlement_items", { settlement_id: settlementId, status }),
      findByStatus: async (status) => this.where<SettlementItem>("settlement_items", { status }),
      findAppliedByUserBefore: async (userId, asOf) => {
        const items = await this.where<SettlementItem>("settlement_items", { user_id: userId, status: SettlementItemStatus.Applied });
        return items.filter((item) => item.applied_at !== null && item.applied_at < asOf).sort(compareDateAsc<SettlementItem>("applied_at"));
      },
      insert: async (item) => { assertSettlementItemInvariant(item); await this.add("settlement_items", compositeId(item.settlement_id, item.prediction_id), item); },
      update: async (item) => { assertSettlementItemInvariant(item); await this.update("settlement_items", compositeId(item.settlement_id, item.prediction_id), item); },
    };
    this.unlocks = {
      findByUser: async (userId) => this.where<Unlock>("unlocks", { user_id: userId }),
      findByUserAndCode: async (userId, unlockCode) => this.one<Unlock>("unlocks", { user_id: userId, unlock_code: unlockCode }),
      insert: async (unlock) => this.add("unlocks", unlock.unlock_id, unlock),
    };
    this.userSeasonStats = {
      findByUserAndSeason: async (userId, seasonId) => this.one<UserSeasonStats>("user_season_stats", { user_id: userId, level_season_id: seasonId }),
      findByUser: async (userId) => this.where<UserSeasonStats>("user_season_stats", { user_id: userId }),
      findByLevelSeason: async (seasonId) => this.where<UserSeasonStats>("user_season_stats", { level_season_id: seasonId }),
      insert: async (stats) => {
        assertSeasonStatsInvariants(stats);
        await this.add("user_season_stats", compositeId(stats.user_id, stats.level_season_id), stats);
      },
      update: async (stats) => {
        assertSeasonStatsInvariants(stats);
        await this.update("user_season_stats", compositeId(stats.user_id, stats.level_season_id), stats);
      },
    };
    this.rankings = {
      findByPeriodAndUser: async (periodType, periodKey, userId) => this.one<RankingEntry>("rankings", { period_type: periodType, period_key: periodKey, user_id: userId }),
      findByPeriod: async (periodType, periodKey) => this.where<RankingEntry>("rankings", { period_type: periodType, period_key: periodKey }),
      findAll: async () => this.all<RankingEntry>("rankings"),
      insert: async (entry) => { assertRankingInvariants(entry); await this.add("rankings", compositeId(entry.period_type, entry.period_key, entry.user_id), entry); },
      update: async (entry) => { assertRankingInvariants(entry); await this.update("rankings", compositeId(entry.period_type, entry.period_key, entry.user_id), entry); },
    };
    this.levelHistory = {
      findByUser: async (userId) => this.where<LevelHistoryEntry>("level_history", { user_id: userId }),
      insert: async (entry) => { assertLevelHistoryInvariants(entry); await this.add("level_history", entry.level_history_id, entry); },
    };
    this.boardSnapshots = {
      findLatestByBoard: async (board) => {
        const items = (await this.where<BoardSnapshot>("board_snapshots", { board })).filter((item) => item.is_final !== true);
        const latest = items.reduce<Date | null>((at, item) => at === null || item.snapshot_at > at ? item.snapshot_at : at, null);
        return latest === null ? [] : items.filter((item) => item.snapshot_at.getTime() === latest.getTime()).sort((a, b) => a.rank - b.rank);
      },
      findLatestBySeason: async (seasonId) => {
        const items = (await this.where<BoardSnapshot>("board_snapshots", { board: "season", level_season_id: seasonId })).filter((item) => item.is_final !== true);
        const latest = items.reduce<Date | null>((at, item) => at === null || item.snapshot_at > at ? item.snapshot_at : at, null);
        return latest === null ? [] : items.filter((item) => item.snapshot_at.getTime() === latest.getTime()).sort((a, b) => a.rank - b.rank);
      },
      findFinalBySeason: async (seasonId) => (await this.where<BoardSnapshot>("board_snapshots", { board: "season", level_season_id: seasonId, is_final: true })).sort((a, b) => a.rank - b.rank),
      listFinalSeasonIds: async () => [...new Set((await this.where<BoardSnapshot>("board_snapshots", { board: "season", is_final: true })).filter((item) => item.snapshot_kind !== "head" && item.level_season_id !== null).map((item) => item.level_season_id!))].sort((a, b) => b.localeCompare(a)),
      findByBoardAndSnapshotAt: async (board, snapshotAt) => (await this.where<BoardSnapshot>("board_snapshots", { board, snapshot_at: snapshotAt })).filter((item) => item.is_final !== true),
      insert: async (snapshot) => {
        assertBoardSnapshotInvariants(snapshot);
        await this.add("board_snapshots", compositeId(snapshot.board, snapshot.snapshot_at.toISOString(), snapshot.user_id), snapshot);
      },
    };
    this.groups = {
      findById: async (id) => this.byId<Group>("groups", id),
      findByOwner: async (ownerId) => this.where<Group>("groups", { owner_user_id: ownerId }),
      findByInviteCode: async (inviteCode) => this.one<Group>("groups", { invite_code: inviteCode }),
      insert: async (group) => { assertGroupInvariants(group); await this.add("groups", group.group_id, group); },
      update: async (group) => { assertGroupInvariants(group); await this.update("groups", group.group_id, group); },
    };
    this.groupMembers = {
      findByGroupAndUser: async (groupId, userId) => this.byId<GroupMember>("group_members", compositeId(groupId, userId)),
      findByGroup: async (groupId) => this.where<GroupMember>("group_members", { group_id: groupId }),
      findByUser: async (userId) => this.where<GroupMember>("group_members", { user_id: userId }),
      insert: async (member) => { assertGroupMemberInvariants(member); await this.add("group_members", compositeId(member.group_id, member.user_id), member); },
      update: async (member) => { assertGroupMemberInvariants(member); await this.update("group_members", compositeId(member.group_id, member.user_id), member); },
    };
  }

  async withTransaction<T>(work: (tx: UnitOfWork) => Promise<T>): Promise<T> {
    return this.db.transaction((txDb) => work(new CloudBaseAppRepository(this.config, txDb)));
  }

  async savepoint<T>(work: (tx: UnitOfWork) => Promise<T>): Promise<T> {
    return this.db.transaction((txDb) => work(new CloudBaseAppRepository(this.config, txDb)));
  }

  private collection(name: string): string {
    return cloudBaseCollectionName(this.config.resource_namespace, name);
  }

  private async byId<T>(name: string, id: string): Promise<T | null> {
    const doc = await this.db.get(this.collection(name), id);
    return doc === null ? null : withoutId<T>(doc);
  }

  private async all<T>(name: string): Promise<T[]> {
    return (await this.db.query(this.collection(name))).map((doc) => withoutId<T>(doc));
  }

  private async where<T>(name: string, filter: Record<string, unknown>): Promise<T[]> {
    return (await this.db.query(this.collection(name), filter)).map((doc) => withoutId<T>(doc));
  }

  private async one<T>(name: string, filter: Record<string, unknown>): Promise<T | null> {
    return (await this.where<T>(name, filter))[0] ?? null;
  }

  private async add<T extends EntityDoc>(name: string, id: string, value: T): Promise<void> {
    assertSchemaVersionOne(value);
    try {
      await this.db.add(this.collection(name), id, { ...value, _id: id });
    } catch (error) {
      if (error instanceof CloudBaseDuplicateKeyError) {
        const deterministicIndex = DETERMINISTIC_ID_INDEXES[name];
        if (error.indexName.startsWith("pk_") && deterministicIndex !== undefined) {
          const fields = value as unknown as Record<string, unknown>;
          throw new UniqueConstraintError(
            name,
            deterministicIndex.name,
            Object.fromEntries(deterministicIndex.fields.map((field) => [field, fields[field]])),
          );
        }
        throw new UniqueConstraintError(name, error.indexName, error.key);
      }
      throw error;
    }
  }

  private async update<T extends EntityDoc>(name: string, id: string, value: T): Promise<void> {
    assertSchemaVersionOne(value);
    try {
      await this.db.update(this.collection(name), id, { ...value, _id: id });
    } catch (error) {
      if (error instanceof CloudBaseDocumentNotFoundError) throw new DocumentNotFoundError(name, id);
      if (error instanceof CloudBaseDuplicateKeyError) throw new UniqueConstraintError(name, error.indexName, error.key);
      throw error;
    }
  }

  private async findAnomalyPage(query: AdminAnomalyPageQuery): Promise<AdminAnomalyPage> {
    const items = (await this.all<Anomaly>("anomalies"))
      .filter((item) => query.status === null || item.status === query.status)
      .filter((item) => query.blocking === null || item.blocking === query.blocking)
      .filter((item) => query.after === null || item.last_seen_at < query.after.last_seen_at ||
        (item.last_seen_at.getTime() === query.after.last_seen_at.getTime() && item.anomaly_id < query.after.anomaly_id))
      .sort(compareDateDesc<Anomaly>("last_seen_at", "anomaly_id"));
    return { items: items.slice(0, query.limit), has_more: items.length > query.limit };
  }
}

export function cloudBaseRepositoryUnitOfWork(repo: AppRepository): UnitOfWork {
  return repo;
}
