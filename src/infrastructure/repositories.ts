/**
 * 基础设施仓储层（阶段 2）。
 *
 * 定义 repository ports、事务/锁抽象，并提供内存适配器（InMemoryRepository）作为
 * 测试与本地运行实现。接口语义对齐规范 21/22 节：
 * - users.openid 唯一（uk_openid）
 * - predictions UNIQUE(user_id, canonical_match_id) 与 UNIQUE(user_id, match_id)（uk_user_match）及
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
  MatchStatus,
  SCHEMA_VERSION,
  SettlementItemStatus,
  SettlementStatus,
  SettlementDocStatus,
  type SyncJobType,
} from "../domain/enums.js";
import {
  selectSettlementFallbackPage,
  selectSettlementTodos,
  type SettlementTodoQuery,
} from "./settlement-todo-query.js";
import {
  selectActiveWindow,
  type ActiveWindowQuery,
} from "./active-window-query.js";
import {
  assertMatchResultVersionInvariants,
  assertMatchSupersessionWrite,
  assertFinishDetectedImmutable,
  assertPeriodAnchorImmutable,
  assertPredictionInvariants,
  assertPredictionClosedAtImmutable,
  assertBoardSnapshotInvariants,
  assertGroupInvariants,
  assertGroupMemberInvariants,
  assertLevelHistoryInvariants,
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
  BoardSnapshot,
  DeletedOpenidMapping,
  Group,
  GroupMember,
  JobLock,
  LevelHistoryEntry,
  LeagueSeason,
  Match,
  MatchProviderMapping,
  MatchResult,
  Prediction,
  ProviderSnapshot,
  ProviderReconcileTodo,
  RankingEntry,
  SettlementDoc,
  SettlementItem,
  SeasonTeam,
  SyncLog,
  Team,
  TeamProviderMapping,
  Unlock,
  User,
  UserSeasonStats,
} from "../domain/types.js";
import type { AdminAuditAction, AdminAuditEntityType, AnomalyStatus } from "../domain/enums.js";
import type { AuthSessionRevoker } from "./cloudbase-db.js";

export type { SettlementTodoQuery, ActiveWindowQuery, AuthSessionRevoker };

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

/** 丢掉 undefined / _id，并拒绝改写主键。null 是合法局部更新值。 */
export function repositoryPatchPayload(
  collection: string,
  fields: object,
  identity: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || key === "_id") continue;
    if (Object.prototype.hasOwnProperty.call(identity, key)) {
      if (value !== identity[key]) throw internalError(`${collection} 主键不可通过 patch 修改`);
      continue;
    }
    if (key === "schema_version" && value !== SCHEMA_VERSION) {
      throw internalError("schema_version 必须为 1");
    }
    payload[key] = value;
  }
  return payload;
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
  findByIds?(userIds: readonly string[]): Promise<Map<string, User>>;
  findAll(): Promise<User[]>;
  insert(user: User): Promise<void>;
  update(user: User): Promise<void>;
  /**
   * 事务内按 user_id 行锁读取（SELECT ... FOR UPDATE）。事务外必须拒绝；缺失返回 null。
   * 多文档加锁顺序：users → user_season_stats → rankings → matches → groups，同集合再按 id 升序。
   */
  findByIdForUpdate?(userId: string): Promise<User | null>;
  /** 只合并传入字段，不读取后整文档覆写。缺失抛 DocumentNotFoundError。 */
  patchFields?(userId: string, fields: Partial<User>): Promise<void>;
}

/**
 * 注销身份映射仓储（D-P1 方案 B，§4.5.1）。
 * original_openid 唯一；upsert 语义 = 同 original_openid 覆盖为最新 deleted_user_id。
 */
export interface DeletedOpenidMappingRepository {
  findByOriginalOpenid(originalOpenid: string): Promise<DeletedOpenidMapping | null>;
  findByDeletedUserId(userId: string): Promise<DeletedOpenidMapping | null>;
  upsert(mapping: DeletedOpenidMapping): Promise<void>;
}

/** 公开比赛查询与同步共用的球队仓储。 */
export interface TeamRepository {
  findById(teamId: string): Promise<Team | null>;
  findByIds?(teamIds: readonly string[]): Promise<Map<string, Team>>;
  findAll?(): Promise<Team[]>;
  insert(team: Team): Promise<void>;
  update?(team: Team): Promise<void>;
  /** 只合并传入字段，不整文档覆写。缺失抛 DocumentNotFoundError。 */
  patchFields?(teamId: string, fields: Partial<Team>): Promise<void>;
}

/** Provider 外部球队 ID 映射；唯一约束由 (provider, provider_team_id) 提供。 */
export interface TeamProviderMappingRepository {
  findByProviderAndExternalId(
    provider: TeamProviderMapping["provider"],
    providerTeamId: string,
  ): Promise<TeamProviderMapping | null>;
  /** RP11：按外部 ID 批量取映射，避免逐场查询。key 为 provider_team_id。 */
  findByProviderAndExternalIds(
    provider: TeamProviderMapping["provider"],
    providerTeamIds: readonly string[],
  ): Promise<Map<string, TeamProviderMapping>>;
  findByTeamId(teamId: string): Promise<TeamProviderMapping[]>;
  findAll?(): Promise<TeamProviderMapping[]>;
  insert(mapping: TeamProviderMapping): Promise<void>;
  update?(mapping: TeamProviderMapping): Promise<void>;
}

/** Provider 外部比赛 ID 映射；唯一约束由 (provider, provider_match_id) 提供。 */
export interface MatchProviderMappingRepository {
  findByProviderAndExternalId(
    provider: MatchProviderMapping["provider"],
    providerMatchId: string,
  ): Promise<MatchProviderMapping | null>;
  /** RP11：按外部 ID 批量取映射，避免逐场查询。key 为 provider_match_id。 */
  findByProviderAndExternalIds(
    provider: MatchProviderMapping["provider"],
    providerMatchIds: readonly string[],
  ): Promise<Map<string, MatchProviderMapping>>;
  findByMatchId(matchId: string): Promise<MatchProviderMapping[]>;
  insert(mapping: MatchProviderMapping): Promise<void>;
}

/**
 * 计入"最近成功 Provider 同步"的快照 event_type（33.1 判定 last_successful_sync_at）；
 * 排除 provider_error / provider_conflict / admin_conflict。
 */
const PROVIDER_SYNC_SUCCESS_EVENT_TYPES: ReadonlySet<ProviderSnapshot["event_type"]> = new Set([
  "discovered",
  "status_changed",
  "kickoff_changed",
  "result_observed",
  "result_changed",
]);

/** Provider 关键快照只追加，按实体读取供同步异常与审计排查使用。 */
export interface ProviderSnapshotRepository {
  findByEntity(
    entityType: ProviderSnapshot["entity_type"],
    entityId: string | null,
  ): Promise<ProviderSnapshot[]>;
  /**
   * 返回该实体最近一次成功类 Provider 同步快照（按 created_at 倒序取第一个成功 event_type），
   * 供 LIVE_SYNC_STALE 决策作为 last_successful_sync_at；无成功记录时返回 null。
   */
  findLatestSuccessByEntity(
    entityType: ProviderSnapshot["entity_type"],
    entityId: string | null,
  ): Promise<ProviderSnapshot | null>;
  insert(snapshot: ProviderSnapshot): Promise<void>;
}

/** 管理员身份查询与部署 provision 写入；不提供业务创建/删除 API。 */
export interface AdminRepository {
  findByOpenid(openid: string): Promise<Admin | null>;
  insert(admin: Admin): Promise<void>;
  update(admin: Admin): Promise<void>;
}

export interface AdminAuditLogPageQuery {
  action: AdminAuditAction | null;
  entity_type: AdminAuditEntityType | null;
  entity_id: string | null;
  after: {
    created_at: Date;
    audit_id: string;
  } | null;
  limit: number;
}

export interface AdminAuditLogPage {
  items: AdminAuditLog[];
  has_more: boolean;
}

/** 管理员审计日志只追加，不提供 update/delete。 */
export interface AdminAuditLogRepository {
  findByEntity(entityType: string, entityId: string): Promise<AdminAuditLog[]>;
  findPage?(query: AdminAuditLogPageQuery): Promise<AdminAuditLogPage>;
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
  findById?(anomalyId: string): Promise<Anomaly | null>;
  findByIdForUpdate?(anomalyId: string): Promise<Anomaly | null>;
  findByKey(anomalyKey: string): Promise<Anomaly | null>;
  findOpenBlockingByMatch(matchId: string): Promise<Anomaly[]>;
  findOpenByMatch?(matchId: string): Promise<Anomaly[]>;
  findPage(query: AdminAnomalyPageQuery): Promise<AdminAnomalyPage>;
  insert(anomaly: Anomaly): Promise<void>;
  update(anomaly: Anomaly): Promise<void>;
}

/** 同步任务日志只追加创建、允许更新运行结果，不承载业务事实。 */
export interface SyncLogRepository {
  insert(log: SyncLog): Promise<void>;
  update(log: SyncLog): Promise<void>;
  /** RP07：取某 job_type 最近一条日志。实现可选，调用方必须处理 undefined。 */
  findLatestByJobType?(
    jobType: SyncJobType,
    options?: { excludeSyncJobId?: string; leagueId?: string },
  ): Promise<SyncLog | null>;
}

export interface LeagueSeasonCatalogEntry {
  league_id: string;
  season_id: string;
  round_ids: string[];
}

export function aggregateLeagueSeasonCatalog(
  rows: Iterable<{ league_id: string; season_id: string; round_id: string }>,
): LeagueSeasonCatalogEntry[] {
  const grouped = new Map<string, { league_id: string; season_id: string; rounds: Set<string> }>();
  for (const row of rows) {
    const key = `${row.league_id}\u0000${row.season_id}`;
    const current = grouped.get(key);
    if (current === undefined) {
      grouped.set(key, { league_id: row.league_id, season_id: row.season_id, rounds: new Set([row.round_id]) });
    } else {
      current.rounds.add(row.round_id);
    }
  }
  return [...grouped.values()]
    .map((item) => ({
      league_id: item.league_id,
      season_id: item.season_id,
      round_ids: [...item.rounds].sort((left, right) => left.localeCompare(right)),
    }))
      .sort((left, right) => left.league_id.localeCompare(right.league_id) || right.season_id.localeCompare(left.season_id));
}

