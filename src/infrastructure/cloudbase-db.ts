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
  update(collection: string, id: string, document: CloudBaseDocument): Promise<void>;
  query(
    collection: string,
    filter?: Record<string, unknown>,
    options?: CloudBaseQueryOptions,
  ): Promise<CloudBaseDocument[]>;
  count(collection: string, filter?: Record<string, unknown>): Promise<number>;
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

export function cloudBaseCollectionName(namespace: string, collection: string): string {
  return `${namespace}_${collection}`;
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
