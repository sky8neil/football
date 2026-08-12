import { describe, expect, it } from "vitest";
import { SyncJobType } from "../domain/enums.js";
import { ProviderQuotaExceededError } from "../provider/http.js";
import {
  SYNC_RETRY_V1,
  SYNC_TASKS_V1,
  applyJitter,
  isQuotaExceededError,
  jobLockKey,
  nextRetryDelayMinutes,
} from "./config.js";

describe("SYNC_TASKS_V1（规范 32.1-32.6）", () => {
  it("future_schedule：未来 30 天、每 6 小时", () => {
    expect(SYNC_TASKS_V1[SyncJobType.FutureSchedule]).toMatchObject({
      lookaheadDays: 30,
      intervalHours: 6,
    });
  });

  it("full_schedule_verify：每天至少 1 次", () => {
    expect(SYNC_TASKS_V1[SyncJobType.FullScheduleVerify]).toMatchObject({
      intervalHours: 24,
    });
  });

  it("near_match：T-24h ~ T-2h、每 30 分钟", () => {
    expect(SYNC_TASKS_V1[SyncJobType.NearMatch]).toMatchObject({
      windowStartHoursBeforeKickoff: 24,
      windowEndHoursBeforeKickoff: 2,
      intervalMinutes: 30,
    });
  });

  it("live_match：T-2h ~ finished、每 3 分钟", () => {
    expect(SYNC_TASKS_V1[SyncJobType.LiveMatch]).toMatchObject({
      windowStartHoursBeforeKickoff: 2,
      intervalMinutes: 3,
    });
  });

  it("post_finish_verify：首次 finished 后高频确认直到首次 settlement 开始", () => {
    expect(SYNC_TASKS_V1[SyncJobType.PostFinishVerify]).toMatchObject({
      intervalMinutes: 3,
      highFrequencyUntilFirstSettlement: true,
    });
  });

  it("period_finalize：每小时", () => {
    expect(SYNC_TASKS_V1[SyncJobType.PeriodFinalize]).toMatchObject({
      intervalHours: 1,
    });
  });
});

describe("重试策略（规范 32.8）", () => {
  it("退避延迟 1/2/5/10/30 分钟，最多 5 次重试", () => {
    expect(nextRetryDelayMinutes(0)).toBe(1);
    expect(nextRetryDelayMinutes(1)).toBe(2);
    expect(nextRetryDelayMinutes(2)).toBe(5);
    expect(nextRetryDelayMinutes(3)).toBe(10);
    expect(nextRetryDelayMinutes(4)).toBe(30);
    expect(nextRetryDelayMinutes(5)).toBeNull();
  });

  it("jitter ±20%（random=0.5 时无抖动，0/1 为边界）", () => {
    expect(applyJitter(10, 20, () => 0.5)).toBe(10);
    expect(applyJitter(10, 20, () => 0)).toBe(8);
    expect(applyJitter(10, 20, () => 1)).toBe(12);
  });

  it("quota 超限停止高频自动重试（等 reset 或下一正常 run）", () => {
    expect(SYNC_RETRY_V1.quotaExceededStopsAutoRetry).toBe(true);
    expect(isQuotaExceededError(new ProviderQuotaExceededError(null))).toBe(true);
    expect(isQuotaExceededError(new Error("network down"))).toBe(false);
  });
});

describe("任务边界（规范 32.7）", () => {
  it("同类任务锁 key 为 sync:{job_type}", () => {
    expect(jobLockKey(SyncJobType.FutureSchedule)).toBe("sync:future_schedule");
    expect(jobLockKey(SyncJobType.LiveMatch)).toBe("sync:live_match");
    expect(jobLockKey(SyncJobType.PostFinishVerify)).toBe("sync:post_finish_verify");
  });
});
