import { describe, expect, it, vi } from "vitest";
import { MVP_SEASON, SUPPORTED_LEAGUES } from "../domain/config.js";
import {
  MatchStatus,
  Provider,
  SettlementStatus,
  SyncJobType,
  TeamStatus,
} from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { Match, Team, TeamProviderMapping } from "../domain/types.js";
import { InMemorySchedulerStateStore, POST_FINISH_DAILY_FALLBACK_STATE_ID } from "../infrastructure/cloudbase-scheduler-state.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { makeApiFixture } from "../provider/fixture-factory.js";
import type { ApiFootballFixture } from "../provider/types.js";
import { ProviderPostFinishVerifyService } from "./provider-post-finish.js";
import { ProviderFixtureSyncService } from "./provider-fixture-sync.js";

const NOW = new Date("2026-08-10T12:34:56.000Z");
const KICKOFF_OVER_24_HOURS_AGO = new Date("2026-08-10T10:00:00.000Z");

async function seedMappedMatch(
  repo: InMemoryRepository,
  providerMatchId: string,
): Promise<void> {
  const homeTeamId = newUuid();
  const awayTeamId = newUuid();
  const makeTeam = (teamId: string, name: string): Team => ({
    schema_version: 1,
    team_id: teamId,
    league_id: "premier_league",
    name,
    short_name: null,
    primary_color: null,
    secondary_color: null,
    status: TeamStatus.Active,
    created_at: NOW,
    updated_at: NOW,
  });
  const makeMapping = (
    teamId: string,
    providerTeamId: string,
  ): TeamProviderMapping => ({
    schema_version: 1,
    team_id: teamId,
    provider: Provider.FootballData,
    provider_team_id: providerTeamId,
    created_at: NOW,
    updated_at: NOW,
  });
  await repo.teams.insert(makeTeam(homeTeamId, "Home FC"));
  await repo.teams.insert(makeTeam(awayTeamId, "Away FC"));
  await repo.teamProviderMappings.insert(makeMapping(homeTeamId, "40"));
  await repo.teamProviderMappings.insert(makeMapping(awayTeamId, "41"));

  const kickoffAt = KICKOFF_OVER_24_HOURS_AGO;
  const matchId = newUuid();
  const match: Match = {
    schema_version: 1,
    match_id: matchId,
    canonical_match_id: matchId,
    superseded_by: null,
    league_id: MVP_SEASON.league_id,
    season_id: MVP_SEASON.season_id,
    round_id: "01",
    home_team_id: homeTeamId,
    away_team_id: awayTeamId,
    kickoff_at: kickoffAt,
    kickoff_confirmed: true,
    prediction_deadline_at: new Date(kickoffAt.getTime() - 10 * 60 * 1000),
    prediction_closed_at: kickoffAt,
    period_anchor_at: kickoffAt,
    match_status: MatchStatus.Finished,
    finish_detected_at: NOW,
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
    settled_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
  await repo.matches.insert(match);
  await repo.matchProviderMappings.insert({
    schema_version: 1,
    match_id: match.match_id,
    provider: Provider.FootballData,
    provider_match_id: providerMatchId,
    created_at: NOW,
    updated_at: NOW,
  });
}

describe("ProviderPostFinishVerifyService", () => {
  it("副源 apply 一致后立即停止请求后续副源", async () => {
    const repo = new InMemoryRepository();
    await seedMappedMatch(repo, "1200049");
    const mapping = await repo.matchProviderMappings.findByProviderAndExternalId(Provider.FootballData, "1200049");
    await repo.matchProviderMappings.insert({
      schema_version: 1, match_id: mapping!.match_id, provider: Provider.FiveDollar,
      provider_match_id: "1200050", created_at: NOW, updated_at: NOW,
    });
    const makeFixture = (id: number, provider: typeof Provider.FootballData | typeof Provider.FiveDollar) => {
      const fixture = makeApiFixture({ fixtureId: id, statusShort: "FT", date: KICKOFF_OVER_24_HOURS_AGO.toISOString(), timestamp: KICKOFF_OVER_24_HOURS_AGO.getTime() / 1000 });
      fixture.provider = provider;
      fixture.league.id = provider === Provider.FiveDollar ? "4160026622" : "PL";
      return fixture;
    };
    const getFixturesFromSource = vi.fn(async (source: string, query: { dateFrom?: string }) =>
      source === "5d" && query.dateFrom === "2026-08-10" ? [makeFixture(1200050, Provider.FiveDollar)] : []);
    const service = new ProviderPostFinishVerifyService(repo, {
      getTeams: vi.fn(async () => []),
      getFixtures: vi.fn(async () => [makeFixture(1200049, Provider.FootballData)]),
      getFixturesFromSource,
      getResultComparisonSources: () => [
        { sourceId: "5d", role: "secondary" }, { sourceId: "of", role: "secondary" },
      ],
    });
    const outcome = await service.run(NOW);
    expect(outcome).toMatchObject({ kind: "completed", fixtures: { items_read: 2, items_failed: 0 } });
    expect(getFixturesFromSource.mock.calls.map(([source, query]) => [source, query.dateFrom])).toEqual([
      ["5d", "2026-08-10"], ["5d", "2026-08-11"],
    ]);
    expect((await repo.matches.findById(mapping!.match_id))?.compared_providers).toEqual([Provider.FootballData, Provider.FiveDollar]);
    const corrected = makeFixture(1200049, Provider.FootballData);
    corrected.score!.fulltime!.home = 3;
    const conflict = await new ProviderFixtureSyncService(repo).applyFixture(corrected, { fixture: corrected }, new Date(NOW.getTime() + 60_000));
    expect(conflict).toMatchObject({ kind: "conflict", result_version: 1 });
    expect(await repo.matches.findById(mapping!.match_id)).toMatchObject({
      result_version: 1, regular_home_score: 2, compared_providers: [],
    });
  });

  it("串联固定赛季球队 mapping、post_finish_verify loader 与 fixture 同步", async () => {
    const repo = new InMemoryRepository();
    await seedMappedMatch(repo, "1200041");
    const fixture = makeApiFixture({
      fixtureId: 1200041,
      statusShort: "FT",
      date: KICKOFF_OVER_24_HOURS_AGO.toISOString(),
      timestamp: KICKOFF_OVER_24_HOURS_AGO.getTime() / 1000,
      round: "Regular Season - 1",
    });
    fixture.provider = Provider.FootballData;
    fixture.league.id = "PL";
    const getTeams = vi.fn(async (query: {
      leagueId: string;
      season: string;
    }) => {
      if (query.leagueId !== MVP_SEASON.api_football_league_id) {
        return [];
      }
      expect(query.season).toBe(MVP_SEASON.api_football_season);
      return [
        { team: { id: 40, name: "Home FC" } },
        { team: { id: 41, name: "Away FC" } },
      ];
    });
    const getFixtures = vi.fn(async (query: {
      dateFrom?: string;
      dateTo?: string;
      leagueId: string;
      season: string;
    }): Promise<readonly ApiFootballFixture[]> => {
      expect(query.season).toBe(MVP_SEASON.api_football_season);
      return query.leagueId === MVP_SEASON.api_football_league_id ? [fixture] : [];
    });

    const outcome = await new ProviderPostFinishVerifyService(repo, {
      getTeams,
      getFixtures,
    }).run(NOW);

    expect(outcome).toMatchObject({
      kind: "completed",
      teams: {
        kind: "completed",
        teams_read: 0,
        teams_created: 0,
        teams_unchanged: 0,
      },
      fixtures: {
        kind: "completed",
        job_type: SyncJobType.PostFinishVerify,
        items_read: 1,
        items_changed: 1,
        items_failed: 0,
      },
    });
    const mapping = await repo.matchProviderMappings.findByProviderAndExternalId(
      Provider.FootballData,
      "1200041",
    );
    expect(mapping).not.toBeNull();
    await expect(repo.matches.findById(mapping!.match_id)).resolves.toMatchObject({
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Waiting,
      result_version: 1,
    });
    expect(getTeams).not.toHaveBeenCalled();
    expect(getFixtures).toHaveBeenCalledTimes(1);
    expect(getFixtures.mock.calls[0]?.[0]).toMatchObject({
      dateFrom: "2026-08-10",
      dateTo: "2026-08-10",
      leagueId: MVP_SEASON.api_football_league_id,
      season: MVP_SEASON.api_football_season,
    });
  });

  it("highFrequencyUntilFirstSettlement 下 finished+settled 场次被过滤出批次", async () => {
    const repo = new InMemoryRepository();
    await seedMappedMatch(repo, "1200042");
    const mapping = await repo.matchProviderMappings.findByProviderAndExternalId(
      Provider.FootballData,
      "1200042",
    );
    const match = await repo.matches.findById(mapping!.match_id);
    await repo.matches.update({
      ...match!,
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Settled,
      regular_home_score: 2,
      regular_away_score: 1,
      result_version: 1,
      settled_result_version: 1,
      result_source: "provider",
      settled_at: NOW,
    });
    await repo.matchResults.insert({
      schema_version: 1,
      match_id: mapping!.match_id,
      result_version: 1,
      regular_home_score: 2,
      regular_away_score: 1,
      source: "provider",
      provider_status: "FT",
      admin_id: null,
      reason: null,
      created_at: NOW,
    });
    const fixture = makeApiFixture({
      fixtureId: 1200042,
      statusShort: "FT",
      fulltimeHome: 2,
      fulltimeAway: 1,
      date: KICKOFF_OVER_24_HOURS_AGO.toISOString(),
      timestamp: KICKOFF_OVER_24_HOURS_AGO.getTime() / 1000,
      round: "Regular Season - 1",
    });
    fixture.provider = Provider.FootballData;
    fixture.league.id = "PL";
    const getTeams = vi.fn(async () => []);
    const getFixtures = vi.fn(async (query: { fixtureId?: string }) =>
      query.fixtureId === "1200042" ? [fixture] : [],
    );

    const outcome = await new ProviderPostFinishVerifyService(repo, {
      getTeams,
      getFixtures,
    }).run(NOW);

    expect(outcome).toMatchObject({
      kind: "completed",
      fixtures: {
        kind: "completed",
        job_type: SyncJobType.PostFinishVerify,
        items_read: 0,
        items_changed: 0,
        items_failed: 0,
      },
    });
    expect(getFixtures).not.toHaveBeenCalled();
    await expect(repo.matches.findById(mapping!.match_id)).resolves.toMatchObject({
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Settled,
      result_version: 1,
    });
    await expect(repo.matchResults.findLatestByMatch(mapping!.match_id)).resolves.toMatchObject({
      result_version: 1,
    });
  });

  it("highFrequencyUntilFirstSettlement 下 finished+waiting 场次仍进入批次", async () => {
    const repo = new InMemoryRepository();
    await seedMappedMatch(repo, "1200043");
    const mapping = await repo.matchProviderMappings.findByProviderAndExternalId(
      Provider.FootballData,
      "1200043",
    );
    const match = await repo.matches.findById(mapping!.match_id);
    await repo.matches.update({
      ...match!,
      settlement_status: SettlementStatus.Waiting,
    });
    const fixture = makeApiFixture({
      fixtureId: 1200043,
      statusShort: "FT",
      fulltimeHome: 2,
      fulltimeAway: 1,
      date: KICKOFF_OVER_24_HOURS_AGO.toISOString(),
      timestamp: KICKOFF_OVER_24_HOURS_AGO.getTime() / 1000,
      round: "Regular Season - 1",
    });
    fixture.provider = Provider.FootballData;
    fixture.league.id = "PL";
    const getTeams = vi.fn(async () => []);
    const getFixtures = vi.fn(async () => [fixture]);

    const outcome = await new ProviderPostFinishVerifyService(repo, {
      getTeams,
      getFixtures,
    }).run(NOW);

    expect(outcome).toMatchObject({
      kind: "completed",
      fixtures: {
        kind: "completed",
        job_type: SyncJobType.PostFinishVerify,
        items_read: 1,
        items_changed: 1,
        items_failed: 0,
      },
    });
    await expect(repo.matches.findById(mapping!.match_id)).resolves.toMatchObject({
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Waiting,
      result_version: 1,
      regular_home_score: 2,
      regular_away_score: 1,
    });
  });

  it("post_finish_verify 锁被占用时跳过整个任务，不调用 Provider client", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const repo = new InMemoryRepository();
      await repo.jobLocks.acquire(
        "sync:post_finish_verify",
        "other-owner",
        new Date(NOW.getTime() + 60_000),
      );
      const getTeams = vi.fn(async () => []);
      const getFixtures = vi.fn(async () => [] as readonly ApiFootballFixture[]);

      const outcome = await new ProviderPostFinishVerifyService(repo, {
        getTeams,
        getFixtures,
      }).run(NOW);

      expect(outcome).toEqual({
        kind: "skipped",
        fixtures: {
          kind: "skipped",
          job_type: SyncJobType.PostFinishVerify,
          reason: "lock_held",
        },
      });
      expect(getTeams).not.toHaveBeenCalled();
      expect(getFixtures).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("主源先报 FT 时过滤/忽略副源滞后 LIVE 观测，不打开阻塞性 PROVIDER_STATE_CONFLICT (A-S3-01)", async () => {
    const repo = new InMemoryRepository();
    const matchId = newUuid();
    await repo.matches.insert({
      schema_version: 1,
      match_id: matchId,
      canonical_match_id: matchId,
      superseded_by: null,
      league_id: MVP_SEASON.league_id,
      season_id: MVP_SEASON.season_id,
      round_id: "01",
      home_team_id: newUuid(),
      away_team_id: newUuid(),
      kickoff_at: KICKOFF_OVER_24_HOURS_AGO,
      kickoff_confirmed: true,
      prediction_deadline_at: new Date(KICKOFF_OVER_24_HOURS_AGO.getTime() - 10 * 60_000),
      prediction_closed_at: KICKOFF_OVER_24_HOURS_AGO,
      period_anchor_at: KICKOFF_OVER_24_HOURS_AGO,
      match_status: MatchStatus.Live,
      finish_detected_at: null,
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
      settled_at: null,
      created_at: NOW,
      updated_at: NOW,
    });
    await repo.matchProviderMappings.insert({
      schema_version: 1, match_id: matchId, provider: Provider.FootballData,
      provider_match_id: "1200060", created_at: NOW, updated_at: NOW,
    });
    await repo.matchProviderMappings.insert({
      schema_version: 1, match_id: matchId, provider: Provider.FiveDollar,
      provider_match_id: "1200061", created_at: NOW, updated_at: NOW,
    });
    const fdFt = makeApiFixture({
      fixtureId: 1200060, statusShort: "FT", fulltimeHome: 2, fulltimeAway: 1,
      date: KICKOFF_OVER_24_HOURS_AGO.toISOString(), timestamp: KICKOFF_OVER_24_HOURS_AGO.getTime() / 1000,
    });
    fdFt.provider = Provider.FootballData;
    fdFt.league.id = "PL";
    const fiveDLive = makeApiFixture({
      fixtureId: 1200061, statusShort: "1H",
      date: KICKOFF_OVER_24_HOURS_AGO.toISOString(), timestamp: KICKOFF_OVER_24_HOURS_AGO.getTime() / 1000,
    });
    fiveDLive.provider = Provider.FiveDollar;
    fiveDLive.league.id = "4160026622";

    const service = new ProviderPostFinishVerifyService(repo, {
      getTeams: vi.fn(async () => []),
      getFixtures: vi.fn(async () => [fdFt]),
      getFixturesFromSource: vi.fn(async () => [fiveDLive]),
      getResultComparisonSources: () => [{ sourceId: "5d", role: "secondary" }],
    });
    const outcome = await service.run(NOW);
    expect(outcome).toMatchObject({ kind: "completed", fixtures: { items_failed: 0 } });
    expect(await repo.matches.findById(matchId)).toMatchObject({
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Waiting,
      result_version: 1,
      regular_home_score: 2,
      regular_away_score: 1,
    });
    expect(await repo.anomalies.findOpenBlockingByMatch(matchId)).toEqual([]);
  });

  it("00:00 UTC 错过时由持久化状态在当日 00:03 UTC 补跑超 24h 每日兜底且同日不重复跑，defer 后次轮继续补跑 (A-S3-09)", async () => {
    const repo = new InMemoryRepository();
    const schedulerState = new InMemorySchedulerStateStore();
    await seedMappedMatch(repo, "1200070");
    const mapping = await repo.matchProviderMappings.findByProviderAndExternalId(Provider.FootballData, "1200070");
    const match = (await repo.matches.findById(mapping!.match_id))!;
    // seedMappedMatch 使用 KICKOFF_OVER_24_HOURS_AGO (2026-08-10T10:00Z)；以 2026-08-12 为超 24h 日
    const missedTick = new Date("2026-08-12T00:03:00.000Z");
    const laterSameDay = new Date("2026-08-12T00:06:00.000Z");
    const nextUtcDay = new Date("2026-08-13T00:04:00.000Z");
    const ft = makeApiFixture({
      fixtureId: 1200070, statusShort: "FT", fulltimeHome: 2, fulltimeAway: 1,
      date: match.kickoff_at.toISOString(), timestamp: match.kickoff_at.getTime() / 1000,
    });
    ft.provider = Provider.FootballData;
    ft.league.id = "PL";

    // 若首个补跑轮次发生网络 defer，则不能写入完成态；待下轮成功后再推进。
    let shouldFail = true;
    const getFixtures = vi.fn(async () => {
      if (shouldFail) throw new Error("network blip");
      return [ft];
    });
    const service = new ProviderPostFinishVerifyService(
      repo,
      { getTeams: vi.fn(async () => []), getFixtures },
      { random: () => 0.5 },
      {},
      undefined,
      schedulerState,
    );

    await expect(service.run(missedTick)).resolves.toMatchObject({ kind: "deferred" });
    expect(await schedulerState.getPeriodicJobCycle(POST_FINISH_DAILY_FALLBACK_STATE_ID)).toBeNull();

    shouldFail = false;
    await expect(service.run(new Date("2026-08-12T00:05:00.000Z"))).resolves.toMatchObject({
      kind: "completed",
      fixtures: { items_read: 1, items_changed: 1 },
    });
    expect(getFixtures).toHaveBeenCalledTimes(2);
    expect((await schedulerState.getPeriodicJobCycle(POST_FINISH_DAILY_FALLBACK_STATE_ID))?.completed_cycle_at.toISOString())
      .toBe("2026-08-12T00:05:00.000Z");

    // 同一 UTC 日内后续轮次不再重复扫描超 24h 比赛
    await expect(service.run(laterSameDay)).resolves.toMatchObject({
      kind: "completed",
      fixtures: { items_read: 0 },
    });
    expect(getFixtures).toHaveBeenCalledTimes(2);

    // 把 match 重设为 Waiting 模拟次日仍待结算：次日 00:04 UTC 应自动再次触发每日兜底
    const updated = (await repo.matches.findById(match.match_id))!;
    await repo.matches.update({ ...updated, settlement_status: SettlementStatus.Waiting });
    await service.run(nextUtcDay);
    expect(getFixtures).toHaveBeenCalledTimes(3);
  });

  it("[CR-22] 含超 24h 候选的任一联赛拉取失败时，不推进当日 POST_FINISH_DAILY_FALLBACK_STATE_ID", async () => {
    const repo = new InMemoryRepository();
    const schedulerState = new InMemorySchedulerStateStore();
    await seedMappedMatch(repo, "1200080");
    // 再插入一场西甲超 24h 待结算比赛
    const laLiga = SUPPORTED_LEAGUES.find((l) => l.league_id === "la_liga")!;
    const laHome = newUuid();
    const laAway = newUuid();
    for (const tid of [laHome, laAway]) {
      await repo.teams.insert({
        schema_version: 1, team_id: tid, league_id: laLiga.league_id, name: tid, name_zh: null,
        logo_url: null, short_name: null, primary_color: null, secondary_color: null,
        status: TeamStatus.Active, created_at: NOW, updated_at: NOW,
      });
    }
    const laMatchId = newUuid();
    await repo.matches.insert({
      schema_version: 1, match_id: laMatchId, canonical_match_id: laMatchId, superseded_by: null,
      league_id: laLiga.league_id, season_id: laLiga.season_id, round_id: "Regular Season - 1",
      home_team_id: laHome, away_team_id: laAway, kickoff_at: KICKOFF_OVER_24_HOURS_AGO,
      kickoff_confirmed: true, prediction_deadline_at: new Date(KICKOFF_OVER_24_HOURS_AGO.getTime() - 600_000),
      prediction_closed_at: new Date(KICKOFF_OVER_24_HOURS_AGO.getTime() - 600_000),
      period_anchor_at: KICKOFF_OVER_24_HOURS_AGO, match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Waiting, regular_home_score: null, regular_away_score: null,
      extra_home_score: null, extra_away_score: null, penalty_home_score: null, penalty_away_score: null,
      result_version: 0, settled_result_version: 0, result_source: null, scoring_rule_version: "scoring_v1",
      finish_detected_at: KICKOFF_OVER_24_HOURS_AGO, settled_at: null, created_at: NOW, updated_at: NOW,
    });

    const missedTick = new Date("2026-08-12T00:03:00.000Z");
    const getFixtures = vi.fn(async (query: { leagueId: string }) => {
      if (query.leagueId === laLiga.api_football_league_id) {
        throw new Error("la_liga timeout");
      }
      return [];
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const outcome = await new ProviderPostFinishVerifyService(
        repo,
        { getTeams: vi.fn(async () => []), getFixtures },
        { random: () => 0.5 },
        {},
        undefined,
        schedulerState,
      ).run(missedTick);

      expect(outcome).toMatchObject({ kind: "completed" });
      expect(await schedulerState.getPeriodicJobCycle(POST_FINISH_DAILY_FALLBACK_STATE_ID)).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});
