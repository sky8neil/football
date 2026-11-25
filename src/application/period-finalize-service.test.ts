import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PeriodType } from "../domain/enums.js";
import { defaultLevelState, type RankingEntry, type User, type UserSeasonStats } from "../domain/types.js";
import { InMemoryRepository, type AppRepository, type UnitOfWork } from "../infrastructure/repositories.js";
import { PeriodFinalizeService } from "./period-finalize-service.js";
import { rankingPeriodLockKey } from "./settlement-item-application-service.js";

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
      expect.objectContaining({ user_id: entry.user_id, is_final: true, updated_at: entry.updated_at }),
      expect.objectContaining({
        user_id: alreadyFinal.user_id,
        is_final: true,
        updated_at: alreadyFinal.updated_at,
      }),
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

  it("拒绝 finalize month period", async () => {
    const repo = new InMemoryRepository();

    await expect(
      new PeriodFinalizeService(repo).finalize(("month" as PeriodType), "2026-08", NOW),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
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

describe("PeriodFinalizeService A-S5-02", () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => vi.useRealTimers());

  function makeUser(userId: string): User {
    return {
      schema_version: 1,
      user_id: userId,
      openid: `openid-${userId}`,
      unionid: null,
      nickname: `name-${userId}`,
      favorite_team_id: null,
      status: "active",
      career_points: 12,
      career_valid_predictions: 1,
      career_wdl_hits: 1,
      career_exact_hits: 1,
      career_level: 1,
      career_best_level: 2,
      career_last_scoring_match_at: new Date("2026-08-08T06:00:00.000Z"),
      career_level_state: defaultLevelState(),
      deleted_at: null,
      created_at: NOW,
      updated_at: NOW,
    };
  }

  function makeSeason(userId: string, levelSeasonId: string): UserSeasonStats {
    return {
      schema_version: 1,
      user_id: userId,
      level_season_id: levelSeasonId,
      points: 12,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
      last_scoring_match_at: new Date("2026-08-08T06:00:00.000Z"),
      level: 1,
      best_level: levelSeasonId === "2024_2025" ? 4 : 3,
      level_state: defaultLevelState(),
      is_level_frozen: true,
      created_at: NOW,
      updated_at: NOW,
    };
  }

  it("事务外持 ranking 周期锁，事务内按 users → season → rankings 加锁且只 patch is_final", async () => {
    const repo = new InMemoryRepository();
    const first = "a-user";
    const second = "b-user";
    await repo.users.insert(makeUser(second));
    await repo.users.insert(makeUser(first));
    await repo.userSeasonStats.insert(makeSeason(second, "2024_2025"));
    await repo.userSeasonStats.insert(makeSeason(first, "2026_2027"));
    await repo.userSeasonStats.insert(makeSeason(first, "2025_2026"));
    const firstRanking = makeRanking({ user_id: first, global_rank: 2, period_score: 12 });
    const secondRanking = makeRanking({ user_id: second, global_rank: 1, period_score: 30 });
    await repo.rankings.insert(secondRanking);
    await repo.rankings.insert(firstRanking);
    const calls: string[] = [];
    const patches: Array<Partial<RankingEntry>> = [];
    let rankingLockHeld = false;
    const lockKey = rankingPeriodLockKey(PeriodType.Week, "2026-W32");
    const original = repo.withTransaction.bind(repo);
    repo.withTransaction = (async (fn: (tx: UnitOfWork) => Promise<unknown>) => original(async (tx) => {
      rankingLockHeld = await repo.jobLocks.isHeld(lockKey, NOW);
      const users = tx.users;
      const seasons = tx.userSeasonStats;
      const rankings = tx.rankings;
      if (seasons === undefined || rankings === undefined) throw new Error("missing ports");
      const wrapped = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop === "users") {
            return {
              ...users,
              findByIdForUpdate: async (userId: string) => {
                calls.push(`users.lock:${userId}`);
                return users.findByIdForUpdate!(userId);
              },
              update: async () => {
                calls.push("users.update");
              },
            };
          }
          if (prop === "userSeasonStats") {
            return {
              ...seasons,
              findByUserAndSeasonForUpdate: async (userId: string, levelSeasonId: string) => {
                calls.push(`season.lock:${userId}:${levelSeasonId}`);
                return seasons.findByUserAndSeasonForUpdate!(userId, levelSeasonId);
              },
              update: async () => {
                calls.push("season.update");
              },
            };
          }
          if (prop === "rankings") {
            return {
              ...rankings,
              findByPeriodAndUserForUpdate: async (...args: Parameters<NonNullable<typeof rankings.findByPeriodAndUserForUpdate>>) => {
                calls.push(`ranking.lock:${args[2]}`);
                return rankings.findByPeriodAndUserForUpdate!(...args);
              },
              update: async () => {
                calls.push("ranking.update");
              },
              patchFields: async (...args: Parameters<NonNullable<typeof rankings.patchFields>>) => {
                calls.push(`ranking.patch:${args[2]}`);
                patches.push(args[3]);
                return rankings.patchFields!(...args);
              },
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      return fn(wrapped);
    })) as AppRepository["withTransaction"];

    await expect(
      new PeriodFinalizeService(repo).finalize(PeriodType.Week, "2026-W32", NOW),
    ).resolves.toMatchObject({ finalized_count: 2, skipped_count: 0, skipped: false });

    expect(rankingLockHeld).toBe(true);
    expect(calls).toEqual([
      "users.lock:a-user",
      "users.lock:b-user",
      "season.lock:a-user:2025_2026",
      "season.lock:a-user:2026_2027",
      "season.lock:b-user:2024_2025",
      "ranking.lock:a-user",
      "ranking.lock:b-user",
      "ranking.patch:a-user",
      "ranking.patch:b-user",
    ]);
    expect(patches).toEqual([{ is_final: true }, { is_final: true }]);
    expect(await repo.rankings.findByPeriodAndUser(PeriodType.Week, "2026-W32", first)).toMatchObject({
      is_final: true,
      period_score: 12,
      global_rank: 2,
      updated_at: firstRanking.updated_at,
    });
    expect(await repo.rankings.findByPeriodAndUser(PeriodType.Week, "2026-W32", second)).toMatchObject({
      is_final: true,
      period_score: 30,
      global_rank: 1,
      updated_at: secondRanking.updated_at,
    });
    expect(await repo.users.findById(first)).toMatchObject({ nickname: "name-a-user", career_best_level: 2 });
    expect(await repo.userSeasonStats.findByUserAndSeason(second, "2024_2025")).toMatchObject({
      best_level: 4,
      is_level_frozen: true,
      points: 12,
    });
    expect(await repo.jobLocks.isHeld(lockKey, NOW)).toBe(false);
    expect(await repo.jobLocks.isHeld("sync:period_finalize", NOW)).toBe(false);
  });

  it("ranking 周期锁被占用时跳过封板，不改 is_final，并释放 period_finalize 锁", async () => {
    const repo = new InMemoryRepository();
    const entry = makeRanking();
    await repo.rankings.insert(entry);
    const lockKey = rankingPeriodLockKey(PeriodType.Week, "2026-W32");
    await repo.jobLocks.acquire(lockKey, "rebuild-owner", new Date(NOW.getTime() + 60_000));

    await expect(
      new PeriodFinalizeService(repo).finalize(PeriodType.Week, "2026-W32", NOW),
    ).resolves.toMatchObject({ skipped: true, finalized_count: 0 });
    await expect(repo.rankings.findByPeriodAndUser(PeriodType.Week, "2026-W32", entry.user_id))
      .resolves.toMatchObject({ is_final: false, period_score: 12 });
    await expect(
      repo.jobLocks.acquire("sync:period_finalize", "probe", new Date(NOW.getTime() + 60_000)),
    ).resolves.toBe(true);
    await expect(repo.jobLocks.isHeld(lockKey, NOW)).resolves.toBe(true);
  });

  it("封板不把 findByPeriod 的过期快照整行写回", async () => {
    const repo = new InMemoryRepository();
    const entry = makeRanking({ period_score: 12, global_rank: 3, valid_predictions: 1 });
    await repo.rankings.insert(entry);
    const original = repo.withTransaction.bind(repo);
    repo.withTransaction = (async (fn: (tx: UnitOfWork) => Promise<unknown>) => original(async (tx) => {
      const rankings = tx.rankings;
      if (rankings === undefined) throw new Error("missing rankings");
      const wrapped = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop === "rankings") {
            return {
              ...rankings,
              findByPeriod: async () => [{
                ...entry,
                period_score: 0,
                valid_predictions: 0,
                wdl_hits: 0,
                exact_hits: 0,
                global_rank: null,
                last_scoring_match_at: null,
              }],
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      return fn(wrapped);
    })) as AppRepository["withTransaction"];

    await new PeriodFinalizeService(repo).finalize(PeriodType.Week, "2026-W32", NOW);

    expect(await repo.rankings.findByPeriodAndUser(PeriodType.Week, "2026-W32", entry.user_id)).toMatchObject({
      is_final: true,
      period_score: 12,
      valid_predictions: 1,
      global_rank: 3,
      updated_at: entry.updated_at,
    });
  });

  it("[CR-05] 封榜时若周期内有用户注销，事务内重算 global_rank 消除名次断层", async () => {
    const repo = new InMemoryRepository();
    const deletedFirst = makeUser("u-del");
    deletedFirst.status = "deleted";
    deletedFirst.deleted_at = new Date("2026-08-09T10:00:00.000Z");
    const activeSecond = makeUser("u-act");
    await repo.users.insert(deletedFirst);
    await repo.users.insert(activeSecond);
    await repo.rankings.insert(makeRanking({
      user_id: deletedFirst.user_id,
      period_score: 30,
      global_rank: 1,
    }));
    await repo.rankings.insert(makeRanking({
      user_id: activeSecond.user_id,
      period_score: 12,
      global_rank: 2,
    }));

    const outcome = await new PeriodFinalizeService(repo).finalize(PeriodType.Week, "2026-W32", NOW);
    expect(outcome.finalized_count).toBe(2);

    await expect(
      repo.rankings.findByPeriodAndUser(PeriodType.Week, "2026-W32", deletedFirst.user_id),
    ).resolves.toMatchObject({ is_final: true, global_rank: null });
    await expect(
      repo.rankings.findByPeriodAndUser(PeriodType.Week, "2026-W32", activeSecond.user_id),
    ).resolves.toMatchObject({ is_final: true, global_rank: 1 });
  });
});
