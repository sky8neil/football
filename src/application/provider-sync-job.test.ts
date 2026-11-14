import { describe, expect, it, vi } from "vitest";
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { MatchStatus, Provider, SettlementStatus, SyncJobType } from "../domain/enums.js";
import { validationError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import type { Match, SyncLog, Team, TeamProviderMapping } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { ProviderBudgetDeniedError } from "../provider/budget.js";
import { makeApiFixture } from "../provider/fixture-factory.js";
import { ProviderRegistry } from "../provider/registry.js";
import { loadProviderSources } from "../provider/sources.js";
import {
  ProviderDataError,
  ProviderError,
  ProviderHttpError,
  ProviderQuotaExceededError,
} from "../provider/http.js";
import type { ApiFootballFixture } from "../provider/types.js";
import { applyJitter } from "../sync/config.js";
import { planDueProviderJobs, runDueProviderJobs } from "../runtime/scheduled-jobs.js";
import { ProviderFixtureSyncService } from "./provider-fixture-sync.js";
import {
  ProviderFixtureSyncJobService,
  type ProviderFixtureBatchItem,
} from "./provider-sync-job.js";
import {
  loadActiveWindowFixtures,
  loadActiveWindowFixturesWithStats,
} from "./provider-window-loader.js";

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
  provider: "api_football" | "football_data" = "api_football",
): Promise<void> {
  await repo.matches.insert(match);
  await repo.matchProviderMappings.insert({
    schema_version: 1,
    match_id: match.match_id,
    provider,
    provider_match_id: providerMatchId,
    created_at: NOW,
    updated_at: NOW,
  });
}

function item(fixture: ApiFootballFixture): ProviderFixtureBatchItem {
  return { fixture, payload: { fixture_id: fixture.fixture.id } };
}

