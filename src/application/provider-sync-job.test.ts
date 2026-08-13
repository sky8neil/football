import { describe, expect, it, vi } from "vitest";
import { MatchStatus, SettlementStatus, SyncJobType } from "../domain/enums.js";
import { validationError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import type { Match, SyncLog } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { makeApiFixture } from "../provider/fixture-factory.js";
import {
  ProviderDataError,
  ProviderError,
  ProviderHttpError,
  ProviderQuotaExceededError,
} from "../provider/http.js";
import type { ApiFootballFixture } from "../provider/types.js";
import { ProviderFixtureSyncService } from "./provider-fixture-sync.js";
import {
  ProviderFixtureSyncJobService,
  type ProviderFixtureBatchItem,
} from "./provider-sync-job.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");

function makeMatch(): Match {
  const kickoffAt = new Date("2026-08-09T12:00:00.000Z");
  return {
    schema_version: 1,
    match_id: newUuid(),
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: newUuid(),
    away_team_id: newUuid(),
    kickoff_at: kickoffAt,
    kickoff_confirmed: true,
    prediction_deadline_at: new Date(kickoffAt.getTime() - 10 * 60 * 1000),
    prediction_closed_at: null,
    period_anchor_at: null,
    match_status: MatchStatus.Scheduled,
    settlement_status: SettlementStatus.Pending,
    regular_home_score: null,
    regular_away_score: null,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 0,
    settled_result_version: 0,
    result_source: null,
    scoring_rule_version: "scoring_v1",
    finish_detected_at: null,
    settled_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

async function seedMatch(
  repo: InMemoryRepository,
  match: Match,
  providerMatchId: string,
): Promise<void> {
  await repo.matches.insert(match);
  await repo.matchProviderMappings.insert({
    schema_version: 1,
    match_id: match.match_id,
    provider: "api_football",
    provider_match_id: providerMatchId,
    created_at: NOW,
    updated_at: NOW,
  });
}

function item(fixture: ApiFootballFixture): ProviderFixtureBatchItem {
  return { fixture, payload: { fixture_id: fixture.fixture.id } };
}

function recordingSyncLogs() {
  return {
    insert: vi.fn(async (_log: SyncLog) => undefined),
    update: vi.fn(async (_log: SyncLog) => undefined),
  };
}

describe("ProviderFixtureSyncJobService", () => {
  it("在 job lock 内批量应用 fixture，并记录 running/success 统计", async () => {
    const repo = new InMemoryRepository();
    const first = makeMatch();
    const second = makeMatch();
    await seedMatch(repo, first, "1100001");
    await seedMatch(repo, second, "1100002");
    const syncLogs = recordingSyncLogs();
    const load = vi.fn(async (serverNow: Date) => {
      expect(serverNow).toBe(NOW);
      return [
        item(makeApiFixture({ fixtureId: 1100001, statusShort: "TBD" })),
        item(makeApiFixture({ fixtureId: 1100002, statusShort: "FT", fulltimeHome: 2, fulltimeAway: 1 })),
      ];
    });

    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs },
      new ProviderFixtureSyncService(repo),
      { sleep: async () => undefined },
    );

    await expect(service.run(SyncJobType.FutureSchedule, load, NOW)).resolves.toEqual({
      kind: "completed",
      job_type: SyncJobType.FutureSchedule,
      items_read: 2,
      items_changed: 2,
      items_failed: 0,
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(syncLogs.insert).toHaveBeenCalledWith(expect.objectContaining({
      job_type: SyncJobType.FutureSchedule,
      status: "running",
      attempt_count: 1,
      items_read: 0,
      items_changed: 0,
      items_failed: 0,
      finished_at: null,
    }));
    expect(syncLogs.update).toHaveBeenCalledWith(expect.objectContaining({
      job_type: SyncJobType.FutureSchedule,
      status: "success",
      items_read: 2,
      items_changed: 2,
      items_failed: 0,
      finished_at: NOW,
    }));
    expect(await repo.matches.findById(second.match_id)).toMatchObject({
      match_status: MatchStatus.Finished,
      result_version: 1,
    });
  });

  it("Provider loader 失败时记录 failed log、释放锁且不改变比赛", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch();
    await seedMatch(repo, match, "1100003");
    const syncLogs = recordingSyncLogs();
    const failure = new Error("provider unavailable");
    const load = vi.fn(async () => Promise.reject(failure));
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs },
      new ProviderFixtureSyncService(repo),
      { sleep: async () => undefined },
    );

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).rejects.toBe(failure);
    expect(await repo.matches.findById(match.match_id)).toEqual(match);
    expect(syncLogs.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      items_failed: 1,
      last_error_code: "INTERNAL_ERROR",
      last_error_message: "provider unavailable",
    }));
  });

  it("暂时 loader 失败按 32.8 的首次退避重试后继续完成任务", async () => {
    const repo = new InMemoryRepository();
    const syncLogs = recordingSyncLogs();
    const sleep = vi.fn(async (_delayMs: number) => undefined);
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValueOnce([]);
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs },
      new ProviderFixtureSyncService(repo),
      { sleep, random: () => 0.5 },
    );

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toEqual({
      kind: "completed",
      job_type: SyncJobType.LiveMatch,
      items_read: 0,
      items_changed: 0,
      items_failed: 0,
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(60_000);
    expect(syncLogs.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "success",
      attempt_count: 2,
    }));
  });

  it("loader 重试边界固定为 5 次 retry，等待序列按 jitter 下界注入且不真实等待", async () => {
    const repo = new InMemoryRepository();
    const syncLogs = recordingSyncLogs();
    const sleep = vi.fn(async (_delayMs: number) => undefined);
    const load = vi.fn(async () => {
      if (load.mock.calls.length <= 5) {
        throw new Error(`temporary failure ${load.mock.calls.length}`);
      }
      return [];
    });
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs },
      new ProviderFixtureSyncService(repo),
      { sleep, random: () => 0 },
    );

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toEqual({
      kind: "completed",
      job_type: SyncJobType.LiveMatch,
      items_read: 0,
      items_changed: 0,
      items_failed: 0,
    });
    expect(load).toHaveBeenCalledTimes(6);
    expect(sleep.mock.calls.map(([delayMs]) => delayMs)).toEqual([
      48_000,
      96_000,
      240_000,
      480_000,
      1_440_000,
    ]);

    const updates = syncLogs.update.mock.calls.map(([log]) => log);
    expect(updates).toHaveLength(6);
    expect(updates.slice(0, 5)).toEqual(
      [1, 2, 3, 4, 5].map((attemptCount) =>
        expect.objectContaining({
          status: "running",
          attempt_count: attemptCount,
          finished_at: null,
          items_read: 0,
          items_changed: 0,
          items_failed: 0,
          last_error_code: "INTERNAL_ERROR",
        }),
      ),
    );
    expect(updates[5]).toEqual(expect.objectContaining({
      status: "success",
      attempt_count: 6,
      finished_at: NOW,
      last_error_code: null,
      last_error_message: null,
    }));
  });

  it("第五次 retry 后仍失败时不再等待，sync_log 记录第六次最终尝试", async () => {
    const repo = new InMemoryRepository();
    const syncLogs = recordingSyncLogs();
    const sleep = vi.fn(async () => undefined);
    const failure = new Error("provider unavailable");
    const load = vi.fn(async () => {
      throw failure;
    });
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs },
      new ProviderFixtureSyncService(repo),
      { sleep, random: () => 0.5 },
    );

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).rejects.toBe(failure);
    expect(load).toHaveBeenCalledTimes(6);
    expect(sleep).toHaveBeenCalledTimes(5);
    expect(syncLogs.update).toHaveBeenLastCalledWith(expect.objectContaining({
      status: "failed",
      attempt_count: 6,
      finished_at: NOW,
      items_failed: 1,
      last_error_code: "INTERNAL_ERROR",
      last_error_message: "provider unavailable",
    }));
  });

  it("按现有 Provider/domain 错误分类决定是否重试", async () => {
    const cases = [
      { name: "HTTP 408", error: new ProviderHttpError(408, "timeout"), retryable: true },
      { name: "HTTP 500", error: new ProviderHttpError(500, "server error"), retryable: true },
      { name: "HTTP 429", error: new ProviderHttpError(429, "rate limited"), retryable: false },
      { name: "Provider data", error: new ProviderDataError("invalid data"), retryable: false },
      { name: "Provider base error", error: new ProviderError("PROVIDER_ERROR", "failed"), retryable: false },
      { name: "domain validation", error: validationError("invalid loader input"), retryable: false },
      { name: "ordinary network error", error: new Error("network down"), retryable: true },
    ] as const;

    for (const testCase of cases) {
      const repo = new InMemoryRepository();
      const syncLogs = recordingSyncLogs();
      const sleep = vi.fn(async (_delayMs: number) => undefined);
      const load = vi.fn(async () => {
        if (load.mock.calls.length === 1) {
          throw testCase.error;
        }
        return [];
      });
      const service = new ProviderFixtureSyncJobService(
        { jobLocks: repo.jobLocks, syncLogs },
        new ProviderFixtureSyncService(repo),
        { sleep, random: () => 0.5 },
      );

      if (testCase.retryable) {
        await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toMatchObject({
          kind: "completed",
        });
        expect(load, testCase.name).toHaveBeenCalledTimes(2);
        expect(sleep, testCase.name).toHaveBeenCalledTimes(1);
      } else {
        await expect(service.run(SyncJobType.LiveMatch, load, NOW)).rejects.toBe(testCase.error);
        expect(load, testCase.name).toHaveBeenCalledTimes(1);
        expect(sleep, testCase.name).not.toHaveBeenCalled();
      }
    }
  });

  it("Provider quota 超限不自动重试并记录最终失败尝试次数", async () => {
    const repo = new InMemoryRepository();
    const syncLogs = recordingSyncLogs();
    const sleep = vi.fn(async (_delayMs: number) => undefined);
    const quotaError = new ProviderQuotaExceededError(null);
    const load = vi.fn(async () => Promise.reject(quotaError));
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs },
      new ProviderFixtureSyncService(repo),
      { sleep },
    );

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).rejects.toBe(quotaError);
    expect(load).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(syncLogs.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      attempt_count: 1,
      last_error_code: "PROVIDER_QUOTA_EXCEEDED",
    }));
  });

  it("单 fixture 的 fail-closed outcome 计入 items_failed 且批次仍完成", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch();
    await seedMatch(repo, match, "1100004");
    const syncLogs = recordingSyncLogs();
    const load = vi.fn(async () => [
      item(makeApiFixture({ fixtureId: 1100004, statusShort: "FT", fulltimeHome: null })),
    ]);
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs },
      new ProviderFixtureSyncService(repo),
    );

    await expect(service.run(SyncJobType.PostFinishVerify, load, NOW)).resolves.toEqual({
      kind: "completed",
      job_type: SyncJobType.PostFinishVerify,
      items_read: 1,
      items_changed: 0,
      items_failed: 1,
    });
    expect(await repo.matches.findById(match.match_id)).toEqual(match);
    expect(syncLogs.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "success",
      items_read: 1,
      items_changed: 0,
      items_failed: 1,
    }));
  });

  it("锁被占用时跳过任务，不加载 fixture 也不创建 sync log", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const repo = new InMemoryRepository();
      await repo.jobLocks.acquire(
        "sync:post_finish_verify",
        "other-owner",
        new Date(NOW.getTime() + 60_000),
      );
      const syncLogs = recordingSyncLogs();
      const load = vi.fn(async () => []);
      const service = new ProviderFixtureSyncJobService(
        { jobLocks: repo.jobLocks, syncLogs },
        new ProviderFixtureSyncService(repo),
      );

      await expect(service.run(SyncJobType.PostFinishVerify, load, NOW)).resolves.toEqual({
        kind: "skipped",
        job_type: SyncJobType.PostFinishVerify,
        reason: "lock_held",
      });
      expect(load).not.toHaveBeenCalled();
      expect(syncLogs.insert).not.toHaveBeenCalled();
      expect(syncLogs.update).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("按同类 job key 获取 lease，初次 lease 基于 server_now", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-08T00:00:00.000Z") });
    try {
      const acquire = vi.fn(async (_lockKey: string, _ownerId: string, _leaseUntil: Date) => true);
      const release = vi.fn(async (_lockKey: string, _ownerId: string) => undefined);
      const syncLogs = recordingSyncLogs();
      const service = new ProviderFixtureSyncJobService(
        {
          jobLocks: {
            acquire,
            renew: vi.fn(async () => true),
            release,
          },
          syncLogs,
        },
        { applyFixture: vi.fn(async () => ({
          kind: "failed" as const,
          match_id: null,
          anomaly_types: [],
        })) },
      );

      await expect(
        service.run(SyncJobType.NearMatch, async () => [], NOW),
      ).resolves.toMatchObject({ kind: "completed", job_type: SyncJobType.NearMatch });

      const acquireCall = acquire.mock.calls[0];
      expect(acquireCall?.[0]).toBe("sync:near_match");
      expect(acquireCall?.[2]).toEqual(new Date(NOW.getTime() + 10 * 60_000));
      expect(release).toHaveBeenCalledWith("sync:near_match", acquireCall?.[1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("在半 lease 节点续租，并用 lease wall-clock 计算新的到期时间", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const acquire = vi.fn(async (_lockKey: string, _ownerId: string, _leaseUntil: Date) => true);
      const renew = vi.fn(async (_lockKey: string, _ownerId: string, _leaseUntil: Date) => true);
      const syncLogs = recordingSyncLogs();
      let releaseLoad: ((items: readonly ProviderFixtureBatchItem[]) => void) | undefined;
      const load = vi.fn(
        () => new Promise<readonly ProviderFixtureBatchItem[]>((resolve) => {
          releaseLoad = resolve;
        }),
      );
      const service = new ProviderFixtureSyncJobService(
        {
          jobLocks: { acquire, renew, release: vi.fn(async () => undefined) },
          syncLogs,
        },
        { applyFixture: vi.fn(async () => ({
          kind: "failed" as const,
          match_id: null,
          anomaly_types: [],
        })) },
      );

      const runPromise = service.run(SyncJobType.LiveMatch, load, NOW);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(renew).toHaveBeenCalledTimes(1);
      const renewCall = renew.mock.calls[0];
      expect(renewCall?.[0]).toBe("sync:live_match");
      expect(renewCall?.[1]).toBe(acquire.mock.calls[0]?.[1]);
      expect(renewCall?.[2]).toEqual(new Date(NOW.getTime() + 15 * 60_000));

      releaseLoad?.([]);
      await expect(runPromise).resolves.toMatchObject({ kind: "completed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("续租失败后停止后续续租尝试", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const syncLogs = recordingSyncLogs();
      let releaseLoad: ((items: readonly ProviderFixtureBatchItem[]) => void) | undefined;
      const load = vi.fn(
        () => new Promise<readonly ProviderFixtureBatchItem[]>((resolve) => {
          releaseLoad = resolve;
        }),
      );
      const applyFixture = vi.fn(async () => ({
        kind: "failed" as const,
        match_id: null,
        anomaly_types: [],
      }));
      const jobLocks = {
        acquire: vi.fn(async () => true),
        renew: vi.fn(async () => false),
        release: vi.fn(async () => undefined),
      };
      const service = new ProviderFixtureSyncJobService(
        { jobLocks, syncLogs },
        { applyFixture },
      );

      const runPromise = service.run(SyncJobType.LiveMatch, load, NOW);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(jobLocks.renew).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(jobLocks.renew).toHaveBeenCalledTimes(1);

      releaseLoad?.([item(makeApiFixture({ fixtureId: 1100005, statusShort: "TBD" }))]);
      await expect(runPromise).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
      expect(applyFixture).not.toHaveBeenCalled();
      expect(syncLogs.update).toHaveBeenLastCalledWith(expect.objectContaining({
        status: "failed",
        last_error_code: "INTERNAL_ERROR",
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("续租异常后同样停止后续续租尝试并记录 failed log", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const syncLogs = recordingSyncLogs();
      const renewError = new Error("renew unavailable");
      let releaseLoad: ((items: readonly ProviderFixtureBatchItem[]) => void) | undefined;
      const load = vi.fn(
        () => new Promise<readonly ProviderFixtureBatchItem[]>((resolve) => {
          releaseLoad = resolve;
        }),
      );
      const jobLocks = {
        acquire: vi.fn(async () => true),
        renew: vi.fn(async () => {
          throw renewError;
        }),
        release: vi.fn(async () => undefined),
      };
      const service = new ProviderFixtureSyncJobService(
        { jobLocks, syncLogs },
        { applyFixture: vi.fn(async () => ({
          kind: "failed" as const,
          match_id: null,
          anomaly_types: [],
        })) },
      );

      const runPromise = service.run(SyncJobType.LiveMatch, load, NOW);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(jobLocks.renew).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(jobLocks.renew).toHaveBeenCalledTimes(1);

      releaseLoad?.([]);
      await expect(runPromise).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
        message: "Provider 同步锁续租失败",
      });
      expect(syncLogs.update).toHaveBeenLastCalledWith(expect.objectContaining({
        status: "failed",
        last_error_code: "INTERNAL_ERROR",
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("无效 server_now 时在获取 Provider job lock 前 Fail Closed", async () => {
    const jobLocks = {
      acquire: vi.fn(async () => true),
      renew: vi.fn(async () => true),
      release: vi.fn(async () => undefined),
    };
    const syncLogs = recordingSyncLogs();
    const load = vi.fn(async () => [] as ProviderFixtureBatchItem[]);
    const service = new ProviderFixtureSyncJobService(
      { jobLocks, syncLogs },
      {
        applyFixture: vi.fn(async () => ({
          kind: "failed" as const,
          match_id: null,
          anomaly_types: [],
        })),
      },
    );

    await expect(
      service.run(SyncJobType.LiveMatch, load, new Date("invalid")),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(jobLocks.acquire).not.toHaveBeenCalled();
    expect(syncLogs.insert).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
});
