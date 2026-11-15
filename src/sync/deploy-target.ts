/**
 * 部署目标与调度粒度。
 *
 * 实际刷新频率由两步决定，缺一不可：
 *   1. 单个任务的常规间隔（`SYNC_TASKS_V1.intervalMinutes`）；
 *   2. 调度器多久醒一次（systemd timer / 云函数定时器）。
 * 真正生效的频率是两者的**较大者**。
 *
 * 两种部署目标的默认粒度：
 * - `vps`（本机 systemd timer）：**3 分钟**，`live_match` 的 3 分钟间隔可以真正生效；
 * - `cloudbase`（腾讯云云函数定时器）：**15 分钟**，这是平台的最小粒度，
 *   `live_match` 的 3 分钟配置在云上会退化为 15 分钟——不是配置写错，是平台限制。
 *
 * 结论：想要"比赛比分 3 分钟级实时"，必须部署在 VPS。部署到 CloudBase 时
 * `scripts/deploy-preflight.mjs` 会在部署前把这件事打印出来。
 */
import { SyncJobType } from "../domain/enums.js";
import { taskIntervalMinutes, type ProviderJobProfile } from "./config.js";

export type DeployTarget = "vps" | "cloudbase";

/** 调度器自身的最小唤醒粒度（分钟）。 */
export const SCHEDULER_TICK_MINUTES: Readonly<Record<DeployTarget, number>> = {
  vps: 3,
  cloudbase: 15,
};

export const DEPLOY_TARGETS: readonly DeployTarget[] = ["vps", "cloudbase"] as const;

export function isDeployTarget(value: unknown): value is DeployTarget {
  return value === "vps" || value === "cloudbase";
}

/**
 * 解析部署目标。
 *
 * 显式 `FOOTBALL_DEPLOY_TARGET` 优先；未设置时按仓库后端推断：
 * `cloudbase` 后端 → cloudbase，其余（postgres / memory）→ vps。
 * 写了非法值时抛错（部署配置错误应当启动即失败，而不是静默按 VPS 跑）。
 */
export function resolveDeployTarget(env: Record<string, string | undefined>): DeployTarget {
  const raw = env.FOOTBALL_DEPLOY_TARGET?.trim().toLowerCase();
  if (raw !== undefined && raw !== "") {
    if (!isDeployTarget(raw)) {
      throw new Error("FOOTBALL_DEPLOY_TARGET must be one of: vps, cloudbase");
    }
    return raw;
  }
  return env.FOOTBALL_REPOSITORY_BACKEND === "cloudbase" ? "cloudbase" : "vps";
}

export function schedulerTickMinutes(target: DeployTarget): number {
  return SCHEDULER_TICK_MINUTES[target];
}

/**
 * 任务在该部署目标下**真正**能跑到的间隔（分钟）= max(任务间隔, tick 粒度)。
 *
 * 用于文档、部署前提醒与 dry-run 计划输出；不参与门禁判断（门禁用的是最小间隔，
 * 比 tick 更小的间隔只是永远不会被触发，不会产生额外请求）。
 */
export function effectiveRefreshMinutes(
  jobType: SyncJobType,
  profile: ProviderJobProfile,
  target: DeployTarget,
): number {
  return Math.max(taskIntervalMinutes(jobType, profile), schedulerTickMinutes(target));
}
