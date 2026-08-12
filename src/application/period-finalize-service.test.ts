import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PeriodType } from "../domain/enums.js";
import type { RankingEntry } from "../domain/types.js";
import { InMemoryRepository, type AppRepository } from "../infrastructure/repositories.js";
import { PeriodFinalizeService } from "./period-finalize-service.js";

const NOW = new Date("2026-08-09T16:00:00.000Z");
const BEFORE_END = new Date("2026-08-09T15:59:59.999Z");

function makeRanking(overrides: Partial<RankingEntry> = {}): RankingEntry {
  return {
    schema_version: 1,
    period_type: PeriodType.Week,
    period_key: "2026-W32",
    user_id: "00000000-0000-4000-8000-000000000001",
    period_score: 12,
    valid_predictions: 1,
    wdl_hits: 1,
    exact_hits: 1,
    last_scoring_match_at: new Date("2026-08-08T06:00:00.000Z"),
    global_rank: null,
    is_final: false,
    created_at: new Date("2026-08-08T06:00:00.000Z"),
    updated_at: new Date("2026-08-08T06:00:00.000Z"),
    ...overrides,
  };
}

describe("PeriodFinalizeService", () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => vi.useRealTimers());

  it("封存任务写入 period_finalize 的 running/success sync log 摘要", async () => {
    const repo = new InMemoryRepository();
    await repo.rankings.insert(makeRanking());
    const insert = vi.fn(repo.syncLogs.insert);
    const update = vi.fn(repo.syncLogs.update);
    const repoWithSyncLogs = Object.create(repo) as AppRepository;
    Object.defineProperty(repoWithSyncLogs, "syncLogs", {
      value: { insert, update },
    });

    await new PeriodFinalizeService(repoWithSyncLogs).finalize(
      PeriodType.Week,
      "2026-W32",
      NOW,
    );

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      job_type: "period_finalize",
      status: "running",
      attempt_count: 1,
      items_read: 0,
      items_changed: 0,
      items_failed: 0,
      finished_at: null,
    }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      job_type: "period_finalize",
      status: "success",
      attempt_count: 1,
      items_read: 1,
      items_changed: 1,
      items_failed: 0,
      finished_at: NOW,
      last_error_code: null,
      last_error_message: null,
    }));
  });

  it("封存已结束周期内的所有 ranking，并保持已封存记录幂等", async () => {
    const repo = new InMemoryRepository();
    const entry = makeRanking();
    const alreadyFinal = makeRanking({
      user_id: "00000000-0000-4000-8000-000000000002",
      is_final: true,
    });
    await repo.rankings.insert(entry);
    await repo.rankings.insert(alreadyFinal);

    const service = new PeriodFinalizeService(repo);
    await expect(
      service.finalize(PeriodType.Week, "2026-W32", NOW),
    ).resolves.toMatchObject({ finalized_count: 1, skipped_count: 1 });

    await expect(repo.rankings.findByPeriod(PeriodType.Week, "2026-W32")).resolves.toEqual([
      expect.objectContaining({ user_id: entry.user_id, is_final: true, updated_at: NOW }),
      expect.objectContaining({ user_id: alreadyFinal.user_id, is_final: true }),
    ]);

    await expect(
      service.finalize(PeriodType.Week, "2026-W32", NOW),
    ).resolves.toMatchObject({ finalized_count: 0, skipped_count: 2 });
  });

  it("周期尚未结束时不写入 ranking", async () => {
    const repo = new InMemoryRepository();
    const entry = makeRanking();
    await repo.rankings.insert(entry);

    await expect(
      new PeriodFinalizeService(repo).finalize(
        PeriodType.Week,
        "2026-W32",
        BEFORE_END,
      ),
    ).resolves.toMatchObject({ finalized_count: 0, skipped_count: 0, due: false });
    await expect(repo.rankings.findByPeriod(PeriodType.Week, "2026-W32")).resolves.toEqual([
      entry,
    ]);
  });

  it("使用 period_finalize job lock，锁冲突时跳过且不写入", async () => {
    const repo = new InMemoryRepository();
    await repo.rankings.insert(makeRanking());
    await repo.jobLocks.acquire(
      "sync:period_finalize",
      "existing-owner",
      new Date(NOW.getTime() + 60_000),
    );

    await expect(
      new PeriodFinalizeService(repo).finalize(PeriodType.Week, "2026-W32", NOW),
    ).resolves.toMatchObject({ skipped: true, finalized_count: 0 });
  });

  it("rankings repository port 缺失时 Fail Closed", async () => {
    const repo = new InMemoryRepository();
    const missingRankings = Object.create(repo) as AppRepository;
    Object.defineProperty(missingRankings, "rankings", { value: undefined });

    await expect(
      new PeriodFinalizeService(missingRankings).finalize(
        PeriodType.Week,
        "2026-W32",
        NOW,
      ),
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("sync_logs repository port 缺失时 Fail Closed，不获取封存锁", async () => {
    const repo = new InMemoryRepository();
    const missingSyncLogs = Object.create(repo) as AppRepository;
    Object.defineProperty(missingSyncLogs, "syncLogs", { value: undefined });

    await expect(
      new PeriodFinalizeService(missingSyncLogs).finalize(
        PeriodType.Week,
        "2026-W32",
        NOW,
      ),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(
      repo.jobLocks.acquire(
        "sync:period_finalize",
        "probe-owner",
        new Date(NOW.getTime() + 60_000),
      ),
    ).resolves.toBe(true);
  });

  it("无效 server_now 时 Fail Closed，不封存排行榜", async () => {
    const repo = new InMemoryRepository();
    const entry = makeRanking();
    await repo.rankings.insert(entry);

    await expect(
      new PeriodFinalizeService(repo).finalize(
        PeriodType.Week,
        "2026-W32",
        new Date("invalid"),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await expect(repo.rankings.findByPeriod(PeriodType.Week, "2026-W32")).resolves.toEqual([
      entry,
    ]);
  });
});
