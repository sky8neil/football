/**
 * CloudBase repository adapter 骨架。
 *
 * 待真环境集成验证：当前仓库无 CloudBase 环境，唯一约束、事务与
 * 原子语义尚未在真实库验证。不得把本文件当作已完成的生产持久化，
 * 也不得把未接线方法接进 gateway / 应用服务。
 *
 * 只读取配置变量名 FOOTBALL_CLOUD_ENVIRONMENT_ID / FOOTBALL_RESOURCE_NAMESPACE
 *（与 src/gateway/config.ts / B5 相同的注入 env 映射风格），不读取、不提交真实凭证。
 *
 * TODO(B1 接线后): 接入 @cloudbase/node-sdk
 * 本文件不 import 真实 SDK，以免改动 package.json。
 */
import { SCHEMA_VERSION } from "../domain/enums.js";
import type { User } from "../domain/types.js";
import { DocumentNotFoundError, type UserRepository } from "./repositories.js";

// TODO(B1 接线后): 接入 @cloudbase/node-sdk
// import cloudbase from "@cloudbase/node-sdk";

/** 规划级环境键名，与 gateway / B5 配置占位键一致。不在此解析凭证。 */
export const CLOUDBASE_REPOSITORY_ENV_KEYS = {
  cloud_environment_id: "FOOTBALL_CLOUD_ENVIRONMENT_ID",
  resource_namespace: "FOOTBALL_RESOURCE_NAMESPACE",
} as const;

export const CLOUDBASE_USERS_COLLECTION = "users" as const;

/** D-P1 方案 B：注销身份映射集合名（§4.5.1）。 */
export const CLOUDBASE_DELETED_OPENID_MAPPINGS_COLLECTION =
  "deleted_openid_mappings" as const;

export interface CloudBaseRepositoryConfig {
  cloud_environment_id: string;
  resource_namespace: string;
}

/** CloudBase users 文档形状。`_id` 即 `user_id`。 */
/** CloudBase deleted_openid_mappings 文档形状。`_id` 可为 deleted_user_id 或独立 UUID。 */
export interface CloudBaseDeletedOpenidMappingDocument {
  _id: string;
  original_openid: string;
  deleted_user_id: string;
  deleted_at: Date;
  created_at: Date;
  updated_at: Date;
  schema_version: typeof SCHEMA_VERSION;
}

export interface CloudBaseUserDocument {
  _id: string;
  user_id: string;
  openid: string;
  unionid: string | null;
  nickname: string | null;
  favorite_team_id: string | null;
  status: User["status"];
  career_points: number;
  career_valid_predictions: number;
  career_wdl_hits: number;
  career_exact_hits: number;
  career_level: number;
  career_best_level: number;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
  schema_version: typeof SCHEMA_VERSION;
}

export interface CloudBaseQueryResult {
  data: Record<string, unknown>[];
}

export interface CloudBaseDocumentResult {
  data: Record<string, unknown> | undefined;
}

/**
 * 可注入的 CloudBase 文档面。测试传入 fake；真环境在 B1 接线后
 * 用 collection.where / doc.get / doc.set / 事务实现。
 *
 * 最小面：where（唯一键查询）、get（按 _id）、set（整文档写入）。
 * 事务 / 唯一索引冲突 / 原子语义待真环境集成验证。
 */
export interface CloudBaseDatabase {
  where(collection: string, filter: Record<string, unknown>): Promise<CloudBaseQueryResult>;
  get(collection: string, id: string): Promise<CloudBaseDocumentResult>;
  set(collection: string, id: string, document: CloudBaseUserDocument): Promise<void>;
}

/**
 * 从调用方传入的 env 映射读取规划级键。不读真实环境文件，
 * 也不读取密钥/凭证字段。缺失或空白 Fail Closed；错误不回显传入值。
 */
export function loadCloudBaseRepositoryConfig(
  env: Record<string, string | undefined>,
): CloudBaseRepositoryConfig {
  return assertCloudBaseRepositoryConfig({
    cloud_environment_id: env[CLOUDBASE_REPOSITORY_ENV_KEYS.cloud_environment_id],
    resource_namespace: env[CLOUDBASE_REPOSITORY_ENV_KEYS.resource_namespace],
  });
}

/**
 * 校验并 trim 配置。空白环境 id / namespace Fail Closed；
 * 错误信息只含键名，不回显传入值。
 */
