import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("timer trigger (RP01)", () => {
  const config = JSON.parse(readFileSync(resolve(ROOT, "cloudfunctions/api/config.json"), "utf8"));
  const source = readFileSync(resolve(ROOT, "scripts/cloudbase-deploy-function.mjs"), "utf8");

  it("config.json 恰好 1 个 Timer，名称沿用 everyMinuteProviderSync", () => {
    expect(config.triggers).toHaveLength(1);
    expect(config.triggers[0].name).toBe("everyMinuteProviderSync");
    expect(config.triggers[0].type).toBe("timer");
  });

  it("cron 为 7 段，秒段 0、分钟段 */10", () => {
    const cron = config.triggers[0].config;
    const parts = cron.split(" ");
    expect(parts).toHaveLength(7);
    expect(parts[0]).toBe("0");
    expect(parts[1]).toBe("*/10");
  });

  it("脚本 TIMER_CRON 与 config.json 字面一致", () => {
    const match = source.match(/TIMER_CRON\s*=\s*"([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match[1]).toBe(config.triggers[0].config);
  });

  it("TIMER_INTERVAL_MINUTES = 10", () => {
    const match = source.match(/TIMER_INTERVAL_MINUTES\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBe(10);
  });
});