export function selectPredictionHistoryPage(
  predictions: readonly Prediction[],
  matchesById: ReadonlyMap<string, Match>,
  params: {
    league_id: string | null;
    season_id: string | null;
    cursor: { submitted_at: Date; prediction_id: string } | null;
    limit: number;
  },
): Prediction[] {
  const selected: Prediction[] = [];
  for (const prediction of predictions) {
    const effective = resolveEffectiveMatchForHistory(prediction.match_id, matchesById);
    if (effective === null) continue;
    if (params.league_id !== null && effective.league_id !== params.league_id) continue;
    if (params.season_id !== null && effective.season_id !== params.season_id) continue;
    if (params.cursor !== null) {
      const submittedAt = prediction.submitted_at.getTime();
      const cursorAt = params.cursor.submitted_at.getTime();
      if (submittedAt > cursorAt) continue;
      if (submittedAt === cursorAt && prediction.prediction_id >= params.cursor.prediction_id) continue;
    }
    selected.push(prediction);
  }
  selected.sort((left, right) => {
    const byTime = right.submitted_at.getTime() - left.submitted_at.getTime();
    if (byTime !== 0) return byTime;
    if (left.prediction_id === right.prediction_id) return 0;
    return left.prediction_id < right.prediction_id ? 1 : -1;
  });
  return selected.slice(0, params.limit);
}

function resolveEffectiveMatchForHistory(
  matchId: string,
  matchesById: ReadonlyMap<string, Match>,
): Match | null {
  let match = matchesById.get(matchId);
  if (match === undefined) return null;
  const visited = new Set<string>();
  while (match.superseded_by != null) {
    if (visited.has(match.match_id)) return null;
    visited.add(match.match_id);
    const next = matchesById.get(match.superseded_by);
    if (next === undefined) return null;
    match = next;
  }
  return match;
}

export interface MatchRepository {
  findById(matchId: string): Promise<Match | null>;
  findByIds?(matchIds: readonly string[]): Promise<Map<string, Match>>;
  findIdsByCanonicalMatchId(canonicalMatchId: string): Promise<string[]>;
  findBySeason(seasonId: string): Promise<Match[]>;
  findBySeasonInWindow?(seasonId: string, from: Date, to: Date): Promise<Match[]>;
  /** 按实际 period_anchor_at 半开区间 [startAt, endAt) 选赛，不依赖赛季候选集。 */
  findByPeriodAnchorWindow?(startAt: Date, endAt: Date): Promise<Match[]>;
  findByLeague(leagueId: string): Promise<Match[]>;
  findByLeagueSeason(leagueId: string, seasonId: string): Promise<Match[]>;
  findFinishedSettledOnDay(day: string): Promise<Match[]>;
  findByLeagueSeasonRound(
    leagueId: string,
    seasonId: string,
    roundId: string,
  ): Promise<Match[]>;
  findLeagueSeasonCatalog(leagueId?: string): Promise<LeagueSeasonCatalogEntry[]>;
  /** 当前 match_status = live 的比赛（33.1 job 级 live 巡检用）。 */
  findLive(): Promise<Match[]>;
  /** RP05：按数据库条件取「待结算/待更正/待恢复」比赛，不再全量遍历赛季。 */
  findSettlementTodos(query: SettlementTodoQuery): Promise<Match[]>;
  /** RP05 兜底：finished 且非 voided 的分页页，用于漏标扫描。 */
  findSettlementFallbackPage(query: SettlementTodoQuery): Promise<Match[]>;
  /** RP09：按比赛窗口在数据库侧筛选候选，避免整赛季读入内存。 */
  findActiveWindow(query: ActiveWindowQuery): Promise<Match[]>;
  insert(match: Match): Promise<void>;
  update(match: Match): Promise<void>;
  /** 事务内按 match_id 行锁读取。事务外必须拒绝；缺失返回 null。 */
  findByIdForUpdate?(matchId: string): Promise<Match | null>;
  /** 只合并传入字段，不整文档覆写 settlement 等其它列。缺失抛 DocumentNotFoundError。 */
  patchFields?(matchId: string, fields: Partial<Match>): Promise<void>;
  updateSettlementProgress(matchId: string, resultVersion: number, settledAt: Date): Promise<void>;
  /** 只更新结算状态与更新时间，保留并发写入的其它 match 字段。 */
  updateSettlementStatus(
    matchId: string,
    settlementStatus: Match["settlement_status"],
    updatedAt: Date,
  ): Promise<void>;
}

export interface PredictionHistoryPageResult {
  predictions: Prediction[];
  exhausted: boolean;
  resume_cursor: { submitted_at: Date; prediction_id: string } | null;
}

export interface PredictionRepository {
  findById(predictionId: string): Promise<Prediction | null>;
  findByIds?(predictionIds: readonly string[]): Promise<Map<string, Prediction>>;
  findByUserAndMatch(userId: string, matchId: string): Promise<Prediction | null>;
  findByUserAndMatchIds(userId: string, matchIds: readonly string[]): Promise<Prediction[]>;
  findByUserAndCanonicalMatchIds(userId: string, canonicalMatchIds: readonly string[]): Promise<Prediction[]>;
  findByCanonicalMatchIds?(canonicalMatchIds: readonly string[]): Promise<Prediction[]>;
  findByUserAndCanonicalMatch(userId: string, canonicalMatchId: string): Promise<Prediction | null>;
  findByUserAndIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<Prediction | null>;
  findByUser(userId: string): Promise<Prediction[]>;
  /**
   * 按用户、可选联赛/赛季过滤历史预测。联赛/赛季取该预测对应「有效比赛」的值：
   * 沿 superseded_by 链追到最新一场，或按 canonical 身份匹配未作废比赛。
   * 排序：submitted_at DESC, prediction_id DESC（稳定）。只返回 limit 条，不再额外全量读取。
   */
  findHistoryPage(params: {
    user_id: string;
    league_id: string | null;
    season_id: string | null;
    cursor: { submitted_at: Date; prediction_id: string } | null;
    limit: number;
  }): Promise<Prediction[]>;
  /** 支持扫描触限续扫的实现返回耗尽状态与严格推进的续扫游标。 */
  findHistoryPageWithScanResume?(params: {
    user_id: string;
    league_id: string | null;
    season_id: string | null;
    cursor: { submitted_at: Date; prediction_id: string } | null;
    limit: number;
  }): Promise<PredictionHistoryPageResult>;
  findByMatch(matchId: string): Promise<Prediction[]>;
  findByCanonicalMatch(canonicalMatchId: string): Promise<Prediction[]>;
  countByMatchGroupedByResult(matchId: string): Promise<{
    HOME: number;
    DRAW: number;
    AWAY: number;
  }>;
  insert(prediction: Prediction): Promise<void>;
  update(prediction: Prediction): Promise<void>;
}

export interface JobLockRepository {
  /** 原子 compare-and-set：仅在空闲或 lease 过期时获得锁。 */
  acquire(lockKey: string, ownerId: string, leaseUntil: Date): Promise<boolean>;
  isHeld(lockKey: string, asOf: Date): Promise<boolean>;
  /** 是否仍由该 owner 持有且未过期（围栏用：写入前确认自己还持有锁）。 */
  isHeldBy(lockKey: string, ownerId: string, asOf: Date): Promise<boolean>;
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
  findByIds?(settlementIds: readonly string[]): Promise<Map<string, SettlementDoc>>;
  /** 按比赛读取完整 settlement 版本序列，映射 settlements 的 match_id/result_version 索引。 */
  findByMatch(matchId: string): Promise<SettlementDoc[]>;
  findByMatchIds?(matchIds: readonly string[]): Promise<SettlementDoc[]>;
  findByMatchAndVersionAndRule(
    matchId: string,
    resultVersion: number,
    ruleVersion: string,
  ): Promise<SettlementDoc | null>;
  findByStatus(status: SettlementDocStatus): Promise<SettlementDoc[]>;
  /** 已结算改判单中等级重评未完成的候选；缺少 level_reeval_status 的 legacy 单据也视为未完成。 */
  findSettledCorrectionsPendingReeval?(): Promise<SettlementDoc[]>;
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
  /** 批量读取多张 settlement 下指定状态的 items。 */
  findBySettlementIdsAndStatus?(
    settlementIds: readonly string[],
    status: SettlementItemStatus,
  ): Promise<SettlementItem[]>;
  /** 指定用户在指定状态下的 items，避免全表 findByStatus。 */
  findByUserAndStatus?(userId: string, status: SettlementItemStatus): Promise<SettlementItem[]>;
  /** 全局按状态查询（pending / applied / failed）。 */
  findByStatus(status: SettlementItemStatus): Promise<SettlementItem[]>;
  /** 用户在指定时刻前 applied 的账本。 */
  findAppliedByUserBefore(userId: string, asOf: Date): Promise<SettlementItem[]>;
  insert(item: SettlementItem): Promise<void>;
  update(item: SettlementItem): Promise<void>;
}

/** 解锁记录：immutable，按用户读取并由唯一索引保证幂等。 */
export interface UnlockRepository {
  findByUser(userId: string): Promise<Unlock[]>;
  findByUserAndCode(userId: string, unlockCode: string): Promise<Unlock | null>;
  insert(unlock: Unlock): Promise<void>;
}

/** 赛季统计缓存：按 user_id + level_season_id 唯一。 */
export interface UserSeasonStatsRepository {
  findByUserAndSeason(userId: string, levelSeasonId: string): Promise<UserSeasonStats | null>;
  findByUser(userId: string): Promise<UserSeasonStats[]>;
  findByUserIds?(userIds: readonly string[]): Promise<Map<string, UserSeasonStats[]>>;
  findByLevelSeason(levelSeasonId: string): Promise<UserSeasonStats[]>;
  insert(stats: UserSeasonStats): Promise<void>;
  update(stats: UserSeasonStats): Promise<void>;
  /** 事务内按 user_id + level_season_id 行锁读取。事务外必须拒绝；缺失返回 null。 */
  findByUserAndSeasonForUpdate?(userId: string, levelSeasonId: string): Promise<UserSeasonStats | null>;
  /** 只合并传入字段。缺失抛 DocumentNotFoundError。 */
  patchFields?(userId: string, levelSeasonId: string, fields: Partial<UserSeasonStats>): Promise<void>;
}

export interface BoardSnapshotRepository {
  findLatestByBoard(
    board: BoardSnapshot["board"],
  ): Promise<BoardSnapshot[]>;
  findLatestBySeason(levelSeasonId: string): Promise<BoardSnapshot[]>;
  findFinalBySeason(levelSeasonId: string): Promise<BoardSnapshot[]>;
  listFinalSeasonIds(): Promise<string[]>;
  findByBoardAndSnapshotAt(
    board: BoardSnapshot["board"],
    snapshotAt: Date,
  ): Promise<BoardSnapshot[]>;
  insert(snapshot: BoardSnapshot): Promise<void>;
}

export interface GroupRepository {
  findById(groupId: string): Promise<Group | null>;
  findByOwner(ownerUserId: string): Promise<Group[]>;
  findByInviteCode(inviteCode: string): Promise<Group | null>;
  insert(group: Group): Promise<void>;
  update(group: Group): Promise<void>;
  /** 事务内按 group_id 行锁读取。事务外必须拒绝；缺失返回 null。 */
  findByIdForUpdate?(groupId: string): Promise<Group | null>;
  /** 只合并传入字段。缺失抛 DocumentNotFoundError。 */
  patchFields?(groupId: string, fields: Partial<Group>): Promise<void>;
}

