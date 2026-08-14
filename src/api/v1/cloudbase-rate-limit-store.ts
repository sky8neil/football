/**
 * CloudBase 数据库原子计数 adapter 骨架。
 *
 * 待真环境集成验证：当前仓库无 CloudBase 环境，原子自增、窗口重置与
 * 事务锁冲突语义尚未在真实库验证。不得把本文件接进 gateway / http.ts。
 *
 * 只读取配置变量名 FOOTBALL_CLOUD_ENVIRONMENT_ID / FOOTBALL_RESOURCE_NAMESPACE
 *（与 src/gateway/config.ts 相同的注入 env 映射风格），不读取、不提交真实凭证。
 *
 * TODO(B1 接线后): 接入 @cloudbase/node-sdk
 * 本文件不 import 真实 SDK，以免改动 package.json。
 */
import type { RateLimitStore } from "./rate-limit-store.js";

// TODO(B1 接线后): 接入 @cloudbase/node-sdk
// import cloudbase from "@cloudbase/node-sdk";

/** 规划级环境键名，与 gateway 配置占位键一致。不在此解析凭证。 */
export const CLOUDBASE_RATE_LIMIT_ENV_KEYS = {
  cloud_environment_id: "FOOTBALL_CLOUD_ENVIRONMENT_ID",
  resource_namespace: "FOOTBALL_RESOURCE_NAMESPACE",
} as const;

export interface CloudBaseRateLimitStoreConfig {
  cloud_environment_id: string;
  resource_namespace: string;
}

/**
 * 共享限流文档结构。`_id` 即 RateLimitStore key（`${scope}\u0000${identity}`）。
 */
export interface CloudBaseRateLimitDocument {
  _id: string;
  window_start: number;
  count: number;
}

/**
 * 可注入的 CloudBase 原子计数面。测试传入 fake；真环境在 B1 接线后
 * 用 db.command.inc + 条件更新或事务实现。
 */
export interface CloudBaseRateLimitDatabase {
  incrementInWindow(
    key: string,
    windowStart: number,
    serverNow: Date,
  ): Promise<number>;
}

/**
 * 从调用方传入的 env 映射读取规划级键。不读真实环境文件，
 * 也不读取密钥/凭证字段。
 */
export function loadCloudBaseRateLimitStoreConfig(
  env: Record<string, string | undefined>,
): CloudBaseRateLimitStoreConfig {
  const rawEnvironmentId = env[CLOUDBASE_RATE_LIMIT_ENV_KEYS.cloud_environment_id];
  if (typeof rawEnvironmentId !== "string" || rawEnvironmentId.trim().length === 0) {
    throw new Error("FOOTBALL_CLOUD_ENVIRONMENT_ID is required");
  }

  const rawNamespace = env[CLOUDBASE_RATE_LIMIT_ENV_KEYS.resource_namespace];
  if (typeof rawNamespace !== "string" || rawNamespace.trim().length === 0) {
    throw new Error("FOOTBALL_RESOURCE_NAMESPACE is required");
  }

  return {
    cloud_environment_id: rawEnvironmentId.trim(),
    resource_namespace: rawNamespace.trim(),
  };
}

export function cloudBaseRateLimitCollectionName(resourceNamespace: string): string {
  return `${resourceNamespace}_rate_limits`;
}

/**
 * CloudBase RateLimitStore 骨架。
 *
 * increment 语义（必须原子，待真环境集成验证）：
 *   文档 `{ _id: key, window_start, count }`
 *   同窗口：`db.command.inc(1)`
 *   窗口变化或不存在：事务内重置 `count = 1`（禁止无锁读-改-写）
 *
 * 示意（SDK 未安装，保持注释，B1 接线后替换注入的 database）：
 *
 * ```
 * // TODO(B1 接线后): 接入 @cloudbase/node-sdk
 * // const app = cloudbase.init({ env: config.cloud_environment_id });
 * // const db = app.database();
 * // const _ = db.command;
 * // const colName = `${config.resource_namespace}_rate_limits`;
 * // const col = db.collection(colName);
 * //
 * // // 快路径：同窗口条件更新，原子 +1
 * // const updated = await col.where({ _id: key, window_start: windowStart }).update({
 * //   count: _.inc(1),
 * // });
 * // if (updated.updated === 1) {
 * //   const after = await col.doc(key).get();
 * //   return after.data.count;
 * // }
 * //
 * // // 慢路径：文档不存在或窗口已变。必须事务，避免两实例同时 reset 成 1。
 * // const tx = await db.startTransaction();
 * // try {
 * //   const snap = await tx.collection(colName).doc(key).get();
 * //   const data = snap.data as { window_start?: number; count?: number } | undefined;
 * //   if (data === undefined || data.window_start !== windowStart) {
 * //     await tx.collection(colName).doc(key).set({
 * //       window_start: windowStart,
 * //       count: 1,
 * //     });
 * //     await tx.commit();
 * //     return 1;
 * //   }
 * //   await tx.collection(colName).doc(key).update({ count: _.inc(1) });
 * //   const after = await tx.collection(colName).doc(key).get();
 * //   await tx.commit();
 * //   return after.data.count;
 * // } catch (err) {
 * //   await tx.rollback();
 * //   throw err; // 锁冲突由上层重试；此处不吞。待真环境集成验证。
 * // }
 * ```
 */
export class CloudBaseRateLimitStore implements RateLimitStore {
  private readonly config: CloudBaseRateLimitStoreConfig;
  private readonly database: CloudBaseRateLimitDatabase | undefined;

  constructor(
    config: CloudBaseRateLimitStoreConfig,
    database?: CloudBaseRateLimitDatabase,
  ) {
    this.config = config;
    this.database = database;
  }

  get collectionName(): string {
    return cloudBaseRateLimitCollectionName(this.config.resource_namespace);
  }

  get cloudEnvironmentId(): string {
    return this.config.cloud_environment_id;
  }

  async increment(
    key: string,
    windowStart: number,
    serverNow: Date,
  ): Promise<number> {
    if (this.database === undefined) {
      throw new Error(
        "CloudBaseRateLimitStore is a skeleton; inject CloudBaseRateLimitDatabase after B1 wiring. TODO(B1 接线后): 接入 @cloudbase/node-sdk. 待真环境集成验证。",
      );
    }
    return this.database.incrementInWindow(key, windowStart, serverNow);
  }
}
