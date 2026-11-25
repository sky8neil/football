import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("VPS09 templates match compiled entries", () => {
  const apiUnit = read("ops/vps/football-api.service");
  const jobsUnit = read("ops/vps/football-jobs.service");
  const jobsTimer = read("ops/vps/football-jobs.timer");
  const periodicUnit = read("ops/vps/football-periodic.service");
  const periodicTimer = read("ops/vps/football-periodic.timer");
  const caddy = read("ops/vps/Caddyfile");
  const vpsReadme = read("ops/vps/README.md");
  const vpsEnv = read("ops/vps/football.env.example");
  const cloudEnv = read("ops/vps/cloudbase.env.example");
  const pkg = JSON.parse(read("package.json"));
  const httpSrc = read("src/gateway/http.ts");
  const tickSrc = read("src/jobs/tick.ts");
  const cloudIndex = read("cloudfunctions/api/index.js");
  const cloudTimer = JSON.parse(read("cloudfunctions/api/config.json"));
  const tsconfigBuild = JSON.parse(read("tsconfig.build.json"));
  const tsconfigCloud = JSON.parse(read("tsconfig.cloudfunction.json"));

  it("API unit starts the build output of src/gateway/http.ts", () => {
    expect(tsconfigBuild.compilerOptions.outDir).toBe("dist");
    expect(tsconfigBuild.compilerOptions.rootDir).toBe("src");
    expect(pkg.scripts.build).toBe("tsc -p tsconfig.build.json");
    expect(httpSrc).toContain('export const GATEWAY_LISTEN_HOST = "127.0.0.1"');
    expect(httpSrc).toContain("export const GATEWAY_LISTEN_PORT = 8787");
    expect(httpSrc).toContain('deps.onceSignal("SIGTERM", onSignal)');
    expect(httpSrc).toContain("process.once(signal, listener)");
    expect(httpSrc).toContain("server.close((err) =>");
    expect(apiUnit).toContain("After=network-online.target postgresql.service");
    expect(apiUnit).toContain("Wants=network-online.target");
    expect(apiUnit).toContain("ExecStart=/usr/bin/node /home/neilxu/football/current/dist/gateway/http.js");
    expect(apiUnit).toContain("EnvironmentFile=/home/neilxu/football/shared/football.env");
    expect(apiUnit).toContain("Type=simple");
    expect(apiUnit).toContain("LimitNOFILE=65536");
    expect(apiUnit).toContain("MemoryMax=512M");
    expect(apiUnit).toContain("TimeoutStopSec=30");
    expect(apiUnit).toContain("NoNewPrivileges=true");
    expect(apiUnit).toContain("PrivateTmp=true");
    expect(apiUnit).not.toMatch(/\bPORT=/);
  });

  it("jobs unit and npm script start dist/jobs/tick.js", () => {
    expect(pkg.scripts["jobs:tick"]).toBe("npm run build && node dist/jobs/tick.js");
    expect(tickSrc).toContain("if (isDirectRun())");
    expect(tickSrc).toContain("void runJobsTick()");
    expect(jobsUnit).toContain("ExecStart=/usr/bin/node /home/neilxu/football/current/dist/jobs/tick.js --mode=realtime");
    expect(jobsUnit).toContain("Type=oneshot");
    expect(jobsUnit).toContain("Environment=FOOTBALL_PG_POOL_MAX=5");
    expect(jobsUnit).toContain("TimeoutStartSec=150");
    expect(jobsTimer).toContain("OnCalendar=*-*-* *:00/3:00");
    expect(jobsTimer).toContain("Persistent=true");
    expect(jobsTimer).toContain("Unit=football-jobs.service");
    expect(jobsTimer).toContain("AccuracySec=10s");
    expect(periodicUnit).toContain("ExecStart=/usr/bin/node /home/neilxu/football/current/dist/jobs/tick.js --mode=periodic");
    expect(periodicUnit).toContain("Type=oneshot");
    expect(periodicUnit).toContain("Environment=FOOTBALL_PG_POOL_MAX=5");
    expect(periodicUnit).toContain("TimeoutStartSec=600");
    expect(periodicTimer).toContain("OnCalendar=*-*-* *:01/15:00");
    expect(periodicTimer).toContain("Persistent=true");
    expect(periodicTimer).toContain("Unit=football-periodic.service");
    expect(periodicTimer).toContain("AccuracySec=10s");
  });

  it("ops/vps/README.md documents periodic timer, chmod 600, /admin/ and --issue-login", () => {
    expect(vpsReadme).toContain("football-periodic.service");
    expect(vpsReadme).toContain("football-periodic.timer");
    expect(vpsReadme).toContain("*:01/15:00");
    expect(vpsReadme).toContain("chmod 600");
    expect(vpsReadme).toContain("/admin/");
    expect(vpsReadme).toContain("--issue-login");
  });

  it("Caddy fragment proxies the compiled listen address", () => {
    expect(caddy).toContain("reverse_proxy 127.0.0.1:8787");
    expect(caddy).toContain("api.example.com");
  });

  it("env examples list mode-specific required keys and no real secrets", () => {
    for (const key of [
      "FOOTBALL_ENVIRONMENT",
      "FOOTBALL_REPOSITORY_BACKEND=postgres",
      "FOOTBALL_DATABASE_URL",
      "FOOTBALL_DATABASE_SCHEMA",
      "FOOTBALL_RESOURCE_NAMESPACE",
      "FOOTBALL_MATCH_CURSOR_SECRET",
      "FOOTBALL_WECHAT_APP_ID",
      "FOOTBALL_WECHAT_APP_SECRET",
      "FOOTBALL_SESSION_TTL_SECONDS",
    ]) {
      expect(vpsEnv).toContain(key);
    }
    expect(vpsEnv).toContain("replace-me");
    expect(vpsEnv).not.toMatch(/\bAKID[0-9A-Za-z]+/);
    expect(vpsEnv).not.toMatch(/\bwx[a-f0-9]{16}\b/);
    expect(vpsEnv).not.toMatch(/postgres:\/\/[^:]+:(?!replace-me(?:@|$))[^@\s]{12,}@/);
    for (const key of [
      "FOOTBALL_ENVIRONMENT",
      "FOOTBALL_REPOSITORY_BACKEND=cloudbase",
      "FOOTBALL_CLOUD_ENVIRONMENT_ID",
      "FOOTBALL_RESOURCE_NAMESPACE",
      "FOOTBALL_MATCH_CURSOR_SECRET",
    ]) {
      expect(cloudEnv).toContain(key);
    }
    expect(cloudEnv).not.toContain("TENCENTCLOUD_SECRET_ID=");
    expect(cloudEnv).not.toContain("FOOTBALL_WECHAT_APP_SECRET=");
    expect(cloudEnv).not.toContain("FOOTBALL_DATABASE_URL=");
  });

  it("CloudBase package entry and timer match current runtime", () => {
    expect(tsconfigCloud.compilerOptions.outDir).toBe("cloudfunctions/api/dist");
    expect(cloudIndex).toContain('require("./dist/cloud-function/runtime.js")');
    expect(cloudTimer.triggers).toEqual([
      { name: "everyMinuteProviderSync", type: "timer", config: "0 */10 * * * * *" },
    ]);
    expect(pkg.scripts["cloudfunction:build"]).toContain("tsconfig.cloudfunction.json");
  });
});
