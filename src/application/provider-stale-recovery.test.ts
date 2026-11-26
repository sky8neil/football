import { describe, expect, it, vi } from "vitest";
import { MatchStatus, SettlementStatus } from "../domain/enums.js";
import type { Match } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { InMemorySchedulerStateStore } from "../infrastructure/cloudbase-scheduler-state.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { newUuid } from "../domain/ids.js";
import { ProviderBudgetDeniedError } from "../provider/budget.js";
import { ProviderQuotaExceededError, type ApiFootballFixturesQuery } from "../provider/http.js";
import { makeApiFixture } from "../provider/fixture-factory.js";
import { loadStaleRecoveryBatches, ProviderStaleRecoveryService, STALE_RECOVERY_ROUND_CAP } from "./provider-stale-recovery.js";
import type { ProviderFixtureBatchItem } from "./provider-sync-job.js";

const now = new Date("2026-10-12T12:00:00.000Z");
const fixture = { fixture: { id: "external" } } as any;

async function drain(generator: AsyncGenerator<unknown>): Promise<void> {
  for await (const _batch of generator) {}
}

function setup(count = 1) {
  let matches = Array.from({ length: count }, (_, index) => ({
    match_id: `match-${index}`, league_id: index === 1 ? "la_liga" : "premier_league", season_id: "2026_2027",
    kickoff_at: new Date("2026-10-10T23:00:00.000Z"), match_status: MatchStatus.Scheduled,
  } as Match));
  const findActiveWindow = vi.fn(async ({ limit }: { limit: number }) => matches.filter((match) => match.match_status !== MatchStatus.Finished).slice(0, limit));
  const repo = {
    matches: { findActiveWindow },
    matchProviderMappings: { findByProviderAndExternalId: async () => ({ match_id: "match-0" }) },
  } as unknown as AppRepository;
  const client = { getFixtures: vi.fn(async (query: ApiFootballFixturesQuery) => query.dateFrom === "2026-10-10" ? [fixture] : []), getFixturesFromSource: vi.fn(async () => []), log: vi.fn() };
  return { repo, client, findActiveWindow, finish: () => { matches[0]!.match_status = MatchStatus.Finished; }, clear: () => { matches = []; } };
}

