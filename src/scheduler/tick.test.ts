import { describe, expect, it, vi } from "vitest";
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { MatchStatus, Provider, SettlementStatus, SyncJobType } from "../domain/enums.js";
import { internalError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import type { Match } from "../domain/types.js";
import { InMemoryRepository, type JobLockRepository } from "../infrastructure/repositories.js";
import { ProviderFixtureSyncService } from "../application/provider-fixture-sync.js";
import {
  ProviderFixtureSyncJobService,
  type ProviderFixtureBatchItem,
  type ProviderFixtureBatchLoader,
} from "../application/provider-sync-job.js";
import { makeApiFixture } from "../provider/fixture-factory.js";
import { ProviderHttpError } from "../provider/http.js";
import { jobLockKey } from "../sync/config.js";
import {
  SCHEDULER_LEASE_MS,
  SchedulerTick,
  type SchedulerLogEntry,
  type SchedulerRunner,
  type SchedulerRunnerMap,
} from "./tick.js";

const SERVER_NOW = new Date("2026-08-13T12:00:00.000Z");
const OWNER_ID = "instance-test-host-1";

function makeMatch(): Match {
  const kickoffAt = new Date("2026-08-13T14:00:00.000Z");
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
    created_at: SERVER_NOW,
    updated_at: SERVER_NOW,
  };
}

async function seedMappedMatch(repo: InMemoryRepository, match: Match): Promise<void> {
  await repo.matches.insert(match);
  await repo.matchProviderMappings.insert({
    schema_version: 1,
    match_id: match.match_id,
    provider: Provider.ApiFootball,
    provider_match_id: "1200001",
    created_at: SERVER_NOW,
    updated_at: SERVER_NOW,
  });
}

function batchItem(): ProviderFixtureBatchItem {
  return {
    fixture: makeApiFixture({
      fixtureId: 1200001,
      statusShort: "1H",
      date: "2026-08-13T14:00:00.000Z",
      timestamp: Date.parse("2026-08-13T14:00:00.000Z") / 1000,
      round: "Regular Season - 1",
    }),
    payload: { fixture_id: 1200001 },
  };
}

function createRunners(
  overrides: Partial<Record<SyncJobType, SchedulerRunner>> = {},
): SchedulerRunnerMap {
  const runners = {} as SchedulerRunnerMap;
  for (const jobType of Object.values(SyncJobType)) {
    const impl = overrides[jobType] ?? (async () => ({}));
    runners[jobType] = vi.fn(impl);
  }
  return runners;
}

function createLocks(acquireResult = true): JobLockRepository & {
  acquire: ReturnType<typeof vi.fn>;
  renew: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  return {
    acquire: vi.fn(async () => acquireResult),
    renew: vi.fn(async () => true),
    release: vi.fn(async () => undefined),
  };
}

