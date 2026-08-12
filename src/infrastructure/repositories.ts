/**
 * 基础设施仓储层（阶段 2）。
 *
 * 定义 repository ports、事务/锁抽象，并提供内存适配器（InMemoryRepository）作为
 * 测试与本地运行实现。接口语义对齐规范 21/22 节：
 * - users.openid 唯一（uk_openid）
 * - predictions UNIQUE(user_id, match_id)（uk_user_match）与
 *   UNIQUE(user_id, idempotency_key)（uk_user_idempotency）
 * - job_locks UNIQUE(lock_key)，lease 过期可接管
 * - match_results immutable 且 UNIQUE(match_id, result_version)，result_version 只允许
 *   严格递增写入（旧版本不可覆盖账本）
 * - settlements UNIQUE(match_id, result_version, rule_version)
 * - settlement_items UNIQUE(settlement_id, prediction_id)
 *
 * 事务采用"共享 store + 失败回滚（undo log）"实现：事务内写操作直接作用于共享 store，
 * 唯一约束在写入时原子校验，等价数据库唯一索引的竞态语义；回滚只撤销本事务自身写入，
 * 不影响其他事务已提交的数据。
 */
import {
  SCHEMA_VERSION,
  type SettlementDocStatus,
  type SettlementItemStatus,
} from "../domain/enums.js";
import {
  assertMatchResultVersionInvariants,
  assertFinishDetectedImmutable,
  assertPeriodAnchorImmutable,
  assertPredictionInvariants,
  assertPredictionClosedAtImmutable,
  assertRankingInvariants,
  assertSchemaVersion,
  assertSeasonStatsInvariants,
  assertSettlementDocumentInvariant,
  assertSettlementItemInvariant,
  assertUserCareerInvariants,
} from "../domain/invariants.js";
import { internalError } from "../domain/errors.js";
import type {
  Admin,
  AdminAuditLog,
  Anomaly,
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
import type { AnomalyStatus } from "../domain/enums.js";

/** 唯一约束冲突（模拟数据库唯一索引冲突）。 */
export class UniqueConstraintError extends Error {
  readonly collection: string;
  readonly indexName: string;
  readonly key: Record<string, unknown>;

  constructor(collection: string, indexName: string, key: Record<string, unknown>) {
    super(`Unique constraint violated: ${collection}.${indexName}`);
    this.name = "UniqueConstraintError";
    this.collection = collection;
    this.indexName = indexName;
    this.key = key;
  }
}

/** 对不存在文档执行 update 时抛出。 */
export class DocumentNotFoundError extends Error {
  readonly collection: string;
  readonly id: string;

  constructor(collection: string, id: string) {
    super(`Document not found in ${collection}: ${id}`);
    this.name = "DocumentNotFoundError";
    this.collection = collection;
    this.id = id;
  }
}

/**
 * 向 match_results 账本写入旧版本结果时抛出：同一 match 的 result_version 只允许
 * 严格递增（不可回退、不可覆盖历史结果）。等价数据库不可变 append-only 语义。
 */
export class StaleResultVersionError extends Error {
  readonly collection: string;
  readonly matchId: string;
  readonly latestVersion: number;
  readonly attemptedVersion: number;

  constructor(matchId: string, latestVersion: number, attemptedVersion: number) {
    super(
      `Cannot write stale match_result version ${attemptedVersion}; latest for match is ${latestVersion}`,
    );
    this.name = "StaleResultVersionError";
    this.collection = "match_results";
    this.matchId = matchId;
    this.latestVersion = latestVersion;
    this.attemptedVersion = attemptedVersion;
  }
}

export interface UserRepository {
  findByOpenid(openid: string): Promise<User | null>;
  findById(userId: string): Promise<User | null>;
  findAll(): Promise<User[]>;
  insert(user: User): Promise<void>;
  update(user: User): Promise<void>;
}

/** 公开比赛查询所需的球队只读 port；写入由 Provider 同步流程负责。 */
export interface TeamRepository {
  findById(teamId: string): Promise<Team | null>;
  insert(team: Team): Promise<void>;
}

/** Provider 外部球队 ID 映射；唯一约束由 (provider, provider_team_id) 提供。 */
export interface TeamProviderMappingRepository {
  findByProviderAndExternalId(
    provider: TeamProviderMapping["provider"],
    providerTeamId: string,
  ): Promise<TeamProviderMapping | null>;
  findByTeamId(teamId: string): Promise<TeamProviderMapping[]>;
  insert(mapping: TeamProviderMapping): Promise<void>;
}

/** Provider 外部比赛 ID 映射；唯一约束由 (provider, provider_match_id) 提供。 */
export interface MatchProviderMappingRepository {
  findByProviderAndExternalId(
    provider: MatchProviderMapping["provider"],
    providerMatchId: string,
  ): Promise<MatchProviderMapping | null>;
  findByMatchId(matchId: string): Promise<MatchProviderMapping[]>;
  insert(mapping: MatchProviderMapping): Promise<void>;
}

/** Provider 关键快照只追加，按实体读取供同步异常与审计排查使用。 */
export interface ProviderSnapshotRepository {
  findByEntity(
    entityType: ProviderSnapshot["entity_type"],
    entityId: string | null,
  ): Promise<ProviderSnapshot[]>;
  insert(snapshot: ProviderSnapshot): Promise<void>;
}

/** 管理员身份只读查询；管理员由部署配置 provision，不提供业务创建/删除 API。 */
export interface AdminRepository {
  findByOpenid(openid: string): Promise<Admin | null>;
  insert(admin: Admin): Promise<void>;
}

/** 管理员审计日志只追加，不提供 update/delete。 */
export interface AdminAuditLogRepository {
  findByEntity(entityType: string, entityId: string): Promise<AdminAuditLog[]>;
  insert(log: AdminAuditLog): Promise<void>;
}

export interface AdminAnomalyPageQuery {
  status: AnomalyStatus | null;
  blocking: boolean | null;
  after: {
    last_seen_at: Date;
    anomaly_id: string;
  } | null;
  limit: number;
}

export interface AdminAnomalyPage {
  items: Anomaly[];
  has_more: boolean;
}

/** 异常只读查询与 anomaly 记录的基础写入 port。 */
export interface AnomalyRepository {
  findByKey(anomalyKey: string): Promise<Anomaly | null>;
  findOpenBlockingByMatch(matchId: string): Promise<Anomaly[]>;
  findPage(query: AdminAnomalyPageQuery): Promise<AdminAnomalyPage>;
  insert(anomaly: Anomaly): Promise<void>;
  update(anomaly: Anomaly): Promise<void>;
}

/** 同步任务日志只追加创建、允许更新运行结果，不承载业务事实。 */
export interface SyncLogRepository {
  insert(log: SyncLog): Promise<void>;
  update(log: SyncLog): Promise<void>;
}

export interface MatchRepository {
  findById(matchId: string): Promise<Match | null>;
  findBySeason(seasonId: string): Promise<Match[]>;
  insert(match: Match): Promise<void>;
  update(match: Match): Promise<void>;
  /** 只更新结算状态与更新时间，保留并发写入的其它 match 字段。 */
  updateSettlementStatus(
    matchId: string,
    settlementStatus: Match["settlement_status"],
    updatedAt: Date,
  ): Promise<void>;
}

export interface PredictionRepository {
  findById(predictionId: string): Promise<Prediction | null>;
  findByUserAndMatch(userId: string, matchId: string): Promise<Prediction | null>;
  findByUserAndIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<Prediction | null>;
  findByUser(userId: string): Promise<Prediction[]>;
  findByMatch(matchId: string): Promise<Prediction[]>;
  insert(prediction: Prediction): Promise<void>;
  update(prediction: Prediction): Promise<void>;
}

export interface JobLockRepository {
  /** 原子 compare-and-set：仅在空闲或 lease 过期时获得锁。 */
  acquire(lockKey: string, ownerId: string, leaseUntil: Date): Promise<boolean>;
  /** 仅 owner 且未过期时可续租。 */
  renew(lockKey: string, ownerId: string, leaseUntil: Date): Promise<boolean>;
  /** 仅 owner 可释放；非 owner 调用为空操作。 */
  release(lockKey: string, ownerId: string): Promise<void>;
}

/** 结算账本：match_results 为不可变 append-only 结果记录（规范 11.1/21 节）。 */
export interface MatchResultRepository {
  findByMatchAndVersion(matchId: string, resultVersion: number): Promise<MatchResult | null>;
  /** 返回某 match 当前最大 result_version 的结果；无结果时返回 null。 */
  findLatestByMatch(matchId: string): Promise<MatchResult | null>;
  /**
   * 追加一条结果。唯一约束 uk_match_result_version；且 result_version 必须严格大于
   * 该 match 现有最大版本（旧版本抛 StaleResultVersionError）。
   */
  insert(matchResult: MatchResult): Promise<void>;
}

/** 结算单账本：UNIQUE(match_id, result_version, rule_version)，状态/phase 基础读写。 */
export interface SettlementRepository {
  findById(settlementId: string): Promise<SettlementDoc | null>;
  /** 按比赛读取完整 settlement 版本序列，映射 settlements 的 match_id/result_version 索引。 */
  findByMatch(matchId: string): Promise<SettlementDoc[]>;
  findByMatchAndVersionAndRule(
    matchId: string,
    resultVersion: number,
    ruleVersion: string,
  ): Promise<SettlementDoc | null>;
  findByStatus(status: SettlementDocStatus): Promise<SettlementDoc[]>;
  insert(settlement: SettlementDoc): Promise<void>;
  update(settlement: SettlementDoc): Promise<void>;
}

/** 结算明细账本：UNIQUE(settlement_id, prediction_id)，按状态查询 + 更新 item。 */
export interface SettlementItemRepository {
  findBySettlementAndPrediction(
    settlementId: string,
    predictionId: string,
  ): Promise<SettlementItem | null>;
  /** 某 settlement 的全部 items。 */
  findBySettlement(settlementId: string): Promise<SettlementItem[]>;
  /** 某 settlement 内指定状态（pending / applied / failed）的 items。 */
  findBySettlementAndStatus(
    settlementId: string,
    status: SettlementItemStatus,
  ): Promise<SettlementItem[]>;
  /** 全局按状态查询（pending / applied / failed）。 */
  findByStatus(status: SettlementItemStatus): Promise<SettlementItem[]>;
  insert(item: SettlementItem): Promise<void>;
  update(item: SettlementItem): Promise<void>;
}

/** 解锁记录：immutable，按用户读取并由唯一索引保证幂等。 */
export interface UnlockRepository {
  findByUser(userId: string): Promise<Unlock[]>;
  findByUserAndCode(userId: string, unlockCode: string): Promise<Unlock | null>;
  insert(unlock: Unlock): Promise<void>;
}

/** 赛季统计缓存：按 user_id + season_id 唯一。 */
export interface UserSeasonStatsRepository {
  findByUserAndSeason(userId: string, seasonId: string): Promise<UserSeasonStats | null>;
  findByUser(userId: string): Promise<UserSeasonStats[]>;
  insert(stats: UserSeasonStats): Promise<void>;
  update(stats: UserSeasonStats): Promise<void>;
}

/** 周/月排行榜聚合：按 period_type + period_key + user_id 唯一。 */
export interface RankingRepository {
  findByPeriodAndUser(
    periodType: RankingEntry["period_type"],
    periodKey: string,
    userId: string,
  ): Promise<RankingEntry | null>;
  findByPeriod(
    periodType: RankingEntry["period_type"],
    periodKey: string,
  ): Promise<RankingEntry[]>;
  findAll(): Promise<RankingEntry[]>;
  insert(entry: RankingEntry): Promise<void>;
  update(entry: RankingEntry): Promise<void>;
}

/** 等级变化历史只追加、不更新、不删除。 */
export interface LevelHistoryRepository {
  findByUser(userId: string): Promise<LevelHistoryEntry[]>;
  insert(entry: LevelHistoryEntry): Promise<void>;
}

export interface UnitOfWork {
  users: UserRepository;
  /** Provider 同步适配器未实现时由应用层 Fail Closed。 */
  teamProviderMappings?: TeamProviderMappingRepository;
  /** Provider 同步适配器未实现时由应用层 Fail Closed。 */
  matchProviderMappings?: MatchProviderMappingRepository;
  /** 旧适配器未实现时，比赛公开查询必须 fail closed。 */
  teams?: TeamRepository;
  /** 旧适配器未实现时，Provider 同步必须 fail closed。 */
  providerSnapshots?: ProviderSnapshotRepository;
  /** 旧适配器未实现时，管理员应用服务必须 fail closed。 */
  admins?: AdminRepository;
  adminAuditLogs?: AdminAuditLogRepository;
  /** 旧适配器未实现时，管理员异常查询必须 fail closed。 */
  anomalies?: AnomalyRepository;
  /** 旧适配器未实现时，同步任务必须 fail closed。 */
  syncLogs?: SyncLogRepository;
  matches: MatchRepository;
  predictions: PredictionRepository;
  matchResults: MatchResultRepository;
  settlements: SettlementRepository;
  settlementItems: SettlementItemRepository;
  unlocks: UnlockRepository;
  /** 旧适配器未实现时必须由应用层 Fail Closed。 */
  userSeasonStats?: UserSeasonStatsRepository;
  rankings?: RankingRepository;
  levelHistory?: LevelHistoryRepository;
  /** 旧适配器未实现时，settlement global rank 重算必须 Fail Closed。 */
  jobLocks?: JobLockRepository;
}

export interface AppRepository extends UnitOfWork {
  jobLocks: JobLockRepository;
  withTransaction<T>(fn: (tx: UnitOfWork) => Promise<T>): Promise<T>;
}

interface InMemoryStore {
  adminsByOpenid: Map<string, Admin>;
  adminsById: Map<string, Admin>;
  adminAuditLogsById: Map<string, AdminAuditLog>;
  anomaliesById: Map<string, Anomaly>;
  anomaliesByKey: Map<string, Anomaly>;
  syncLogsById: Map<string, SyncLog>;
  usersByOpenid: Map<string, User>;
  usersById: Map<string, User>;
  teamsById: Map<string, Team>;
  teamProviderMappingsByKey: Map<string, TeamProviderMapping>;
  matchProviderMappingsByKey: Map<string, MatchProviderMapping>;
  providerSnapshotsById: Map<string, ProviderSnapshot>;
  matchesById: Map<string, Match>;
  predictionsByUserMatch: Map<string, Prediction>;
  predictionsByUserKey: Map<string, Prediction>;
  matchResultsByKey: Map<string, MatchResult>;
  settlementsById: Map<string, SettlementDoc>;
  settlementsByKey: Map<string, SettlementDoc>;
  settlementItemsByKey: Map<string, SettlementItem>;
  unlocksById: Map<string, Unlock>;
  unlocksByUserCode: Map<string, Unlock>;
  userSeasonStatsByKey: Map<string, UserSeasonStats>;
  rankingsByKey: Map<string, RankingEntry>;
  levelHistoryById: Map<string, LevelHistoryEntry>;
  jobLocks: Map<string, JobLock>;
}

function createStore(): InMemoryStore {
  return {
    adminsByOpenid: new Map(),
    adminsById: new Map(),
    adminAuditLogsById: new Map(),
    anomaliesById: new Map(),
    anomaliesByKey: new Map(),
    syncLogsById: new Map(),
    usersByOpenid: new Map(),
    usersById: new Map(),
    teamsById: new Map(),
    teamProviderMappingsByKey: new Map(),
    matchProviderMappingsByKey: new Map(),
    providerSnapshotsById: new Map(),
    matchesById: new Map(),
    predictionsByUserMatch: new Map(),
    predictionsByUserKey: new Map(),
    matchResultsByKey: new Map(),
    settlementsById: new Map(),
    settlementsByKey: new Map(),
    settlementItemsByKey: new Map(),
    unlocksById: new Map(),
    unlocksByUserCode: new Map(),
    userSeasonStatsByKey: new Map(),
    rankingsByKey: new Map(),
    levelHistoryById: new Map(),
    jobLocks: new Map(),
  };
}

function userMatchKey(userId: string, matchId: string): string {
  return `${userId}\u0000${matchId}`;
}

function providerMappingKey(provider: string, providerEntityId: string): string {
  return `${provider}\u0000${providerEntityId}`;
}

function userKeyKey(userId: string, idempotencyKey: string): string {
  return `${userId}\u0000${idempotencyKey}`;
}

function matchResultKey(matchId: string, resultVersion: number): string {
  return `${matchId}\u0000${resultVersion}`;
}

function settlementKey(
  matchId: string,
  resultVersion: number,
  ruleVersion: string,
): string {
  return `${matchId}\u0000${resultVersion}\u0000${ruleVersion}`;
}

function settlementItemKey(settlementId: string, predictionId: string): string {
  return `${settlementId}\u0000${predictionId}`;
}

function unlockUserCodeKey(userId: string, unlockCode: string): string {
  return `${userId}\u0000${unlockCode}`;
}

function userSeasonStatsKey(userId: string, seasonId: string): string {
  return `${userId}\u0000${seasonId}`;
}

function rankingKey(
  periodType: RankingEntry["period_type"],
  periodKey: string,
  userId: string,
): string {
  return `${periodType}\u0000${periodKey}\u0000${userId}`;
}

type UndoFn = () => void;

export class InMemoryRepository implements AppRepository {
  private store: InMemoryStore;
  private undoLog: UndoFn[] | null;
  private transactionTail: Promise<void> = Promise.resolve();

  constructor() {
    this.store = createStore();
    this.undoLog = null;
  }

  private logUndo(undo: UndoFn): void {
    if (this.undoLog !== null) {
      this.undoLog.push(undo);
    }
  }

  get users(): UserRepository {
    const self = this;
    return {
      findByOpenid: (openid) => self.findUserByOpenid(openid),
      findById: (userId) => self.findUserById(userId),
      findAll: () => self.findAllUsers(),
      insert: (user) => self.insertUser(user),
      update: (user) => self.updateUser(user),
    };
  }

  get teams(): TeamRepository {
    const self = this;
    return {
      findById: (teamId) => self.findTeamById(teamId),
      insert: (team) => self.insertTeam(team),
    };
  }

  get teamProviderMappings(): TeamProviderMappingRepository {
    const self = this;
    return {
      findByProviderAndExternalId: (provider, providerTeamId) =>
        self.findTeamProviderMappingByExternalId(provider, providerTeamId),
      findByTeamId: (teamId) => self.findTeamProviderMappingsByTeamId(teamId),
      insert: (mapping) => self.insertTeamProviderMapping(mapping),
    };
  }

  get matchProviderMappings(): MatchProviderMappingRepository {
    const self = this;
    return {
      findByProviderAndExternalId: (provider, providerMatchId) =>
        self.findMatchProviderMappingByExternalId(provider, providerMatchId),
      findByMatchId: (matchId) => self.findMatchProviderMappingsByMatchId(matchId),
      insert: (mapping) => self.insertMatchProviderMapping(mapping),
    };
  }

  get providerSnapshots(): ProviderSnapshotRepository {
    const self = this;
    return {
      findByEntity: (entityType, entityId) => self.findProviderSnapshotsByEntity(entityType, entityId),
      insert: (snapshot) => self.insertProviderSnapshot(snapshot),
    };
  }

  get admins(): AdminRepository {
    const self = this;
    return {
      findByOpenid: (openid) => self.findAdminByOpenid(openid),
      insert: (admin) => self.insertAdmin(admin),
    };
  }

  get adminAuditLogs(): AdminAuditLogRepository {
    const self = this;
    return {
      findByEntity: (entityType, entityId) => self.findAdminAuditLogsByEntity(entityType, entityId),
      insert: (log) => self.insertAdminAuditLog(log),
    };
  }

  get anomalies(): AnomalyRepository {
    const self = this;
    return {
      findByKey: (anomalyKey) => self.findAnomalyByKey(anomalyKey),
      findOpenBlockingByMatch: (matchId) => self.findOpenBlockingAnomaliesByMatch(matchId),
      findPage: (query) => self.findAnomaliesPage(query),
      insert: (anomaly) => self.insertAnomaly(anomaly),
      update: (anomaly) => self.updateAnomaly(anomaly),
    };
  }

  get syncLogs(): SyncLogRepository {
    const self = this;
    return {
      insert: (log) => self.insertSyncLog(log),
      update: (log) => self.updateSyncLog(log),
    };
  }

  get matches(): MatchRepository {
    const self = this;
    return {
      findById: (matchId) => self.findMatchById(matchId),
      findBySeason: (seasonId) => self.findMatchesBySeason(seasonId),
      insert: (match) => self.insertMatch(match),
      update: (match) => self.updateMatch(match),
      updateSettlementStatus: (matchId, settlementStatus, updatedAt) =>
        self.updateMatchSettlementStatus(matchId, settlementStatus, updatedAt),
    };
  }

  get predictions(): PredictionRepository {
    const self = this;
    return {
      findById: (predictionId) => self.findPredictionById(predictionId),
      findByUserAndMatch: (userId, matchId) => self.findPredictionByUserAndMatch(userId, matchId),
      findByUserAndIdempotencyKey: (userId, key) =>
        self.findPredictionByUserAndIdempotencyKey(userId, key),
      findByUser: (userId) => self.findPredictionsByUser(userId),
      findByMatch: (matchId) => self.findPredictionsByMatch(matchId),
      insert: (prediction) => self.insertPrediction(prediction),
      update: (prediction) => self.updatePrediction(prediction),
    };
  }

  get matchResults(): MatchResultRepository {
    const self = this;
    return {
      findByMatchAndVersion: (matchId, resultVersion) =>
        self.findMatchResultByKey(matchId, resultVersion),
      findLatestByMatch: (matchId) => self.findLatestMatchResult(matchId),
      insert: (matchResult) => self.insertMatchResult(matchResult),
    };
  }

  get settlements(): SettlementRepository {
    const self = this;
    return {
      findById: (settlementId) => self.findSettlementById(settlementId),
      findByMatch: (matchId) => self.findSettlementsByMatch(matchId),
      findByMatchAndVersionAndRule: (matchId, resultVersion, ruleVersion) =>
        self.findSettlementByKey(matchId, resultVersion, ruleVersion),
      findByStatus: (status) => self.findSettlementsByStatus(status),
      insert: (settlement) => self.insertSettlement(settlement),
      update: (settlement) => self.updateSettlement(settlement),
    };
  }

  get settlementItems(): SettlementItemRepository {
    const self = this;
    return {
      findBySettlementAndPrediction: (settlementId, predictionId) =>
        self.findSettlementItemByKey(settlementId, predictionId),
      findBySettlement: (settlementId) => self.findSettlementItemsBySettlement(settlementId),
      findBySettlementAndStatus: (settlementId, status) =>
        self.findSettlementItemsBySettlementAndStatus(settlementId, status),
      findByStatus: (status) => self.findSettlementItemsByStatus(status),
      insert: (item) => self.insertSettlementItem(item),
      update: (item) => self.updateSettlementItem(item),
    };
  }

  get unlocks(): UnlockRepository {
    const self = this;
    return {
      findByUser: (userId) => self.findUnlocksByUser(userId),
      findByUserAndCode: (userId, unlockCode) =>
        self.findUnlockByUserAndCode(userId, unlockCode),
      insert: (unlock) => self.insertUnlock(unlock),
    };
  }

  get userSeasonStats(): UserSeasonStatsRepository {
    const self = this;
    return {
      findByUserAndSeason: (userId, seasonId) =>
        self.findUserSeasonStatsByKey(userId, seasonId),
      findByUser: (userId) => self.findUserSeasonStats(userId),
      insert: (stats) => self.insertUserSeasonStats(stats),
      update: (stats) => self.updateUserSeasonStats(stats),
    };
  }

  get rankings(): RankingRepository {
    const self = this;
    return {
      findByPeriodAndUser: (periodType, periodKey, userId) =>
        self.findRankingByKey(periodType, periodKey, userId),
      findByPeriod: (periodType, periodKey) =>
        self.findRankingsByPeriod(periodType, periodKey),
      findAll: () => self.findAllRankings(),
      insert: (entry) => self.insertRanking(entry),
      update: (entry) => self.updateRanking(entry),
    };
  }

  get levelHistory(): LevelHistoryRepository {
    const self = this;
    return {
      findByUser: (userId) => self.findLevelHistoryByUser(userId),
      insert: (entry) => self.insertLevelHistory(entry),
    };
  }

  get jobLocks(): JobLockRepository {
    const self = this;
    return {
      acquire: (lockKey, ownerId, leaseUntil) => self.acquireLock(lockKey, ownerId, leaseUntil),
      renew: (lockKey, ownerId, leaseUntil) => self.renewLock(lockKey, ownerId, leaseUntil),
      release: (lockKey, ownerId) => self.releaseLock(lockKey, ownerId),
    };
  }

  // ---- users ----

  // ---- admins ----

  private async findAdminByOpenid(openid: string): Promise<Admin | null> {
    return this.store.adminsByOpenid.get(openid) ?? null;
  }

  private async insertAdmin(admin: Admin): Promise<void> {
    assertSchemaVersion(admin.schema_version);
    if (this.store.adminsById.has(admin.admin_id)) {
      throw new UniqueConstraintError("admins", "pk_admin", { admin_id: admin.admin_id });
    }
    if (this.store.adminsByOpenid.has(admin.openid)) {
      throw new UniqueConstraintError("admins", "uk_admin_openid", { openid: admin.openid });
    }
    this.store.adminsById.set(admin.admin_id, admin);
    this.store.adminsByOpenid.set(admin.openid, admin);
    this.logUndo(() => {
      if (this.store.adminsById.get(admin.admin_id) === admin) {
        this.store.adminsById.delete(admin.admin_id);
      }
      if (this.store.adminsByOpenid.get(admin.openid) === admin) {
        this.store.adminsByOpenid.delete(admin.openid);
      }
    });
  }

  private async findUserByOpenid(openid: string): Promise<User | null> {
    return this.store.usersByOpenid.get(openid) ?? null;
  }

  private async findUserById(userId: string): Promise<User | null> {
    return this.store.usersById.get(userId) ?? null;
  }

  private async findAllUsers(): Promise<User[]> {
    return [...this.store.usersById.values()];
  }

  private async insertUser(user: User): Promise<void> {
    assertUserCareerInvariants(user);
    if (this.store.usersByOpenid.has(user.openid)) {
      throw new UniqueConstraintError("users", "uk_openid", { openid: user.openid });
    }
    if (this.store.usersById.has(user.user_id)) {
      throw new UniqueConstraintError("users", "pk_user", { user_id: user.user_id });
    }
    this.store.usersByOpenid.set(user.openid, user);
    this.store.usersById.set(user.user_id, user);
    this.logUndo(() => {
      if (this.store.usersByOpenid.get(user.openid) === user) {
        this.store.usersByOpenid.delete(user.openid);
      }
      if (this.store.usersById.get(user.user_id) === user) {
        this.store.usersById.delete(user.user_id);
      }
    });
  }

  private async updateUser(user: User): Promise<void> {
    assertUserCareerInvariants(user);
    const old = this.store.usersById.get(user.user_id);
    if (old === undefined) {
      throw new DocumentNotFoundError("users", user.user_id);
    }
    // openid 是用户事实身份，普通业务不得变更（规范 4.2）；仅注销流程改写为墓碑值
    // （规范 4.5，openid = "deleted:" + user_id）。一旦变更必须同步唯一索引：
    // 新 openid 不得被其他 active 用户占用，且旧 openid 索引必须移除，避免悬挂。
    const openidChanged = user.openid !== old.openid;
    if (openidChanged) {
      const owner = this.store.usersByOpenid.get(user.openid);
      if (owner !== undefined && owner !== old) {
        throw new UniqueConstraintError("users", "uk_openid", { openid: user.openid });
      }
    }
    if (openidChanged) {
      this.store.usersByOpenid.delete(old.openid);
    }
    this.store.usersById.set(user.user_id, user);
    this.store.usersByOpenid.set(user.openid, user);
    this.logUndo(() => {
      if (this.store.usersById.get(user.user_id) !== user) {
        return;
      }
      if (this.store.usersByOpenid.get(user.openid) !== user) {
        return;
      }
      this.store.usersById.set(user.user_id, old);
      if (openidChanged) {
        this.store.usersByOpenid.delete(user.openid);
      }
      this.store.usersByOpenid.set(old.openid, old);
    });
  }

  // ---- teams ----

  private async findTeamById(teamId: string): Promise<Team | null> {
    return this.store.teamsById.get(teamId) ?? null;
  }

  private async insertTeam(team: Team): Promise<void> {
    assertSchemaVersion(team.schema_version);
    if (this.store.teamsById.has(team.team_id)) {
      throw new UniqueConstraintError("teams", "pk_team", { team_id: team.team_id });
    }
    this.store.teamsById.set(team.team_id, team);
    this.logUndo(() => {
      if (this.store.teamsById.get(team.team_id) === team) {
        this.store.teamsById.delete(team.team_id);
      }
    });
  }

  // ---- provider mappings ----

  private async findTeamProviderMappingByExternalId(
    provider: TeamProviderMapping["provider"],
    providerTeamId: string,
  ): Promise<TeamProviderMapping | null> {
    return (
      this.store.teamProviderMappingsByKey.get(
        providerMappingKey(provider, providerTeamId),
      ) ?? null
    );
  }

  private async findTeamProviderMappingsByTeamId(
    teamId: string,
  ): Promise<TeamProviderMapping[]> {
    return [...this.store.teamProviderMappingsByKey.values()].filter(
      (mapping) => mapping.team_id === teamId,
    );
  }

  private async insertTeamProviderMapping(mapping: TeamProviderMapping): Promise<void> {
    const key = providerMappingKey(mapping.provider, mapping.provider_team_id);
    if (this.store.teamProviderMappingsByKey.has(key)) {
      throw new UniqueConstraintError("team_provider_mappings", "uk_provider_team", {
        provider: mapping.provider,
        provider_team_id: mapping.provider_team_id,
      });
    }
    this.store.teamProviderMappingsByKey.set(key, mapping);
    this.logUndo(() => {
      if (this.store.teamProviderMappingsByKey.get(key) === mapping) {
        this.store.teamProviderMappingsByKey.delete(key);
      }
    });
  }

  private async findMatchProviderMappingByExternalId(
    provider: MatchProviderMapping["provider"],
    providerMatchId: string,
  ): Promise<MatchProviderMapping | null> {
    return (
      this.store.matchProviderMappingsByKey.get(
        providerMappingKey(provider, providerMatchId),
      ) ?? null
    );
  }

  private async findMatchProviderMappingsByMatchId(
    matchId: string,
  ): Promise<MatchProviderMapping[]> {
    return [...this.store.matchProviderMappingsByKey.values()].filter(
      (mapping) => mapping.match_id === matchId,
    );
  }

  private async insertMatchProviderMapping(mapping: MatchProviderMapping): Promise<void> {
    const key = providerMappingKey(mapping.provider, mapping.provider_match_id);
    if (this.store.matchProviderMappingsByKey.has(key)) {
      throw new UniqueConstraintError("match_provider_mappings", "uk_provider_match", {
        provider: mapping.provider,
        provider_match_id: mapping.provider_match_id,
      });
    }
    this.store.matchProviderMappingsByKey.set(key, mapping);
    this.logUndo(() => {
      if (this.store.matchProviderMappingsByKey.get(key) === mapping) {
        this.store.matchProviderMappingsByKey.delete(key);
      }
    });
  }

  // ---- provider_snapshots ----

  private async findProviderSnapshotsByEntity(
    entityType: ProviderSnapshot["entity_type"],
    entityId: string | null,
  ): Promise<ProviderSnapshot[]> {
    return [...this.store.providerSnapshotsById.values()]
      .filter((snapshot) => snapshot.entity_type === entityType && snapshot.entity_id === entityId)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  }

  private async insertProviderSnapshot(snapshot: ProviderSnapshot): Promise<void> {
    assertSchemaVersion(snapshot.schema_version);
    if (this.store.providerSnapshotsById.has(snapshot.snapshot_id)) {
      throw new UniqueConstraintError("provider_snapshots", "pk_snapshot", {
        snapshot_id: snapshot.snapshot_id,
      });
    }
    this.store.providerSnapshotsById.set(snapshot.snapshot_id, snapshot);
    this.logUndo(() => {
      if (this.store.providerSnapshotsById.get(snapshot.snapshot_id) === snapshot) {
        this.store.providerSnapshotsById.delete(snapshot.snapshot_id);
      }
    });
  }

  // ---- matches ----

  private async findMatchById(matchId: string): Promise<Match | null> {
    return this.store.matchesById.get(matchId) ?? null;
  }

  private async findMatchesBySeason(seasonId: string): Promise<Match[]> {
    return [...this.store.matchesById.values()].filter((match) => match.season_id === seasonId);
  }

  private async insertMatch(match: Match): Promise<void> {
    if (this.store.matchesById.has(match.match_id)) {
      throw new UniqueConstraintError("matches", "pk_match", { match_id: match.match_id });
    }
    assertMatchResultVersionInvariants(match);
    this.store.matchesById.set(match.match_id, match);
    this.logUndo(() => {
      if (this.store.matchesById.get(match.match_id) === match) {
        this.store.matchesById.delete(match.match_id);
      }
    });
  }

  private async updateMatch(match: Match): Promise<void> {
    const old = this.store.matchesById.get(match.match_id);
    if (old === undefined) {
      throw new DocumentNotFoundError("matches", match.match_id);
    }

    if (
      old.league_id !== match.league_id ||
      old.season_id !== match.season_id ||
      old.round_id !== match.round_id ||
      old.scoring_rule_version !== match.scoring_rule_version
    ) {
      throw internalError("match 的固定身份字段不可修改");
    }
    assertPredictionClosedAtImmutable(
      old.prediction_closed_at,
      match.prediction_closed_at,
    );
    assertPeriodAnchorImmutable(old.period_anchor_at, match.period_anchor_at);
    assertFinishDetectedImmutable(old.finish_detected_at, match.finish_detected_at);
    if (match.result_version < old.result_version) {
      throw internalError("match.result_version 不得回退");
    }
    if (match.settled_result_version < old.settled_result_version) {
      throw internalError("match.settled_result_version 不得回退");
    }
    assertMatchResultVersionInvariants(match);

    this.store.matchesById.set(match.match_id, match);
    this.logUndo(() => {
      if (this.store.matchesById.get(match.match_id) === match) {
        this.store.matchesById.set(match.match_id, old);
      }
    });
  }

  private async updateMatchSettlementStatus(
    matchId: string,
    settlementStatus: Match["settlement_status"],
    updatedAt: Date,
  ): Promise<void> {
    const old = this.store.matchesById.get(matchId);
    if (old === undefined) {
      throw new DocumentNotFoundError("matches", matchId);
    }
    const updated: Match = {
      ...old,
      settlement_status: settlementStatus,
      updated_at: updatedAt,
    };
    assertMatchResultVersionInvariants(updated);
    this.store.matchesById.set(matchId, updated);
    this.logUndo(() => {
      if (this.store.matchesById.get(matchId) === updated) {
        this.store.matchesById.set(matchId, old);
      }
    });
  }

  // ---- predictions ----

  private async findPredictionById(predictionId: string): Promise<Prediction | null> {
    for (const prediction of this.store.predictionsByUserMatch.values()) {
      if (prediction.prediction_id === predictionId) {
        return prediction;
      }
    }
    return null;
  }

  private async findPredictionByUserAndMatch(
    userId: string,
    matchId: string,
  ): Promise<Prediction | null> {
    return this.store.predictionsByUserMatch.get(userMatchKey(userId, matchId)) ?? null;
  }

  private async findPredictionByUserAndIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<Prediction | null> {
    return this.store.predictionsByUserKey.get(userKeyKey(userId, idempotencyKey)) ?? null;
  }

  private async findPredictionsByUser(userId: string): Promise<Prediction[]> {
    const result: Prediction[] = [];
    for (const prediction of this.store.predictionsByUserMatch.values()) {
      if (prediction.user_id === userId) {
        result.push(prediction);
      }
    }
    return result;
  }

  private async findPredictionsByMatch(matchId: string): Promise<Prediction[]> {
    const result: Prediction[] = [];
    for (const prediction of this.store.predictionsByUserMatch.values()) {
      if (prediction.match_id === matchId) {
        result.push(prediction);
      }
    }
    return result;
  }

  private async insertPrediction(prediction: Prediction): Promise<void> {
    assertPredictionInvariants(prediction);
    const um = userMatchKey(prediction.user_id, prediction.match_id);
    const uk = userKeyKey(prediction.user_id, prediction.idempotency_key);
    if (this.store.predictionsByUserMatch.has(um)) {
      throw new UniqueConstraintError("predictions", "uk_user_match", {
        user_id: prediction.user_id,
        match_id: prediction.match_id,
      });
    }
    if (this.store.predictionsByUserKey.has(uk)) {
      throw new UniqueConstraintError("predictions", "uk_user_idempotency", {
        user_id: prediction.user_id,
        idempotency_key: prediction.idempotency_key,
      });
    }
    this.store.predictionsByUserMatch.set(um, prediction);
    this.store.predictionsByUserKey.set(uk, prediction);
    this.logUndo(() => {
      if (this.store.predictionsByUserMatch.get(um) === prediction) {
        this.store.predictionsByUserMatch.delete(um);
      }
      if (this.store.predictionsByUserKey.get(uk) === prediction) {
        this.store.predictionsByUserKey.delete(uk);
      }
    });
  }

  private async updatePrediction(prediction: Prediction): Promise<void> {
    const key = userMatchKey(prediction.user_id, prediction.match_id);
    const old = this.store.predictionsByUserMatch.get(key);
    if (old === undefined) {
      throw new DocumentNotFoundError("predictions", prediction.prediction_id);
    }
    if (
      old.prediction_id !== prediction.prediction_id ||
      old.user_id !== prediction.user_id ||
      old.match_id !== prediction.match_id ||
      old.idempotency_key !== prediction.idempotency_key
    ) {
      throw new DocumentNotFoundError("predictions", prediction.prediction_id);
    }
    if (
      old.schema_version !== prediction.schema_version ||
      old.pred_home_score !== prediction.pred_home_score ||
      old.pred_away_score !== prediction.pred_away_score ||
      old.derived_result !== prediction.derived_result ||
      old.submitted_at.getTime() !== prediction.submitted_at.getTime() ||
      old.scoring_rule_version !== prediction.scoring_rule_version ||
      old.created_at.getTime() !== prediction.created_at.getTime()
    ) {
      throw internalError("prediction 提交事实字段不可修改");
    }
    if (prediction.applied_result_version < old.applied_result_version) {
      throw internalError("prediction.applied_result_version 不得回退");
    }
    assertPredictionInvariants(prediction);
    this.store.predictionsByUserMatch.set(key, prediction);
    this.store.predictionsByUserKey.set(
      userKeyKey(prediction.user_id, prediction.idempotency_key),
      prediction,
    );
    this.logUndo(() => {
      if (this.store.predictionsByUserMatch.get(key) === prediction) {
        this.store.predictionsByUserMatch.set(key, old);
      }
      const keyByIdempotency = userKeyKey(prediction.user_id, prediction.idempotency_key);
      if (this.store.predictionsByUserKey.get(keyByIdempotency) === prediction) {
        this.store.predictionsByUserKey.set(keyByIdempotency, old);
      }
    });
  }

  // ---- match_results (immutable ledger) ----

  private async findMatchResultByKey(
    matchId: string,
    resultVersion: number,
  ): Promise<MatchResult | null> {
    return this.store.matchResultsByKey.get(matchResultKey(matchId, resultVersion)) ?? null;
  }

  private async findLatestMatchResult(matchId: string): Promise<MatchResult | null> {
    let latest: MatchResult | null = null;
    for (const value of this.store.matchResultsByKey.values()) {
      if (value.match_id !== matchId) {
        continue;
      }
      if (latest === null || value.result_version > latest.result_version) {
        latest = value;
      }
    }
    return latest;
  }

  private async insertMatchResult(matchResult: MatchResult): Promise<void> {
    assertSchemaVersion(matchResult.schema_version);
    const key = matchResultKey(matchResult.match_id, matchResult.result_version);
    if (this.store.matchResultsByKey.has(key)) {
      throw new UniqueConstraintError("match_results", "uk_match_result_version", {
        match_id: matchResult.match_id,
        result_version: matchResult.result_version,
      });
    }
    // 账本不可覆盖：已有更高版本时拒绝写入旧版本，防止历史结果被篡改。
    const latest = await this.findLatestMatchResult(matchResult.match_id);
    if (latest !== null && matchResult.result_version < latest.result_version) {
      throw new StaleResultVersionError(
        matchResult.match_id,
        latest.result_version,
        matchResult.result_version,
      );
    }
    this.store.matchResultsByKey.set(key, matchResult);
    this.logUndo(() => {
      if (this.store.matchResultsByKey.get(key) === matchResult) {
        this.store.matchResultsByKey.delete(key);
      }
    });
  }

  // ---- settlements ----

  private async findSettlementById(settlementId: string): Promise<SettlementDoc | null> {
    return this.store.settlementsById.get(settlementId) ?? null;
  }

  private async findSettlementsByMatch(matchId: string): Promise<SettlementDoc[]> {
    return [...this.store.settlementsById.values()]
      .filter((settlement) => settlement.match_id === matchId)
      .sort(
        (a, b) =>
          a.result_version - b.result_version ||
          a.rule_version.localeCompare(b.rule_version) ||
          a.settlement_id.localeCompare(b.settlement_id),
      );
  }

  private async findSettlementByKey(
    matchId: string,
    resultVersion: number,
    ruleVersion: string,
  ): Promise<SettlementDoc | null> {
    return (
      this.store.settlementsByKey.get(settlementKey(matchId, resultVersion, ruleVersion)) ?? null
    );
  }

  private async findSettlementsByStatus(
    status: SettlementDocStatus,
  ): Promise<SettlementDoc[]> {
    const result: SettlementDoc[] = [];
    for (const settlement of this.store.settlementsById.values()) {
      if (settlement.status === status) {
        result.push(settlement);
      }
    }
    return result;
  }

  private async insertSettlement(settlement: SettlementDoc): Promise<void> {
    assertSettlementDocumentInvariant(settlement);
    if (this.store.settlementsById.has(settlement.settlement_id)) {
      throw new UniqueConstraintError("settlements", "pk_settlement", {
        settlement_id: settlement.settlement_id,
      });
    }
    const key = settlementKey(
      settlement.match_id,
      settlement.result_version,
      settlement.rule_version,
    );
    if (this.store.settlementsByKey.has(key)) {
      throw new UniqueConstraintError("settlements", "uk_match_version_rule", {
        match_id: settlement.match_id,
        result_version: settlement.result_version,
        rule_version: settlement.rule_version,
      });
    }
    this.store.settlementsById.set(settlement.settlement_id, settlement);
    this.store.settlementsByKey.set(key, settlement);
    this.logUndo(() => {
      if (this.store.settlementsById.get(settlement.settlement_id) === settlement) {
        this.store.settlementsById.delete(settlement.settlement_id);
      }
      if (this.store.settlementsByKey.get(key) === settlement) {
        this.store.settlementsByKey.delete(key);
      }
    });
  }

  private async updateSettlement(settlement: SettlementDoc): Promise<void> {
    assertSettlementDocumentInvariant(settlement);
    const old = this.store.settlementsById.get(settlement.settlement_id);
    if (old === undefined) {
      throw new DocumentNotFoundError("settlements", settlement.settlement_id);
    }
    // 唯一键字段变更时必须同步唯一索引：新键不得被其他 settlement 占用，旧键索引必须移除。
    const oldKey = settlementKey(old.match_id, old.result_version, old.rule_version);
    const newKey = settlementKey(
      settlement.match_id,
      settlement.result_version,
      settlement.rule_version,
    );
    const keyChanged = newKey !== oldKey;
    if (keyChanged) {
      const owner = this.store.settlementsByKey.get(newKey);
      if (owner !== undefined && owner !== old) {
        throw new UniqueConstraintError("settlements", "uk_match_version_rule", {
          match_id: settlement.match_id,
          result_version: settlement.result_version,
          rule_version: settlement.rule_version,
        });
      }
      this.store.settlementsByKey.delete(oldKey);
    }
    this.store.settlementsById.set(settlement.settlement_id, settlement);
    this.store.settlementsByKey.set(newKey, settlement);
    this.logUndo(() => {
      if (this.store.settlementsById.get(settlement.settlement_id) !== settlement) {
        return;
      }
      if (this.store.settlementsByKey.get(newKey) !== settlement) {
        return;
      }
      this.store.settlementsById.set(settlement.settlement_id, old);
      if (keyChanged) {
        this.store.settlementsByKey.delete(newKey);
      }
      this.store.settlementsByKey.set(oldKey, old);
    });
  }

  // ---- settlement_items ----

  private async findSettlementItemByKey(
    settlementId: string,
    predictionId: string,
  ): Promise<SettlementItem | null> {
    return (
      this.store.settlementItemsByKey.get(settlementItemKey(settlementId, predictionId)) ?? null
    );
  }

  private async findSettlementItemsBySettlement(
    settlementId: string,
  ): Promise<SettlementItem[]> {
    const result: SettlementItem[] = [];
    for (const item of this.store.settlementItemsByKey.values()) {
      if (item.settlement_id === settlementId) {
        result.push(item);
      }
    }
    return result;
  }

  private async findSettlementItemsBySettlementAndStatus(
    settlementId: string,
    status: SettlementItemStatus,
  ): Promise<SettlementItem[]> {
    const result: SettlementItem[] = [];
    for (const item of this.store.settlementItemsByKey.values()) {
      if (item.settlement_id === settlementId && item.status === status) {
        result.push(item);
      }
    }
    return result;
  }

  private async findSettlementItemsByStatus(
    status: SettlementItemStatus,
  ): Promise<SettlementItem[]> {
    const result: SettlementItem[] = [];
    for (const item of this.store.settlementItemsByKey.values()) {
      if (item.status === status) {
        result.push(item);
      }
    }
    return result;
  }

  private async insertSettlementItem(item: SettlementItem): Promise<void> {
    assertSettlementItemInvariant(item);
    const key = settlementItemKey(item.settlement_id, item.prediction_id);
    if (this.store.settlementItemsByKey.has(key)) {
      throw new UniqueConstraintError("settlement_items", "uk_settlement_prediction", {
        settlement_id: item.settlement_id,
        prediction_id: item.prediction_id,
      });
    }
    this.store.settlementItemsByKey.set(key, item);
    this.logUndo(() => {
      if (this.store.settlementItemsByKey.get(key) === item) {
        this.store.settlementItemsByKey.delete(key);
      }
    });
  }

  private async updateSettlementItem(item: SettlementItem): Promise<void> {
    assertSettlementItemInvariant(item);
    const key = settlementItemKey(item.settlement_id, item.prediction_id);
    const old = this.store.settlementItemsByKey.get(key);
    if (old === undefined) {
      throw new DocumentNotFoundError("settlement_items", item.prediction_id);
    }
    this.store.settlementItemsByKey.set(key, item);
    this.logUndo(() => {
      if (this.store.settlementItemsByKey.get(key) === item) {
        this.store.settlementItemsByKey.set(key, old);
      }
    });
  }

  // ---- unlocks ----

  private async findUnlocksByUser(userId: string): Promise<Unlock[]> {
    const result: Unlock[] = [];
    for (const unlock of this.store.unlocksById.values()) {
      if (unlock.user_id === userId) {
        result.push(unlock);
      }
    }
    return result;
  }

  private async findUnlockByUserAndCode(
    userId: string,
    unlockCode: string,
  ): Promise<Unlock | null> {
    return this.store.unlocksByUserCode.get(unlockUserCodeKey(userId, unlockCode)) ?? null;
  }

  private async insertUnlock(unlock: Unlock): Promise<void> {
    assertSchemaVersion(unlock.schema_version);
    if (this.store.unlocksById.has(unlock.unlock_id)) {
      throw new UniqueConstraintError("unlocks", "pk_unlock", {
        unlock_id: unlock.unlock_id,
      });
    }
    const key = unlockUserCodeKey(unlock.user_id, unlock.unlock_code);
    if (this.store.unlocksByUserCode.has(key)) {
      throw new UniqueConstraintError("unlocks", "uk_user_unlock_code", {
        user_id: unlock.user_id,
        unlock_code: unlock.unlock_code,
      });
    }
    this.store.unlocksById.set(unlock.unlock_id, unlock);
    this.store.unlocksByUserCode.set(key, unlock);
    this.logUndo(() => {
      if (this.store.unlocksById.get(unlock.unlock_id) === unlock) {
        this.store.unlocksById.delete(unlock.unlock_id);
      }
      if (this.store.unlocksByUserCode.get(key) === unlock) {
        this.store.unlocksByUserCode.delete(key);
      }
    });
  }

  // ---- user_season_stats ----

  private async findUserSeasonStatsByKey(
    userId: string,
    seasonId: string,
  ): Promise<UserSeasonStats | null> {
    return this.store.userSeasonStatsByKey.get(userSeasonStatsKey(userId, seasonId)) ?? null;
  }

  private async findUserSeasonStats(userId: string): Promise<UserSeasonStats[]> {
    return [...this.store.userSeasonStatsByKey.values()].filter(
      (stats) => stats.user_id === userId,
    );
  }

  private async insertUserSeasonStats(stats: UserSeasonStats): Promise<void> {
    assertSeasonStatsInvariants(stats);
    const key = userSeasonStatsKey(stats.user_id, stats.season_id);
    if (this.store.userSeasonStatsByKey.has(key)) {
      throw new UniqueConstraintError("user_season_stats", "uk_user_season", {
        user_id: stats.user_id,
        season_id: stats.season_id,
      });
    }
    this.store.userSeasonStatsByKey.set(key, stats);
    this.logUndo(() => {
      if (this.store.userSeasonStatsByKey.get(key) === stats) {
        this.store.userSeasonStatsByKey.delete(key);
      }
    });
  }

  private async updateUserSeasonStats(stats: UserSeasonStats): Promise<void> {
    assertSeasonStatsInvariants(stats);
    const key = userSeasonStatsKey(stats.user_id, stats.season_id);
    const old = this.store.userSeasonStatsByKey.get(key);
    if (old === undefined) {
      throw new DocumentNotFoundError("user_season_stats", key);
    }
    this.store.userSeasonStatsByKey.set(key, stats);
    this.logUndo(() => {
      if (this.store.userSeasonStatsByKey.get(key) === stats) {
        this.store.userSeasonStatsByKey.set(key, old);
      }
    });
  }

  // ---- rankings ----

  private async findRankingByKey(
    periodType: RankingEntry["period_type"],
    periodKey: string,
    userId: string,
  ): Promise<RankingEntry | null> {
    return this.store.rankingsByKey.get(rankingKey(periodType, periodKey, userId)) ?? null;
  }

  private async findRankingsByPeriod(
    periodType: RankingEntry["period_type"],
    periodKey: string,
  ): Promise<RankingEntry[]> {
    const result: RankingEntry[] = [];
    for (const entry of this.store.rankingsByKey.values()) {
      if (entry.period_type === periodType && entry.period_key === periodKey) {
        result.push(entry);
      }
    }
    return result;
  }

  private async findAllRankings(): Promise<RankingEntry[]> {
    return [...this.store.rankingsByKey.values()];
  }

  private async insertRanking(entry: RankingEntry): Promise<void> {
    assertRankingInvariants(entry);
    const key = rankingKey(entry.period_type, entry.period_key, entry.user_id);
    if (this.store.rankingsByKey.has(key)) {
      throw new UniqueConstraintError("rankings", "uk_period_user", {
        period_type: entry.period_type,
        period_key: entry.period_key,
        user_id: entry.user_id,
      });
    }
    this.store.rankingsByKey.set(key, entry);
    this.logUndo(() => {
      if (this.store.rankingsByKey.get(key) === entry) {
        this.store.rankingsByKey.delete(key);
      }
    });
  }

  private async updateRanking(entry: RankingEntry): Promise<void> {
    assertRankingInvariants(entry);
    const key = rankingKey(entry.period_type, entry.period_key, entry.user_id);
    const old = this.store.rankingsByKey.get(key);
    if (old === undefined) {
      throw new DocumentNotFoundError("rankings", key);
    }
    this.store.rankingsByKey.set(key, entry);
    this.logUndo(() => {
      if (this.store.rankingsByKey.get(key) === entry) {
        this.store.rankingsByKey.set(key, old);
      }
    });
  }

  // ---- level_history ----

  private async findLevelHistoryByUser(userId: string): Promise<LevelHistoryEntry[]> {
    const result: LevelHistoryEntry[] = [];
    for (const entry of this.store.levelHistoryById.values()) {
      if (entry.user_id === userId) {
        result.push(entry);
      }
    }
    return result;
  }

  private async insertLevelHistory(entry: LevelHistoryEntry): Promise<void> {
    assertSchemaVersion(entry.schema_version);
    if (this.store.levelHistoryById.has(entry.level_history_id)) {
      throw new UniqueConstraintError("level_history", "pk_level_history", {
        level_history_id: entry.level_history_id,
      });
    }
    this.store.levelHistoryById.set(entry.level_history_id, entry);
    this.logUndo(() => {
      if (this.store.levelHistoryById.get(entry.level_history_id) === entry) {
        this.store.levelHistoryById.delete(entry.level_history_id);
      }
    });
  }

  // ---- admin_audit_logs ----

  private async findAdminAuditLogsByEntity(
    entityType: string,
    entityId: string,
  ): Promise<AdminAuditLog[]> {
    return [...this.store.adminAuditLogsById.values()].filter(
      (log) => log.entity_type === entityType && log.entity_id === entityId,
    );
  }

  private async insertAdminAuditLog(log: AdminAuditLog): Promise<void> {
    assertSchemaVersion(log.schema_version);
    if (this.store.adminAuditLogsById.has(log.audit_id)) {
      throw new UniqueConstraintError("admin_audit_logs", "pk_audit", {
        audit_id: log.audit_id,
      });
    }
    this.store.adminAuditLogsById.set(log.audit_id, log);
    this.logUndo(() => {
      if (this.store.adminAuditLogsById.get(log.audit_id) === log) {
        this.store.adminAuditLogsById.delete(log.audit_id);
      }
    });
  }

  // ---- anomalies ----

  private async findAnomalyByKey(anomalyKey: string): Promise<Anomaly | null> {
    return this.store.anomaliesByKey.get(anomalyKey) ?? null;
  }

  private async findOpenBlockingAnomaliesByMatch(matchId: string): Promise<Anomaly[]> {
    return [...this.store.anomaliesById.values()].filter(
      (anomaly) =>
        anomaly.match_id === matchId &&
        anomaly.status === "open" &&
        anomaly.blocking,
    );
  }

  private async findAnomaliesPage(query: AdminAnomalyPageQuery): Promise<AdminAnomalyPage> {
    const filtered = [...this.store.anomaliesById.values()]
      .filter((anomaly) => query.status === null || anomaly.status === query.status)
      .filter((anomaly) => query.blocking === null || anomaly.blocking === query.blocking)
      .filter((anomaly) => {
        if (query.after === null) {
          return true;
        }
        const lastSeenAt = anomaly.last_seen_at.getTime();
        const cursorLastSeenAt = query.after.last_seen_at.getTime();
        return (
          lastSeenAt < cursorLastSeenAt ||
          (lastSeenAt === cursorLastSeenAt && anomaly.anomaly_id < query.after.anomaly_id)
        );
      })
      .sort((a, b) => {
        const byLastSeen = b.last_seen_at.getTime() - a.last_seen_at.getTime();
        if (byLastSeen !== 0) {
          return byLastSeen;
        }
        if (a.anomaly_id === b.anomaly_id) {
          return 0;
        }
        return a.anomaly_id < b.anomaly_id ? 1 : -1;
      });

    const pageItems = filtered.slice(0, query.limit);
    return {
      items: pageItems,
      has_more: filtered.length > query.limit,
    };
  }

  private async insertAnomaly(anomaly: Anomaly): Promise<void> {
    assertSchemaVersion(anomaly.schema_version);
    if (this.store.anomaliesById.has(anomaly.anomaly_id)) {
      throw new UniqueConstraintError("anomalies", "pk_anomaly", {
        anomaly_id: anomaly.anomaly_id,
      });
    }
    if (this.store.anomaliesByKey.has(anomaly.anomaly_key)) {
      throw new UniqueConstraintError("anomalies", "uk_anomaly_key", {
        anomaly_key: anomaly.anomaly_key,
      });
    }
    this.store.anomaliesById.set(anomaly.anomaly_id, anomaly);
    this.store.anomaliesByKey.set(anomaly.anomaly_key, anomaly);
    this.logUndo(() => {
      if (this.store.anomaliesById.get(anomaly.anomaly_id) === anomaly) {
        this.store.anomaliesById.delete(anomaly.anomaly_id);
      }
      if (this.store.anomaliesByKey.get(anomaly.anomaly_key) === anomaly) {
        this.store.anomaliesByKey.delete(anomaly.anomaly_key);
      }
    });
  }

  private async updateAnomaly(anomaly: Anomaly): Promise<void> {
    assertSchemaVersion(anomaly.schema_version);
    const old = this.store.anomaliesById.get(anomaly.anomaly_id);
    if (old === undefined) {
      throw new DocumentNotFoundError("anomalies", anomaly.anomaly_id);
    }
    const keyChanged = old.anomaly_key !== anomaly.anomaly_key;
    if (keyChanged) {
      const owner = this.store.anomaliesByKey.get(anomaly.anomaly_key);
      if (owner !== undefined && owner !== old) {
        throw new UniqueConstraintError("anomalies", "uk_anomaly_key", {
          anomaly_key: anomaly.anomaly_key,
        });
      }
      this.store.anomaliesByKey.delete(old.anomaly_key);
    }
    this.store.anomaliesById.set(anomaly.anomaly_id, anomaly);
    this.store.anomaliesByKey.set(anomaly.anomaly_key, anomaly);
    this.logUndo(() => {
      if (this.store.anomaliesById.get(anomaly.anomaly_id) !== anomaly) {
        return;
      }
      this.store.anomaliesById.set(anomaly.anomaly_id, old);
      this.store.anomaliesByKey.delete(anomaly.anomaly_key);
      this.store.anomaliesByKey.set(old.anomaly_key, old);
    });
  }

  // ---- sync_logs ----

  private async insertSyncLog(log: SyncLog): Promise<void> {
    assertSchemaVersion(log.schema_version);
    if (this.store.syncLogsById.has(log.sync_job_id)) {
      throw new UniqueConstraintError("sync_logs", "pk_sync_job", {
        sync_job_id: log.sync_job_id,
      });
    }
    this.store.syncLogsById.set(log.sync_job_id, log);
    this.logUndo(() => {
      if (this.store.syncLogsById.get(log.sync_job_id) === log) {
        this.store.syncLogsById.delete(log.sync_job_id);
      }
    });
  }

  private async updateSyncLog(log: SyncLog): Promise<void> {
    assertSchemaVersion(log.schema_version);
    const old = this.store.syncLogsById.get(log.sync_job_id);
    if (old === undefined) {
      throw new DocumentNotFoundError("sync_logs", log.sync_job_id);
    }
    this.store.syncLogsById.set(log.sync_job_id, log);
    this.logUndo(() => {
      if (this.store.syncLogsById.get(log.sync_job_id) === log) {
        this.store.syncLogsById.set(log.sync_job_id, old);
      }
    });
  }

  // ---- job locks ----

  private async acquireLock(
    lockKey: string,
    ownerId: string,
    leaseUntil: Date,
  ): Promise<boolean> {
    const now = Date.now();
    const existing = this.store.jobLocks.get(lockKey);
    if (existing !== undefined && existing.lease_until.getTime() > now) {
      return false;
    }
    this.store.jobLocks.set(lockKey, {
      schema_version: SCHEMA_VERSION,
      lock_key: lockKey,
      owner_id: ownerId,
      lease_until: leaseUntil,
      updated_at: new Date(),
    });
    this.logUndo(() => this.store.jobLocks.delete(lockKey));
    return true;
  }

  private async renewLock(
    lockKey: string,
    ownerId: string,
    leaseUntil: Date,
  ): Promise<boolean> {
    const now = Date.now();
    const existing = this.store.jobLocks.get(lockKey);
    if (
      existing === undefined ||
      existing.owner_id !== ownerId ||
      existing.lease_until.getTime() <= now
    ) {
      return false;
    }
    this.store.jobLocks.set(lockKey, {
      ...existing,
      lease_until: leaseUntil,
      updated_at: new Date(),
    });
    this.logUndo(() => this.store.jobLocks.set(lockKey, existing));
    return true;
  }

  private async releaseLock(lockKey: string, ownerId: string): Promise<void> {
    const existing = this.store.jobLocks.get(lockKey);
    if (existing !== undefined && existing.owner_id === ownerId) {
      this.store.jobLocks.delete(lockKey);
      this.logUndo(() => this.store.jobLocks.set(lockKey, existing));
    }
  }

  // ---- transaction ----

  async withTransaction<T>(fn: (tx: UnitOfWork) => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    const tx = new InMemoryRepository();
    tx.store = this.store;
    tx.undoLog = [];
    try {
      const result = await fn(tx);
      return result;
    } catch (err) {
      // 回滚必须按写入的逆序执行（LIFO）：同一文档被多次 update/insert 时，
      // 只有从最后一次写入往回撤销才能恢复正确状态，否则会留下悬挂索引/过期数据。
      for (const undo of [...tx.undoLog].reverse()) {
        undo();
      }
      throw err;
    } finally {
      release();
    }
  }
}