export interface GroupMemberRepository {
  findByGroupAndUser(groupId: string, userId: string): Promise<GroupMember | null>;
  findByGroup(groupId: string): Promise<GroupMember[]>;
  findByUser(userId: string): Promise<GroupMember[]>;
  insert(member: GroupMember): Promise<void>;
  update(member: GroupMember): Promise<void>;
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
  findUnfinalizedWeeks?(): Promise<RankingEntry[]>;
  /**
   * 返回 period_key >= minPeriodKey 的周榜；includeUnfinalized 时再合并所有
   * 未定稿历史周榜（含早于 minPeriodKey 的周），避免全表扫描。
   */
  findWeekEntriesSince?(
    minPeriodKey: string,
    includeUnfinalized?: boolean,
  ): Promise<RankingEntry[]>;
  insert(entry: RankingEntry): Promise<void>;
  update(entry: RankingEntry): Promise<void>;
  /** 事务内按 period_type + period_key + user_id 行锁读取。事务外必须拒绝；缺失返回 null。 */
  findByPeriodAndUserForUpdate?(
    periodType: RankingEntry["period_type"],
    periodKey: string,
    userId: string,
  ): Promise<RankingEntry | null>;
  /** 只合并传入字段，不整文档覆写积分与命中。缺失抛 DocumentNotFoundError。 */
  patchFields?(
    periodType: RankingEntry["period_type"],
    periodKey: string,
    userId: string,
    fields: Partial<RankingEntry>,
  ): Promise<void>;
  /** 原子局部更新：仅写 global_rank / updated_at，绝不覆盖积分与命中字段。 */
  updateGlobalRank?(
    periodType: RankingEntry["period_type"],
    periodKey: string,
    userId: string,
    globalRank: number | null,
    updatedAt: Date,
  ): Promise<void>;
}

/** 等级变化历史只追加、不更新、不删除。 */
export interface LevelHistoryRepository {
  findByUser(userId: string): Promise<LevelHistoryEntry[]>;
  findByUserIds?(userIds: readonly string[]): Promise<Map<string, LevelHistoryEntry[]>>;
  insert(entry: LevelHistoryEntry): Promise<void>;
}

export interface UnitOfWork {
  leagueSeasons?: LeagueSeasonRepository;
  seasonTeams?: SeasonTeamRepository;
  providerReconcileTodos?: ProviderReconcileTodoRepository;
  authSessions?: AuthSessionRevoker;
  users: UserRepository;
  deletedOpenidMappings: DeletedOpenidMappingRepository;
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
  boardSnapshots?: BoardSnapshotRepository;
  groups?: GroupRepository;
  groupMembers?: GroupMemberRepository;
  /** 旧适配器未实现时，settlement global rank 重算必须 Fail Closed。 */
  jobLocks?: JobLockRepository;
  /**
   * 在已开启的事务内建立撤销点（嵌套隔离）：回调期间的写入若抛错则逐条回滚到撤销点并
   * 重新抛出，成功则并入外层事务；用于满足 §15.5 单 item 写入的原子性。
   */
  savepoint<T>(fn: (tx: UnitOfWork) => Promise<T>): Promise<T>;
}

export interface LeagueSeasonRepository {
  findByKey(leagueId: string, seasonId: string): Promise<LeagueSeason | null>;
  findByLeague(leagueId: string): Promise<LeagueSeason[]>;
  insert(season: LeagueSeason): Promise<void>;
  update(season: LeagueSeason): Promise<void>;
}

export interface SeasonTeamRepository {
  findByLeagueSeason(leagueId: string, seasonId: string): Promise<SeasonTeam[]>;
  upsertMany(teams: readonly SeasonTeam[]): Promise<void>;
}

export interface ProviderReconcileTodoRepository {
  findPending(limit: number, offset?: number): Promise<ProviderReconcileTodo[]>;
  upsert(todo: ProviderReconcileTodo): Promise<void>;
  markDone(todoId: string, now: Date): Promise<void>;
  recordFailure(todoId: string, errorCode: string, now: Date): Promise<void>;
}

export interface AppRepository extends UnitOfWork {
  jobLocks: JobLockRepository;
  withTransaction<T>(fn: (tx: UnitOfWork) => Promise<T>): Promise<T>;
}

interface InMemoryStore {
  leagueSeasonsByKey: Map<string, LeagueSeason>;
  seasonTeamsByKey: Map<string, SeasonTeam>;
  providerReconcileTodosById: Map<string, ProviderReconcileTodo>;
  adminsByOpenid: Map<string, Admin>;
  adminsById: Map<string, Admin>;
  adminAuditLogsById: Map<string, AdminAuditLog>;
  anomaliesById: Map<string, Anomaly>;
  anomaliesByKey: Map<string, Anomaly>;
  syncLogsById: Map<string, SyncLog>;
  usersByOpenid: Map<string, User>;
  usersById: Map<string, User>;
  deletedOpenidMappingsByOpenid: Map<string, DeletedOpenidMapping>;
  deletedOpenidMappingsByUserId: Map<string, DeletedOpenidMapping>;
  teamsById: Map<string, Team>;
  teamProviderMappingsByKey: Map<string, TeamProviderMapping>;
  matchProviderMappingsByKey: Map<string, MatchProviderMapping>;
  providerSnapshotsById: Map<string, ProviderSnapshot>;
  matchesById: Map<string, Match>;
  predictionsByUserMatch: Map<string, Prediction>;
  predictionsByUserCanonicalMatch: Map<string, Prediction>;
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
  boardSnapshotsByKey: Map<string, BoardSnapshot>;
  groupsById: Map<string, Group>;
  groupsByInviteCode: Map<string, Group>;
  groupMembersByKey: Map<string, GroupMember>;
  jobLocks: Map<string, JobLock>;
}

function createStore(): InMemoryStore {
  return {
    leagueSeasonsByKey: new Map(),
    seasonTeamsByKey: new Map(),
    providerReconcileTodosById: new Map(),
    adminsByOpenid: new Map(),
    adminsById: new Map(),
    adminAuditLogsById: new Map(),
    anomaliesById: new Map(),
    anomaliesByKey: new Map(),
    syncLogsById: new Map(),
    usersByOpenid: new Map(),
    usersById: new Map(),
    deletedOpenidMappingsByOpenid: new Map(),
    deletedOpenidMappingsByUserId: new Map(),
    teamsById: new Map(),
    teamProviderMappingsByKey: new Map(),
    matchProviderMappingsByKey: new Map(),
    providerSnapshotsById: new Map(),
    matchesById: new Map(),
    predictionsByUserMatch: new Map(),
    predictionsByUserCanonicalMatch: new Map(),
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
    boardSnapshotsByKey: new Map(),
    groupsById: new Map(),
    groupsByInviteCode: new Map(),
    groupMembersByKey: new Map(),
    jobLocks: new Map(),
  };
}

function userMatchKey(userId: string, matchId: string): string {
  return `${userId}\u0000${matchId}`;
}

