#!/usr/bin/env node
/**
 * 部署前提醒：这个部署目标能跑到多"实时"。
 *
 * 背景：刷新频率 = max(任务配置间隔, 调度器 tick 粒度)。
 * - VPS（systemd timer）默认 3 分钟，live_match 的 3 分钟配置能真正生效；
 * - CloudBase（腾讯云云函数定时器）最小粒度 15 分钟，live_match 会退化成 15 分钟。
 *
 * 数值来源只有一个：dist/sync/config.js 的 SYNC_TASKS_V1 与 dist/sync/deploy-target.js，
 * 本脚本不重复定义任何间隔（历史上就是因为写了两份，配置改了不生效）。
 *
 * 用法：
 *   node scripts/deploy-preflight.mjs --target=cloudbase
 *   node scripts/deploy-preflight.mjs --target=vps --json
 *   npm run deploy:preflight            # 目标从 FOOTBALL_DEPLOY_TARGET / 仓库后端推断
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIST_DEPLOY_TARGET = new URL("../dist/sync/deploy-target.js", import.meta.url);
const DIST_SYNC_CONFIG = new URL("../dist/sync/config.js", import.meta.url);
const DIST_GATEWAY_CONFIG = new URL("../dist/gateway/config.js", import.meta.url);

/** 检查顺序固定，方便人读也方便测试。 */
const JOBS = [
  { jobType: "live_match", label: "live_match（赛中）" },
  { jobType: "post_finish_verify", label: "post_finish_verify（赛后确认）" },
  { jobType: "near_match", label: "near_match（赛前 24h-2h）" },
  { jobType: "future_schedule", label: "future_schedule（赛程变更）" },
  { jobType: "full_schedule_verify", label: "full_schedule_verify（全量核对）" },
];

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  return prefixed === undefined ? undefined : prefixed.slice(name.length + 1);
}

function hasFlag(args, name) {
  return args.includes(name);
}

export function formatMinutes(minutes) {
  if (minutes % 60 === 0 && minutes >= 60) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

/**
 * 纯函数：把数值渲染成给人看的报告。不碰文件系统、不读 env。
 *
 * @param {{
 *   target: "vps" | "cloudbase",
 *   profile: "test" | "prod",
 *   tickMinutes: number,
 *   rows: Array<{ jobType: string, label: string, configuredMinutes: number, effectiveMinutes: number }>,
 * }} input
 */
export function buildReport(input) {
  const degraded = input.rows.filter((row) => row.effectiveMinutes > row.configuredMinutes);
  const lines = [];
  lines.push("────────────────────────────────────────────────────────────");
  lines.push("  部署前检查：调度实时性");
  lines.push("────────────────────────────────────────────────────────────");
  lines.push(`  部署目标      : ${input.target}${input.target === "cloudbase" ? "（腾讯云云函数）" : "（systemd timer）"}`);
  lines.push(`  调度粒度      : ${formatMinutes(input.tickMinutes)}`);
  lines.push(`  sync profile  : ${input.profile}`);
  lines.push("");
  lines.push("  任务                              配置间隔        实际生效");
  for (const row of input.rows) {
    const mark = row.effectiveMinutes > row.configuredMinutes ? "  ← 被调度粒度限制" : "";
    lines.push(
      `  ${row.label.padEnd(32)}${formatMinutes(row.configuredMinutes).padEnd(16)}${formatMinutes(row.effectiveMinutes)}${mark}`,
    );
  }
  lines.push("");
  if (degraded.length > 0) {
    lines.push(`  ⚠️  警告：${degraded.length} 个任务的实际刷新频率低于配置值。`);
    lines.push(`      部署在 ${input.target} 时，调度器最快每 ${formatMinutes(input.tickMinutes)}醒一次，`);
    lines.push("      比它更短的间隔不会生效。想要「比赛比分 3 分钟级实时」，请部署到 VPS。");
  } else {
    lines.push("  ✓ 所有任务的配置间隔都能被调度粒度覆盖，配置值即实际值。");
    lines.push("  ⚠️  提醒：VPS 上请确认 /etc/systemd/system/football-jobs.timer 已按模板");
    lines.push("      ops/vps/football-jobs.timer 安装（OnCalendar=*-*-* *:00/3:00），");
    lines.push("      否则代码里的 3 分钟不会生效。");
  }
  lines.push("────────────────────────────────────────────────────────────");
  return { text: lines.join("\n"), degraded };
}

export async function main(args = process.argv.slice(2), env = process.env, write = console.log) {
  const json = hasFlag(args, "--json");
  const failOnDegraded = hasFlag(args, "--fail-on-degraded");
  const explicitTarget = argValue(args, "--target");

  if (!existsSync(fileURLToPath(DIST_DEPLOY_TARGET)) || !existsSync(fileURLToPath(DIST_SYNC_CONFIG))) {
    throw new Error("dist/ 尚未构建，请先 npm run build（或用 npm run deploy:preflight）");
  }
  const deployTarget = await import(DIST_DEPLOY_TARGET.href);
  const syncConfig = await import(DIST_SYNC_CONFIG.href);
  if (
    env.FOOTBALL_ENVIRONMENT === "prod" ||
    (typeof env.FOOTBALL_LEVEL_FIRST_EVAL_AS_OF === "string" &&
      env.FOOTBALL_LEVEL_FIRST_EVAL_AS_OF.trim().length > 0) ||
    (typeof env.FOOTBALL_RANKING_FIRST_PERIOD_KEY === "string" &&
      env.FOOTBALL_RANKING_FIRST_PERIOD_KEY.trim().length > 0)
  ) {
    if (!existsSync(fileURLToPath(DIST_GATEWAY_CONFIG))) {
      throw new Error("dist/ 尚未构建，请先 npm run build（或用 npm run deploy:preflight）");
    }
    const gatewayConfig = await import(DIST_GATEWAY_CONFIG.href);
    gatewayConfig.parseLevelFirstEvalAsOf(env, env.FOOTBALL_ENVIRONMENT);
    gatewayConfig.parseRankingFirstPeriodKey(env, env.FOOTBALL_ENVIRONMENT);
  }

  const target = explicitTarget === undefined
    ? deployTarget.resolveDeployTarget(env)
    : explicitTarget;
  if (!deployTarget.isDeployTarget(target)) {
    throw new Error(`未知部署目标：${target}（可选 vps / cloudbase）`);
  }
  const profile = env.FOOTBALL_SYNC_PROFILE === "prod" ? "prod" : "test";
  const tickMinutes = deployTarget.schedulerTickMinutes(target);
  const rows = JOBS.map(({ jobType, label }) => ({
    jobType,
    label,
    configuredMinutes: syncConfig.taskIntervalMinutes(jobType, profile),
    effectiveMinutes: deployTarget.effectiveRefreshMinutes(jobType, profile, target),
  }));

  const report = buildReport({ target, profile, tickMinutes, rows });
  if (json) {
    write(JSON.stringify({
      deploy_target: target,
      sync_profile: profile,
      tick_minutes: tickMinutes,
      rows,
      degraded_jobs: report.degraded.map((row) => row.jobType),
    }, null, 2));
  } else {
    write(report.text);
  }
  return failOnDegraded && report.degraded.length > 0 ? 1 : 0;
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
