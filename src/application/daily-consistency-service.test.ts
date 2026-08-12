import { describe, expect, it, vi } from "vitest";
import type { DailyConsistencyInput } from "./daily-consistency.js";
import {
  DAILY_CONSISTENCY_LOCK_KEY,
  DailyConsistencyService,
} from "./daily-consistency-service.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");

function emptyInput(): DailyConsistencyInput {
  return {
    career: [],
    season_stats: [],
    rankings: [],
    active_settlements: [],
  };
}

function makeLockRepository(acquired: boolean) {
  return {
    acquire: vi.fn(
      async (_lockKey: string, _ownerId: string, _leaseUntil: Date) => acquired,
    ),
    renew: vi.fn(
      async (_lockKey: string, _ownerId: string, _leaseUntil: Date) => true,
    ),
    release: vi.fn(async (_lockKey: string, _ownerId: string) => undefined),
  };
}

describe("DailyConsistencyService", () => {
  it("在 daily consistency lock 内加载快照并只返回差异告警", async () => {
    const lockRepository = makeLockRepository(true);
    const syncLogs = { insert: vi.fn(async () => undefined), update: vi.fn(async () => undefined) };
    const input = emptyInput();
    const source = {
      load: vi.fn(async (serverNow: Date) => {
        expect(serverNow).toBe(NOW);
        return input;
      }),
    };
    const service = new DailyConsistencyService(
      { jobLocks: lockRepository, syncLogs },
      source,
    );

    await expect(service.run(NOW)).resolves.toEqual({
      kind: "completed",
      checked_at: NOW,
      differences: [],
      skipped_active_settlement: [],
    });
    expect(lockRepository.acquire).toHaveBeenCalledWith(
      DAILY_CONSISTENCY_LOCK_KEY,
      expect.any(String),
      expect.any(Date),
    );
    const leaseUntil = lockRepository.acquire.mock.calls[0]?.[2] as Date;
    expect(leaseUntil.getTime()).toBe(NOW.getTime() + 10 * 60 * 1000);
    expect(source.load).toHaveBeenCalledTimes(1);
    expect(lockRepository.release).toHaveBeenCalledWith(
      DAILY_CONSISTENCY_LOCK_KEY,
      expect.any(String),
    );
  });

  it("已有 daily consistency lease 时跳过本轮且不读取快照", async () => {
    const lockRepository = makeLockRepository(false);
    const syncLogs = { insert: vi.fn(async () => undefined), update: vi.fn(async () => undefined) };
    const source = { load: vi.fn(async () => emptyInput()) };
    const service = new DailyConsistencyService(
      { jobLocks: lockRepository, syncLogs },
      source,
    );

    await expect(service.run(NOW)).resolves.toEqual({
      kind: "skipped",
      checked_at: NOW,
      reason: "lock_held",
    });
    expect(source.load).not.toHaveBeenCalled();
    expect(lockRepository.release).not.toHaveBeenCalled();
  });

  it("无效 server_now 时在获取 lease 前 Fail Closed", async () => {
    const lockRepository = makeLockRepository(true);
    const syncLogs = {
      insert: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
    };
    const source = { load: vi.fn(async () => emptyInput()) };
    const service = new DailyConsistencyService(
      { jobLocks: lockRepository, syncLogs },
      source,
    );

    await expect(service.run(new Date("invalid"))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(lockRepository.acquire).not.toHaveBeenCalled();
    expect(source.load).not.toHaveBeenCalled();
    expect(syncLogs.insert).not.toHaveBeenCalled();
  });

  it("缺少 sync_logs repository 时在获取 lease 前 Fail Closed", async () => {
    const lockRepository = makeLockRepository(true);
    const source = { load: vi.fn(async () => emptyInput()) };
    const service = new DailyConsistencyService(
      { jobLocks: lockRepository },
      source,
    );

    await expect(service.run(NOW)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    expect(lockRepository.acquire).not.toHaveBeenCalled();
    expect(source.load).not.toHaveBeenCalled();
  });

  it("快照加载失败时仍释放 lease 并原样抛出错误", async () => {
    const lockRepository = makeLockRepository(true);
    const syncLogs = { insert: vi.fn(async () => undefined), update: vi.fn(async () => undefined) };
    const failure = new Error("snapshot unavailable");
    const source = { load: vi.fn(async () => Promise.reject(failure)) };
    const service = new DailyConsistencyService(
      { jobLocks: lockRepository, syncLogs },
      source,
    );

    await expect(service.run(NOW)).rejects.toBe(failure);
    expect(lockRepository.release).toHaveBeenCalledWith(
      DAILY_CONSISTENCY_LOCK_KEY,
      expect.any(String),
    );
    expect(syncLogs.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      items_failed: 1,
      last_error_code: "INTERNAL_ERROR",
      last_error_message: "snapshot unavailable",
    }));
  });

  it("完成校验后写入 daily_consistency sync log 摘要", async () => {
    const lockRepository = makeLockRepository(true);
    const syncLogs = {
      insert: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
    };
    const source = {
      load: vi.fn(async () => ({
        career: [
          {
            user_id: "user-1",
            actual: {
              career_points: 0,
              career_valid_predictions: 0,
              career_wdl_hits: 0,
              career_exact_hits: 0,
              career_level: 1,
              career_best_level: 1,
            },
            expected: {
              career_points: 1,
              career_valid_predictions: 0,
              career_wdl_hits: 0,
              career_exact_hits: 0,
              career_level: 1,
              career_best_level: 1,
            },
          },
        ],
        season_stats: [],
        rankings: [],
        active_settlements: [],
      })),
    };
    const service = new DailyConsistencyService(
      { jobLocks: lockRepository, syncLogs },
      source,
    );

    await service.run(NOW);

    expect(syncLogs.insert).toHaveBeenCalledWith(expect.objectContaining({
      job_type: "daily_consistency",
      status: "running",
      attempt_count: 1,
      items_read: 0,
      items_changed: 0,
      items_failed: 0,
      finished_at: null,
    }));
    expect(syncLogs.update).toHaveBeenCalledWith(expect.objectContaining({
      job_type: "daily_consistency",
      status: "success",
      attempt_count: 1,
      items_read: 1,
      items_changed: 1,
      items_failed: 0,
      finished_at: NOW,
      last_error_code: "DAILY_CONSISTENCY_MISMATCH",
      last_error_message: "career:user-1 [career_points]",
    }));
  });

  it("发现缓存差异时在成功日志中持久化可定位的报警摘要", async () => {
    const lockRepository = makeLockRepository(true);
    const syncLogs = {
      insert: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
    };
    const source = {
      load: vi.fn(async () => ({
        career: [
          {
            user_id: "user-1",
            actual: {
              career_points: 0,
              career_valid_predictions: 0,
              career_wdl_hits: 0,
              career_exact_hits: 0,
              career_level: 1,
              career_best_level: 1,
            },
            expected: {
              career_points: 3,
              career_valid_predictions: 1,
              career_wdl_hits: 1,
              career_exact_hits: 0,
              career_level: 1,
              career_best_level: 1,
            },
          },
        ],
        season_stats: [],
        rankings: [],
        active_settlements: [],
      })),
    };

    await new DailyConsistencyService(
      { jobLocks: lockRepository, syncLogs },
      source,
    ).run(NOW);

    expect(syncLogs.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "success",
      items_changed: 1,
      last_error_code: "DAILY_CONSISTENCY_MISMATCH",
      last_error_message: "career:user-1 [career_points,career_valid_predictions,career_wdl_hits]",
    }));
  });

  it("跳过 active settlement 范围时在成功日志中记录可定位摘要", async () => {
    const lockRepository = makeLockRepository(true);
    const syncLogs = {
      insert: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
    };
    const source = {
      load: vi.fn(async (): Promise<DailyConsistencyInput> => ({
        career: [
          {
            user_id: "user-1",
            actual: {
              career_points: 0,
              career_valid_predictions: 0,
              career_wdl_hits: 0,
              career_exact_hits: 0,
              career_level: 1,
              career_best_level: 1,
            },
            expected: {
              career_points: 3,
              career_valid_predictions: 1,
              career_wdl_hits: 1,
              career_exact_hits: 0,
              career_level: 1,
              career_best_level: 1,
            },
          },
        ],
        season_stats: [
          {
            user_id: "user-1",
            season_id: "season-1",
            actual: {
              points: 0,
              valid_predictions: 0,
              wdl_hits: 0,
              exact_hits: 0,
              level: 1,
              best_level: 1,
            },
            expected: {
              points: 3,
              valid_predictions: 1,
              wdl_hits: 1,
              exact_hits: 0,
              level: 1,
              best_level: 1,
            },
          },
        ],
        rankings: [
          {
            period_type: "week",
            period_key: "2026-W32",
            user_id: "user-1",
            actual: {
              period_score: 0,
              valid_predictions: 0,
              wdl_hits: 0,
              exact_hits: 0,
              last_scoring_match_at: null,
              global_rank: null,
            },
            expected: {
              period_score: 3,
              valid_predictions: 1,
              wdl_hits: 1,
              exact_hits: 0,
              last_scoring_match_at: NOW,
              global_rank: null,
            },
          },
        ],
        active_settlements: [
          {
            match_id: "match-1",
            user_ids: ["user-1"],
            season_id: "season-1",
            periods: [
              { period_type: "week", period_key: "2026-W32" },
              { period_type: "month", period_key: "2026-08" },
            ],
          },
        ],
      })),
    };

    const result = await new DailyConsistencyService(
      { jobLocks: lockRepository, syncLogs },
      source,
    ).run(NOW);

    expect(result).toMatchObject({
      kind: "completed",
      differences: [],
      skipped_active_settlement: [
        expect.objectContaining({
          kind: "skipped_active_settlement",
          match_id: "match-1",
        }),
      ],
    });
    expect(syncLogs.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "success",
      items_changed: 0,
      last_error_code: null,
      last_error_message:
        "skipped_active_settlement:match-1 [users:user-1;season:season-1;periods:week:2026-W32,month:2026-08]",
    }));
  });

  it("长时间读取事实快照期间续租 daily consistency lease", async () => {
    vi.useFakeTimers({ now: NOW });
    let releaseSnapshot: ((input: DailyConsistencyInput) => void) | undefined;
    const snapshot = new Promise<DailyConsistencyInput>((resolve) => {
      releaseSnapshot = resolve;
    });
    const lockRepository = makeLockRepository(true);
    const syncLogs = {
      insert: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
    };
    const source = { load: vi.fn(async () => snapshot) };
    const runPromise = new DailyConsistencyService(
      { jobLocks: lockRepository, syncLogs },
      source,
    ).run(NOW);

    try {
      for (let attempt = 0; attempt < 5 && source.load.mock.calls.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      expect(source.load).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(lockRepository.renew).toHaveBeenCalledWith(
        DAILY_CONSISTENCY_LOCK_KEY,
        expect.any(String),
        expect.any(Date),
      );

      if (releaseSnapshot === undefined) {
        throw new Error("snapshot gate was not initialized");
      }
      releaseSnapshot(emptyInput());
      await expect(runPromise).resolves.toMatchObject({ kind: "completed" });
    } finally {
      releaseSnapshot?.(emptyInput());
      await runPromise.catch(() => undefined);
      vi.useRealTimers();
    }
  });
});