export function assertCloudBaseRepositoryConfig(
  config: {
    cloud_environment_id: string | undefined;
    resource_namespace: string | undefined;
  },
): CloudBaseRepositoryConfig {
  const cloud_environment_id =
    typeof config.cloud_environment_id === "string" ? config.cloud_environment_id.trim() : "";
  if (cloud_environment_id.length === 0) {
    throw new Error("FOOTBALL_CLOUD_ENVIRONMENT_ID is required");
  }

  const resource_namespace =
    typeof config.resource_namespace === "string" ? config.resource_namespace.trim() : "";
  if (resource_namespace.length === 0) {
    throw new Error("FOOTBALL_RESOURCE_NAMESPACE is required");
  }

  return { cloud_environment_id, resource_namespace };
}

/** 与 B5 rate_limits 相同的 `${namespace}_${collection}` 约定。 */
export function cloudBaseCollectionName(namespace: string, collection: string): string {
  return `${namespace}_${collection}`;
}

function notWired(method: string): never {
  throw new Error(
    `CloudBaseUserRepository.${method} not wired; TODO(B1 接线后) 待真环境集成验证`,
  );
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`CloudBaseUserRepository: users.${field} is required`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`CloudBaseUserRepository: users.${field} is invalid`);
  }
  return value;
}

function parseDate(value: unknown, field: string): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  throw new Error(`CloudBaseUserRepository: users.${field} is invalid`);
}

function parseNullableDate(value: unknown, field: string): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  return parseDate(value, field);
}

function parseNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("CloudBaseUserRepository: nullable string field is invalid");
  }
  return value;
}

function parseUserStatus(value: unknown): User["status"] {
  if (value === "active" || value === "deleted") {
    return value;
  }
  throw new Error("CloudBaseUserRepository: users.status is invalid");
}

/**
 * CloudBase UserRepository 骨架。
 *
 * 仅接线代表性方法：`findByOpenid`（uk_openid 查询）、`insert` / `update`
 *（整文档写入，强制 schema_version=1）。其余方法 Fail Closed 抛错，
 * 绝不静默返回 null / 空数组，以免生产误判数据不存在。
 *
 * 示意（SDK 未安装，保持注释，B1 接线后替换注入的 database）：
 *
 * ```
 * // TODO(B1 接线后): 接入 @cloudbase/node-sdk
 * // const app = cloudbase.init({ env: config.cloud_environment_id });
 * // const db = app.database();
 * // const colName = `${config.resource_namespace}_users`;
 * // const col = db.collection(colName);
 * //
 * // const found = await col.where({ openid }).get();
 * // await col.doc(user.user_id).set({ ...fields, schema_version: 1 });
 * //
 * // 唯一约束 uk_openid、事务与原子语义待真环境集成验证。
 * ```
 */
export class CloudBaseUserRepository implements UserRepository {
  private readonly config: CloudBaseRepositoryConfig;
  private readonly database: CloudBaseDatabase;

  constructor(config: CloudBaseRepositoryConfig, database: CloudBaseDatabase) {
    this.config = assertCloudBaseRepositoryConfig(config);
    this.database = database;
  }

  get cloudEnvironmentId(): string {
    return this.config.cloud_environment_id;
  }

  get collectionName(): string {
    return cloudBaseCollectionName(this.config.resource_namespace, CLOUDBASE_USERS_COLLECTION);
  }

  async findByOpenid(openid: string): Promise<User | null> {
    requireNonEmptyString(openid, "openid");
    const result = await this.database.where(this.collectionName, { openid });
    const first = result.data[0];
    if (first === undefined) {
      return null;
    }
    if (result.data.length > 1) {
      throw new Error(
        "CloudBaseUserRepository.findByOpenid: multiple documents for unique openid; 待真环境集成验证",
      );
    }
    return this.fromDocument(first);
  }

  async findById(_userId: string): Promise<User | null> {
    notWired("findById");
  }

  async findAll(): Promise<User[]> {
    notWired("findAll");
  }

  async insert(user: User): Promise<void> {
    const document = this.toDocument(user);
    await this.database.set(this.collectionName, document._id, document);
  }

  async update(user: User): Promise<void> {
    const document = this.toDocument(user);
    const existing = await this.database.get(this.collectionName, document._id);
    if (existing.data === undefined) {
      throw new DocumentNotFoundError(CLOUDBASE_USERS_COLLECTION, document._id);
    }
    await this.database.set(this.collectionName, document._id, document);
  }

