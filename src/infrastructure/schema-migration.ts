/**
 * 数据 migration / schema version 基础设施（规范 2.5、43.21）。
 *
 * - 当前核心文档固定 schema_version = 1。
 * - 未来不兼容变更必须登记 migration，禁止运行时猜测旧结构。
 * - 未知版本 Fail Closed。
 */
import { SCHEMA_VERSION } from "../domain/enums.js";
import { internalError } from "../domain/errors.js";

export const CURRENT_SCHEMA_VERSION = SCHEMA_VERSION;

export interface SchemaMigration {
  /** 迁移起点版本（含）。 */
  from_version: number;
  /** 迁移终点版本（含）。 */
  to_version: number;
  /** 稳定标识，便于审计与幂等。 */
  migration_id: string;
  description: string;
}

/**
 * MVP 初始版本无已登记 migration。
 * 未来字段语义不兼容时在此追加，并编写对应迁移过程；不得跳过版本。
 */
export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [];

/** 运行时文档版本必须等于当前固定版本。 */
export function assertSupportedSchemaVersion(
  version: unknown,
): asserts version is typeof CURRENT_SCHEMA_VERSION {
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version !== CURRENT_SCHEMA_VERSION
  ) {
    throw internalError(`unsupported schema_version: ${String(version)}`);
  }
}

/**
 * 列出从 fromVersion 升级到当前版本所需的有序 migration。
 * 已是当前版本时返回空数组。
 */
export function listPendingMigrations(
  fromVersion: number,
): readonly SchemaMigration[] {
  return resolveMigrationPath(fromVersion, CURRENT_SCHEMA_VERSION);
}

/**
 * 解析 from -> to 的 migration 链。
 * 缺少连续路径时 Fail Closed，禁止猜测。
 */
export function resolveMigrationPath(
  fromVersion: number,
  toVersion: number = CURRENT_SCHEMA_VERSION,
): readonly SchemaMigration[] {
  if (
    !Number.isInteger(fromVersion) ||
    !Number.isInteger(toVersion) ||
    fromVersion < 1 ||
    toVersion < 1
  ) {
    throw internalError(
      `invalid schema migration versions: ${fromVersion} -> ${toVersion}`,
    );
  }
  if (fromVersion === toVersion) {
    return [];
  }
  if (fromVersion > toVersion) {
    throw internalError(
      `schema downgrade is not supported: ${fromVersion} -> ${toVersion}`,
    );
  }

  const path: SchemaMigration[] = [];
  let cursor = fromVersion;
  while (cursor < toVersion) {
    const next = SCHEMA_MIGRATIONS.find(
      (migration) => migration.from_version === cursor,
    );
    if (next === undefined) {
      throw internalError(
        `missing schema migration path: ${cursor} -> ${toVersion}`,
      );
    }
    if (next.to_version <= cursor) {
      throw internalError(
        `schema migration does not advance version: ${next.migration_id}`,
      );
    }
    path.push(next);
    cursor = next.to_version;
  }
  if (cursor !== toVersion) {
    throw internalError(
      `schema migration path overshoots target: ${fromVersion} -> ${toVersion}`,
    );
  }
  return path;
}