function createTick(options: {
  acquire?: boolean;
  runners?: Partial<Record<SyncJobType, SchedulerRunner>>;
  now?: () => number;
  logs?: SchedulerLogEntry[];
  locks?: ReturnType<typeof createLocks>;
} = {}) {
  const locks = options.locks ?? createLocks(options.acquire ?? true);
  const runners = createRunners(options.runners);
  const logs = options.logs ?? [];
  const deps = {
    jobLocks: locks,
    runners,
    ownerId: OWNER_ID,
    log: (entry: SchedulerLogEntry) => {
      logs.push(entry);
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  return {
    tick: new SchedulerTick(deps),
    locks,
    runners,
    logs,
  };
}

describe("SchedulerTick", () => {
  it("acquire 成功则调用 runner、返回 completed、释放锁，且日志字段齐全", async () => {
    const runner = vi.fn(async (serverNow: Date) => {
      expect(serverNow).toBe(SERVER_NOW);
      return { items_read: 4, items_changed: 2, items_failed: 0 };
    });
    let clock = 1_000;
    const { tick, locks, logs } = createTick({
      runners: { [SyncJobType.LiveMatch]: runner },
      now: () => {
        const value = clock;
        clock += 15;
        return value;
      },
    });

    await expect(tick.run(SyncJobType.LiveMatch, SERVER_NOW)).resolves.toEqual({
      outcome: "completed",
      items_read: 4,
      items_changed: 2,
      items_failed: 0,
    });

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(SERVER_NOW);
    expect(locks.acquire).toHaveBeenCalledTimes(1);
    expect(locks.acquire).toHaveBeenCalledWith(
      jobLockKey(SyncJobType.LiveMatch),
      OWNER_ID,
      new Date(SERVER_NOW.getTime() + SCHEDULER_LEASE_MS),
    );
    expect(SCHEDULER_LEASE_MS).toBe(FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60_000);
    expect(locks.release).toHaveBeenCalledTimes(1);
    expect(locks.release).toHaveBeenCalledWith(
      jobLockKey(SyncJobType.LiveMatch),
      OWNER_ID,
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      job_type: SyncJobType.LiveMatch,
      outcome: "completed",
      started_at: "1970-01-01T00:00:01.000Z",
      finished_at: "1970-01-01T00:00:01.015Z",
      duration_ms: 15,
      lock_key: "sync:live_match",
      owner_id: OWNER_ID,
      items_read: 4,
      items_changed: 2,
      items_failed: 0,
    });
    expect(logs[0]?.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("锁被他人持有时 skipped，不调用 runner，也不 release", async () => {
    const runner = vi.fn(async () => ({ items_read: 1 }));
    const { tick, locks, logs, runners } = createTick({
      acquire: false,
      runners: { [SyncJobType.FutureSchedule]: runner },
    });

    await expect(tick.run(SyncJobType.FutureSchedule, SERVER_NOW)).resolves.toEqual({
      outcome: "skipped",
    });

    expect(runner).not.toHaveBeenCalled();
    for (const jobType of Object.values(SyncJobType)) {
      expect(vi.mocked(runners[jobType])).not.toHaveBeenCalled();
    }
    expect(locks.acquire).toHaveBeenCalledTimes(1);
    expect(locks.release).not.toHaveBeenCalled();
    expect(logs).toEqual([
      expect.objectContaining({
        job_type: SyncJobType.FutureSchedule,
        outcome: "skipped",
        lock_key: "sync:future_schedule",
        owner_id: OWNER_ID,
      }),
    ]);
    expect(logs[0]?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(typeof logs[0]?.started_at).toBe("string");
    expect(typeof logs[0]?.finished_at).toBe("string");
  });

  it("ProviderHttpError 使 outcome=failed，释放锁，日志只含错误摘要", async () => {
    const error = new ProviderHttpError(502, "upstream unavailable");
    Object.assign(error, {
      apiKey: "sk-secret",
      payload: { raw: "fixture-json" },
      details: { authorization: "Bearer xyz" },
    });
    const runner = vi.fn(async () => {
      throw error;
    });
    const { tick, locks, logs } = createTick({
      runners: { [SyncJobType.NearMatch]: runner },
    });

    const result = await tick.run(SyncJobType.NearMatch, SERVER_NOW);

    expect(result).toEqual({ outcome: "failed", error });
    expect(locks.release).toHaveBeenCalledTimes(1);
    expect(locks.release).toHaveBeenCalledWith(
      jobLockKey(SyncJobType.NearMatch),
      OWNER_ID,
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      job_type: SyncJobType.NearMatch,
      outcome: "failed",
      lock_key: "sync:near_match",
      owner_id: OWNER_ID,
      error: {
        name: "ProviderHttpError",
        code: "PROVIDER_HTTP_502",
        message: "upstream unavailable",
        status: 502,
      },
    });
    expect(logs[0]?.error).toEqual({
      name: "ProviderHttpError",
      code: "PROVIDER_HTTP_502",
      message: "upstream unavailable",
      status: 502,
    });
    const serialized = JSON.stringify(logs[0]);
    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("fixture-json");
    expect(serialized).not.toContain("Bearer xyz");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("payload");
    expect(serialized).not.toContain("authorization");
  });

  it("账本 worker 的 internalError 使 outcome=failed，锁已释放且错误出现在日志", async () => {
    const error = internalError("settlement worker failed");
    const runner = vi.fn(async () => {
      throw error;
    });
    const { tick, locks, logs } = createTick({
      runners: { [SyncJobType.PostFinishVerify]: runner },
    });

    const result = await tick.run(SyncJobType.PostFinishVerify, SERVER_NOW);

    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") {
      throw new Error("expected failed outcome");
    }
    expect(result.error).toBe(error);
    expect(locks.release).toHaveBeenCalledTimes(1);
    expect(locks.release).toHaveBeenCalledWith(
      jobLockKey(SyncJobType.PostFinishVerify),
      OWNER_ID,
    );
    expect(logs[0]).toMatchObject({
      outcome: "failed",
      error: {
        name: "DomainError",
        code: "INTERNAL_ERROR",
        message: "settlement worker failed",
      },
    });
    expect(JSON.stringify(logs[0])).toContain("INTERNAL_ERROR");
    expect(JSON.stringify(logs[0])).toContain("settlement worker failed");
  });

  it("server_now 非法时抛 VALIDATION_ERROR，且不 acquire", async () => {
    const { tick, locks, runners } = createTick();

    await expect(tick.run(SyncJobType.DailyConsistency, new Date(Number.NaN)))
      .rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        details: { field: "server_now" },
      });
    await expect(
      tick.run(SyncJobType.DailyConsistency, { getTime: () => 1 } as Date),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    expect(locks.acquire).not.toHaveBeenCalled();
    expect(locks.release).not.toHaveBeenCalled();
    expect(vi.mocked(runners[SyncJobType.DailyConsistency])).not.toHaveBeenCalled();
  });

  it("未知 jobType 抛 VALIDATION_ERROR，且不 acquire", async () => {
    const { tick, locks } = createTick();

    await expect(
      tick.run("not_a_job" as SyncJobType, SERVER_NOW),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "job_type" },
    });
    expect(locks.acquire).not.toHaveBeenCalled();
    expect(locks.release).not.toHaveBeenCalled();
  });

  it("finally 总是对当前 owner 调用 release", async () => {
    const { tick, locks } = createTick({
      runners: {
        [SyncJobType.PeriodFinalize]: async () => ({ finalized_count: 1 }),
      },
    });

    await tick.run(SyncJobType.PeriodFinalize, SERVER_NOW);

    expect(locks.release).toHaveBeenCalledTimes(1);
    expect(locks.release.mock.calls[0]?.[1]).toBe(OWNER_ID);
    expect(locks.release).toHaveBeenCalledWith(
      "sync:period_finalize",
      OWNER_ID,
    );
  });

  it("lease 使用 server_now + JOB_LEASE_MINUTES，不用观测时钟", async () => {
    const { tick, locks } = createTick({
      now: () => Date.parse("2099-01-01T00:00:00.000Z"),
      runners: {
        [SyncJobType.FullScheduleVerify]: async () => ({ items_read: 0 }),
      },
    });

    await tick.run(SyncJobType.FullScheduleVerify, SERVER_NOW);

    expect(locks.acquire.mock.calls[0]?.[2]).toEqual(
      new Date(SERVER_NOW.getTime() + 10 * 60_000),
    );
  });

  it("按 job_type 只分发到对应 runner", async () => {
    const spies = Object.fromEntries(
      Object.values(SyncJobType).map((jobType) => [
        jobType,
        vi.fn(async () => ({ job: jobType })),
      ]),
    ) as Record<SyncJobType, ReturnType<typeof vi.fn>>;
    const { tick } = createTick({ runners: spies });

    await tick.run(SyncJobType.DailyConsistency, SERVER_NOW);

    expect(spies[SyncJobType.DailyConsistency]).toHaveBeenCalledTimes(1);
    for (const jobType of Object.values(SyncJobType)) {
      if (jobType !== SyncJobType.DailyConsistency) {
        expect(spies[jobType]).not.toHaveBeenCalled();
      }
    }
  });

  it("双层锁回归（RED）：tick 持锁后 runner 仍调 run() 内层 skipped，业务不执行", async () => {
    vi.useFakeTimers({ now: SERVER_NOW });
    try {
      const repo = new InMemoryRepository();
      const match = makeMatch();
      await seedMappedMatch(repo, match);
      const fixtureSync = new ProviderFixtureSyncService(repo);
      const job = new ProviderFixtureSyncJobService(repo, fixtureSync, {
        sleep: async () => undefined,
      });
      const load: ProviderFixtureBatchLoader = async () => [batchItem()];
      const runner: SchedulerRunner = (serverNow) =>
        job.run(SyncJobType.LiveMatch, load, serverNow);
      const tick = new SchedulerTick({
        jobLocks: repo.jobLocks,
        runners: createRunners({ [SyncJobType.LiveMatch]: runner }),
        ownerId: OWNER_ID,
        log: () => undefined,
      });

      const result = await tick.run(SyncJobType.LiveMatch, SERVER_NOW);

      expect(result).toMatchObject({
        outcome: "completed",
        kind: "skipped",
        reason: "lock_held",
      });
      await expect(repo.matches.findById(match.match_id)).resolves.toMatchObject({
        match_status: MatchStatus.Scheduled,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("双层锁回归（GREEN）：runner 改调 executeHeldByCaller 后批次被处理", async () => {
    vi.useFakeTimers({ now: SERVER_NOW });
    try {
      const repo = new InMemoryRepository();
      const match = makeMatch();
      await seedMappedMatch(repo, match);
      const fixtureSync = new ProviderFixtureSyncService(repo);
      const job = new ProviderFixtureSyncJobService(repo, fixtureSync, {
        sleep: async () => undefined,
      });
      const load: ProviderFixtureBatchLoader = async () => [batchItem()];
      const runner: SchedulerRunner = (serverNow) =>
        job.executeHeldByCaller(SyncJobType.LiveMatch, load, serverNow, OWNER_ID);
      const tick = new SchedulerTick({
        jobLocks: repo.jobLocks,
        runners: createRunners({ [SyncJobType.LiveMatch]: runner }),
        ownerId: OWNER_ID,
        log: () => undefined,
      });

      const result = await tick.run(SyncJobType.LiveMatch, SERVER_NOW);

      expect(result).toMatchObject({
        outcome: "completed",
        kind: "completed",
        job_type: SyncJobType.LiveMatch,
        items_read: 1,
        items_changed: 1,
        items_failed: 0,
      });
      await expect(repo.matches.findById(match.match_id)).resolves.toMatchObject({
        match_status: MatchStatus.Live,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