function makeTeam(teamId: string): Team {
  return {
    schema_version: 1,
    team_id: teamId,
    league_id: "premier_league",
    name: `Team ${teamId}`,
    short_name: null,
    primary_color: null,
    secondary_color: null,
    status: "active",
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeTeamMapping(
  teamId: string,
  providerTeamId: string,
  provider: Provider,
): TeamProviderMapping {
  return {
    schema_version: 1,
    team_id: teamId,
    provider,
    provider_team_id: providerTeamId,
    created_at: NOW,
    updated_at: NOW,
  };
}

async function seedLiveWindowMatch(repo: InMemoryRepository): Promise<Match> {
  const homeTeamId = newUuid();
  const awayTeamId = newUuid();
  await repo.teams.insert(makeTeam(homeTeamId));
  await repo.teams.insert(makeTeam(awayTeamId));
  await repo.teamProviderMappings.insert(makeTeamMapping(homeTeamId, "1001", Provider.FiveDollar));
  await repo.teamProviderMappings.insert(makeTeamMapping(awayTeamId, "1002", Provider.FiveDollar));
  const kickoffAt = new Date(NOW.getTime() + 60 * 60_000);
  const match = makeMatch();
  const seeded: Match = {
    ...match,
    home_team_id: homeTeamId,
    away_team_id: awayTeamId,
    kickoff_at: kickoffAt,
    prediction_deadline_at: new Date(kickoffAt.getTime() - 10 * 60_000),
  };
  await repo.matches.insert(seeded);
  await repo.matchProviderMappings.insert({
    schema_version: 1,
    match_id: seeded.match_id,
    provider: Provider.FootballData,
    provider_match_id: "fd-live-1",
    created_at: NOW,
    updated_at: NOW,
  });
  return seeded;
}

function fiveDollarLiveFixture(overrides: {
  id?: number;
  season?: string;
  omitSeason?: boolean;
  kickoffAt?: Date;
  homeTeamId?: number;
  awayTeamId?: number;
} = {}): ApiFootballFixture {
  const kickoffAt = overrides.kickoffAt ?? new Date(NOW.getTime() + 60 * 60_000);
  const fixture: ApiFootballFixture = {
    provider: Provider.FiveDollar,
    fixture: {
      id: overrides.id ?? 1300101,
      date: kickoffAt.toISOString(),
      timestamp: kickoffAt.getTime() / 1000,
      status: { short: "LIVE" },
    },
    league: {
      id: "4160026622",
      round: "3",
      ...(overrides.omitSeason === true || overrides.season === undefined
        ? {}
        : { season: overrides.season }),
    },
    teams: {
      home: { id: overrides.homeTeamId ?? 1001, name: "Home" },
      away: { id: overrides.awayTeamId ?? 1002, name: "Away" },
    },
  };
  return fixture;
}

async function seedFiveDollarWindowMatch(
  repo: InMemoryRepository,
  kickoffAt: Date,
  providerTeamIds: readonly [string, string],
): Promise<Match> {
  const homeTeamId = newUuid();
  const awayTeamId = newUuid();
  await repo.teams.insert(makeTeam(homeTeamId));
  await repo.teams.insert(makeTeam(awayTeamId));
  await repo.teamProviderMappings.insert(
    makeTeamMapping(homeTeamId, providerTeamIds[0], Provider.FiveDollar),
  );
  await repo.teamProviderMappings.insert(
    makeTeamMapping(awayTeamId, providerTeamIds[1], Provider.FiveDollar),
  );
  const seeded: Match = {
    ...makeMatch(),
    home_team_id: homeTeamId,
    away_team_id: awayTeamId,
    kickoff_at: kickoffAt,
    prediction_deadline_at: new Date(kickoffAt.getTime() - 10 * 60_000),
  };
  await repo.matches.insert(seeded);
  return seeded;
}

function windowClient(fixtures: readonly ApiFootballFixture[]) {
  return {
    getFixtures: async (query: { leagueId?: string }) =>
      query.leagueId === "39" ? fixtures : [],
  };
}

function recordingSyncLogs() {
  return {
    insert: vi.fn(async (_log: SyncLog) => undefined),
    update: vi.fn(async (_log: SyncLog) => undefined),
  };
}

function makeDeferredLog(overrides: Partial<SyncLog> = {}): SyncLog {
  const startedAt = new Date(NOW.getTime() - 60_000);
  return {
    schema_version: 1,
    sync_job_id: newUuid(),
    job_type: SyncJobType.LiveMatch,
    status: "deferred",
    started_at: startedAt,
    finished_at: startedAt,
    attempt_count: 1,
    items_read: 0,
    items_changed: 0,
    items_failed: 0,
    last_error_code: "INTERNAL_ERROR",
    last_error_message: "temporary failure",
    retry_attempt: 0,
    next_attempt_at: new Date(NOW.getTime() - 1_000),
    created_at: startedAt,
    ...overrides,
  };
}

describe("ProviderFixtureSyncJobService", () => {
  it("在 job lock 内批量应用 fixture，并记录 running/success 统计", async () => {
    const repo = new InMemoryRepository();
    const first = makeMatch();
    const second = makeMatch();
    await seedMatch(repo, first, "1100001");
    await seedMatch(repo, second, "1100002", "football_data");
    const syncLogs = recordingSyncLogs();
    const load = vi.fn(async (serverNow: Date) => {
      expect(serverNow).toBe(NOW);
      const authoritativeFixture = makeApiFixture({
        fixtureId: 1100002,
        statusShort: "FT",
        fulltimeHome: 2,
        fulltimeAway: 1,
      });
      authoritativeFixture.provider = "football_data";
      authoritativeFixture.league.id = "PL";
      return [
        item(makeApiFixture({ fixtureId: 1100001, statusShort: "TBD" })),
        item(authoritativeFixture),
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

  it("N127 Provider 网络失败时记录 failed log、释放锁且不改变比赛状态", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch();
    await seedMatch(repo, match, "1100003");
    const syncLogs = recordingSyncLogs();
    const failure = new Error("provider network unavailable");
    const load = vi.fn(async () => Promise.reject(failure));
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs },
      new ProviderFixtureSyncService(repo),
      { random: () => 0.5 },
    );

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toMatchObject({
      kind: "deferred",
      job_type: SyncJobType.LiveMatch,
      retry_attempt: 0,
    });
    expect(await repo.matches.findById(match.match_id)).toEqual(match);
    expect(await repo.jobLocks.isHeld("sync:live_match", NOW)).toBe(false);
    expect(syncLogs.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "deferred",
      next_attempt_at: new Date(NOW.getTime() + 60_000),
      last_error_code: "INTERNAL_ERROR",
      last_error_message: "provider network unavailable",
    }));
  });

  it("N127 Provider 数据错误不可重试时记录 failed log、释放锁且不改变比赛状态", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch();
    await seedMatch(repo, match, "1100003");
    const syncLogs = recordingSyncLogs();
    const failure = new ProviderDataError("invalid data");
    const load = vi.fn(async () => Promise.reject(failure));
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs },
      new ProviderFixtureSyncService(repo),
    );

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).rejects.toBe(failure);
    expect(await repo.matches.findById(match.match_id)).toEqual(match);
    expect(await repo.jobLocks.isHeld("sync:live_match", NOW)).toBe(false);
    expect(syncLogs.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      items_failed: 1,
      last_error_code: "PROVIDER_DATA_ERROR",
      last_error_message: "invalid data",
    }));
  });

  it("暂时 loader 失败按 32.8 的首次退避重试后继续完成任务", async () => {
    const repo = new InMemoryRepository();
    const syncLogs = recordingSyncLogs();
    const load = vi.fn().mockRejectedValueOnce(new Error("temporary network failure"));
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs },
      new ProviderFixtureSyncService(repo),
      { random: () => 0.5 },
    );

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toEqual({
      kind: "deferred",
      job_type: SyncJobType.LiveMatch,
      retry_attempt: 0,
      next_attempt_at: new Date(NOW.getTime() + 60_000),
      last_error_code: "INTERNAL_ERROR",
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(syncLogs.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "deferred",
      attempt_count: 1,
    }));
  });

  it("上一轮 deferred 到期后本轮 load 成功则完成任务", async () => {
    const repo = new InMemoryRepository();
    await repo.syncLogs.insert(makeDeferredLog({
      retry_attempt: 0,
      next_attempt_at: new Date(NOW.getTime() - 1_000),
    }));
    const load = vi.fn(async () => []);
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs: repo.syncLogs },
      new ProviderFixtureSyncService(repo),
      { random: () => 0.5 },
    );

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toEqual({
      kind: "completed",
      job_type: SyncJobType.LiveMatch,
      items_read: 0,
      items_changed: 0,
      items_failed: 0,
    });
    expect(load).toHaveBeenCalledTimes(1);
    const latest = await repo.syncLogs.findLatestByJobType!(SyncJobType.LiveMatch);
    expect(latest).toMatchObject({
      status: "success",
      attempt_count: 1,
      items_read: 0,
      items_changed: 0,
      items_failed: 0,
      finished_at: NOW,
    });
  });

  it("loader 重试边界固定为 5 次 retry，等待序列按 jitter 下界注入且不真实等待", async () => {
    const expectedDelaysMs = FIXED_CONFIG_V1.SYNC_RETRY_DELAYS_MINUTES.map((minutes) =>
      applyJitter(minutes * 60_000, FIXED_CONFIG_V1.SYNC_RETRY_JITTER_PERCENT, () => 0),
    );

    for (const retryAttempt of [0, 1, 2, 3, 4] as const) {
      const repo = new InMemoryRepository();
      if (retryAttempt > 0) {
        await repo.syncLogs.insert(makeDeferredLog({
          retry_attempt: retryAttempt - 1,
          started_at: new Date(NOW.getTime() - (retryAttempt + 1) * 60_000),
        }));
      }
      const load = vi.fn(async () => {
        throw new Error(`temporary failure ${retryAttempt}`);
      });
      const service = new ProviderFixtureSyncJobService(
        { jobLocks: repo.jobLocks, syncLogs: repo.syncLogs },
        new ProviderFixtureSyncService(repo),
        { random: () => 0 },
      );

      const outcome = await service.run(SyncJobType.LiveMatch, load, NOW);
      expect(load).toHaveBeenCalledTimes(1);
      expect(outcome).toMatchObject({
        kind: "deferred",
        job_type: SyncJobType.LiveMatch,
        retry_attempt: retryAttempt,
      });
      if (outcome.kind !== "deferred") {
        throw new Error(`expected deferred for retry_attempt ${retryAttempt}`);
      }
      expect(outcome.next_attempt_at.getTime() - NOW.getTime()).toBe(expectedDelaysMs[retryAttempt]);
    }
  });

  it("第五次 retry 后仍失败时不再等待，sync_log 记录第六次最终尝试", async () => {
    const repo = new InMemoryRepository();
    await repo.syncLogs.insert(makeDeferredLog({
      retry_attempt: 4,
      started_at: new Date(NOW.getTime() - 60_000),
    }));
    const failure = new Error("provider unavailable");
    const load = vi.fn(async () => {
      throw failure;
    });
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs: repo.syncLogs },
      new ProviderFixtureSyncService(repo),
      { random: () => 0.5 },
    );

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).rejects.toMatchObject({
      code: "PROVIDER_RETRY_EXHAUSTED",
    });
    expect(load).toHaveBeenCalledTimes(1);
    const latest = await repo.syncLogs.findLatestByJobType!(SyncJobType.LiveMatch);
    expect(latest).toMatchObject({
      status: "failed",
      last_error_code: "PROVIDER_RETRY_EXHAUSTED",
    });
  });

  it("按现有 Provider/domain 错误分类决定是否重试", async () => {
    const cases = [
      { name: "HTTP 408", error: new ProviderHttpError(408, "timeout"), retryable: true },
      { name: "HTTP 500", error: new ProviderHttpError(500, "server error"), retryable: true },
      { name: "HTTP 429", error: new ProviderHttpError(429, "rate limited"), retryable: false },
      { name: "Provider data", error: new ProviderDataError("invalid data"), retryable: false },
      { name: "Provider base error", error: new ProviderError("PROVIDER_ERROR", "failed"), retryable: false },
      { name: "Provider budget denied", error: new ProviderBudgetDeniedError("minute_limit"), retryable: false },
      { name: "domain validation", error: validationError("invalid loader input"), retryable: false },
      { name: "ordinary network error", error: new Error("network down"), retryable: true },
    ] as const;

    for (const testCase of cases) {
      const repo = new InMemoryRepository();
      const syncLogs = recordingSyncLogs();
      const load = vi.fn(async () => {
        throw testCase.error;
      });
      const service = new ProviderFixtureSyncJobService(
        { jobLocks: repo.jobLocks, syncLogs },
        new ProviderFixtureSyncService(repo),
        { random: () => 0.5 },
      );

      if (testCase.retryable) {
        await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toMatchObject({
          kind: "deferred",
        });
        expect(load, testCase.name).toHaveBeenCalledTimes(1);
        expect(syncLogs.update).toHaveBeenLastCalledWith(expect.objectContaining({
          status: "deferred",
        }));
      } else {
        await expect(service.run(SyncJobType.LiveMatch, load, NOW)).rejects.toBe(testCase.error);
        expect(load, testCase.name).toHaveBeenCalledTimes(1);
        expect(syncLogs.update).toHaveBeenLastCalledWith(expect.objectContaining({
          status: "failed",
        }));
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

  it("HTTP 成功但全部入库失败时不持久化为 success，按退避延后补偿", async () => {
    const repo = new InMemoryRepository();
    const syncLogs = recordingSyncLogs();
    const applyFixture = vi.fn(async () => ({
      kind: "failed" as const,
      match_id: null,
      anomaly_types: [],
    }));
    const items = Array.from({ length: 100 }, (_, index) =>
      item(makeApiFixture({ fixtureId: 1110000 + index, statusShort: "TBD" })),
    );
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs },
      { applyFixture },
      { random: () => 0.5 },
    );

    await expect(
      service.run(SyncJobType.FutureSchedule, async () => items, NOW),
    ).resolves.toEqual({
      kind: "deferred",
      job_type: SyncJobType.FutureSchedule,
      next_attempt_at: new Date(NOW.getTime() + 60_000),
      retry_attempt: 0,
      last_error_code: "PROVIDER_FIXTURE_FAILED",
      items_read: 100,
      items_changed: 0,
      items_failed: 100,
      failure_diagnostics: expect.any(Array),
      failure_diagnostics_omitted: 0,
    });
    expect(applyFixture).toHaveBeenCalledTimes(100);
    expect(syncLogs.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "deferred",
      items_read: 100,
      items_changed: 0,
      items_failed: 100,
      retry_attempt: 0,
      next_attempt_at: new Date(NOW.getTime() + 60_000),
      last_error_code: "PROVIDER_FIXTURE_FAILED",
      failure_diagnostics_omitted: 0,
    }));
    expect(syncLogs.update).not.toHaveBeenCalledWith(expect.objectContaining({
      status: "success",
    }));
    const update = syncLogs.update.mock.calls.at(-1)?.[0];
    expect(update?.failure_diagnostics).toHaveLength(100);
  });

  it("重试耗尽时返回 failed 且日志保持 failed，不伪装 completed", async () => {
    const repo = new InMemoryRepository();
    await repo.syncLogs.insert(makeDeferredLog({
      job_type: SyncJobType.FutureSchedule,
      retry_attempt: 4,
      started_at: new Date(NOW.getTime() - 60_000),
    }));
    const applyFixture = vi.fn(async () => ({
      kind: "failed" as const,
      match_id: null,
      anomaly_types: [],
    }));
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs: repo.syncLogs },
      { applyFixture },
      { random: () => 0.5 },
    );

    await expect(service.run(
      SyncJobType.FutureSchedule,
      async () => [item(makeApiFixture({ fixtureId: 1119999, statusShort: "TBD" }))],
      NOW,
    )).resolves.toMatchObject({
      kind: "failed",
      job_type: SyncJobType.FutureSchedule,
      items_read: 1,
      items_changed: 0,
      items_failed: 1,
      last_error_code: "PROVIDER_FIXTURE_FAILED",
    });
    const latest = await repo.syncLogs.findLatestByJobType!(SyncJobType.FutureSchedule);
    expect(latest).toMatchObject({
      status: "failed",
      items_read: 1,
      items_changed: 0,
      items_failed: 1,
      last_error_code: "PROVIDER_FIXTURE_FAILED",
    });
  });

  it("部分入库成功时保留已写入结果，失败部分跨 tick 补偿且重放幂等", async () => {
    const repo = new InMemoryRepository();
    const scheduled = makeMatch();
    const result = makeMatch();
    await seedMatch(repo, scheduled, "1200001");
    await seedMatch(repo, result, "1200002", "football_data");
    const incompleteResult = makeApiFixture({
      fixtureId: 1200002,
      statusShort: "FT",
      fulltimeHome: null,
    });
    incompleteResult.provider = "football_data";
    incompleteResult.league.id = "PL";
    const loadIncomplete = async () => [
      item(makeApiFixture({ fixtureId: 1200001, statusShort: "TBD" })),
      item(incompleteResult),
    ];
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs: repo.syncLogs },
      new ProviderFixtureSyncService(repo),
      { random: () => 0.5 },
    );

    await expect(
      service.run(SyncJobType.FutureSchedule, loadIncomplete, NOW),
    ).resolves.toEqual({
      kind: "deferred",
      job_type: SyncJobType.FutureSchedule,
      next_attempt_at: new Date(NOW.getTime() + 60_000),
      retry_attempt: 0,
      last_error_code: "PROVIDER_FIXTURE_FAILED",
      items_read: 2,
      items_changed: 1,
      items_failed: 1,
      failure_diagnostics: [expect.objectContaining({
        provider_fixture_id: "1200002",
        outcome: "failed",
        error_code: "INVALID_FINAL_SCORE",
      })],
      failure_diagnostics_omitted: 0,
    });
    const deferredLog = await repo.syncLogs.findLatestByJobType!(SyncJobType.FutureSchedule);
    expect(deferredLog).toMatchObject({
      status: "deferred",
      items_read: 2,
      items_changed: 1,
      items_failed: 1,
      retry_attempt: 0,
      next_attempt_at: new Date(NOW.getTime() + 60_000),
    });
    await expect(repo.matches.findById(scheduled.match_id)).resolves.toMatchObject({
      kickoff_confirmed: false,
    });
    await expect(repo.matches.findById(result.match_id)).resolves.toMatchObject({
      match_status: MatchStatus.Finished,
      regular_home_score: null,
      regular_away_score: null,
      result_version: 0,
    });

    const correctedResult = makeApiFixture({
      fixtureId: 1200002,
      statusShort: "FT",
      fulltimeHome: 2,
      fulltimeAway: 1,
    });
    correctedResult.provider = "football_data";
    correctedResult.league.id = "PL";
    const loadCorrected = async () => [
      item(makeApiFixture({ fixtureId: 1200001, statusShort: "TBD" })),
      item(correctedResult),
    ];
    const nextTick = new Date(NOW.getTime() + 60_000);
    await expect(
      service.run(SyncJobType.FutureSchedule, loadCorrected, nextTick),
    ).resolves.toMatchObject({
      kind: "completed",
      items_read: 2,
      items_failed: 0,
    });
    await expect(repo.matches.findById(result.match_id)).resolves.toMatchObject({
      regular_home_score: 2,
      regular_away_score: 1,
      result_version: 1,
    });

    await expect(
      service.run(
        SyncJobType.FutureSchedule,
        loadCorrected,
        new Date(NOW.getTime() + 120_000),
      ),
    ).resolves.toMatchObject({
      kind: "completed",
      items_changed: 0,
      items_failed: 0,
    });
    await expect(repo.matches.findById(result.match_id)).resolves.toMatchObject({
      result_version: 1,
    });
  });

  it("单 fixture 的 fail-closed outcome 计入 items_failed 并延后补偿", async () => {
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
      { random: () => 0.5 },
    );

    await expect(service.run(SyncJobType.PostFinishVerify, load, NOW)).resolves.toEqual({
      kind: "deferred",
      job_type: SyncJobType.PostFinishVerify,
      next_attempt_at: new Date(NOW.getTime() + 60_000),
      retry_attempt: 0,
      last_error_code: "PROVIDER_FIXTURE_FAILED",
      items_read: 1,
      items_changed: 0,
      items_failed: 1,
      failure_diagnostics: [expect.objectContaining({
        provider: "api_football",
        provider_fixture_id: "1100004",
        stage: "apply_fixture",
        outcome: "failed",
        error_code: "INVALID_FINAL_SCORE",
        reason_codes: ["INVALID_FINAL_SCORE"],
        match_id: match.match_id,
      })],
      failure_diagnostics_omitted: 0,
    });
    await expect(repo.matches.findById(match.match_id)).resolves.toMatchObject({
      match_status: MatchStatus.Finished,
      finish_detected_at: NOW,
      regular_home_score: null,
      regular_away_score: null,
      result_version: 0,
    });
    expect(syncLogs.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "deferred",
      items_read: 1,
      items_changed: 0,
      items_failed: 1,
    }));
  });

  it("窗口失败行丢失后不得报零条成功：无赛季 5d 唯一候选应计入读取并更新同一场", async () => {
    const repo = new InMemoryRepository();
    const match = await seedLiveWindowMatch(repo);
    const fixture = fiveDollarLiveFixture({ omitSeason: true });
    const load = (serverNow: Date) => loadActiveWindowFixtures(
      repo,
      windowClient([fixture]),
      SyncJobType.LiveMatch,
      serverNow,
    );
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs: repo.syncLogs },
      new ProviderFixtureSyncService(repo),
    );

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toMatchObject({
      kind: "completed",
      job_type: SyncJobType.LiveMatch,
      items_read: 1,
      items_changed: 1,
      items_failed: 0,
    });
    await expect(repo.matches.findById(match.match_id)).resolves.toMatchObject({
      match_status: MatchStatus.Live,
      season_id: "2026_2027",
    });
    await expect(
      repo.matchProviderMappings.findByProviderAndExternalId(Provider.FiveDollar, "1300101"),
    ).resolves.toMatchObject({ match_id: match.match_id });
    const log = await repo.syncLogs.findLatestByJobType!(SyncJobType.LiveMatch);
    expect(log).toMatchObject({
      status: "success",
      items_read: 1,
      items_changed: 1,
      items_failed: 0,
    });
  });

  it("窗口明确旧赛季冲突不得丢失后报零条成功", async () => {
    const repo = new InMemoryRepository();
    const match = await seedLiveWindowMatch(repo);
    const fixture = fiveDollarLiveFixture({ season: "25/26" });
    const load = (serverNow: Date) => loadActiveWindowFixtures(
      repo,
      windowClient([fixture]),
      SyncJobType.LiveMatch,
      serverNow,
    );
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs: repo.syncLogs },
      new ProviderFixtureSyncService(repo),
      { random: () => 0.5 },
    );

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toMatchObject({
      kind: "deferred",
      items_read: 1,
      items_changed: 0,
      items_failed: 1,
    });
    await expect(repo.matches.findById(match.match_id)).resolves.toMatchObject({
      match_status: MatchStatus.Scheduled,
      season_id: "2026_2027",
    });
    const log = await repo.syncLogs.findLatestByJobType!(SyncJobType.LiveMatch);
    expect(log).toMatchObject({
      status: "deferred",
      items_read: 1,
      items_failed: 1,
    });
    expect(log).not.toMatchObject({ status: "success" });
  });

  it("窗口未关联观察可见且不把整批升级为失败", async () => {
    const repo = new InMemoryRepository();
    const match = await seedLiveWindowMatch(repo);
    const fixture = fiveDollarLiveFixture({ omitSeason: true });
    fixture.teams.home.id = 9001;
    fixture.teams.away.id = 9002;
    const load = (serverNow: Date) => loadActiveWindowFixtures(
      repo,
      windowClient([fixture]),
      SyncJobType.LiveMatch,
      serverNow,
    );
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs: repo.syncLogs },
      new ProviderFixtureSyncService(repo),
    );

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toMatchObject({
      kind: "completed",
      items_read: 1,
      items_changed: 0,
      items_failed: 0,
      failure_diagnostics: [expect.objectContaining({
        provider: "5dollar",
        provider_fixture_id: "1300101",
        outcome: "unlinked",
      })],
    });
    await expect(repo.matches.findById(match.match_id)).resolves.toMatchObject({
      match_status: MatchStatus.Scheduled,
    });
    await expect(
      repo.matchProviderMappings.findByProviderAndExternalId(Provider.FiveDollar, "1300101"),
    ).resolves.toBeNull();
  });

  it("窗口外已有 5d 映射不更新，窗口内比赛仍正常关联并处理", async () => {
    const repo = new InMemoryRepository();
    const kickoffInWindow = new Date(NOW.getTime() + 60 * 60_000);
    const kickoffOutsideWindow = new Date(NOW.getTime() + 3 * 60 * 60_000);
    const inWindow = await seedFiveDollarWindowMatch(repo, kickoffInWindow, ["1001", "1002"]);
    const outsideWindow = await seedFiveDollarWindowMatch(repo, kickoffOutsideWindow, ["2001", "2002"]);
    await repo.matchProviderMappings.insert({
      schema_version: 1,
      match_id: outsideWindow.match_id,
      provider: Provider.FiveDollar,
      provider_match_id: "1300102",
      created_at: NOW,
      updated_at: NOW,
    });
    const inWindowFixture = fiveDollarLiveFixture({ omitSeason: true });
    const outsideFixture = fiveDollarLiveFixture({
      id: 1300102,
      omitSeason: true,
      kickoffAt: kickoffOutsideWindow,
      homeTeamId: 2001,
      awayTeamId: 2002,
    });
    const load = (serverNow: Date) => loadActiveWindowFixturesWithStats(
      repo,
      windowClient([inWindowFixture, outsideFixture]),
      SyncJobType.LiveMatch,
      serverNow,
    );
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs: repo.syncLogs },
      new ProviderFixtureSyncService(repo),
    );

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toMatchObject({
      kind: "completed",
      items_read: 1,
      items_window_input: 2,
      items_window_filtered: 1,
      items_changed: 1,
      items_failed: 0,
    });
    await expect(repo.matches.findById(inWindow.match_id)).resolves.toMatchObject({
      match_status: MatchStatus.Live,
    });
    await expect(repo.matches.findById(outsideWindow.match_id)).resolves.toMatchObject({
      match_status: MatchStatus.Scheduled,
      regular_home_score: null,
      regular_away_score: null,
      result_version: 0,
    });
    await expect(
      repo.matchProviderMappings.findByProviderAndExternalId(Provider.FiveDollar, "1300101"),
    ).resolves.toMatchObject({ match_id: inWindow.match_id });
    await expect(
      repo.matchProviderMappings.findByProviderAndExternalId(Provider.FiveDollar, "1300102"),
    ).resolves.toMatchObject({ match_id: outsideWindow.match_id });
    await expect(repo.matches.findBySeason("2026_2027")).resolves.toHaveLength(2);
  });

  it("窗口外无映射但球队唯一可匹配时不创建映射，也不更新窗口外比赛", async () => {
    const repo = new InMemoryRepository();
    const kickoffInWindow = new Date(NOW.getTime() + 60 * 60_000);
    const kickoffOutsideWindow = new Date(NOW.getTime() + 3 * 60 * 60_000);
    const inWindow = await seedFiveDollarWindowMatch(repo, kickoffInWindow, ["1001", "1002"]);
    const outsideWindow = await seedFiveDollarWindowMatch(repo, kickoffOutsideWindow, ["2001", "2002"]);
    const inWindowFixture = fiveDollarLiveFixture({ omitSeason: true });
    const outsideFixture = fiveDollarLiveFixture({
      id: 1300103,
      omitSeason: true,
      kickoffAt: kickoffOutsideWindow,
      homeTeamId: 2001,
      awayTeamId: 2002,
    });
    const load = (serverNow: Date) => loadActiveWindowFixturesWithStats(
      repo,
      windowClient([inWindowFixture, outsideFixture]),
      SyncJobType.LiveMatch,
      serverNow,
    );
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs: repo.syncLogs },
      new ProviderFixtureSyncService(repo),
    );

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toMatchObject({
      kind: "completed",
      items_read: 1,
      items_window_input: 2,
      items_window_filtered: 1,
      items_changed: 1,
      items_failed: 0,
    });
    await expect(repo.matches.findById(inWindow.match_id)).resolves.toMatchObject({
      match_status: MatchStatus.Live,
    });
    await expect(repo.matches.findById(outsideWindow.match_id)).resolves.toMatchObject({
      match_status: MatchStatus.Scheduled,
      regular_home_score: null,
      regular_away_score: null,
      result_version: 0,
    });
    await expect(
      repo.matchProviderMappings.findByProviderAndExternalId(Provider.FiveDollar, "1300101"),
    ).resolves.toMatchObject({ match_id: inWindow.match_id });
    await expect(
      repo.matchProviderMappings.findByProviderAndExternalId(Provider.FiveDollar, "1300103"),
    ).resolves.toBeNull();
    await expect(repo.matches.findBySeason("2026_2027")).resolves.toHaveLength(2);
  });

  it("窗口全部正常过滤时保留原始条数且不伪造采纳", async () => {
    const repo = new InMemoryRepository();
    const kickoffInWindow = new Date(NOW.getTime() + 60 * 60_000);
    const kickoffOutsideWindow = new Date(NOW.getTime() + 3 * 60 * 60_000);
    await seedFiveDollarWindowMatch(repo, kickoffInWindow, ["1001", "1002"]);
    const outsideOne = await seedFiveDollarWindowMatch(repo, kickoffOutsideWindow, ["2001", "2002"]);
    const outsideTwo = await seedFiveDollarWindowMatch(repo, kickoffOutsideWindow, ["3001", "3002"]);
    await repo.matchProviderMappings.insert({
      schema_version: 1,
      match_id: outsideOne.match_id,
      provider: Provider.FiveDollar,
      provider_match_id: "1300102",
      created_at: NOW,
      updated_at: NOW,
    });
    await repo.matchProviderMappings.insert({
      schema_version: 1,
      match_id: outsideTwo.match_id,
      provider: Provider.FiveDollar,
      provider_match_id: "1300103",
      created_at: NOW,
      updated_at: NOW,
    });
    const outsideFixtureOne = fiveDollarLiveFixture({
      id: 1300102,
      omitSeason: true,
      kickoffAt: kickoffOutsideWindow,
      homeTeamId: 2001,
      awayTeamId: 2002,
    });
    const outsideFixtureTwo = fiveDollarLiveFixture({
      id: 1300103,
      omitSeason: true,
      kickoffAt: kickoffOutsideWindow,
      homeTeamId: 3001,
      awayTeamId: 3002,
    });
    const load = (serverNow: Date) => loadActiveWindowFixturesWithStats(
      repo,
      windowClient([outsideFixtureOne, outsideFixtureTwo]),
      SyncJobType.LiveMatch,
      serverNow,
    );
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs: repo.syncLogs },
      new ProviderFixtureSyncService(repo),
    );

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toMatchObject({
      kind: "completed",
      items_read: 0,
      items_window_input: 2,
      items_window_filtered: 2,
      items_changed: 0,
      items_failed: 0,
    });
    const log = await repo.syncLogs.findLatestByJobType!(SyncJobType.LiveMatch);
    expect(log).toMatchObject({
      status: "success",
      items_read: 0,
      items_window_input: 2,
      items_window_filtered: 2,
      items_changed: 0,
      items_failed: 0,
    });
    await expect(repo.matches.findById(outsideOne.match_id)).resolves.toMatchObject({
      match_status: MatchStatus.Scheduled,
      result_version: 0,
    });
    await expect(repo.matches.findById(outsideTwo.match_id)).resolves.toMatchObject({
      match_status: MatchStatus.Scheduled,
      result_version: 0,
    });
  });

  it("未映射的主源窗口记录计入输入与过滤，不伪装成真正零输入", async () => {
    const repo = new InMemoryRepository();
    await seedLiveWindowMatch(repo);
    const fixture = makeApiFixture({ fixtureId: 1200001, statusShort: "LIVE" });
    const load = (serverNow: Date) => loadActiveWindowFixturesWithStats(
      repo,
      windowClient([fixture]),
      SyncJobType.LiveMatch,
      serverNow,
    );
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs: repo.syncLogs },
      new ProviderFixtureSyncService(repo),
    );

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toMatchObject({
      kind: "completed",
      items_read: 0,
      items_window_input: 1,
      items_window_filtered: 1,
      items_changed: 0,
      items_failed: 0,
    });
    const log = await repo.syncLogs.findLatestByJobType!(SyncJobType.LiveMatch);
    expect(log).toMatchObject({
      status: "success",
      items_read: 0,
      items_window_input: 1,
      items_window_filtered: 1,
    });
  });

  it("5d 指定联赛缺 league.id 时不补写请求联赛，逐场无效并延后补偿", async () => {
    const config = loadProviderSources({
      FOOTBALL_PROVIDER_SOURCES: "5d",
      FOOTBALL_PROVIDER_KEY_5D: "5d-key-only",
      FOOTBALL_SYNC_PROFILE: "test",
    });
    const repo = new InMemoryRepository();
    const kickoffAt = new Date(NOW.getTime() - 2 * 60 * 60_000);
    const match: Match = {
      ...makeMatch(),
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Pending,
      kickoff_at: kickoffAt,
      prediction_deadline_at: new Date(kickoffAt.getTime() - 10 * 60_000),
      finish_detected_at: new Date(NOW.getTime() - 60 * 60_000),
    };
    await repo.matches.insert(match);
    let requestCount = 0;
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1;
      return new Response(JSON.stringify({
        data: [{
          id: 1300101,
          kickoff_utc: kickoffAt.toISOString(),
          status: "finished",
          status_code: "full",
          league: { id: "" },
          round: 3,
          teams: { home: { id: 1001, name: "Home" }, away: { id: 1002, name: "Away" } },
          goals: { home: 1, away: 0 },
        }],
        pagination: { has_more: false },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const registry = new ProviderRegistry({
      config,
      fetchImpl,
      minimumGapMs: 0,
    });
    const client = registry.asClient();
    const load = (serverNow: Date) => loadActiveWindowFixturesWithStats(
      repo,
      client,
      SyncJobType.PostFinishVerify,
      serverNow,
      config.league_refs,
    );
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs: repo.syncLogs },
      new ProviderFixtureSyncService(repo, undefined, config.league_refs),
      { random: () => 0.5 },
    );

    const outcome = await service.run(SyncJobType.PostFinishVerify, load, NOW);
    expect(outcome).toMatchObject({
      kind: "deferred",
      items_read: 3,
      items_changed: 0,
      items_failed: 3,
    });
    expect(requestCount).toBe(3);
    expect((outcome as { failure_diagnostics?: unknown[] }).failure_diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "5dollar",
          provider_fixture_id: "1300101",
          outcome: "failed",
          reason_codes: expect.arrayContaining(["PROVIDER_DATA_INVALID"]),
        }),
      ]),
    );
    await expect(repo.matches.findById(match.match_id)).resolves.toMatchObject({
      season_id: "2026_2027",
      regular_home_score: null,
      regular_away_score: null,
      result_version: 0,
    });
    await expect(
      repo.matchProviderMappings.findByProviderAndExternalId(Provider.FiveDollar, "1300101"),
    ).resolves.toBeNull();
  });

  it("目标赛季明确但缺少比赛映射时 job 记为 unlinked 且诊断可见", async () => {
    const repo = new InMemoryRepository();
    const homeTeamId = newUuid();
    const awayTeamId = newUuid();
    await repo.teams.insert(makeTeam(homeTeamId));
    await repo.teams.insert(makeTeam(awayTeamId));
    await repo.teamProviderMappings.insert(makeTeamMapping(homeTeamId, "1001", Provider.FiveDollar));
    await repo.teamProviderMappings.insert(makeTeamMapping(awayTeamId, "1002", Provider.FiveDollar));
    const fixture = fiveDollarLiveFixture({ omitSeason: true });
    fixture.league.season = "26/27";
    const load = async () => [item(fixture)];
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs: repo.syncLogs },
      new ProviderFixtureSyncService(repo),
    );

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toMatchObject({
      kind: "completed",
      items_read: 1,
      items_changed: 0,
      items_failed: 0,
      failure_diagnostics: [expect.objectContaining({
        provider: "5dollar",
        provider_fixture_id: "1300101",
        outcome: "unlinked",
        error_code: "UNLINKED",
      })],
    });
    await expect(
      repo.matchProviderMappings.findByProviderAndExternalId(Provider.FiveDollar, "1300101"),
    ).resolves.toBeNull();
  });

  it("显式赛季冲突在 job 失败诊断中保留具体原因", async () => {
    const repo = new InMemoryRepository();
    await seedFiveDollarWindowMatch(repo, new Date(NOW.getTime() + 60 * 60_000), ["1001", "1002"]);
    const fixture = fiveDollarLiveFixture({ season: "25/26" });
    const load = async () => [item(fixture)];
    const service = new ProviderFixtureSyncJobService(
      { jobLocks: repo.jobLocks, syncLogs: repo.syncLogs },
      new ProviderFixtureSyncService(repo),
      { random: () => 0.5 },
    );

    await expect(service.run(SyncJobType.LiveMatch, load, NOW)).resolves.toMatchObject({
      kind: "deferred",
      items_read: 1,
      items_changed: 0,
      items_failed: 1,
      failure_diagnostics: [expect.objectContaining({
        provider: "5dollar",
        provider_fixture_id: "1300101",
        outcome: "failed",
        reason_codes: expect.arrayContaining(["PROVIDER_CONFLICT_SEASON"]),
      })],
    });
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
            isHeld: vi.fn(async () => false),
            isHeldBy: vi.fn(async () => true),
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
          jobLocks: {
            acquire,
            isHeld: vi.fn(async () => false),
            isHeldBy: vi.fn(async () => true),
            renew,
            release: vi.fn(async () => undefined),
          },
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
        isHeld: vi.fn(async () => false),
        isHeldBy: vi.fn(async () => true),
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
      expect(syncLogs.update).not.toHaveBeenCalled();
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
        isHeld: vi.fn(async () => false),
        isHeldBy: vi.fn(async () => true),
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
      expect(syncLogs.update).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("executeHeldByCaller 不再 acquire/release，批次由持锁调用方复用（P1-2 方案 A）", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch();
    await seedMatch(repo, match, "1100006");
    const syncLogs = recordingSyncLogs();
    const acquire = vi.fn(async (_lockKey: string, _ownerId: string, _leaseUntil: Date) => true);
    const release = vi.fn(async (_lockKey: string, _ownerId: string) => undefined);
    const service = new ProviderFixtureSyncJobService(
      {
        jobLocks: {
          acquire,
          isHeld: vi.fn(async () => false),
          isHeldBy: vi.fn(async () => true),
          renew: vi.fn(async () => true),
          release,
        },
        syncLogs,
      },
      new ProviderFixtureSyncService(repo),
      { sleep: async () => undefined },
    );
    const load = vi.fn(async () => [
      item(makeApiFixture({ fixtureId: 1100006, statusShort: "TBD" })),
    ]);

    await expect(
      service.executeHeldByCaller(SyncJobType.FutureSchedule, load, NOW, "external-owner"),
    ).resolves.toEqual({
      kind: "completed",
      job_type: SyncJobType.FutureSchedule,
      items_read: 1,
      items_changed: 1,
      items_failed: 0,
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(await repo.matches.findById(match.match_id)).toMatchObject({
      match_status: MatchStatus.Scheduled,
      kickoff_confirmed: false,
    });
  });

  it("无效 server_now 时在获取 Provider job lock 前 Fail Closed", async () => {
    const jobLocks = {
      acquire: vi.fn(async () => true),
      isHeld: vi.fn(async () => false),
      isHeldBy: vi.fn(async () => true),
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

describe("Provider 调度联赛隔离", () => {
  it("赛程任务为每个到期联赛分别生成 run 决策，首个联赛被跳过时不阻断其它联赛", async () => {
    const dueLeagues = vi.fn(async (_leagueIds: readonly string[], jobType: SyncJobType) =>
      jobType === SyncJobType.FullScheduleVerify ? ["premier_league", "la_liga"] : [],
    );
    const decisions = await planDueProviderJobs({
      cloudDb: { query: vi.fn(async () => []) } as never,
      namespace: "football_test",
      providerRegistry: { dueLeagues } as never,
      syncLeagueIds: ["premier_league", "la_liga"],
      sourceIds: ["fd"],
      profile: "test",
      serverNow: NOW,
    });

    expect(decisions.filter((decision) => decision.task === SyncJobType.FullScheduleVerify)).toEqual([
      { task: SyncJobType.FullScheduleVerify, action: "run", reason: "due", league_id: "premier_league" },
      { task: SyncJobType.FullScheduleVerify, action: "run", reason: "due", league_id: "la_liga" },
    ]);
  });

  it("调度异常时丢弃待提交的联赛成功候选，不推进业务完成时间", async () => {
    const dueLeagues = vi.fn(async (_leagueIds: readonly string[], jobType: SyncJobType) =>
      jobType === SyncJobType.FutureSchedule ? ["premier_league"] : [],
    );
    const commitPendingLeagueSuccess = vi.fn(async () => undefined);
    const discardPendingLeagueSuccess = vi.fn();
    const dispatchRun = vi.fn(async (jobType: string) => {
      if (jobType === SyncJobType.FutureSchedule) throw new Error("fixture exception");
      return {
        kind: "completed",
        fixtures: {
          kind: "completed",
          job_type: jobType,
          items_read: 0,
          items_changed: 0,
          items_failed: 0,
        },
      };
    });
    const recentlySuccessful = new Set<string>([
      SyncJobType.LiveMatch,
      SyncJobType.NearMatch,
      SyncJobType.PostFinishVerify,
      SyncJobType.ProviderReconcile,
    ]);

    const result = await runDueProviderJobs({
      cloudDb: {
        query: vi.fn(async (_collection: string, filter: { job_type?: string }) => (
          filter.job_type !== undefined && recentlySuccessful.has(filter.job_type)
            ? [{ job_type: filter.job_type, status: "success", started_at: NOW }]
            : []
        )),
      } as never,
      namespace: "football_test",
      dispatcher: { run: dispatchRun } as never,
      providerRegistry: {
        dueLeagues,
        commitPendingLeagueSuccess,
        discardPendingLeagueSuccess,
      } as never,
      syncLeagueIds: ["premier_league"],
      sourceIds: ["fd"],
      profile: "test",
      reconcile: { run: vi.fn(async () => ({ kind: "completed" })) } as never,
      serverNow: NOW,
      log: vi.fn(),
    });

    expect(dispatchRun).toHaveBeenCalledWith(SyncJobType.FutureSchedule, NOW, "premier_league");
    expect(discardPendingLeagueSuccess).toHaveBeenCalledWith(SyncJobType.FutureSchedule, "premier_league");
    expect(commitPendingLeagueSuccess).not.toHaveBeenCalled();
    expect(result.failed).toEqual(expect.arrayContaining([
      { task: `${SyncJobType.FutureSchedule}:premier_league`, reason: "exception" },
    ]));
  });
});
