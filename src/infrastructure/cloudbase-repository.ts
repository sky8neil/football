import type { User } from "../domain/types.js";
import type { UserRepository } from "./repositories.js";
import {
  CLOUDBASE_REPOSITORY_ENV_KEYS,
  assertCloudBaseRepositoryConfig,
  cloudBaseCollectionName,
  loadCloudBaseRepositoryConfig,
  type CloudBaseDb,
  type CloudBaseDocument,
  type CloudBaseRepositoryConfig,
} from "./cloudbase-db.js";
import { CloudBaseAppRepository } from "./cloudbase-app-repository.js";

export {
  CLOUDBASE_REPOSITORY_ENV_KEYS,
  assertCloudBaseRepositoryConfig,
  cloudBaseCollectionName,
  loadCloudBaseRepositoryConfig,
  type CloudBaseDb,
  type CloudBaseDocument,
  type CloudBaseQueryOptions,
  type CloudBaseRepositoryConfig,
} from "./cloudbase-db.js";
export { CloudBaseDuplicateKeyError, CloudBaseDocumentNotFoundError } from "./cloudbase-db.js";
export {
  CloudBaseAppRepository,
} from "./cloudbase-app-repository.js";

export const CLOUDBASE_USERS_COLLECTION = "users" as const;
export const CLOUDBASE_DELETED_OPENID_MAPPINGS_COLLECTION = "deleted_openid_mappings" as const;

/** 独立用户仓储兼容入口；实际字段读写由统一 CloudBaseAppRepository 完成。 */
export class CloudBaseUserRepository implements UserRepository {
  private readonly users: UserRepository;
  private readonly config: CloudBaseRepositoryConfig;

  constructor(config: CloudBaseRepositoryConfig, database: CloudBaseDb) {
    this.config = assertCloudBaseRepositoryConfig(config);
    this.users = new CloudBaseAppRepository(this.config, database).users;
  }

  get cloudEnvironmentId(): string {
    return this.config.cloud_environment_id;
  }

  get collectionName(): string {
    return cloudBaseCollectionName(this.config.resource_namespace, CLOUDBASE_USERS_COLLECTION);
  }

  findByOpenid(openid: string): Promise<User | null> {
    return this.users.findByOpenid(openid);
  }

  findById(userId: string): Promise<User | null> {
    return this.users.findById(userId);
  }

  findAll(): Promise<User[]> {
    return this.users.findAll();
  }

  insert(user: User): Promise<void> {
    return this.users.insert(user);
  }

  update(user: User): Promise<void> {
    return this.users.update(user);
  }
}