function userCanonicalMatchKey(userId: string, canonicalMatchId: string): string {
  return `${userId}\u0000${canonicalMatchId}`;
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

function userSeasonStatsKey(userId: string, levelSeasonId: string): string {
  return `${userId}\u0000${levelSeasonId}`;
}

function boardSnapshotKey(
  board: BoardSnapshot["board"],
  snapshotAt: Date,
  userId: string,
): string {
  return `${board}\u0000${snapshotAt.toISOString()}\u0000${userId}`;
}

function groupMemberKey(groupId: string, userId: string): string {
  return `${groupId}\u0000${userId}`;
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

  get leagueSeasons(): LeagueSeasonRepository {
    const store = this.store.leagueSeasonsByKey;
    return {
      findByKey: async (leagueId, seasonId) => store.get(`${leagueId}|${seasonId}`) ?? null,
      findByLeague: async (leagueId) => [...store.values()].filter((season) => season.league_id === leagueId),
      insert: async (season) => {
        const key = `${season.league_id}|${season.season_id}`;
        if (store.has(key)) throw new UniqueConstraintError("league_seasons", "uk_league_seasons_league_season", { league_id: season.league_id, season_id: season.season_id });
        store.set(key, season);
        this.logUndo(() => { store.delete(key); });
      },
      update: async (season) => {
        const key = `${season.league_id}|${season.season_id}`;
        const old = store.get(key);
        if (!old) throw new DocumentNotFoundError("league_seasons", key);
        store.set(key, season);
        this.logUndo(() => { store.set(key, old); });
      },
    };
  }

  get seasonTeams(): SeasonTeamRepository {
    const store = this.store.seasonTeamsByKey;
    return {
      findByLeagueSeason: async (leagueId, seasonId) => [...store.values()].filter((team) => team.league_id === leagueId && team.season_id === seasonId),
      upsertMany: async (teams) => {
        for (const team of teams) {
          const key = `${team.league_id}|${team.season_id}|${team.team_id}`;
          const old = store.get(key);
          const next = old ? { ...team, created_at: old.created_at } : team;
          store.set(key, next);
          this.logUndo(() => { if (old) store.set(key, old); else store.delete(key); });
        }
      },
    };
  }

  get providerReconcileTodos(): ProviderReconcileTodoRepository {
    const store = this.store.providerReconcileTodosById;
    const change = (todoId: string, update: (todo: ProviderReconcileTodo) => ProviderReconcileTodo) => {
      const old = store.get(todoId);
      if (!old) throw new DocumentNotFoundError("provider_reconcile_todos", todoId);
      store.set(todoId, update(old));
      this.logUndo(() => { store.set(todoId, old); });
    };
    return {
      findPending: async (limit, offset = 0) => [...store.values()].filter((todo) => todo.status === "pending")
        .sort((left, right) => left.kickoff_at.getTime() - right.kickoff_at.getTime()).slice(offset, offset + limit),
      upsert: async (todo) => {
        if ([...store.values()].some((row) => row.match_id === todo.match_id && row.source_id === todo.source_id && row.target_result_version === todo.target_result_version)) return;
        if (store.has(todo.todo_id)) throw new UniqueConstraintError("provider_reconcile_todos", "pk_todo", { todo_id: todo.todo_id });
        store.set(todo.todo_id, todo);
        this.logUndo(() => { store.delete(todo.todo_id); });
      },
      markDone: async (todoId, now) => change(todoId, (todo) => ({ ...todo, status: "done", completed_at: now, updated_at: now })),
      recordFailure: async (todoId, errorCode, now) => change(todoId, (todo) => ({ ...todo, attempts: todo.attempts + 1, last_error_code: errorCode, last_attempt_at: now, updated_at: now })),
    };
  }

  get users(): UserRepository {
    const self = this;
    return {
      findByOpenid: (openid) => self.findUserByOpenid(openid),
      findById: (userId) => self.findUserById(userId),
      findByIds: async (userIds) => {
        const found = new Map<string, User>();
        for (const id of new Set(userIds)) {
          const user = self.store.usersById.get(id);
          if (user !== undefined) found.set(id, user);
        }
        return found;
      },
      findAll: () => self.findAllUsers(),
      insert: (user) => self.insertUser(user),
      update: (user) => self.updateUser(user),
      findByIdForUpdate: (userId) => self.findUserByIdForUpdate(userId),
      patchFields: (userId, fields) => self.patchUser(userId, fields),
    };
  }

  get deletedOpenidMappings(): DeletedOpenidMappingRepository {
    const self = this;
    return {
      findByOriginalOpenid: (openid) =>
        self.findDeletedOpenidMappingByOriginalOpenid(openid),
      findByDeletedUserId: (userId) =>
        self.findDeletedOpenidMappingByDeletedUserId(userId),
      upsert: (mapping) => self.upsertDeletedOpenidMapping(mapping),
    };
  }

  get teams(): TeamRepository {
    const self = this;
    return {
      findById: (teamId) => self.findTeamById(teamId),
      findByIds: async (teamIds) => {
        const found = new Map<string, Team>();
        for (const id of new Set(teamIds)) {
          const team = self.store.teamsById.get(id);
          if (team !== undefined) found.set(id, team);
        }
        return found;
      },
      findAll: async () => [...self.store.teamsById.values()],
      insert: (team) => self.insertTeam(team),
      update: (team) => self.updateTeam(team),
      patchFields: (teamId, fields) => self.patchTeam(teamId, fields),
    };
  }

  get teamProviderMappings(): TeamProviderMappingRepository {
    const self = this;
    return {
      findByProviderAndExternalId: (provider, providerTeamId) =>
        self.findTeamProviderMappingByExternalId(provider, providerTeamId),
      findByProviderAndExternalIds: (provider, providerTeamIds) =>
        self.findTeamProviderMappingsByExternalIds(provider, providerTeamIds),
      findByTeamId: (teamId) => self.findTeamProviderMappingsByTeamId(teamId),
      findAll: async () => [...self.store.teamProviderMappingsByKey.values()],
      insert: (mapping) => self.insertTeamProviderMapping(mapping),
      update: (mapping) => self.updateTeamProviderMapping(mapping),
    };
  }

  get matchProviderMappings(): MatchProviderMappingRepository {
    const self = this;
    return {
      findByProviderAndExternalId: (provider, providerMatchId) =>
        self.findMatchProviderMappingByExternalId(provider, providerMatchId),
      findByProviderAndExternalIds: (provider, providerMatchIds) =>
        self.findMatchProviderMappingsByExternalIds(provider, providerMatchIds),
      findByMatchId: (matchId) => self.findMatchProviderMappingsByMatchId(matchId),
      insert: (mapping) => self.insertMatchProviderMapping(mapping),
    };
  }

  get providerSnapshots(): ProviderSnapshotRepository {
    const self = this;
    return {
      findByEntity: (entityType, entityId) => self.findProviderSnapshotsByEntity(entityType, entityId),
      findLatestSuccessByEntity: (entityType, entityId) =>
        self.findLatestProviderSyncSuccess(entityType, entityId),
      insert: (snapshot) => self.insertProviderSnapshot(snapshot),
    };
  }

  get admins(): AdminRepository {
    const self = this;
    return {
      findByOpenid: (openid) => self.findAdminByOpenid(openid),
      insert: (admin) => self.insertAdmin(admin),
      update: (admin) => self.updateAdmin(admin),
    };
  }

  get adminAuditLogs(): AdminAuditLogRepository {
    const self = this;
    return {
      findByEntity: (entityType, entityId) => self.findAdminAuditLogsByEntity(entityType, entityId),
      findPage: (query) => self.findAdminAuditLogsPage(query),
      insert: (log) => self.insertAdminAuditLog(log),
    };
  }

  get anomalies(): AnomalyRepository {
    const self = this;
    return {
      findById: (anomalyId) => self.findAnomalyById(anomalyId),
      findByIdForUpdate: (anomalyId) => self.findAnomalyByIdForUpdate(anomalyId),
      findByKey: (anomalyKey) => self.findAnomalyByKey(anomalyKey),
      findOpenBlockingByMatch: (matchId) => self.findOpenBlockingAnomaliesByMatch(matchId),
      findOpenByMatch: (matchId) => self.findOpenAnomaliesByMatch(matchId),
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
      findLatestByJobType: (jobType, options) => self.findLatestSyncLogByJobType(jobType, options),
    };
  }

  get matches(): MatchRepository {
    const self = this;
    return {
      findById: (matchId) => self.findMatchById(matchId),
      findByIds: async (matchIds) => {
        const found = new Map<string, Match>();
        for (const id of new Set(matchIds)) {
          const match = self.store.matchesById.get(id);
          if (match !== undefined) found.set(id, match);
        }
        return found;
      },
      findIdsByCanonicalMatchId: async (canonicalMatchId) =>
        [...self.store.matchesById.values()]
          .filter((match) => (match.canonical_match_id ?? match.match_id) === canonicalMatchId)
          .map((match) => match.match_id),
      findBySeason: (seasonId) => self.findMatchesBySeason(seasonId),
      findBySeasonInWindow: async (seasonId, from, to) =>
        (await self.findMatchesBySeason(seasonId)).filter(
          (match) =>
            match.kickoff_at.getTime() >= from.getTime() &&
            match.kickoff_at.getTime() <= to.getTime(),
        ),
      findByPeriodAnchorWindow: async (startAt, endAt) =>
        [...self.store.matchesById.values()].filter(
          (match) =>
            match.period_anchor_at !== null &&
            match.period_anchor_at.getTime() >= startAt.getTime() &&
            match.period_anchor_at.getTime() < endAt.getTime(),
        ),
      findByLeague: async (leagueId) => [...self.store.matchesById.values()].filter((match) => match.league_id === leagueId),
      findByLeagueSeason: async (leagueId, seasonId) => [...self.store.matchesById.values()].filter(
        (match) => match.league_id === leagueId && match.season_id === seasonId,
      ),
      findFinishedSettledOnDay: async (day) => [...self.store.matchesById.values()].filter((match) =>
        match.match_status === MatchStatus.Finished &&
        match.settlement_status === SettlementStatus.Settled &&
        match.superseded_by == null &&
        (match.finish_detected_at ?? match.kickoff_at).toISOString().slice(0, 10) === day),
      findByLeagueSeasonRound: (leagueId, seasonId, roundId) =>
        self.findMatchesByLeagueSeasonRound(leagueId, seasonId, roundId),
      findLeagueSeasonCatalog: (leagueId) => self.findLeagueSeasonCatalog(leagueId),
      findLive: () => self.findLiveMatches(),
      findSettlementTodos: (query) => self.findSettlementTodos(query),
      findSettlementFallbackPage: (query) => self.findSettlementFallbackPage(query),
      findActiveWindow: (query) => self.findActiveWindow(query),
      insert: (match) => self.insertMatch(match),
      update: (match) => self.updateMatch(match),
      findByIdForUpdate: (matchId) => self.findMatchByIdForUpdate(matchId),
      patchFields: (matchId, fields) => self.patchMatch(matchId, fields),
      updateSettlementProgress: async (matchId, resultVersion, settledAt) => {
        const match = await self.findMatchById(matchId);
        if (match === null) throw new DocumentNotFoundError("matches", matchId);
        await self.updateMatch({ ...match, settled_result_version: Math.max(match.settled_result_version, resultVersion), settled_at: settledAt, updated_at: settledAt });
      },
      updateSettlementStatus: (matchId, settlementStatus, updatedAt) =>
        self.updateMatchSettlementStatus(matchId, settlementStatus, updatedAt),
    };
  }

  get predictions(): PredictionRepository {
    const self = this;
    return {
      findById: (predictionId) => self.findPredictionById(predictionId),
      findByIds: async (predictionIds) => {
        const wanted = new Set(predictionIds);
        const found = new Map<string, Prediction>();
        if (wanted.size === 0) return found;
        for (const prediction of self.store.predictionsByUserMatch.values()) {
          if (wanted.has(prediction.prediction_id)) {
            found.set(prediction.prediction_id, prediction);
            if (found.size >= wanted.size) break;
          }
        }
        return found;
      },
      findByUserAndMatch: (userId, matchId) => self.findPredictionByUserAndMatch(userId, matchId),
      findByUserAndMatchIds: async (userId, matchIds) =>
        [...new Set(matchIds)].flatMap((matchId) => {
          const prediction = self.store.predictionsByUserMatch.get(userMatchKey(userId, matchId));
          return prediction === undefined ? [] : [prediction];
        }),
      findByUserAndCanonicalMatchIds: async (userId, canonicalMatchIds) => {
        const ids = new Set(canonicalMatchIds);
        return [...self.store.predictionsByUserMatch.values()].filter(
          (prediction) => prediction.user_id === userId && ids.has(prediction.canonical_match_id),
        );
      },
      findByCanonicalMatchIds: async (canonicalMatchIds) => {
        const ids = new Set(canonicalMatchIds);
        if (ids.size === 0) return [];
        const byId = new Map<string, Prediction>();
        for (const prediction of self.store.predictionsByUserMatch.values()) {
          const canonical = prediction.canonical_match_id ?? prediction.match_id;
          if (ids.has(canonical)) byId.set(prediction.prediction_id, prediction);
        }
        return [...byId.values()];
      },
      findByUserAndCanonicalMatch: (userId, canonicalMatchId) =>
        self.findPredictionByUserAndCanonicalMatch(userId, canonicalMatchId),
      findByUserAndIdempotencyKey: (userId, key) =>
        self.findPredictionByUserAndIdempotencyKey(userId, key),
      findByUser: (userId) => self.findPredictionsByUser(userId),
      findHistoryPage: (params) => self.findPredictionHistoryPage(params),
      findByMatch: (matchId) => self.findPredictionsByMatch(matchId),
      findByCanonicalMatch: (canonicalMatchId) => self.findPredictionsByCanonicalMatch(canonicalMatchId),
      countByMatchGroupedByResult: (matchId) =>
        self.countPredictionsByMatchGroupedByResult(matchId),
      insert: (prediction) => self.insertPrediction(prediction),
      update: (prediction) => self.updatePrediction(prediction),
    };
  }

  get matchResults(): MatchResultRepository {
    const self = this;
    return {
      findByMatchAndVersion: (matchId, resultVersion) =>
        self.findMatchResultByKey(matchId, resultVersion),
      findLatestByMatch: async (matchId) => self.findLatestMatchResult(matchId),
      insert: (matchResult) => self.insertMatchResult(matchResult),
    };
  }

  get settlements(): SettlementRepository {
    const self = this;
    return {
      findById: (settlementId) => self.findSettlementById(settlementId),
      findByIds: async (settlementIds) => {
        const found = new Map<string, SettlementDoc>();
        for (const id of new Set(settlementIds)) {
          const settlement = self.store.settlementsById.get(id);
          if (settlement !== undefined) found.set(id, settlement);
        }
        return found;
      },
      findByMatch: (matchId) => self.findSettlementsByMatch(matchId),
      findByMatchIds: async (matchIds) => {
        const wanted = new Set(matchIds);
        if (wanted.size === 0) return [];
        return [...self.store.settlementsById.values()]
          .filter((settlement) => wanted.has(settlement.match_id))
          .sort(
            (a, b) =>
              a.match_id.localeCompare(b.match_id) ||
              a.result_version - b.result_version ||
              a.rule_version.localeCompare(b.rule_version) ||
              a.settlement_id.localeCompare(b.settlement_id),
          );
      },
      findByMatchAndVersionAndRule: (matchId, resultVersion, ruleVersion) =>
        self.findSettlementByKey(matchId, resultVersion, ruleVersion),
      findByStatus: (status) => self.findSettlementsByStatus(status),
      findSettledCorrectionsPendingReeval: () => self.findSettledCorrectionsPendingReeval(),
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
      findBySettlementIdsAndStatus: async (settlementIds, status) => {
        const wanted = new Set(settlementIds);
        if (wanted.size === 0) return [];
        const result: SettlementItem[] = [];
        for (const item of self.store.settlementItemsByKey.values()) {
          if (wanted.has(item.settlement_id) && item.status === status) result.push(item);
        }
        return result;
      },
      findByUserAndStatus: async (userId, status) => {
        const result: SettlementItem[] = [];
        for (const item of self.store.settlementItemsByKey.values()) {
          if (item.user_id === userId && item.status === status) result.push(item);
        }
        return result;
      },
      findByStatus: (status) => self.findSettlementItemsByStatus(status),
      findAppliedByUserBefore: (userId, asOf) =>
        self.findAppliedSettlementItemsByUserBefore(userId, asOf),
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
      findByUserIds: async (userIds) => {
        const grouped = new Map<string, UserSeasonStats[]>();
        for (const id of new Set(userIds)) grouped.set(id, []);
        if (grouped.size === 0) return grouped;
        for (const stats of self.store.userSeasonStatsByKey.values()) {
          grouped.get(stats.user_id)?.push(stats);
        }
        return grouped;
      },
      findByLevelSeason: (levelSeasonId) => self.findUserSeasonStatsByLevelSeason(levelSeasonId),
      insert: (stats) => self.insertUserSeasonStats(stats),
      update: (stats) => self.updateUserSeasonStats(stats),
      findByUserAndSeasonForUpdate: (userId, seasonId) => self.findUserSeasonStatsForUpdate(userId, seasonId),
      patchFields: (userId, seasonId, fields) => self.patchUserSeasonStats(userId, seasonId, fields),
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
      findUnfinalizedWeeks: async () =>
        (await self.findAllRankings()).filter(
          (entry) => entry.period_type === "week" && entry.is_final === false,
        ),
      findWeekEntriesSince: async (minPeriodKey, includeUnfinalized = true) =>
        (await self.findAllRankings()).filter(
          (entry) =>
            entry.period_type === "week" &&
            (entry.period_key >= minPeriodKey ||
              (includeUnfinalized && entry.is_final === false)),
        ),
      insert: (entry) => self.insertRanking(entry),
      update: (entry) => self.updateRanking(entry),
      findByPeriodAndUserForUpdate: (periodType, periodKey, userId) =>
        self.findRankingForUpdate(periodType, periodKey, userId),
      patchFields: (periodType, periodKey, userId, fields) =>
        self.patchRanking(periodType, periodKey, userId, fields),
      updateGlobalRank: (periodType, periodKey, userId, globalRank, updatedAt) =>
        self.updateRankingGlobalRank(periodType, periodKey, userId, globalRank, updatedAt),
    };
  }

  get levelHistory(): LevelHistoryRepository {
    const self = this;
    return {
      findByUser: (userId) => self.findLevelHistoryByUser(userId),
      findByUserIds: async (userIds) => {
        const grouped = new Map<string, LevelHistoryEntry[]>();
        for (const id of new Set(userIds)) grouped.set(id, []);
        if (grouped.size === 0) return grouped;
        for (const entry of self.store.levelHistoryById.values()) {
          grouped.get(entry.user_id)?.push(entry);
        }
        return grouped;
      },
      insert: (entry) => self.insertLevelHistory(entry),
    };
  }

  get boardSnapshots(): BoardSnapshotRepository {
    const self = this;
    return {
      findLatestByBoard: (board) => self.findLatestBoardSnapshots(board),
      findLatestBySeason: (levelSeasonId) => self.findLatestSeasonSnapshots(levelSeasonId),
      findFinalBySeason: (levelSeasonId) => self.findFinalBoardSnapshotsBySeason(levelSeasonId),
      listFinalSeasonIds: () => self.listFinalBoardSnapshotSeasonIds(),
      findByBoardAndSnapshotAt: (board, snapshotAt) =>
        self.findBoardSnapshotsByBoardAndAt(board, snapshotAt),
      insert: (snapshot) => self.insertBoardSnapshot(snapshot),
    };
  }

  get groups(): GroupRepository {
    const self = this;
    return {
      findById: (groupId) => self.findGroupById(groupId),
      findByOwner: (ownerUserId) => self.findGroupsByOwner(ownerUserId),
      findByInviteCode: (inviteCode) => self.findGroupByInviteCode(inviteCode),
      insert: (group) => self.insertGroup(group),
      update: (group) => self.updateGroup(group),
      findByIdForUpdate: (groupId) => self.findGroupByIdForUpdate(groupId),
      patchFields: (groupId, fields) => self.patchGroup(groupId, fields),
    };
  }

  get groupMembers(): GroupMemberRepository {
    const self = this;
    return {
      findByGroupAndUser: (groupId, userId) => self.findGroupMemberByKey(groupId, userId),
      findByGroup: (groupId) => self.findGroupMembersByGroup(groupId),
      findByUser: (userId) => self.findGroupMembersByUser(userId),
      insert: (member) => self.insertGroupMember(member),
      update: (member) => self.updateGroupMember(member),
    };
  }

  get jobLocks(): JobLockRepository {
    const self = this;
    return {
      acquire: (lockKey, ownerId, leaseUntil) => self.acquireLock(lockKey, ownerId, leaseUntil),
      isHeld: (lockKey, asOf) => self.isLockHeld(lockKey, asOf),
      isHeldBy: (lockKey, ownerId, asOf) => self.isLockHeldBy(lockKey, ownerId, asOf),
      renew: (lockKey, ownerId, leaseUntil) => self.renewLock(lockKey, ownerId, leaseUntil),
      release: (lockKey, ownerId) => self.releaseLock(lockKey, ownerId),
    };
  }

  // ---- deleted_openid_mappings ----

  private async findDeletedOpenidMappingByOriginalOpenid(
    openid: string,
  ): Promise<DeletedOpenidMapping | null> {
    return this.store.deletedOpenidMappingsByOpenid.get(openid) ?? null;
  }

  private async findDeletedOpenidMappingByDeletedUserId(
    userId: string,
  ): Promise<DeletedOpenidMapping | null> {
    return this.store.deletedOpenidMappingsByUserId.get(userId) ?? null;
  }

  private async upsertDeletedOpenidMapping(
    mapping: DeletedOpenidMapping,
  ): Promise<void> {
    assertSchemaVersion(mapping.schema_version);
    const old = this.store.deletedOpenidMappingsByOpenid.get(mapping.original_openid) ?? null;
    if (old !== null && old.deleted_user_id !== mapping.deleted_user_id) {
      const holder = this.store.deletedOpenidMappingsByUserId.get(old.deleted_user_id);
      if (holder === old) {
        this.store.deletedOpenidMappingsByUserId.delete(old.deleted_user_id);
      }
    }
    this.store.deletedOpenidMappingsByOpenid.set(mapping.original_openid, mapping);
    this.store.deletedOpenidMappingsByUserId.set(mapping.deleted_user_id, mapping);
    this.logUndo(() => {
      if (this.store.deletedOpenidMappingsByOpenid.get(mapping.original_openid) !== mapping) {
        return;
      }
      if (old === null) {
        this.store.deletedOpenidMappingsByOpenid.delete(mapping.original_openid);
        if (this.store.deletedOpenidMappingsByUserId.get(mapping.deleted_user_id) === mapping) {
          this.store.deletedOpenidMappingsByUserId.delete(mapping.deleted_user_id);
        }
        return;
      }
      this.store.deletedOpenidMappingsByOpenid.set(old.original_openid, old);
      if (this.store.deletedOpenidMappingsByUserId.get(mapping.deleted_user_id) === mapping) {
        this.store.deletedOpenidMappingsByUserId.set(mapping.deleted_user_id, old);
      }
      if (old.deleted_user_id !== mapping.deleted_user_id) {
        this.store.deletedOpenidMappingsByUserId.set(old.deleted_user_id, old);
      }
    });
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

  private async updateAdmin(admin: Admin): Promise<void> {
    assertSchemaVersion(admin.schema_version);
    const old = this.store.adminsById.get(admin.admin_id);
    if (old === undefined) {
      throw new DocumentNotFoundError("admins", admin.admin_id);
    }
    const openidChanged = admin.openid !== old.openid;
    if (openidChanged) {
      const owner = this.store.adminsByOpenid.get(admin.openid);
      if (owner !== undefined && owner !== old) {
        throw new UniqueConstraintError("admins", "uk_admin_openid", { openid: admin.openid });
      }
      this.store.adminsByOpenid.delete(old.openid);
    }
    this.store.adminsById.set(admin.admin_id, admin);
    this.store.adminsByOpenid.set(admin.openid, admin);
    this.logUndo(() => {
      if (this.store.adminsById.get(admin.admin_id) !== admin) return;
      if (this.store.adminsByOpenid.get(admin.openid) !== admin) return;
      this.store.adminsById.set(admin.admin_id, old);
      if (openidChanged) this.store.adminsByOpenid.delete(admin.openid);
      this.store.adminsByOpenid.set(old.openid, old);
    });
  }

  private async findUserByOpenid(openid: string): Promise<User | null> {
    return this.store.usersByOpenid.get(openid) ?? null;
  }

  private requireLockTransaction(): void {
    if (this.undoLog === null) throw new Error("getForUpdate requires an active transaction");
  }

  private async findUserById(userId: string): Promise<User | null> {
    return this.store.usersById.get(userId) ?? null;
  }

  private async findUserByIdForUpdate(userId: string): Promise<User | null> {
    this.requireLockTransaction();
    return this.findUserById(userId);
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
    if (user.career_best_level < old.career_best_level) {
      throw internalError("career_best_level 只增不减");
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

  private async patchUser(userId: string, fields: Partial<User>): Promise<void> {
    const payload = repositoryPatchPayload("users", fields, { user_id: userId });
    const old = this.store.usersById.get(userId);
    if (old === undefined) throw new DocumentNotFoundError("users", userId);
    const next: User = { ...old, ...payload, user_id: old.user_id };
    const openidChanged = next.openid !== old.openid;
    if (openidChanged) {
      const owner = this.store.usersByOpenid.get(next.openid);
      if (owner !== undefined && owner !== old) {
        throw new UniqueConstraintError("users", "uk_openid", { openid: next.openid });
      }
      this.store.usersByOpenid.delete(old.openid);
    }
    this.store.usersById.set(userId, next);
    this.store.usersByOpenid.set(next.openid, next);
    this.logUndo(() => {
      if (this.store.usersById.get(userId) !== next) return;
      if (this.store.usersByOpenid.get(next.openid) !== next) return;
      this.store.usersById.set(userId, old);
      if (openidChanged) this.store.usersByOpenid.delete(next.openid);
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

  private async updateTeam(team: Team): Promise<void> {
    assertSchemaVersion(team.schema_version);
    const old = this.store.teamsById.get(team.team_id);
    if (old === undefined) throw new DocumentNotFoundError("teams", team.team_id);
    this.store.teamsById.set(team.team_id, team);
    this.logUndo(() => {
      if (this.store.teamsById.get(team.team_id) === team) {
        this.store.teamsById.set(team.team_id, old);
      }
    });
  }

  private async patchTeam(teamId: string, fields: Partial<Team>): Promise<void> {
    const payload = repositoryPatchPayload("teams", fields, { team_id: teamId });
    const old = this.store.teamsById.get(teamId);
    if (old === undefined) throw new DocumentNotFoundError("teams", teamId);
    const next: Team = { ...old, ...payload, team_id: old.team_id };
    this.store.teamsById.set(teamId, next);
    this.logUndo(() => {
      if (this.store.teamsById.get(teamId) === next) {
        this.store.teamsById.set(teamId, old);
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

  private async findTeamProviderMappingsByExternalIds(
    provider: TeamProviderMapping["provider"],
    providerTeamIds: readonly string[],
  ): Promise<Map<string, TeamProviderMapping>> {
    const found = new Map<string, TeamProviderMapping>();
    if (providerTeamIds.length === 0) return found;
    for (const providerTeamId of providerTeamIds) {
      const mapping = this.store.teamProviderMappingsByKey.get(
        providerMappingKey(provider, providerTeamId),
      );
      if (mapping !== undefined) found.set(providerTeamId, mapping);
    }
    return found;
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

  private async updateTeamProviderMapping(mapping: TeamProviderMapping): Promise<void> {
    assertSchemaVersion(mapping.schema_version);
    const key = providerMappingKey(mapping.provider, mapping.provider_team_id);
    const old = this.store.teamProviderMappingsByKey.get(key);
    if (old === undefined) throw new DocumentNotFoundError("team_provider_mappings", key);
    this.store.teamProviderMappingsByKey.set(key, mapping);
    this.logUndo(() => {
      if (this.store.teamProviderMappingsByKey.get(key) === mapping) {
        this.store.teamProviderMappingsByKey.set(key, old);
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

  private async findMatchProviderMappingsByExternalIds(
    provider: MatchProviderMapping["provider"],
    providerMatchIds: readonly string[],
  ): Promise<Map<string, MatchProviderMapping>> {
    const found = new Map<string, MatchProviderMapping>();
    if (providerMatchIds.length === 0) return found;
    for (const providerMatchId of providerMatchIds) {
      const mapping = this.store.matchProviderMappingsByKey.get(
        providerMappingKey(provider, providerMatchId),
      );
      if (mapping !== undefined) found.set(providerMatchId, mapping);
    }
    return found;
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

  private async findLatestProviderSyncSuccess(
    entityType: ProviderSnapshot["entity_type"],
    entityId: string | null,
  ): Promise<ProviderSnapshot | null> {
    const ordered = await this.findProviderSnapshotsByEntity(entityType, entityId);
    return (
      ordered.find((snapshot) => PROVIDER_SYNC_SUCCESS_EVENT_TYPES.has(snapshot.event_type)) ??
      null
    );
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

  private async findMatchesByLeagueSeasonRound(
    leagueId: string,
    seasonId: string,
    roundId: string,
  ): Promise<Match[]> {
    return [...this.store.matchesById.values()].filter(
      (match) =>
        match.league_id === leagueId &&
        match.season_id === seasonId &&
        match.round_id === roundId,
    );
  }

  private async findLeagueSeasonCatalog(leagueId?: string): Promise<LeagueSeasonCatalogEntry[]> {
    const matches = [...this.store.matchesById.values()].filter(
      (match) => match.superseded_by == null && (leagueId === undefined || match.league_id === leagueId),
    );
    return aggregateLeagueSeasonCatalog(matches);
  }

  private async findLiveMatches(): Promise<Match[]> {
    return [...this.store.matchesById.values()].filter(
      (match) => match.match_status === MatchStatus.Live && match.superseded_by == null,
    );
  }

  private async findSettlementTodos(query: SettlementTodoQuery): Promise<Match[]> {
    return selectSettlementTodos(this.store.matchesById.values(), query);
  }

  private async findSettlementFallbackPage(query: SettlementTodoQuery): Promise<Match[]> {
    return selectSettlementFallbackPage(this.store.matchesById.values(), query);
  }

  private async findActiveWindow(query: ActiveWindowQuery): Promise<Match[]> {
    return selectActiveWindow(this.store.matchesById.values(), query);
  }

  private async insertMatch(match: Match): Promise<void> {
    if (this.store.matchesById.has(match.match_id)) {
      throw new UniqueConstraintError("matches", "pk_match", { match_id: match.match_id });
    }
    assertMatchResultVersionInvariants(match);
    if (match.superseded_by !== null) {
      throw internalError("新建 match 必须满足 superseded_by=null");
    }
    this.store.matchesById.set(match.match_id, match);
    this.logUndo(() => {
      if (this.store.matchesById.get(match.match_id) === match) {
        this.store.matchesById.delete(match.match_id);
      }
    });
  }

  private async findMatchByIdForUpdate(matchId: string): Promise<Match | null> {
    this.requireLockTransaction();
    return this.store.matchesById.get(matchId) ?? null;
  }

  private async updateMatch(match: Match): Promise<void> {
    const old = this.store.matchesById.get(match.match_id);
    if (old === undefined) {
      throw new DocumentNotFoundError("matches", match.match_id);
    }

    if (
      old.canonical_match_id !== match.canonical_match_id ||
      old.superseded_by !== match.superseded_by
    ) {
      const target = match.superseded_by === null
        ? null
        : this.store.matchesById.get(match.superseded_by) ?? null;
      const inbound = [...this.store.matchesById.values()].filter(
        (item) => item.superseded_by === match.match_id,
      );
      assertMatchSupersessionWrite(match, target, inbound, old);
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

  private async patchMatch(matchId: string, fields: Partial<Match>): Promise<void> {
    const payload = repositoryPatchPayload("matches", fields, { match_id: matchId });
    const old = this.store.matchesById.get(matchId);
    if (old === undefined) throw new DocumentNotFoundError("matches", matchId);
    const next: Match = { ...old, ...payload, match_id: old.match_id };
    this.store.matchesById.set(matchId, next);
    this.logUndo(() => {
      if (this.store.matchesById.get(matchId) === next) this.store.matchesById.set(matchId, old);
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

  private async findPredictionByUserAndCanonicalMatch(
    userId: string,
    canonicalMatchId: string,
  ): Promise<Prediction | null> {
    return this.store.predictionsByUserCanonicalMatch.get(
      userCanonicalMatchKey(userId, canonicalMatchId),
    ) ?? null;
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

  private async findPredictionHistoryPage(params: {
    user_id: string;
    league_id: string | null;
    season_id: string | null;
    cursor: { submitted_at: Date; prediction_id: string } | null;
    limit: number;
  }): Promise<Prediction[]> {
    const predictions = await this.findPredictionsByUser(params.user_id);
    return selectPredictionHistoryPage(predictions, this.store.matchesById, params);
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

  private async findPredictionsByCanonicalMatch(canonicalMatchId: string): Promise<Prediction[]> {
    const byId = new Map<string, Prediction>();
    for (const prediction of this.store.predictionsByUserMatch.values()) {
      const effectiveCanonical = prediction.canonical_match_id ?? prediction.match_id;
      if (effectiveCanonical === canonicalMatchId) {
        byId.set(prediction.prediction_id, prediction);
      }
    }
    return [...byId.values()];
  }

  private async countPredictionsByMatchGroupedByResult(
    matchId: string,
  ): Promise<{ HOME: number; DRAW: number; AWAY: number }> {
    const counts = { HOME: 0, DRAW: 0, AWAY: 0 };
    for (const prediction of this.store.predictionsByUserMatch.values()) {
      if ((prediction.canonical_match_id ?? prediction.match_id) === matchId) {
        counts[prediction.derived_result] += 1;
      }
    }
    return counts;
  }

  private async insertPrediction(prediction: Prediction): Promise<void> {
    assertPredictionInvariants(prediction);
    const um = userMatchKey(prediction.user_id, prediction.match_id);
    const uc = userCanonicalMatchKey(prediction.user_id, prediction.canonical_match_id);
    const uk = userKeyKey(prediction.user_id, prediction.idempotency_key);
    if (this.store.predictionsByUserMatch.has(um)) {
      throw new UniqueConstraintError("predictions", "uk_user_match", {
        user_id: prediction.user_id,
        match_id: prediction.match_id,
      });
    }
    if (this.store.predictionsByUserCanonicalMatch.has(uc)) {
      throw new UniqueConstraintError("predictions", "uk_user_canonical_match", {
        user_id: prediction.user_id,
        canonical_match_id: prediction.canonical_match_id,
      });
    }
    if (this.store.predictionsByUserKey.has(uk)) {
      throw new UniqueConstraintError("predictions", "uk_user_idempotency", {
        user_id: prediction.user_id,
        idempotency_key: prediction.idempotency_key,
      });
    }
    this.store.predictionsByUserMatch.set(um, prediction);
    this.store.predictionsByUserCanonicalMatch.set(uc, prediction);
    this.store.predictionsByUserKey.set(uk, prediction);
    this.logUndo(() => {
      if (this.store.predictionsByUserMatch.get(um) === prediction) {
        this.store.predictionsByUserMatch.delete(um);
      }
      if (this.store.predictionsByUserCanonicalMatch.get(uc) === prediction) {
        this.store.predictionsByUserCanonicalMatch.delete(uc);
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
      old.canonical_match_id !== prediction.canonical_match_id ||
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
    this.store.predictionsByUserCanonicalMatch.set(
      userCanonicalMatchKey(prediction.user_id, prediction.canonical_match_id),
      prediction,
    );
    this.store.predictionsByUserKey.set(
      userKeyKey(prediction.user_id, prediction.idempotency_key),
      prediction,
    );
    this.logUndo(() => {
      if (this.store.predictionsByUserMatch.get(key) === prediction) {
        this.store.predictionsByUserMatch.set(key, old);
      }
      const keyByCanonicalMatch = userCanonicalMatchKey(
        prediction.user_id,
        prediction.canonical_match_id,
      );
      if (this.store.predictionsByUserCanonicalMatch.get(keyByCanonicalMatch) === prediction) {
        this.store.predictionsByUserCanonicalMatch.set(keyByCanonicalMatch, old);
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

  private findLatestMatchResult(matchId: string): MatchResult | null {
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
    // 同步比较，禁止在 has(key) 校验与 set(key) 之间引入 await（否则并发同键可双通过）。
    const latest = this.findLatestMatchResult(matchResult.match_id);
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

  private async findSettledCorrectionsPendingReeval(): Promise<SettlementDoc[]> {
    return [...this.store.settlementsById.values()].filter(
      (settlement) =>
        settlement.status === SettlementDocStatus.Settled &&
        settlement.is_correction &&
        settlement.level_reeval_status !== "completed",
    );
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
    if (
      old.match_id !== settlement.match_id ||
      old.result_version !== settlement.result_version ||
      old.rule_version !== settlement.rule_version
    ) {
      throw internalError("settlement 身份字段不可修改");
    }
    if (
      old.is_correction !== settlement.is_correction ||
      old.created_at.getTime() !== settlement.created_at.getTime()
    ) {
      throw internalError("settlement 创建事实不可修改");
    }
    this.store.settlementsById.set(settlement.settlement_id, settlement);
    const key = settlementKey(old.match_id, old.result_version, old.rule_version);
    this.store.settlementsByKey.set(key, settlement);
    this.logUndo(() => {
      if (this.store.settlementsById.get(settlement.settlement_id) !== settlement) {
        return;
      }
      if (this.store.settlementsByKey.get(key) !== settlement) {
        return;
      }
      this.store.settlementsById.set(settlement.settlement_id, old);
      this.store.settlementsByKey.set(key, old);
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

  private async findAppliedSettlementItemsByUserBefore(
    userId: string,
    asOf: Date,
  ): Promise<SettlementItem[]> {
    const result: SettlementItem[] = [];
    for (const item of this.store.settlementItemsByKey.values()) {
      if (
        item.status === SettlementItemStatus.Applied && item.user_id === userId &&
        item.applied_at !== null && item.applied_at.getTime() < asOf.getTime()
      ) {
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

  private async findUserSeasonStatsForUpdate(
    userId: string,
    seasonId: string,
  ): Promise<UserSeasonStats | null> {
    this.requireLockTransaction();
    return this.findUserSeasonStatsByKey(userId, seasonId);
  }

  private async findUserSeasonStatsByKey(
    userId: string,
    seasonId: string,
  ): Promise<UserSeasonStats | null> {
    const found = this.store.userSeasonStatsByKey.get(userSeasonStatsKey(userId, seasonId));
    return found ?? null;
  }

  private async findUserSeasonStats(userId: string): Promise<UserSeasonStats[]> {
    return [...this.store.userSeasonStatsByKey.values()]
      .filter((stats) => stats.user_id === userId);
  }

  private async findUserSeasonStatsByLevelSeason(levelSeasonId: string): Promise<UserSeasonStats[]> {
    return [...this.store.userSeasonStatsByKey.values()]
      .filter((stats) => stats.level_season_id === levelSeasonId);
  }

  private async insertUserSeasonStats(stats: UserSeasonStats): Promise<void> {
    assertSeasonStatsInvariants(stats);
    const key = userSeasonStatsKey(stats.user_id, stats.level_season_id);
    if (this.store.userSeasonStatsByKey.has(key)) {
      throw new UniqueConstraintError("user_season_stats", "uk_user_season", {
        user_id: stats.user_id,
        level_season_id: stats.level_season_id,
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
    const key = userSeasonStatsKey(stats.user_id, stats.level_season_id);
    const old = this.store.userSeasonStatsByKey.get(key);
    if (old === undefined) {
      throw new DocumentNotFoundError("user_season_stats", key);
    }
    if (stats.best_level < old.best_level) {
      throw internalError("best_level 只增不减");
    }
    if (
      old.is_level_frozen &&
      (stats.level !== old.level || stats.best_level !== old.best_level)
    ) {
      throw internalError("已冻结赛季的 level/best_level 不可修改");
    }
    this.store.userSeasonStatsByKey.set(key, stats);
    this.logUndo(() => {
      if (this.store.userSeasonStatsByKey.get(key) === stats) {
        this.store.userSeasonStatsByKey.set(key, old);
      }
    });
  }

  private async patchUserSeasonStats(
    userId: string,
    levelSeasonId: string,
    fields: Partial<UserSeasonStats>,
  ): Promise<void> {
    const payload = repositoryPatchPayload("user_season_stats", fields, {
      user_id: userId,
      level_season_id: levelSeasonId,
    });
    const key = userSeasonStatsKey(userId, levelSeasonId);
    const old = this.store.userSeasonStatsByKey.get(key);
    if (old === undefined) throw new DocumentNotFoundError("user_season_stats", key);
    const next: UserSeasonStats = {
      ...old,
      ...payload,
      user_id: old.user_id,
      level_season_id: old.level_season_id,
    };
    this.store.userSeasonStatsByKey.set(key, next);
    this.logUndo(() => {
      if (this.store.userSeasonStatsByKey.get(key) === next) this.store.userSeasonStatsByKey.set(key, old);
    });
  }

  // ---- rankings ----

  private async findRankingForUpdate(
    periodType: RankingEntry["period_type"],
    periodKey: string,
    userId: string,
  ): Promise<RankingEntry | null> {
    this.requireLockTransaction();
    return this.findRankingByKey(periodType, periodKey, userId);
  }

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

  private async patchRanking(
    periodType: RankingEntry["period_type"],
    periodKey: string,
    userId: string,
    fields: Partial<RankingEntry>,
  ): Promise<void> {
    const payload = repositoryPatchPayload("rankings", fields, {
      period_type: periodType,
      period_key: periodKey,
      user_id: userId,
    });
    const key = rankingKey(periodType, periodKey, userId);
    const old = this.store.rankingsByKey.get(key);
    if (old === undefined) throw new DocumentNotFoundError("rankings", key);
    const next: RankingEntry = {
      ...old,
      ...payload,
      period_type: old.period_type,
      period_key: old.period_key,
      user_id: old.user_id,
    };
    this.store.rankingsByKey.set(key, next);
    this.logUndo(() => {
      if (this.store.rankingsByKey.get(key) === next) this.store.rankingsByKey.set(key, old);
    });
  }

  private async updateRankingGlobalRank(
    periodType: RankingEntry["period_type"],
    periodKey: string,
    userId: string,
    globalRank: number | null,
    updatedAt: Date,
  ): Promise<void> {
    const key = rankingKey(periodType, periodKey, userId);
    const current = this.store.rankingsByKey.get(key);
    if (current === undefined) {
      throw new DocumentNotFoundError("rankings", key);
    }
    assertRankingInvariants({ ...current, global_rank: globalRank, updated_at: updatedAt });
    const previousRank = current.global_rank;
    const previousUpdatedAt = current.updated_at;
    current.global_rank = globalRank;
    current.updated_at = updatedAt;
    this.logUndo(() => {
      current.global_rank = previousRank;
      current.updated_at = previousUpdatedAt;
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
    assertLevelHistoryInvariants(entry);
    if (
      entry.scope === "season" &&
      (entry.level_season_id === null || entry.level_season_id === undefined)
    ) {
      throw internalError("season level_history 必须包含 level_season_id");
    }
    if (entry.scope === "career" && entry.level_season_id !== null) {
      throw internalError("career level_history 的 level_season_id 必须为 null");
    }
    if (entry.scope !== "season" && entry.scope !== "career") {
      throw internalError("level_history scope 无效");
    }
    if (
      entry.reason === "correction_reeval" &&
      (entry.settlement_id === null || entry.settlement_id === undefined)
    ) {
      throw internalError("correction_reeval level_history 必须包含 settlement_id");
    }
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

  private async findBoardSnapshotsByBoardAndAt(
    board: BoardSnapshot["board"],
    snapshotAt: Date,
  ): Promise<BoardSnapshot[]> {
    return [...this.store.boardSnapshotsByKey.values()].filter(
      (snapshot) =>
        snapshot.board === board && snapshot.snapshot_at.getTime() === snapshotAt.getTime() &&
        snapshot.is_final !== true,
    );
  }

  private async findLatestBoardSnapshots(
    board: BoardSnapshot["board"],
  ): Promise<BoardSnapshot[]> {
    const snapshots = [...this.store.boardSnapshotsByKey.values()].filter(
      (snapshot) => snapshot.board === board && snapshot.is_final !== true,
    );
    const latestAt = snapshots.reduce<Date | null>(
      (latest, snapshot) => latest === null || snapshot.snapshot_at > latest
        ? snapshot.snapshot_at
        : latest,
      null,
    );
    if (latestAt === null) {
      return [];
    }
    return snapshots
      .filter((snapshot) => snapshot.snapshot_at.getTime() === latestAt.getTime())
      .sort((a, b) => a.rank - b.rank);
  }

  private async findLatestSeasonSnapshots(levelSeasonId: string): Promise<BoardSnapshot[]> {
    const snapshots = [...this.store.boardSnapshotsByKey.values()].filter(
      (snapshot) =>
        snapshot.board === "season" && snapshot.level_season_id === levelSeasonId &&
        snapshot.is_final !== true,
    );
    const latestAt = snapshots.reduce<Date | null>(
      (latest, snapshot) => latest === null || snapshot.snapshot_at > latest
        ? snapshot.snapshot_at
        : latest,
      null,
    );
    if (latestAt === null) {
      return [];
    }
    return snapshots
      .filter((snapshot) => snapshot.snapshot_at.getTime() === latestAt.getTime())
      .sort((a, b) => a.rank - b.rank);
  }

  private async findFinalBoardSnapshotsBySeason(levelSeasonId: string): Promise<BoardSnapshot[]> {
    return [...this.store.boardSnapshotsByKey.values()]
      .filter((snapshot) => snapshot.board === "season" && snapshot.level_season_id === levelSeasonId && snapshot.is_final)
      .sort((a, b) => a.rank - b.rank);
  }

  private async listFinalBoardSnapshotSeasonIds(): Promise<string[]> {
    return [...new Set([...this.store.boardSnapshotsByKey.values()]
      .filter((snapshot) => snapshot.board === "season" && snapshot.is_final && snapshot.snapshot_kind !== "head")
      .map((snapshot) => snapshot.level_season_id)
      .filter((levelSeasonId): levelSeasonId is string => levelSeasonId !== null))]
      .sort((a, b) => b.localeCompare(a));
  }

  private async insertBoardSnapshot(snapshot: BoardSnapshot): Promise<void> {
    assertBoardSnapshotInvariants(snapshot);
    const key = boardSnapshotKey(snapshot.board, snapshot.snapshot_at, snapshot.user_id);
    if (this.store.boardSnapshotsByKey.has(key)) {
      throw new UniqueConstraintError("board_snapshots", "uk_board_snapshot_user", {
        board: snapshot.board,
        snapshot_at: snapshot.snapshot_at,
        user_id: snapshot.user_id,
      });
    }
    this.store.boardSnapshotsByKey.set(key, snapshot);
    this.logUndo(() => {
      if (this.store.boardSnapshotsByKey.get(key) === snapshot) {
        this.store.boardSnapshotsByKey.delete(key);
      }
    });
  }

  private async findGroupByIdForUpdate(groupId: string): Promise<Group | null> {
    this.requireLockTransaction();
    return this.findGroupById(groupId);
  }

  private async findGroupById(groupId: string): Promise<Group | null> {
    return this.store.groupsById.get(groupId) ?? null;
  }

  private async findGroupsByOwner(ownerUserId: string): Promise<Group[]> {
    return [...this.store.groupsById.values()].filter(
      (group) => group.owner_user_id === ownerUserId,
    );
  }

  private async findGroupByInviteCode(inviteCode: string): Promise<Group | null> {
    return this.store.groupsByInviteCode.get(inviteCode) ?? null;
  }

  private async insertGroup(group: Group): Promise<void> {
    assertGroupInvariants(group);
    if (this.store.groupsById.has(group.group_id)) {
      throw new UniqueConstraintError("groups", "pk_group", { group_id: group.group_id });
    }
    if (this.store.groupsByInviteCode.has(group.invite_code)) {
      throw new UniqueConstraintError("groups", "uk_invite_code", {
        invite_code: group.invite_code,
      });
    }
    this.store.groupsById.set(group.group_id, group);
    this.store.groupsByInviteCode.set(group.invite_code, group);
    this.logUndo(() => {
      if (this.store.groupsById.get(group.group_id) === group) {
        this.store.groupsById.delete(group.group_id);
      }
      if (this.store.groupsByInviteCode.get(group.invite_code) === group) {
        this.store.groupsByInviteCode.delete(group.invite_code);
      }
    });
  }

  private async updateGroup(group: Group): Promise<void> {
    assertGroupInvariants(group);
    const old = this.store.groupsById.get(group.group_id);
    if (old === undefined) {
      throw new DocumentNotFoundError("groups", group.group_id);
    }
    if (old.invite_code !== group.invite_code) {
      const owner = this.store.groupsByInviteCode.get(group.invite_code);
      if (owner !== undefined && owner !== old) {
        throw new UniqueConstraintError("groups", "uk_invite_code", {
          invite_code: group.invite_code,
        });
      }
      this.store.groupsByInviteCode.delete(old.invite_code);
    }
    this.store.groupsById.set(group.group_id, group);
    this.store.groupsByInviteCode.set(group.invite_code, group);
    this.logUndo(() => {
      if (this.store.groupsById.get(group.group_id) !== group) {
        return;
      }
      this.store.groupsById.set(group.group_id, old);
      this.store.groupsByInviteCode.delete(group.invite_code);
      this.store.groupsByInviteCode.set(old.invite_code, old);
    });
  }

  private async patchGroup(groupId: string, fields: Partial<Group>): Promise<void> {
    const payload = repositoryPatchPayload("groups", fields, { group_id: groupId });
    const old = this.store.groupsById.get(groupId);
    if (old === undefined) throw new DocumentNotFoundError("groups", groupId);
    const next: Group = { ...old, ...payload, group_id: old.group_id };
    const inviteChanged = next.invite_code !== old.invite_code;
    if (inviteChanged) {
      const owner = this.store.groupsByInviteCode.get(next.invite_code);
      if (owner !== undefined && owner !== old) {
        throw new UniqueConstraintError("groups", "uk_invite_code", { invite_code: next.invite_code });
      }
      this.store.groupsByInviteCode.delete(old.invite_code);
    }
    this.store.groupsById.set(groupId, next);
    this.store.groupsByInviteCode.set(next.invite_code, next);
    this.logUndo(() => {
      if (this.store.groupsById.get(groupId) !== next) return;
      if (this.store.groupsByInviteCode.get(next.invite_code) !== next) return;
      this.store.groupsById.set(groupId, old);
      if (inviteChanged) this.store.groupsByInviteCode.delete(next.invite_code);
      this.store.groupsByInviteCode.set(old.invite_code, old);
    });
  }

  private async findGroupMemberByKey(
    groupId: string,
    userId: string,
  ): Promise<GroupMember | null> {
    return this.store.groupMembersByKey.get(groupMemberKey(groupId, userId)) ?? null;
  }

  private async findGroupMembersByGroup(groupId: string): Promise<GroupMember[]> {
    return [...this.store.groupMembersByKey.values()].filter(
      (member) => member.group_id === groupId,
    );
  }

  private async findGroupMembersByUser(userId: string): Promise<GroupMember[]> {
    return [...this.store.groupMembersByKey.values()].filter(
      (member) => member.user_id === userId,
    );
  }

  private async insertGroupMember(member: GroupMember): Promise<void> {
    assertGroupMemberInvariants(member);
    const key = groupMemberKey(member.group_id, member.user_id);
    if (this.store.groupMembersByKey.has(key)) {
      throw new UniqueConstraintError("group_members", "uk_group_user", {
        group_id: member.group_id,
        user_id: member.user_id,
      });
    }
    this.store.groupMembersByKey.set(key, member);
    this.logUndo(() => {
      if (this.store.groupMembersByKey.get(key) === member) {
        this.store.groupMembersByKey.delete(key);
      }
    });
  }

  private async updateGroupMember(member: GroupMember): Promise<void> {
    assertGroupMemberInvariants(member);
    const key = groupMemberKey(member.group_id, member.user_id);
    const old = this.store.groupMembersByKey.get(key);
    if (old === undefined) {
      throw new DocumentNotFoundError("group_members", key);
    }
    this.store.groupMembersByKey.set(key, member);
    this.logUndo(() => {
      if (this.store.groupMembersByKey.get(key) === member) {
        this.store.groupMembersByKey.set(key, old);
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

  private async findAdminAuditLogsPage(query: AdminAuditLogPageQuery): Promise<AdminAuditLogPage> {
    const filtered = [...this.store.adminAuditLogsById.values()]
      .filter((log) => query.action === null || log.action === query.action)
      .filter((log) => query.entity_type === null || log.entity_type === query.entity_type)
      .filter((log) => query.entity_id === null || log.entity_id === query.entity_id)
      .filter((log) => {
        if (query.after === null) return true;
        const createdAt = log.created_at.getTime();
        const cursorCreatedAt = query.after.created_at.getTime();
        return (
          createdAt < cursorCreatedAt ||
          (createdAt === cursorCreatedAt && log.audit_id < query.after.audit_id)
        );
      })
      .sort((a, b) => {
        const byCreated = b.created_at.getTime() - a.created_at.getTime();
        if (byCreated !== 0) return byCreated;
        if (a.audit_id === b.audit_id) return 0;
        return a.audit_id < b.audit_id ? 1 : -1;
      });
    return {
      items: filtered.slice(0, query.limit),
      has_more: filtered.length > query.limit,
    };
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

  private async findAnomalyById(anomalyId: string): Promise<Anomaly | null> {
    return this.store.anomaliesById.get(anomalyId) ?? null;
  }

  private async findAnomalyByIdForUpdate(anomalyId: string): Promise<Anomaly | null> {
    this.requireLockTransaction();
    return this.store.anomaliesById.get(anomalyId) ?? null;
  }

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

  private async findOpenAnomaliesByMatch(matchId: string): Promise<Anomaly[]> {
    return [...this.store.anomaliesById.values()].filter(
      (anomaly) => anomaly.match_id === matchId && anomaly.status === "open",
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
    if (
      old.anomaly_id !== anomaly.anomaly_id ||
      old.anomaly_key !== anomaly.anomaly_key ||
      old.match_id !== anomaly.match_id ||
      old.type !== anomaly.type
    ) {
      throw internalError("anomaly 身份字段不可修改");
    }
    if (
      old.blocking !== anomaly.blocking ||
      old.first_seen_at.getTime() !== anomaly.first_seen_at.getTime()
    ) {
      throw internalError("anomaly 非可更新字段不可修改");
    }
    this.store.anomaliesById.set(anomaly.anomaly_id, anomaly);
    this.store.anomaliesByKey.set(anomaly.anomaly_key, anomaly);
    this.logUndo(() => {
      if (this.store.anomaliesById.get(anomaly.anomaly_id) !== anomaly) {
        return;
      }
      this.store.anomaliesById.set(anomaly.anomaly_id, old);
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

  private async findLatestSyncLogByJobType(
    jobType: SyncJobType,
    options?: { excludeSyncJobId?: string; leagueId?: string },
  ): Promise<SyncLog | null> {
    const excludeSyncJobId = options?.excludeSyncJobId;
    const leagueId = options?.leagueId;
    const matched = [...this.store.syncLogsById.values()].filter(
      (log) => log.job_type === jobType &&
        log.sync_job_id !== excludeSyncJobId &&
        (leagueId === undefined || log.league_id === leagueId),
    );
    if (matched.length === 0) {
      return null;
    }
    matched.sort((a, b) => {
      const byStarted = b.started_at.getTime() - a.started_at.getTime();
      if (byStarted !== 0) {
        return byStarted;
      }
      if (a.sync_job_id === b.sync_job_id) {
        return 0;
      }
      return a.sync_job_id < b.sync_job_id ? 1 : -1;
    });
    return matched[0] ?? null;
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

  private async isLockHeld(lockKey: string, asOf: Date): Promise<boolean> {
    const existing = this.store.jobLocks.get(lockKey);
    return existing !== undefined && existing.lease_until.getTime() > asOf.getTime();
  }

  private async isLockHeldBy(lockKey: string, ownerId: string, asOf: Date): Promise<boolean> {
    const existing = this.store.jobLocks.get(lockKey);
    return (
      existing !== undefined &&
      existing.owner_id === ownerId &&
      existing.lease_until.getTime() > asOf.getTime()
    );
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
      rollbackUndoLog(tx.undoLog);
      throw err;
    } finally {
      release();
    }
  }

  async savepoint<T>(fn: (tx: UnitOfWork) => Promise<T>): Promise<T> {
    if (this.undoLog === null) {
      throw internalError("savepoint 必须在事务内调用");
    }
    const undoLog = this.undoLog;
    const marker = undoLog.length;
    try {
      return await fn(this);
    } catch (err) {
      rollbackUndoLog(undoLog.splice(marker));
      throw err;
    }
  }
}

/** 回滚必须按写入的逆序执行（LIFO），从最后一次写入往回撤销才能恢复正确状态。 */
function rollbackUndoLog(undoLog: UndoFn[]): void {
  for (const undo of [...undoLog].reverse()) {
    undo();
  }
}
