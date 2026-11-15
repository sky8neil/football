import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildReport, formatMinutes, main } from "./deploy-preflight.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_READY = existsSync(join(ROOT, "dist", "sync", "deploy-target.js"))
  && existsSync(join(ROOT, "dist", "sync", "config.js"));

const ROWS = [
  { jobType: "live_match", label: "live_match（赛中）", configuredMinutes: 3, effectiveMinutes: 15 },
  { jobType: "near_match", label: "near_match（赛前 24h-2h）", configuredMinutes: 30, effectiveMinutes: 30 },
];

describe("deploy-preflight 报告渲染", () => {
  it("分钟/小时格式化", () => {
    expect(formatMinutes(3)).toBe("3 分钟");
    expect(formatMinutes(30)).toBe("30 分钟");
    expect(formatMinutes(60)).toBe("1 小时");
    expect(formatMinutes(360)).toBe("6 小时");
    expect(formatMinutes(1440)).toBe("24 小时");
  });

  it("CloudBase：3 分钟被 15 分钟粒度限制时给出警告", () => {
    const report = buildReport({ target: "cloudbase", profile: "prod", tickMinutes: 15, rows: ROWS });
    expect(report.degraded.map((row) => row.jobType)).toEqual(["live_match"]);
    expect(report.text).toContain("cloudbase（腾讯云云函数）");
    expect(report.text).toContain("15 分钟");
    expect(report.text).toContain("← 被调度粒度限制");
    expect(report.text).toContain("想要「比赛比分 3 分钟级实时」，请部署到 VPS");
  });

  it("VPS：3 分钟生效时提示确认 systemd timer 已按模板安装", () => {
    const report = buildReport({
      target: "vps",
      profile: "prod",
      tickMinutes: 3,
      rows: ROWS.map((row) => ({ ...row, effectiveMinutes: row.configuredMinutes })),
    });
    expect(report.degraded).toEqual([]);
    expect(report.text).toContain("所有任务的配置间隔都能被调度粒度覆盖");
    expect(report.text).toContain("OnCalendar=*-*-* *:00/3:00");
  });
});

describe("部署链路上的提醒不会被摘掉", () => {
  it("cloudbase:deploy 的第一位是预检（npm pre 钩子对冒号脚本不生效，只能显式串）", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts["cloudbase:deploy"]).toMatch(/^npm run build && node scripts\/deploy-preflight\.mjs --target=cloudbase && /);
    expect(pkg.scripts["deploy:preflight"]).toBe("npm run build && node scripts/deploy-preflight.mjs");
    expect(pkg.scripts["vps:preflight"]).toBe("npm run build && node scripts/deploy-preflight.mjs --target=vps");
  });
});

describe("deploy-preflight main（需要 dist）", () => {
  it.skipIf(!DIST_READY)("cloudbase 目标输出降级任务，且默认不阻断部署", async () => {
    const chunks = [];
    const code = await main(["--target=cloudbase", "--json"], { FOOTBALL_SYNC_PROFILE: "prod" }, (line) => chunks.push(line));
    const parsed = JSON.parse(chunks.join("\n"));
    expect(code).toBe(0);
    expect(parsed.deploy_target).toBe("cloudbase");
    expect(parsed.tick_minutes).toBe(15);
    expect(parsed.degraded_jobs).toContain("live_match");
    expect(parsed.rows.find((row) => row.jobType === "live_match")?.effectiveMinutes).toBe(15);
  });

  it.skipIf(!DIST_READY)("--fail-on-degraded 时 CloudBase 上退出码为 1", async () => {
    const code = await main(["--target=cloudbase", "--json", "--fail-on-degraded"], { FOOTBALL_SYNC_PROFILE: "prod" }, () => {});
    expect(code).toBe(1);
  });

  it.skipIf(!DIST_READY)("vps 目标不出现降级任务", async () => {
    const chunks = [];
    const code = await main(["--target=vps", "--json"], { FOOTBALL_SYNC_PROFILE: "prod" }, (line) => chunks.push(line));
    const parsed = JSON.parse(chunks.join("\n"));
    expect(code).toBe(0);
    expect(parsed.tick_minutes).toBe(3);
    expect(parsed.degraded_jobs).toEqual([]);
    expect(parsed.rows.find((row) => row.jobType === "live_match")?.effectiveMinutes).toBe(3);
  });

  it("未知目标直接报错", async () => {
    await expect(main(["--target=aliyun"], {}, () => {})).rejects.toThrow(/未知部署目标/);
  });
});
