import { describe, expect, it } from "vitest";
import { SyncJobType } from "../domain/enums.js";
import {
  DEPLOY_TARGETS,
  SCHEDULER_TICK_MINUTES,
  effectiveRefreshMinutes,
  isDeployTarget,
  resolveDeployTarget,
  schedulerTickMinutes,
} from "./deploy-target.js";

describe("部署目标解析", () => {
  it("显式 FOOTBALL_DEPLOY_TARGET 优先于仓库后端", () => {
    expect(resolveDeployTarget({ FOOTBALL_DEPLOY_TARGET: "vps", FOOTBALL_REPOSITORY_BACKEND: "cloudbase" })).toBe("vps");
    expect(resolveDeployTarget({ FOOTBALL_DEPLOY_TARGET: "cloudbase", FOOTBALL_REPOSITORY_BACKEND: "postgres" })).toBe("cloudbase");
    expect(resolveDeployTarget({ FOOTBALL_DEPLOY_TARGET: "VPS" })).toBe("vps");
  });

  it("未设置时按后端推断：cloudbase 后端 → cloudbase，其余 → vps", () => {
    expect(resolveDeployTarget({ FOOTBALL_REPOSITORY_BACKEND: "cloudbase" })).toBe("cloudbase");
    expect(resolveDeployTarget({ FOOTBALL_REPOSITORY_BACKEND: "postgres" })).toBe("vps");
    expect(resolveDeployTarget({})).toBe("vps");
    expect(resolveDeployTarget({ FOOTBALL_DEPLOY_TARGET: "  " })).toBe("vps");
  });

  it("非法取值直接抛错，不静默按 VPS 跑", () => {
    expect(() => resolveDeployTarget({ FOOTBALL_DEPLOY_TARGET: "tencent" })).toThrow(
      /FOOTBALL_DEPLOY_TARGET must be one of: vps, cloudbase/,
    );
    expect(isDeployTarget("vps")).toBe(true);
    expect(isDeployTarget("aliyun")).toBe(false);
  });
});

describe("调度粒度与真实刷新频率", () => {
  it("默认 tick：VPS 3 分钟，CloudBase 15 分钟", () => {
    expect(SCHEDULER_TICK_MINUTES).toEqual({ vps: 3, cloudbase: 15 });
    expect(DEPLOY_TARGETS).toEqual(["vps", "cloudbase"]);
    expect(schedulerTickMinutes("vps")).toBe(3);
    expect(schedulerTickMinutes("cloudbase")).toBe(15);
  });

  it("live_match 的 3 分钟在 VPS 生效，在 CloudBase 退化为 15 分钟", () => {
    expect(effectiveRefreshMinutes(SyncJobType.LiveMatch, "prod", "vps")).toBe(3);
    expect(effectiveRefreshMinutes(SyncJobType.LiveMatch, "test", "vps")).toBe(3);
    expect(effectiveRefreshMinutes(SyncJobType.LiveMatch, "prod", "cloudbase")).toBe(15);
    expect(effectiveRefreshMinutes(SyncJobType.LiveMatch, "test", "cloudbase")).toBe(15);
  });

  it("比 tick 更长的间隔不受部署目标影响", () => {
    expect(effectiveRefreshMinutes(SyncJobType.NearMatch, "prod", "vps")).toBe(30);
    expect(effectiveRefreshMinutes(SyncJobType.NearMatch, "prod", "cloudbase")).toBe(30);
    expect(effectiveRefreshMinutes(SyncJobType.FutureSchedule, "test", "cloudbase")).toBe(12 * 60);
    expect(effectiveRefreshMinutes(SyncJobType.FullScheduleVerify, "prod", "vps")).toBe(24 * 60);
  });
});
