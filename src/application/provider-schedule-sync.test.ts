import { describe, expect, it, vi } from "vitest";
import { AnomalyType, MatchStatus, Provider, SettlementStatus } from "../domain/enums.js";
import { MVP_SEASON } from "../domain/config.js";
import { newUuid } from "../domain/ids.js";
import type { Team, TeamProviderMapping } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { makeApiFixture } from "../provider/fixture-factory.js";
import type { ApiFootballFixture } from "../provider/types.js";
import { ProviderFixtureSyncService } from "./provider-fixture-sync.js";
import { resolveEffectiveMatch } from "./match-identity.js";

const NOW = new Date("2026-08-10T12:00:00.000Z");

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

function makeTeamMapping(teamId: string, providerTeamId: string): TeamProviderMapping {
  return {
    schema_version: 1,
    team_id: teamId,
    provider: Provider.ApiFootball,
    provider_team_id: providerTeamId,
    created_at: NOW,
    updated_at: NOW,
  };
}

async function seedTeams(repo: InMemoryRepository): Promise<{
  homeTeamId: string;
  awayTeamId: string;
}> {
  const homeTeamId = newUuid();
  const awayTeamId = newUuid();
  await repo.teams.insert(makeTeam(homeTeamId));
  await repo.teams.insert(makeTeam(awayTeamId));
  await repo.teamProviderMappings.insert(makeTeamMapping(homeTeamId, "40"));
  await repo.teamProviderMappings.insert(makeTeamMapping(awayTeamId, "41"));
  return { homeTeamId, awayTeamId };
}

