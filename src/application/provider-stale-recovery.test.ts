import { describe, expect, it, vi } from "vitest";
import { MatchStatus, SettlementStatus } from "../domain/enums.js";
import type { Match } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { newUuid } from "../domain/ids.js";
import { ProviderBudgetDeniedError } from "../provider/budget.js";
import type { ApiFootballFixturesQuery } from "../provider/http.js";
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
});