describe("stale recovery loader", () => {
  it("主源恢复终态后不请求 of，下一轮没有候选", async () => {
    const context = setup();
    const batches = loadStaleRecoveryBatches(context.repo, context.client, now);
    expect((await batches.next()).value).toEqual([{ fixture, payload: { fixture }, seasonId: "2026_2027" }]);
    context.finish();
    await batches.next();
    expect(context.client.getFixturesFromSource).not.toHaveBeenCalled();
    await drain(loadStaleRecoveryBatches(context.repo, context.client, now));
    expect(context.client.getFixtures).toHaveBeenCalledTimes(2);
  });

  it("主源未命中时查询 of，日期包含次日", async () => {
    const context = setup();
    context.client.getFixtures.mockResolvedValue([]);
    await drain(loadStaleRecoveryBatches(context.repo, context.client, now));
    expect(context.client.getFixtures.mock.calls.map(([query]) => query.dateFrom)).toEqual(["2026-10-10", "2026-10-11"]);
    expect(context.client.getFixturesFromSource).toHaveBeenCalledTimes(2);
  });

  it("限制单轮候选并记录截断", async () => {
    const context = setup(12);
    await drain(loadStaleRecoveryBatches(context.repo, context.client, now));
    expect(context.findActiveWindow).toHaveBeenCalledWith(expect.objectContaining({ limit: STALE_RECOVERY_ROUND_CAP }));
    expect(context.client.log).toHaveBeenCalledWith(expect.objectContaining({ event: "provider_stale_recovery_capped", cap: 10 }));
  });

  it("单轮只同步最早的十场候选", async () => {
    const matches = Array.from({ length: 12 }, (_, index) => ({ match_id: `match-${index}`, league_id: "premier_league", season_id: "2026_2027", kickoff_at: new Date("2026-10-10T23:00:00.000Z") } as Match));
    const repo = {
      matches: { findActiveWindow: async ({ limit }: { limit: number }) => matches.slice(0, limit) },
      matchProviderMappings: { findByProviderAndExternalId: async (_provider: string, id: string) => ({ match_id: `match-${id}` }) },
    } as unknown as AppRepository;
    const client = { getFixtures: vi.fn(async (query: ApiFootballFixturesQuery) => query.dateFrom === "2026-10-10" ? matches.map((_, index) => ({ fixture: { id: index } } as any)) : []) };
    const batch = await loadStaleRecoveryBatches(repo, client, now).next();
    expect(batch.value).toHaveLength(10);
    expect((batch.value as readonly ProviderFixtureBatchItem[]).map((item) => item.fixture.fixture.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("预算拒绝后停止所有联赛并记录剩余场数", async () => {
    const context = setup(2);
    context.client.getFixtures.mockRejectedValue(new ProviderBudgetDeniedError("exhausted"));
    await drain(loadStaleRecoveryBatches(context.repo, context.client, now));
    expect(context.client.getFixtures).toHaveBeenCalledTimes(1);
    expect(context.client.log).toHaveBeenCalledWith(expect.objectContaining({ event: "provider_stale_recovery_exhausted", remaining: 2 }));
  });

  it.each([
    { label: "当前赛季", runNow: now, date: "2026-10-10T23:00:00.000Z", seasonId: "2026_2027" },
    { label: "旧赛季跨年恢复", runNow: new Date("2027-01-02T12:00:00Z"), date: "2026-12-31T23:00:00.000Z", seasonId: "2025_2026" },
  ])("$label 的请求与入库沿用比赛赛季", async ({ runNow, date, seasonId }) => {
    const repo = new InMemoryRepository();
    const matchId = newUuid();
    const kickoff = new Date(date);
    const match: Match = {
      schema_version: 1, match_id: matchId, canonical_match_id: matchId, superseded_by: null,
      league_id: "premier_league", season_id: seasonId, round_id: "01",
      home_team_id: newUuid(), away_team_id: newUuid(), kickoff_at: kickoff, kickoff_confirmed: true,
      prediction_deadline_at: new Date(kickoff.getTime() - 600_000), prediction_closed_at: null,
      period_anchor_at: null, match_status: MatchStatus.Live, settlement_status: SettlementStatus.Pending,
      regular_home_score: null, regular_away_score: null, extra_home_score: null, extra_away_score: null,
      penalty_home_score: null, penalty_away_score: null, result_version: 0, settled_result_version: 0,
      result_source: null, scoring_rule_version: "scoring_v1", finish_detected_at: null,
      settled_at: null, created_at: kickoff, updated_at: kickoff,
    };
    await repo.matches.insert(match);
    await repo.matchProviderMappings.insert({ schema_version: 1, match_id: matchId, provider: "football_data", provider_match_id: "1100001", created_at: kickoff, updated_at: kickoff });
    const finalFixture = makeApiFixture({ statusShort: "FT", date: kickoff.toISOString(), timestamp: kickoff.getTime() / 1000 });
    finalFixture.provider = "football_data";
    finalFixture.league.id = "PL";
    finalFixture.league.season = seasonId.split("_")[0]!;
    const client = { getFixtures: vi.fn(async (query: ApiFootballFixturesQuery) => query.dateFrom === date.slice(0, 10) ? [finalFixture] : []), getFixturesFromSource: vi.fn(async () => []) };
    const service = new ProviderStaleRecoveryService(repo, client);
    const outcome = await service.run(runNow);
    expect(outcome).toMatchObject({ kind: "completed", items_failed: 0 });
    expect(client.getFixtures).toHaveBeenCalledWith(expect.objectContaining({ season: seasonId.split("_")[0], seasonId }));
    expect(await repo.matches.findById(matchId)).toMatchObject({ match_status: MatchStatus.Finished, season_id: seasonId });
    expect(await repo.matches.findActiveWindow({ jobType: "stale_recovery", now: new Date(runNow.getTime() + 24 * 3600_000), limit: 10 })).toEqual([]);
    expect(client.getFixturesFromSource).not.toHaveBeenCalled();
  });

  it("[CR42-08] 11 场滞留且前 10 场持续不可恢复时，连续多轮轮转推进并在不改变单轮上限 10 的前提下恢复第 11 场（兼容重启）", async () => {
    expect(STALE_RECOVERY_ROUND_CAP).toBe(10);
    const repo = new InMemoryRepository();
    const schedulerState = new InMemorySchedulerStateStore();
    const baseKickoff = new Date("2026-10-10T18:00:00.000Z");
    const matchIds: string[] = [];

    for (let index = 1; index <= 11; index += 1) {
      const padded = String(index).padStart(2, "0");
      const matchId = `00000000-0000-4000-8000-0000000002${padded}`;
      const kickoff = new Date(baseKickoff.getTime() + index * 60_000);
      matchIds.push(matchId);
      await repo.matches.insert({
        schema_version: 1,
        match_id: matchId,
        canonical_match_id: matchId,
        superseded_by: null,
        league_id: "premier_league",
        season_id: "2026_2027",
        round_id: "01",
        home_team_id: newUuid(),
        away_team_id: newUuid(),
        kickoff_at: kickoff,
        kickoff_confirmed: true,
        prediction_deadline_at: new Date(kickoff.getTime() - 600_000),
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
        created_at: kickoff,
        updated_at: kickoff,
      });
      await repo.matchProviderMappings.insert({
        schema_version: 1,
        match_id: matchId,
        provider: "football_data",
        provider_match_id: String(2200000 + index),
        created_at: kickoff,
        updated_at: kickoff,
      });
    }

    const match11Id = matchIds[10]!;
    const match11 = (await repo.matches.findById(match11Id))!;
    const ft11 = makeApiFixture({
      fixtureId: 2200011,
      statusShort: "FT",
      fulltimeHome: 3,
      fulltimeAway: 1,
      date: match11.kickoff_at.toISOString(),
      timestamp: match11.kickoff_at.getTime() / 1000,
    });
    ft11.provider = "football_data";
    ft11.league.id = "PL";
    ft11.league.season = "2026";

    const matchesRepo = repo.matches;
    const findActiveWindowSpy = vi.spyOn(matchesRepo, "findActiveWindow");
    const repoProxy = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "matches") return matchesRepo;
        return Reflect.get(target, prop, receiver);
      },
    });
    const client = {
      getFixtures: vi.fn(async (query: ApiFootballFixturesQuery) =>
        query.dateFrom === "2026-10-10" ? [ft11] : [],
      ),
      getFixturesFromSource: vi.fn(async () => []),
      log: vi.fn(),
    };

    // 第 1 轮（上限 10）：取前 10 场，第 11 场不在此批中，记录游标并推进一步
    const serviceBeforeRestart = new ProviderStaleRecoveryService(
      repoProxy,
      client,
      {},
      {},
      undefined,
      client.log,
      schedulerState,
    );
    const round1 = await serviceBeforeRestart.run(new Date("2026-10-12T12:00:00.000Z"));
    expect(round1).toMatchObject({ kind: "completed" });
    expect((await repo.matches.findById(match11Id))?.match_status).toBe(MatchStatus.Scheduled);
    expect(await schedulerState.getStaleRecoveryCursor()).toMatchObject({
      cursor_match_id: matchIds[9],
    });
    expect(findActiveWindowSpy.mock.calls[0]?.[0]).toMatchObject({
      limit: STALE_RECOVERY_ROUND_CAP,
    });

    // 模拟无状态进程重启：使用新实例 + 持久化 schedulerState 跑第 2 轮，必须轮转到第 11 场并完场更新
    const serviceAfterRestart = new ProviderStaleRecoveryService(
      repoProxy,
      client,
      {},
      {},
      undefined,
      client.log,
      schedulerState,
    );
    const round2 = await serviceAfterRestart.run(new Date("2026-10-12T12:10:00.000Z"));
    expect(round2).toMatchObject({ kind: "completed", items_changed: 1, items_failed: 0 });
    expect(await repo.matches.findById(match11Id)).toMatchObject({
      match_status: MatchStatus.Finished,
      regular_home_score: 3,
      regular_away_score: 1,
    });
    // 队尾不足 10 场时重置游标，第 3 轮回到队首继续尝试前 10 场
    expect(await schedulerState.getStaleRecoveryCursor()).toMatchObject({
      cursor_kickoff_at: null,
      cursor_match_id: null,
    });

    const round3 = await serviceAfterRestart.run(new Date("2026-10-12T12:20:00.000Z"));
    expect(round3).toMatchObject({ kind: "completed" });
    const round3Remaining = await repo.matches.findActiveWindow({
      jobType: "stale_recovery",
      now: new Date("2026-10-12T12:20:00.000Z"),
      limit: 20,
    });
    expect(round3Remaining).toHaveLength(10);
    expect(round3Remaining.some((match) => match.match_id === match11Id)).toBe(false);
  });

  it("[CR43-04] 同联赛赛季多日滞留且单轮预算仅够 6 次请求时，每轮保存组内游标进度并最终访问恢复第 11 场", async () => {
    const repo = new InMemoryRepository();
    const schedulerState = new InMemorySchedulerStateStore();
    const kickoffs = [
      "2026-09-01T18:00:00.000Z",
      "2026-09-02T18:00:00.000Z",
      "2026-09-03T18:00:00.000Z",
      "2026-09-04T18:00:00.000Z",
      "2026-09-05T18:00:00.000Z",
      "2026-09-06T18:00:00.000Z",
      "2026-09-07T12:00:00.000Z",
      "2026-09-07T14:00:00.000Z",
      "2026-09-07T16:00:00.000Z",
      "2026-09-07T18:00:00.000Z",
      "2026-09-07T20:00:00.000Z",
    ];
    const matchIds: string[] = [];
    for (let index = 0; index < kickoffs.length; index += 1) {
      const padded = String(index + 1).padStart(2, "0");
      const matchId = `00000000-0000-4000-8000-0000000004${padded}`;
      const kickoff = new Date(kickoffs[index]!);
      matchIds.push(matchId);
      await repo.matches.insert({
        schema_version: 1,
        match_id: matchId,
        canonical_match_id: matchId,
        superseded_by: null,
        league_id: "premier_league",
        season_id: "2026_2027",
        round_id: "01",
        home_team_id: newUuid(),
        away_team_id: newUuid(),
        kickoff_at: kickoff,
        kickoff_confirmed: true,
        prediction_deadline_at: new Date(kickoff.getTime() - 600_000),
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
        created_at: kickoff,
        updated_at: kickoff,
      });
      await repo.matchProviderMappings.insert({
        schema_version: 1,
        match_id: matchId,
        provider: "football_data",
        provider_match_id: String(4400000 + index + 1),
        created_at: kickoff,
        updated_at: kickoff,
      });
    }

    const match11Id = matchIds[10]!;
    const match11 = (await repo.matches.findById(match11Id))!;
    const ft11 = makeApiFixture({
      fixtureId: 4400011,
      statusShort: "FT",
      fulltimeHome: 2,
      fulltimeAway: 0,
      date: match11.kickoff_at.toISOString(),
      timestamp: match11.kickoff_at.getTime() / 1000,
    });
    ft11.provider = "football_data";
    ft11.league.id = "PL";
    ft11.league.season = "2026";

    let roundRequests = 0;
    const roundRequestedKeys: string[][] = [];
    let currentRoundKeys: string[] = [];
    const consumeBudget = (source: string, query: ApiFootballFixturesQuery) => {
      roundRequests += 1;
      if (roundRequests > 6) {
        throw new ProviderBudgetDeniedError("day_limit");
      }
      const key = `${source}|${query.leagueId}|${query.seasonId}|${query.dateFrom}`;
      currentRoundKeys.push(key);
    };

    const client = {
      getFixtures: vi.fn(async (query: ApiFootballFixturesQuery) => {
        consumeBudget("primary", query);
        return query.dateFrom === "2026-09-07" ? [ft11] : [];
      }),
      getFixturesFromSource: vi.fn(async (sourceId: string, query: ApiFootballFixturesQuery) => {
        consumeBudget(sourceId, query);
        return [];
      }),
      log: vi.fn(),
    };

    const runRound = async (minutesOffset: number) => {
      roundRequests = 0;
      currentRoundKeys = [];
      const service = new ProviderStaleRecoveryService(
        repo,
        client,
        {},
        {},
        undefined,
        client.log,
        schedulerState,
      );
      const outcome = await service.run(new Date(Date.parse("2026-09-10T12:00:00.000Z") + minutesOffset * 60_000));
      roundRequestedKeys.push(currentRoundKeys);
      expect(new Set(currentRoundKeys).size).toBe(currentRoundKeys.length);
      return outcome;
    };

    // 第 1 轮：第 7 次请求抛 ProviderBudgetDeniedError，必须推进持久游标（不得停在 null）
    const round1 = await runRound(0);
    expect(round1).toMatchObject({ kind: "completed" });
    const cursorAfterRound1 = await schedulerState.getStaleRecoveryCursor();
    expect(cursorAfterRound1?.cursor_match_id).toBe(matchIds[1]);
    expect(cursorAfterRound1?.cursor_kickoff_at?.toISOString()).toBe(kickoffs[1]);
    expect((await repo.matches.findById(match11Id))?.match_status).toBe(MatchStatus.Scheduled);

    // 连续多轮推进，必然访问第 11 场并完场恢复
    let nextRound = 1;
    for (; nextRound <= 5; nextRound += 1) {
      const outcome = await runRound(nextRound * 60);
      expect(outcome).toMatchObject({ kind: "completed", items_failed: 0 });
      if ((await repo.matches.findById(match11Id))?.match_status === MatchStatus.Finished) {
        break;
      }
    }

    expect(await repo.matches.findById(match11Id)).toMatchObject({
      match_status: MatchStatus.Finished,
      regular_home_score: 2,
      regular_away_score: 0,
    });
    expect(roundRequestedKeys.flat().some((key) => key.endsWith("|2026-09-07"))).toBe(true);

    // 队尾不足 10 场且未耗尽预算的收尾轮次结束后，游标回卷重置为 null
    const tailOutcome = await runRound((nextRound + 1) * 60);
    expect(tailOutcome).toMatchObject({ kind: "completed", items_failed: 0 });
    expect(await schedulerState.getStaleRecoveryCursor()).toMatchObject({
      cursor_kickoff_at: null,
      cursor_match_id: null,
    });
  });

  it("[CR43-04] 普通网络错误走 recordComparisonSkipped 且不卡死队列；配额耗尽时仍吐出当组已取回的 FT 并推进游标", async () => {
    const repo = new InMemoryRepository();
    const schedulerState = new InMemorySchedulerStateStore();
    const day1Kickoff = new Date("2026-09-01T18:00:00.000Z");
    const day2Kickoff = new Date("2026-09-03T18:00:00.000Z");
    const match1Id = "00000000-0000-4000-8000-000000000501";
    const match2Id = "00000000-0000-4000-8000-000000000502";

    for (const [index, [matchId, kickoff]] of ([[match1Id, day1Kickoff], [match2Id, day2Kickoff]] as const).entries()) {
      await repo.matches.insert({
        schema_version: 1,
        match_id: matchId,
        canonical_match_id: matchId,
        superseded_by: null,
        league_id: "premier_league",
        season_id: "2026_2027",
        round_id: "01",
        home_team_id: newUuid(),
        away_team_id: newUuid(),
        kickoff_at: kickoff,
        kickoff_confirmed: true,
        prediction_deadline_at: new Date(kickoff.getTime() - 600_000),
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
        created_at: kickoff,
        updated_at: kickoff,
      });
      await repo.matchProviderMappings.insert({
        schema_version: 1,
        match_id: matchId,
        provider: "football_data",
        provider_match_id: String(5500000 + index + 1),
        created_at: kickoff,
        updated_at: kickoff,
      });
    }

    const ft1 = makeApiFixture({
      fixtureId: 5500001,
      statusShort: "FT",
      fulltimeHome: 1,
      fulltimeAway: 0,
      date: day1Kickoff.toISOString(),
      timestamp: day1Kickoff.getTime() / 1000,
    });
    ft1.provider = "football_data";
    ft1.league.id = "PL";
    ft1.league.season = "2026";

    const recordComparisonSkipped = vi.fn();
    const client = {
      getFixtures: vi.fn(async (query: ApiFootballFixturesQuery) => {
        if (query.dateFrom === "2026-09-01") return [ft1];
        if (query.dateFrom === "2026-09-02") throw new Error("network timeout");
        if (query.dateFrom === "2026-09-03") return [];
        throw new ProviderQuotaExceededError(new Date("2026-09-05T00:00:00.000Z"));
      }),
      recordComparisonSkipped,
      log: vi.fn(),
    };

    const service = new ProviderStaleRecoveryService(repo, client, {}, {}, undefined, client.log, schedulerState);
    const outcome = await service.run(new Date("2026-09-10T12:00:00.000Z"));
    expect(outcome).toMatchObject({ kind: "completed", items_changed: 1, items_failed: 0 });
    expect(recordComparisonSkipped).toHaveBeenCalledWith("fd", "premier_league", expect.any(Error));
    expect(await repo.matches.findById(match1Id)).toMatchObject({
      match_status: MatchStatus.Finished,
      regular_home_score: 1,
      regular_away_score: 0,
    });
    expect(await schedulerState.getStaleRecoveryCursor()).toMatchObject({
      cursor_match_id: match1Id,
      cursor_kickoff_at: day1Kickoff,
    });
  });

  it("[CR44-01] 场景 A：副源无额度时不阻断后续主源查询与游标推进，连续轮次恢复较晚日期主源 FT", async () => {
    const repo = new InMemoryRepository();
    const schedulerState = new InMemorySchedulerStateStore();
    const matchIds: string[] = [];

    for (let day = 1; day <= 11; day += 1) {
      const padded = String(day).padStart(2, "0");
      const matchId = `00000000-0000-4000-8000-0000000006${padded}`;
      const kickoff = new Date(`2026-09-${padded}T18:00:00.000Z`);
      matchIds.push(matchId);
      await repo.matches.insert({
        schema_version: 1,
        match_id: matchId,
        canonical_match_id: matchId,
        superseded_by: null,
        league_id: "premier_league",
        season_id: "2026_2027",
        round_id: "01",
        home_team_id: newUuid(),
        away_team_id: newUuid(),
        kickoff_at: kickoff,
        kickoff_confirmed: true,
        prediction_deadline_at: new Date(kickoff.getTime() - 600_000),
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
        created_at: kickoff,
        updated_at: kickoff,
      });
      await repo.matchProviderMappings.insert({
        schema_version: 1,
        match_id: matchId,
        provider: "football_data",
        provider_match_id: String(6600000 + day),
        created_at: kickoff,
        updated_at: kickoff,
      });
    }

    const match11Id = matchIds[10]!;
    const match11 = (await repo.matches.findById(match11Id))!;
    const ft11 = makeApiFixture({
      fixtureId: 6600011,
      statusShort: "FT",
      fulltimeHome: 2,
      fulltimeAway: 1,
      date: match11.kickoff_at.toISOString(),
      timestamp: match11.kickoff_at.getTime() / 1000,
    });
    ft11.provider = "football_data";
    ft11.league.id = "PL";
    ft11.league.season = "2026";

    const primaryDatesPerRound: string[][] = [];
    const secondaryDatesPerRound: string[][] = [];
    let currentPrimaryDates: string[] = [];
    let currentSecondaryDates: string[] = [];

    const client = {
      getFixtures: vi.fn(async (query: ApiFootballFixturesQuery) => {
        currentPrimaryDates.push(query.dateFrom ?? "");
        return query.dateFrom === "2026-09-11" ? [ft11] : [];
      }),
      getFixturesFromSource: vi.fn(async (_sourceId: string, query: ApiFootballFixturesQuery) => {
        currentSecondaryDates.push(query.dateFrom ?? "");
        throw new ProviderBudgetDeniedError("day_limit");
      }),
      log: vi.fn(),
    };

    const runRound = async (serverNowIso: string) => {
      currentPrimaryDates = [];
      currentSecondaryDates = [];
      const service = new ProviderStaleRecoveryService(
        repo,
        client,
        {},
        {},
        undefined,
        client.log,
        schedulerState,
      );
      const outcome = await service.run(new Date(serverNowIso));
      primaryDatesPerRound.push(currentPrimaryDates);
      secondaryDatesPerRound.push(currentSecondaryDates);
      return outcome;
    };

    // 第 1 轮：前 10 场主源全部可执行，副源首个日期被预算拒绝后本轮不再重复请求副源，游标推进到第 10 场
    const round1 = await runRound("2026-09-13T12:00:00.000Z");
    expect(round1).toMatchObject({ kind: "completed", items_failed: 0 });
    expect(secondaryDatesPerRound[0]).toEqual(["2026-09-01"]);
    expect(primaryDatesPerRound[0]).toContain("2026-09-10");
    expect(await schedulerState.getStaleRecoveryCursor()).toMatchObject({
      cursor_match_id: matchIds[9],
    });
    expect((await repo.matches.findById(match11Id))?.match_status).toBe(MatchStatus.Scheduled);

    // 第 2 轮：推进到第 11 场，通过主源恢复 FT 并回卷游标
    const round2 = await runRound("2026-09-14T12:00:00.000Z");
    expect(round2).toMatchObject({ kind: "completed", items_changed: 1, items_failed: 0 });
    expect(secondaryDatesPerRound[1]).toEqual([]);
    expect(await repo.matches.findById(match11Id)).toMatchObject({
      match_status: MatchStatus.Finished,
      regular_home_score: 2,
      regular_away_score: 1,
    });
    expect(await schedulerState.getStaleRecoveryCursor()).toMatchObject({
      cursor_kickoff_at: null,
      cursor_match_id: null,
    });
  });

  it("[CR44-01] 场景 B：每轮仅能成功 1 次主源日期请求且首日无 FT 时，跨轮保留组内进度、不丢次日窗口且持续推进", async () => {
    const repo = new InMemoryRepository();
    const schedulerState = new InMemorySchedulerStateStore();
    const kickoffs = [
      "2026-09-01T18:00:00.000Z",
      "2026-09-02T23:00:00.000Z",
      "2026-09-03T18:00:00.000Z",
    ];
    const matchIds: string[] = [];

    for (let index = 0; index < kickoffs.length; index += 1) {
      const padded = String(index + 1).padStart(2, "0");
      const matchId = `00000000-0000-4000-8000-0000000007${padded}`;
      const kickoff = new Date(kickoffs[index]!);
      matchIds.push(matchId);
      await repo.matches.insert({
        schema_version: 1,
        match_id: matchId,
        canonical_match_id: matchId,
        superseded_by: null,
        league_id: "premier_league",
        season_id: "2026_2027",
        round_id: "01",
        home_team_id: newUuid(),
        away_team_id: newUuid(),
        kickoff_at: kickoff,
        kickoff_confirmed: true,
        prediction_deadline_at: new Date(kickoff.getTime() - 600_000),
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
        created_at: kickoff,
        updated_at: kickoff,
      });
      await repo.matchProviderMappings.insert({
        schema_version: 1,
        match_id: matchId,
        provider: "football_data",
        provider_match_id: String(7700000 + index + 1),
        created_at: kickoff,
        updated_at: kickoff,
      });
    }

    // 第 2 场（9/2 开球）的 FT 落在次日窗口 9/3；第 3 场（9/3 开球）的 FT 也落在 9/3
    const ft2 = makeApiFixture({
      fixtureId: 7700002,
      statusShort: "FT",
      fulltimeHome: 1,
      fulltimeAway: 1,
      date: "2026-09-03T01:00:00.000Z",
      timestamp: Date.parse("2026-09-03T01:00:00.000Z") / 1000,
    });
    ft2.provider = "football_data";
    ft2.league.id = "PL";
    ft2.league.season = "2026";

    const ft3 = makeApiFixture({
      fixtureId: 7700003,
      statusShort: "FT",
      fulltimeHome: 3,
      fulltimeAway: 0,
      date: kickoffs[2]!,
      timestamp: Date.parse(kickoffs[2]!) / 1000,
    });
    ft3.provider = "football_data";
    ft3.league.id = "PL";
    ft3.league.season = "2026";

    let primaryRequestsThisRound = 0;
    const requestedPrimaryDates: string[][] = [];
    let currentRoundDates: string[] = [];

    const client = {
      getFixtures: vi.fn(async (query: ApiFootballFixturesQuery) => {
        primaryRequestsThisRound += 1;
        if (primaryRequestsThisRound > 1) {
          throw new ProviderBudgetDeniedError("day_limit");
        }
        currentRoundDates.push(query.dateFrom ?? "");
        return query.dateFrom === "2026-09-03" ? [ft2, ft3] : [];
      }),
      getFixturesFromSource: vi.fn(async () => {
        throw new ProviderBudgetDeniedError("day_limit");
      }),
      log: vi.fn(),
    };

    const runRound = async (minutesOffset: number) => {
      primaryRequestsThisRound = 0;
      currentRoundDates = [];
      const service = new ProviderStaleRecoveryService(
        repo,
        client,
        {},
        {},
        undefined,
        client.log,
        schedulerState,
      );
      const outcome = await service.run(new Date(Date.parse("2026-09-10T12:00:00.000Z") + minutesOffset * 60_000));
      requestedPrimaryDates.push(currentRoundDates);
      return outcome;
    };

    // 第 1 轮：仅完成 9/1，9/2 被拒 -> 保存组内进度
    expect(await runRound(0)).toMatchObject({ kind: "completed", items_failed: 0 });
    expect(requestedPrimaryDates[0]).toEqual(["2026-09-01"]);
    expect(await schedulerState.getStaleRecoveryCursor()).toMatchObject({
      cursor_match_id: null,
      group_progress: {
        group_key: "premier_league|2026_2027|2026-09-01",
        completed_primary_dates: ["2026-09-01"],
      },
    });

    // 第 2 轮：续查 9/2 完成第 1 组，推进游标至第 1 场
    expect(await runRound(60)).toMatchObject({ kind: "completed", items_failed: 0 });
    expect(requestedPrimaryDates[1]).toEqual(["2026-09-02"]);
    expect(await schedulerState.getStaleRecoveryCursor()).toMatchObject({
      cursor_match_id: matchIds[0],
    });

    // 第 3 轮：开始第 2 组（9/2），9/3 被拒 -> 保存第 2 组组内进度，不回退到第 1 组
    expect(await runRound(120)).toMatchObject({ kind: "completed", items_failed: 0 });
    expect(requestedPrimaryDates[2]).toEqual(["2026-09-02"]);
    expect(await schedulerState.getStaleRecoveryCursor()).toMatchObject({
      cursor_match_id: matchIds[0],
      group_progress: {
        group_key: "premier_league|2026_2027|2026-09-02",
        completed_primary_dates: ["2026-09-02"],
      },
    });

    // 第 4 轮：续查 9/3，命中第 2 场次日窗口 FT 且在同轮命中第 3 场当日 FT（即使 9/4 被预算拒绝也必须落地）
    expect(await runRound(180)).toMatchObject({ kind: "completed", items_changed: 2, items_failed: 0 });
    expect(requestedPrimaryDates[3]).toEqual(["2026-09-03"]);
    expect(await repo.matches.findById(matchIds[1]!)).toMatchObject({
      match_status: MatchStatus.Finished,
      regular_home_score: 1,
      regular_away_score: 1,
    });
    expect(await repo.matches.findById(matchIds[2]!)).toMatchObject({
      match_status: MatchStatus.Finished,
      regular_home_score: 3,
      regular_away_score: 0,
    });
  });

  it("[CR44-01] 同日多场中当日已取得部分 FT、次日预算拒绝时，已取得 FT 落地且下轮仅补查次日窗口", async () => {
    const repo = new InMemoryRepository();
    const schedulerState = new InMemorySchedulerStateStore();
    const kickoff1 = new Date("2026-09-01T15:00:00.000Z");
    const kickoff2 = new Date("2026-09-01T23:00:00.000Z");
    const match1Id = "00000000-0000-4000-8000-000000000801";
    const match2Id = "00000000-0000-4000-8000-000000000802";

    for (const [index, [matchId, kickoff]] of ([[match1Id, kickoff1], [match2Id, kickoff2]] as const).entries()) {
      await repo.matches.insert({
        schema_version: 1,
        match_id: matchId,
        canonical_match_id: matchId,
        superseded_by: null,
        league_id: "premier_league",
        season_id: "2026_2027",
        round_id: "01",
        home_team_id: newUuid(),
        away_team_id: newUuid(),
        kickoff_at: kickoff,
        kickoff_confirmed: true,
        prediction_deadline_at: new Date(kickoff.getTime() - 600_000),
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
        created_at: kickoff,
        updated_at: kickoff,
      });
      await repo.matchProviderMappings.insert({
        schema_version: 1,
        match_id: matchId,
        provider: "football_data",
        provider_match_id: String(8800000 + index + 1),
        created_at: kickoff,
        updated_at: kickoff,
      });
    }

    const ft1 = makeApiFixture({
      fixtureId: 8800001,
      statusShort: "FT",
      fulltimeHome: 2,
      fulltimeAway: 0,
      date: kickoff1.toISOString(),
      timestamp: kickoff1.getTime() / 1000,
    });
    ft1.provider = "football_data";
    ft1.league.id = "PL";
    ft1.league.season = "2026";

    const ft2 = makeApiFixture({
      fixtureId: 8800002,
      statusShort: "FT",
      fulltimeHome: 0,
      fulltimeAway: 1,
      date: "2026-09-02T01:00:00.000Z",
      timestamp: Date.parse("2026-09-02T01:00:00.000Z") / 1000,
    });
    ft2.provider = "football_data";
    ft2.league.id = "PL";
    ft2.league.season = "2026";

    let primaryRequestsThisRound = 0;
    const requestedDates: string[] = [];
    const client = {
      getFixtures: vi.fn(async (query: ApiFootballFixturesQuery) => {
        primaryRequestsThisRound += 1;
        if (primaryRequestsThisRound > 1) {
          throw new ProviderQuotaExceededError(new Date("2026-09-03T00:00:00.000Z"));
        }
        requestedDates.push(query.dateFrom ?? "");
        if (query.dateFrom === "2026-09-01") return [ft1];
        if (query.dateFrom === "2026-09-02") return [ft2];
        return [];
      }),
      log: vi.fn(),
    };

    const service = new ProviderStaleRecoveryService(repo, client, {}, {}, undefined, client.log, schedulerState);

    // 第 1 轮：9/1 返回第 1 场 FT，9/2 配额拒绝 -> 第 1 场立即完场，组内进度保留给同日第 2 场
    const round1 = await service.run(new Date("2026-09-10T12:00:00.000Z"));
    expect(round1).toMatchObject({ kind: "completed", items_changed: 1, items_failed: 0 });
    expect(await repo.matches.findById(match1Id)).toMatchObject({
      match_status: MatchStatus.Finished,
      regular_home_score: 2,
      regular_away_score: 0,
    });
    expect((await repo.matches.findById(match2Id))?.match_status).toBe(MatchStatus.Scheduled);
    expect(await schedulerState.getStaleRecoveryCursor()).toMatchObject({
      cursor_match_id: match1Id,
      group_progress: {
        group_key: "premier_league|2026_2027|2026-09-01",
        completed_primary_dates: ["2026-09-01"],
      },
    });

    // 第 2 轮：跳过 9/1，仅查 9/2 恢复第 2 场并清空游标与组内进度
    primaryRequestsThisRound = 0;
    const round2 = await service.run(new Date("2026-09-10T13:00:00.000Z"));
    expect(round2).toMatchObject({ kind: "completed", items_changed: 1, items_failed: 0 });
    expect(requestedDates).toEqual(["2026-09-01", "2026-09-02"]);
    expect(await repo.matches.findById(match2Id)).toMatchObject({
      match_status: MatchStatus.Finished,
      regular_home_score: 0,
      regular_away_score: 1,
    });
    const finalCursor = await schedulerState.getStaleRecoveryCursor();
    expect(finalCursor).toEqual({
      cursor_kickoff_at: null,
      cursor_match_id: null,
      last_run_at: new Date("2026-09-10T13:00:00.000Z"),
      updated_at: new Date("2026-09-10T13:00:00.000Z"),
    });
  });
});