describe("Provider schedule discovery", () => {
  it.each([MatchStatus.Scheduled, MatchStatus.Postponed])("新来源 ID 归并非终态候选 %s 并保留历史字段", async (status) => {
    const repo = new InMemoryRepository();
    await seedTeams(repo);
    const service = new ProviderFixtureSyncService(repo);
    const first = makeApiFixture({ fixtureId: 1190100, statusShort: "NS" });
    await service.applyFixture(first, {}, NOW);
    const mapping = (await repo.matchProviderMappings.findByProviderAndExternalId(Provider.ApiFootball, "1190100"))!;
    const original = (await repo.matches.findById(mapping.match_id))!;
    const candidate = { ...original, match_status: status };
    await repo.matches.update(candidate);
    const nextNow = new Date(NOW.getTime() + 1000);
    const next = makeApiFixture({ fixtureId: 1190101, statusShort: "NS" });
    const result = await service.applyFixture(next, {}, nextNow);
    expect(result.kind).toBe("applied");
    const nextMapping = (await repo.matchProviderMappings.findByProviderAndExternalId(Provider.ApiFootball, "1190101"))!;
    const effective = (await repo.matches.findById(nextMapping.match_id))!;
    expect(effective.canonical_match_id).toBe(candidate.canonical_match_id);
    expect(effective.superseded_by).toBeNull();
    expect(await repo.matches.findById(candidate.match_id)).toEqual({ ...candidate, superseded_by: effective.match_id, updated_at: nextNow });
    expect(await repo.matches.findBySeason(candidate.season_id)).toHaveLength(2);
  });

  it.each([
    { status: MatchStatus.Finished, extra: false, reason: "terminal_candidate", id: 1190200 },
    { status: MatchStatus.Cancelled, extra: false, reason: "terminal_candidate", id: 1190210 },
    { status: MatchStatus.Abandoned, extra: false, reason: "terminal_candidate", id: 1190220 },
    { status: MatchStatus.Scheduled, extra: true, reason: "ambiguous_candidates", id: 1190300 },
  ])("$reason 保持独立身份并告警", async ({ status, extra, reason, id }) => {
    const repo = new InMemoryRepository();
    await seedTeams(repo);
    const service = new ProviderFixtureSyncService(repo);
    await service.applyFixture(makeApiFixture({ fixtureId: id, statusShort: "NS" }), {}, NOW);
    const mapping = (await repo.matchProviderMappings.findByProviderAndExternalId(Provider.ApiFootball, String(id)))!;
    const candidate = (await repo.matches.findById(mapping.match_id))!;
    await repo.matches.update({ ...candidate, match_status: status });
    if (extra) {
      const matchId = newUuid();
      await repo.matches.insert({ ...candidate, match_id: matchId, canonical_match_id: matchId });
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await (extra ? new ProviderFixtureSyncService(repo) : service).applyFixture(makeApiFixture({ fixtureId: id + 1, statusShort: "NS" }), {}, NOW);
      const nextMapping = (await repo.matchProviderMappings.findByProviderAndExternalId(Provider.ApiFootball, String(id + 1)))!;
      const next = (await repo.matches.findById(nextMapping.match_id))!;
      expect(next.canonical_match_id).toBe(next.match_id);
      expect((await repo.matches.findById(candidate.match_id))!.superseded_by).toBeNull();
      expect(warn).toHaveBeenCalledWith("[match_identity_needs_review]", expect.objectContaining({ reason, provider_match_id: String(id + 1), candidate_match_ids: expect.arrayContaining([candidate.match_id]) }));
    } finally { warn.mockRestore(); }
  });

  it("同一来源 ID 的身份诊断只告警一次", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let index = 0; index < 2; index += 1) {
        const repo = new InMemoryRepository();
        await seedTeams(repo);
        const service = new ProviderFixtureSyncService(repo);
        await service.applyFixture(makeApiFixture({ fixtureId: 1190500, statusShort: "NS" }), {}, NOW);
        const mapping = (await repo.matchProviderMappings.findByProviderAndExternalId(Provider.ApiFootball, "1190500"))!;
        const candidate = (await repo.matches.findById(mapping.match_id))!;
        await repo.matches.update({ ...candidate, match_status: MatchStatus.Finished });
        await service.applyFixture(makeApiFixture({ fixtureId: 1190501, statusShort: "NS" }), {}, NOW);
      }
      expect(warn.mock.calls.filter(([label]) => label === "[match_identity_needs_review]")).toHaveLength(1);
    } finally { warn.mockRestore(); }
  });

  it("连续改期重定向所有入向指针并保留历史记录", async () => {
    const repo = new InMemoryRepository();
    await seedTeams(repo);
    const service = new ProviderFixtureSyncService(repo);
    await service.applyFixture(makeApiFixture({ fixtureId: 1190600, statusShort: "NS" }), {}, NOW);
    await service.applyFixture(makeApiFixture({ fixtureId: 1190601, statusShort: "NS" }), {}, NOW);
    const firstId = (await repo.matchProviderMappings.findByProviderAndExternalId(Provider.ApiFootball, "1190600"))!.match_id;
    const secondId = (await repo.matchProviderMappings.findByProviderAndExternalId(Provider.ApiFootball, "1190601"))!.match_id;
    const firstBefore = (await repo.matches.findById(firstId))!;
    const secondBefore = (await repo.matches.findById(secondId))!;
    const nextNow = new Date(NOW.getTime() + 1000);
    await expect(service.applyFixture(makeApiFixture({ fixtureId: 1190602, statusShort: "NS" }), {}, nextNow)).resolves.toMatchObject({ kind: "applied" });
    const thirdId = (await repo.matchProviderMappings.findByProviderAndExternalId(Provider.ApiFootball, "1190602"))!.match_id;
    const third = (await repo.matches.findById(thirdId))!;
    expect(await repo.matches.findById(firstId)).toEqual({ ...firstBefore, superseded_by: thirdId, updated_at: nextNow });
    expect(await repo.matches.findById(secondId)).toEqual({ ...secondBefore, superseded_by: thirdId, updated_at: nextNow });
    expect(third).toMatchObject({ canonical_match_id: firstBefore.canonical_match_id, superseded_by: null });
    expect(secondBefore.canonical_match_id).toBe(firstBefore.canonical_match_id);
    expect(await resolveEffectiveMatch(repo, firstId)).toEqual(third);
    expect(await repo.matches.findBySeason(MVP_SEASON.season_id)).toHaveLength(3);
  });

  it("同赛季复用候选查询，归并后失效缓存", async () => {
    const repo = new InMemoryRepository();
    await seedTeams(repo);
    const thirdTeamId = newUuid();
    await repo.teams.insert(makeTeam(thirdTeamId));
    await repo.teamProviderMappings.insert(makeTeamMapping(thirdTeamId, "42"));
    const findByLeagueSeason = vi.fn();
    const withTransaction = repo.withTransaction.bind(repo);
    vi.spyOn(repo, "withTransaction").mockImplementation((work) => withTransaction(async (tx) => {
      const matches = tx.matches;
      Object.defineProperty(tx, "matches", { value: { ...matches, findByLeagueSeason: async (leagueId: string, seasonId: string) => {
        findByLeagueSeason(leagueId, seasonId);
        return matches.findByLeagueSeason(leagueId, seasonId);
      } } });
      return work(tx);
    }));
    const service = new ProviderFixtureSyncService(repo);
    await service.applyFixture(makeApiFixture({ fixtureId: 1190700 }), {}, NOW);
    await service.applyFixture(makeApiFixture({ fixtureId: 1190701, homeTeamId: 41, awayTeamId: 40 }), {}, NOW);
    expect(findByLeagueSeason).toHaveBeenCalledTimes(1);
    await service.applyFixture(makeApiFixture({ fixtureId: 1190702 }), {}, NOW);
    expect(findByLeagueSeason).toHaveBeenCalledTimes(2);
    await service.applyFixture(makeApiFixture({ fixtureId: 1190703, homeTeamId: 41, awayTeamId: 42 }), {}, NOW);
    expect(findByLeagueSeason).toHaveBeenCalledTimes(3);
  });

  it.each(["league_id", "season_id", "home_team_id", "away_team_id"] as const)("候选的 %s 不同时不归并", async (field) => {
    const repo = new InMemoryRepository();
    await seedTeams(repo);
    const service = new ProviderFixtureSyncService(repo);
    await service.applyFixture(makeApiFixture({ fixtureId: 1190400, statusShort: "NS" }), {}, NOW);
    const mapping = (await repo.matchProviderMappings.findByProviderAndExternalId(Provider.ApiFootball, "1190400"))!;
    const candidate = (await repo.matches.findById(mapping.match_id))!;
    const isolatedRepo = new InMemoryRepository();
    await isolatedRepo.teams.insert(makeTeam(candidate.home_team_id));
    await isolatedRepo.teams.insert(makeTeam(candidate.away_team_id));
    await isolatedRepo.teamProviderMappings.insert(makeTeamMapping(candidate.home_team_id, "40"));
    await isolatedRepo.teamProviderMappings.insert(makeTeamMapping(candidate.away_team_id, "41"));
    await isolatedRepo.matches.insert({ ...candidate, [field]: field.endsWith("team_id") ? newUuid() : "different" });
    await new ProviderFixtureSyncService(isolatedRepo).applyFixture(makeApiFixture({ fixtureId: 1190401, statusShort: "NS" }), {}, NOW);
    const nextMapping = (await isolatedRepo.matchProviderMappings.findByProviderAndExternalId(Provider.ApiFootball, "1190401"))!;
    const next = (await isolatedRepo.matches.findById(nextMapping.match_id))!;
    expect(next.canonical_match_id).toBe(next.match_id);
    expect((await isolatedRepo.matches.findById(candidate.match_id))!.superseded_by).toBeNull();
  });
  it("首次发现合法 scheduled fixture 时创建 match、mapping 和 discovered snapshot", async () => {
    const repo = new InMemoryRepository();
    const teams = await seedTeams(repo);
    const fixture = makeApiFixture({
      fixtureId: 1100100,
      statusShort: "NS",
      date: "2026-08-11T12:00:00.000Z",
      timestamp: Date.parse("2026-08-11T12:00:00.000Z") / 1000,
      round: "Regular Season - 1",
    });

    const outcome = await new ProviderFixtureSyncService(repo).applyFixture(
      fixture,
      { fixture },
      NOW,
    );

    expect(outcome).toMatchObject({
      kind: "applied",
      match_status: MatchStatus.Scheduled,
    });
    const mapping = await repo.matchProviderMappings.findByProviderAndExternalId(
      Provider.ApiFootball,
      "1100100",
    );
    expect(mapping).not.toBeNull();

    const match = await repo.matches.findById(mapping!.match_id);
    expect(match).toMatchObject({
      league_id: MVP_SEASON.league_id,
      season_id: MVP_SEASON.season_id,
      round_id: "01",
      home_team_id: teams.homeTeamId,
      away_team_id: teams.awayTeamId,
      kickoff_at: new Date("2026-08-11T12:00:00.000Z"),
      kickoff_confirmed: true,
      prediction_deadline_at: new Date("2026-08-11T11:50:00.000Z"),
      prediction_closed_at: null,
      match_status: MatchStatus.Scheduled,
      settlement_status: SettlementStatus.Pending,
      result_version: 0,
      settled_result_version: 0,
      regular_home_score: null,
      regular_away_score: null,
      result_source: null,
    });
    await expect(repo.providerSnapshots.findByEntity("match", mapping!.match_id)).resolves.toEqual([
      expect.objectContaining({
        provider_entity_id: "1100100",
        event_type: "discovered",
        payload: { fixture },
      }),
      expect.objectContaining({
        provider_entity_id: "1100100",
        event_type: "status_changed",
        payload: { sync: "success" },
      }),
    ]);
  });

  it("round 无法解析时记录实体级 PROVIDER_DATA_INVALID 且不创建比赛事实", async () => {
    const repo = new InMemoryRepository();
    await seedTeams(repo);
    const fixture: ApiFootballFixture = makeApiFixture({
      fixtureId: 1100101,
      statusShort: "NS",
      round: "Playoff",
    });

    await expect(
      new ProviderFixtureSyncService(repo).applyFixture(fixture, { fixture }, NOW),
    ).resolves.toMatchObject({
      kind: "failed",
      anomaly_types: [AnomalyType.ProviderDataInvalid],
    });
    await expect(
      repo.matchProviderMappings.findByProviderAndExternalId(
        Provider.ApiFootball,
        "1100101",
      ),
    ).resolves.toBeNull();
    await expect(repo.matches.findBySeason(MVP_SEASON.season_id)).resolves.toEqual([]);
  });

  it("德甲 round 34 可入库，round 35 作为实体级 PROVIDER_DATA_INVALID 失败", async () => {
    const repo = new InMemoryRepository();
    await seedTeams(repo);
    const round34 = makeApiFixture({
      fixtureId: 1100200,
      statusShort: "NS",
      leagueId: 78,
      round: "Regular Season - 34",
    });
    const round35 = makeApiFixture({
      fixtureId: 1100201,
      statusShort: "NS",
      leagueId: 78,
      round: "Regular Season - 35",
    });

    const applied = await new ProviderFixtureSyncService(repo).applyFixture(
      round34,
      { fixture: round34 },
      NOW,
    );
    expect(applied).toMatchObject({ kind: "applied" });
    const mapping = await repo.matchProviderMappings.findByProviderAndExternalId(
      Provider.ApiFootball,
      "1100200",
    );
    await expect(repo.matches.findById(mapping!.match_id)).resolves.toMatchObject({
      league_id: "bundesliga",
      season_id: "2026_2027",
      round_id: "34",
    });

    await expect(
      new ProviderFixtureSyncService(repo).applyFixture(round35, { fixture: round35 }, NOW),
    ).resolves.toMatchObject({
      kind: "failed",
      anomaly_types: [AnomalyType.ProviderDataInvalid],
    });
    await expect(
      repo.matchProviderMappings.findByProviderAndExternalId(Provider.ApiFootball, "1100201"),
    ).resolves.toBeNull();
  });

  it("中超 match.season_id 为自然年 2026", async () => {
    const repo = new InMemoryRepository();
    await seedTeams(repo);
    const fixture = makeApiFixture({
      fixtureId: 1100300,
      statusShort: "NS",
      leagueId: 169,
      round: "Regular Season - 1",
    });

    await new ProviderFixtureSyncService(repo).applyFixture(fixture, { fixture }, NOW);
    const mapping = await repo.matchProviderMappings.findByProviderAndExternalId(
      Provider.ApiFootball,
      "1100300",
    );
    await expect(repo.matches.findById(mapping!.match_id)).resolves.toMatchObject({
      league_id: "chinese_super_league",
      season_id: "2026",
      round_id: "01",
    });
  });

  it("缺少 Provider 球队 mapping 时 fail closed 且不创建比赛事实", async () => {
    const repo = new InMemoryRepository();
    const homeTeamId = newUuid();
    await repo.teams.insert(makeTeam(homeTeamId));
    await repo.teamProviderMappings.insert(makeTeamMapping(homeTeamId, "40"));
    const fixture = makeApiFixture({ fixtureId: 1100102, statusShort: "NS" });

    await expect(
      new ProviderFixtureSyncService(repo).applyFixture(fixture, { fixture }, NOW),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(repo.matches.findBySeason(MVP_SEASON.season_id)).resolves.toEqual([]);
    await expect(
      repo.matchProviderMappings.findByProviderAndExternalId(
        Provider.ApiFootball,
        "1100102",
      ),
    ).resolves.toBeNull();
  });
});
