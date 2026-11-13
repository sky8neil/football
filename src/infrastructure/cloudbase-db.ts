/** CloudBase SDK 之外的最小数据库端口。生产 SDK 适配器在上线门禁切片实现。 */
export interface CloudBaseDocument extends Record<string, unknown> {
  _id: string;
}

export interface CloudBaseQueryOptions {
  order_by?: string;
  direction?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface CloudBaseDb {
  get(collection: string, id: string): Promise<CloudBaseDocument | null>;
  /** 原子新增；主键或唯一索引冲突时拒绝。 */
  add(collection: string, id: string, document: CloudBaseDocument): Promise<void>;
  /** 仅合并传入字段，与 SDK doc.update 一致。 */
  update(collection: string, id: string, document: CloudBaseDocument): Promise<void>;
  query(
    collection: string,
    filter?: Record<string, unknown>,
    options?: CloudBaseQueryOptions,
  ): Promise<CloudBaseDocument[]>;
  count(collection: string, filter?: Record<string, unknown>): Promise<number>;
  /**
   * 构造「字段 <= 值」范围条件，返回可直接并入 query filter 的对象。
   * 适配器不支持范围查询时返回 undefined（调用方退化为不带该条件）。
   */
  lteFilter?(field: string, value: unknown): Record<string, unknown> | undefined;
  /**
   * 构造「字段 in 数组」等值集合条件，返回可直接并入 query filter 的对象。
   * 适配器不支持时返回 undefined（调用方退化为逐条查询）。
   */
  inFilter?(field: string, values: readonly string[]): Record<string, unknown> | undefined;
  reserveCounter?(collection: string, id: string, field: string, limit: number, initial: CloudBaseDocument): Promise<boolean>;
  adjustCounter?(collection: string, id: string, field: string, delta: number): Promise<void>;
  getCounter?(collection: string, id: string, field: string): Promise<number>;
  transaction<T>(work: (transactionDb: CloudBaseDb) => Promise<T>): Promise<T>;
}

export class CloudBaseDuplicateKeyError extends Error {
  constructor(
    readonly collection: string,
    readonly indexName: string,
    readonly key: Record<string, unknown>,
  ) {
    super(`CloudBase duplicate key: ${collection}.${indexName}`);
    this.name = "CloudBaseDuplicateKeyError";
  }
}

export class CloudBaseDocumentNotFoundError extends Error {
  constructor(readonly collection: string, readonly id: string) {
    super(`CloudBase document not found: ${collection}/${id}`);
    this.name = "CloudBaseDocumentNotFoundError";
  }
}

export interface CloudBaseRepositoryConfig {
  cloud_environment_id: string;
  resource_namespace: string;
}

export const CLOUDBASE_REPOSITORY_ENV_KEYS = {
  cloud_environment_id: "FOOTBALL_CLOUD_ENVIRONMENT_ID",
  resource_namespace: "FOOTBALL_RESOURCE_NAMESPACE",
} as const;

export const CLOUDBASE_RUNTIME_COLLECTIONS = ["diag", "rate_limits"] as const;

export const COLLECTION_ALIASES: Readonly<Record<string, string>> = {
  user_season_stats: "stats",
  team_provider_mappings: "team_src_map",
  match_provider_mappings: "match_src_map",
  provider_snapshots: "provider_snaps",
  provider_key_state: "provider_keys",
  provider_league_state: "provider_leagues",
  deleted_openid_mappings: "deleted_openids",
  scheduler_state: "sched_state",
};

const ALIAS_TO_LOGICAL: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(COLLECTION_ALIASES).map(([logical, alias]) => [alias, logical]),
);

export function cloudBaseCollectionName(namespace: string, collection: string): string {
  const name = `${namespace}_${COLLECTION_ALIASES[collection] ?? collection}`;
  if (name.length > 30) throw new Error(`CloudBase collection name exceeds 30 characters: ${name}`);
  return name;
}

export function logicalCollectionFromPhysical(namespace: string, physical: string): string {
  const prefix = `${namespace}_`;
  if (!physical.startsWith(prefix)) return physical;
  const suffix = physical.slice(prefix.length);
  return ALIAS_TO_LOGICAL[suffix] ?? suffix;
}

export function assertCloudBaseRepositoryConfig(config: {
  cloud_environment_id: string | undefined;
  resource_namespace: string | undefined;
}): CloudBaseRepositoryConfig {
  const cloud_environment_id = config.cloud_environment_id?.trim() ?? "";
  if (!cloud_environment_id) throw new Error("FOOTBALL_CLOUD_ENVIRONMENT_ID is required");

  const resource_namespace = config.resource_namespace?.trim() ?? "";
  if (!resource_namespace) throw new Error("FOOTBALL_RESOURCE_NAMESPACE is required");

  return { cloud_environment_id, resource_namespace };
}

export function loadCloudBaseRepositoryConfig(
  env: Record<string, string | undefined>,
): CloudBaseRepositoryConfig {
  return assertCloudBaseRepositoryConfig({
    cloud_environment_id: env[CLOUDBASE_REPOSITORY_ENV_KEYS.cloud_environment_id],
    resource_namespace: env[CLOUDBASE_REPOSITORY_ENV_KEYS.resource_namespace],
  });
}