  private toDocument(user: User): CloudBaseUserDocument {
    const userId = requireNonEmptyString(user.user_id, "user_id");
    const openid = requireNonEmptyString(user.openid, "openid");
    if (user.schema_version !== SCHEMA_VERSION) {
      throw new Error("CloudBaseUserRepository: users.schema_version must be 1");
    }

    return {
      _id: userId,
      user_id: userId,
      openid,
      unionid: user.unionid,
      nickname: user.nickname,
      favorite_team_id: user.favorite_team_id,
      status: parseUserStatus(user.status),
      career_points: user.career_points,
      career_valid_predictions: user.career_valid_predictions,
      career_wdl_hits: user.career_wdl_hits,
      career_exact_hits: user.career_exact_hits,
      career_level: user.career_level,
      career_best_level: user.career_best_level,
      deleted_at: user.deleted_at,
      created_at: user.created_at,
      updated_at: user.updated_at,
      schema_version: SCHEMA_VERSION,
    };
  }

  private fromDocument(raw: Record<string, unknown>): User {
    const schemaVersion = raw.schema_version;
    if (schemaVersion !== SCHEMA_VERSION) {
      throw new Error("CloudBaseUserRepository: users.schema_version must be 1");
    }

    const userId = requireNonEmptyString(raw.user_id ?? raw._id, "user_id");
    return {
      user_id: userId,
      openid: requireNonEmptyString(raw.openid, "openid"),
      unionid: parseNullableString(raw.unionid),
      nickname: parseNullableString(raw.nickname),
      favorite_team_id: parseNullableString(raw.favorite_team_id),
      status: parseUserStatus(raw.status),
      career_points: requireNumber(raw.career_points, "career_points"),
      career_valid_predictions: requireNumber(
        raw.career_valid_predictions,
        "career_valid_predictions",
      ),
      career_wdl_hits: requireNumber(raw.career_wdl_hits, "career_wdl_hits"),
      career_exact_hits: requireNumber(raw.career_exact_hits, "career_exact_hits"),
      career_level: requireNumber(raw.career_level, "career_level"),
      career_best_level: requireNumber(raw.career_best_level, "career_best_level"),
      deleted_at: parseNullableDate(raw.deleted_at, "deleted_at"),
      created_at: parseDate(raw.created_at, "created_at"),
      updated_at: parseDate(raw.updated_at, "updated_at"),
      schema_version: SCHEMA_VERSION,
    };
  }
}

// TODO(B1 接线后) CloudBaseTeamRepository implements TeamRepository
// TODO(B1 接线后) CloudBaseTeamProviderMappingRepository implements TeamProviderMappingRepository
// TODO(B1 接线后) CloudBaseMatchProviderMappingRepository implements MatchProviderMappingRepository
// TODO(B1 接线后) CloudBaseProviderSnapshotRepository implements ProviderSnapshotRepository
// TODO(B1 接线后) CloudBaseAdminRepository implements AdminRepository
// TODO(B1 接线后) CloudBaseAdminAuditLogRepository implements AdminAuditLogRepository
// TODO(B1 接线后) CloudBaseAnomalyRepository implements AnomalyRepository
// TODO(B1 接线后) CloudBaseSyncLogRepository implements SyncLogRepository
// TODO(B1 接线后) CloudBaseMatchRepository implements MatchRepository
// TODO(B1 接线后) CloudBasePredictionRepository implements PredictionRepository
// TODO(B1 接线后) CloudBaseJobLockRepository implements JobLockRepository
// TODO(B1 接线后) CloudBaseMatchResultRepository implements MatchResultRepository
// TODO(B1 接线后) CloudBaseSettlementRepository implements SettlementRepository
// TODO(B1 接线后) CloudBaseSettlementItemRepository implements SettlementItemRepository
// TODO(B1 接线后) CloudBaseUnlockRepository implements UnlockRepository
// TODO(B1 接线后) CloudBaseUserSeasonStatsRepository implements UserSeasonStatsRepository
// TODO(B1 接线后) CloudBaseRankingRepository implements RankingRepository
// TODO(B1 接线后) CloudBaseLevelHistoryRepository implements LevelHistoryRepository
// TODO(B1 接线后) CloudBaseDeletedOpenidMappingRepository implements DeletedOpenidMappingRepository
//   - findByOriginalOpenid: where(collection, { original_openid })（uk_deleted_openid 唯一）
//   - findByDeletedUserId: where(collection, { deleted_user_id })（idx_deleted_user_id）
//   - upsert: where(original_openid) 命中 → set 同 _id 覆盖；未命中 → set 新 _id；
//     与 users 同级待真环境验证唯一/事务语义。
// TODO(B1 接线后) CloudBaseAppRepository implements AppRepository（withTransaction / UnitOfWork）
