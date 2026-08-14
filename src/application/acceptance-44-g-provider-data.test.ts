/**
 * 第 44 节 G. Provider 数据验收矩阵（G43-G52）。
 */
import { describe, expect, it } from "vitest";
import {
  AnomalyStatus,
  AnomalyType,
  MatchStatus,
  Provider,
  ResultSource,
  SettlementStatus,
} from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type {
  Match,
  MatchResult,
  Prediction,
  Team,
  TeamProviderMapping,
  User,
} from "../domain/types.js";
import type { ApiFootballFixture } from "../provider/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { decideFirstSettlement } from "./first-settlement.js";
import { ProviderFixtureSyncService } from "./provider-fixture-sync.js";

const MATCH_ID = "00000000-0000-4000-8000-000000000043";
const PROVIDER_MATCH_ID = "44000043";
const HOME_TEAM_ID = "00000000-0000-4000-8000-0000000000a1";
const AWAY_TEAM_ID = "00000000-0000-4000-8000-0000000000a2";
const NEXT_HOME_TEAM_ID = "00000000-0000-4000-8000-0000000000b1";
const NEXT_AWAY_TEAM_ID = "00000000-0000-4000-8000-0000000000b2";
const ADMIN_ID = "00000000-0000-4000-8000-000000000099";
const NOW = new Date("2026-08-09T00:00:00.000Z");
const KICKOFF = new Date("2026-08-09T12:00:00.000Z");

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    schema_version: 1,
    match_id: MATCH_ID,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: HOME_TEAM_ID,
    away_team_id: AWAY_TEAM_ID,
    kickoff_at: KICKOFF,
    kickoff_confirmed: true,
    prediction_deadline_at: new Date(KICKOFF.getTime() - 10 * 60 * 1000),
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
    ...overrides,
  };
}

function makeTeam(teamId: string, name: string): Team {
  return {
    schema_version: 1,
    team_id: teamId,
    name,
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

function makeUser(): User {
  return {
    schema_version: 1,
    user_id: newUuid(),
    openid: `openid_${newUuid()}`,
    unionid: null,
    nickname: "Fan",
    favorite_team_id: null,
    status: "active",
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_level: 1,
    career_best_level: 1,
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
  } as User;
}

function makePrediction(userId: string): Prediction {
  return {
    schema_version: 1,
    prediction_id: newUuid(),
    user_id: userId,
    match_id: MATCH_ID,
    idempotency_key: `idem_${userId}`,
    pred_home_score: 2,
    pred_away_score: 1,
    derived_result: "HOME",
    submitted_at: NOW,
    scoring_rule_version: "scoring_v1",
    match_score: null,
    wdl_hit: null,
    exact_hit: null,
    applied_result_version: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeResult(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    schema_version: 1,
    match_id: MATCH_ID,
    result_version: 1,
    regular_home_score: 2,
    regular_away_score: 1,
    source: ResultSource.Admin,
    provider_status: null,
    admin_id: ADMIN_ID,
    reason: "manual correction",
    created_at: NOW,
    ...overrides,
  };
}

function makeFixture(options: {
  status: string;
  fulltime?: { home: number | null; away: number | null };
  goals?: { home: number | null; away: number | null };
  homeTeamId?: number;
  awayTeamId?: number;
} = { status: "FT" }): ApiFootballFixture {
  const fixture: ApiFootballFixture = {
    fixture: {
      id: Number(PROVIDER_MATCH_ID),
      date: KICKOFF.toISOString(),
      timestamp: KICKOFF.getTime() / 1000,
      status: { short: options.status },
    },
    league: {
      id: 39,
      season: 2026,
      round: "Regular Season - 1",
    },
    teams: {
      home: { id: options.homeTeamId ?? 1001, name: "Home" },
      away: { id: options.awayTeamId ?? 1002, name: "Away" },
    },
  };
  if (options.fulltime !== undefined) {
    fixture.score = { fulltime: options.fulltime };
  }
  if (options.goals !== undefined) {
    fixture.goals = options.goals;
  }
  return fixture;
}

async function setup(match = makeMatch(), options?: { withDefaultTeams?: boolean }) {
  const repo = new InMemoryRepository();
  await repo.matches.insert(match);
  await repo.matchProviderMappings.insert({
    schema_version: 1,
    match_id: MATCH_ID,
    provider: Provider.ApiFootball,
    provider_match_id: PROVIDER_MATCH_ID,
    created_at: NOW,
    updated_at: NOW,
  });
  if (options?.withDefaultTeams !== false) {
    await repo.teams.insert(makeTeam(HOME_TEAM_ID, "Home FC"));
    await repo.teams.insert(makeTeam(AWAY_TEAM_ID, "Away FC"));
    await repo.teamProviderMappings.insert(makeTeamMapping(HOME_TEAM_ID, "1001"));
    await repo.teamProviderMappings.insert(makeTeamMapping(AWAY_TEAM_ID, "1002"));
  }
  return {
    repo,
    service: new ProviderFixtureSyncService(repo),
  };
}

describe("G. Provider 数据（规范 44-G）", () => {
  it("G43 FT + fulltime 合法比分可以创建 result v1", async () => {
    const { repo, service } = await setup();
    const outcome = await service.applyFixture(
      makeFixture({ status: "FT", fulltime: { home: 2, away: 1 } }),
      { case: "G43" },
      NOW,
    );

    expect(outcome).toMatchObject({
      kind: "applied",
      match_id: MATCH_ID,
      result_version: 1,
      settlement_status: SettlementStatus.Waiting,
    });
    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Waiting,
      regular_home_score: 2,
      regular_away_score: 1,
      result_version: 1,
      result_source: ResultSource.Provider,
    });
    await expect(repo.matchResults.findByMatchAndVersion(MATCH_ID, 1)).resolves.toMatchObject({
      regular_home_score: 2,
      regular_away_score: 1,
      source: ResultSource.Provider,
      provider_status: "FT",
    });
  });

  it("G44 FT 无 fulltime => blocking anomaly，不结算", async () => {
    const { repo, service } = await setup();
    const outcome = await service.applyFixture(
      makeFixture({ status: "FT", fulltime: { home: null, away: null } }),
      { case: "G44" },
      NOW,
    );

    expect(outcome).toMatchObject({
      kind: "failed",
      match_id: MATCH_ID,
      anomaly_types: [AnomalyType.InvalidFinalScore],
    });
    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Waiting,
      result_version: 0,
      regular_home_score: null,
      regular_away_score: null,
      finish_detected_at: NOW,
    });
    await expect(repo.matchResults.findLatestByMatch(MATCH_ID)).resolves.toBeNull();
    await expect(
      repo.anomalies.findByKey(`${MATCH_ID}:${AnomalyType.InvalidFinalScore}`),
    ).resolves.toMatchObject({
      status: AnomalyStatus.Open,
      blocking: true,
    });
    expect(
      decideFirstSettlement({
        match_status: MatchStatus.Finished,
        settlement_status: SettlementStatus.Waiting,
        finish_detected_at: NOW,
        result_version: 0,
        regular_home_score: null,
        regular_away_score: null,
        server_now: new Date(NOW.getTime() + 20 * 60 * 1000),
        has_blocking_anomaly: true,
      }),
    ).not.toMatchObject({ kind: "start" });
  });

  it("G45 FT fulltime 负数/非整数 => blocking anomaly", async () => {
    const cases = [
      { fulltime: { home: -1, away: 1 }, providerMatchId: "44000101" },
      { fulltime: { home: 2.5, away: 1 }, providerMatchId: "44000102" },
      { fulltime: { home: 100, away: 0 }, providerMatchId: "44000103" },
    ] as const;
    for (const { fulltime, providerMatchId: localProviderMatchId } of cases) {
      const localMatchId = newUuid();
      const repo = new InMemoryRepository();
      await repo.matches.insert(makeMatch({ match_id: localMatchId }));
      await repo.matchProviderMappings.insert({
        schema_version: 1,
        match_id: localMatchId,
        provider: Provider.ApiFootball,
        provider_match_id: localProviderMatchId,
        created_at: NOW,
        updated_at: NOW,
      });
      await repo.teams.insert(makeTeam(HOME_TEAM_ID, "Home FC"));
      await repo.teams.insert(makeTeam(AWAY_TEAM_ID, "Away FC"));
      await repo.teamProviderMappings.insert(makeTeamMapping(HOME_TEAM_ID, "1001"));
      await repo.teamProviderMappings.insert(makeTeamMapping(AWAY_TEAM_ID, "1002"));

      const fixture = makeFixture({ status: "FT", fulltime });
      fixture.fixture.id = Number(localProviderMatchId);

      const outcome = await new ProviderFixtureSyncService(repo).applyFixture(
        fixture,
        { case: "G45", fulltime },
        NOW,
      );
      expect(outcome).toMatchObject({
        kind: "failed",
        match_id: localMatchId,
        anomaly_types: [AnomalyType.InvalidFinalScore],
      });
      await expect(repo.matches.findById(localMatchId)).resolves.toMatchObject({
        result_version: 0,
        regular_home_score: null,
      });
      await expect(
        repo.anomalies.findByKey(`${localMatchId}:${AnomalyType.InvalidFinalScore}`),
      ).resolves.toMatchObject({
        status: AnomalyStatus.Open,
        blocking: true,
      });
    }
  });

  it("G46 live goals 不得被当正式比分", async () => {
    const { repo, service } = await setup();
    const outcome = await service.applyFixture(
      makeFixture({
        status: "1H",
        goals: { home: 1, away: 0 },
        fulltime: { home: 1, away: 0 },
      }),
      { case: "G46" },
      NOW,
    );

    expect(outcome).toMatchObject({
      kind: "applied",
      match_id: MATCH_ID,
      match_status: MatchStatus.Live,
    });
    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      match_status: MatchStatus.Live,
      settlement_status: SettlementStatus.Pending,
      result_version: 0,
      regular_home_score: null,
      regular_away_score: null,
    });
    await expect(repo.matchResults.findLatestByMatch(MATCH_ID)).resolves.toBeNull();
  });

  it("G47 Provider 返回未知状态 => anomaly，不猜状态", async () => {
    const { repo, service } = await setup();
    const matchBefore = await repo.matches.findById(MATCH_ID);
    const outcome = await service.applyFixture(
      makeFixture({ status: "ZZZ" }),
      { case: "G47" },
      NOW,
    );

    expect(outcome).toMatchObject({
      kind: "failed",
      match_id: MATCH_ID,
      anomaly_types: [AnomalyType.UnexpectedProviderStatus],
    });
    await expect(repo.matches.findById(MATCH_ID)).resolves.toEqual(matchBefore);
    await expect(
      repo.anomalies.findByKey(`${MATCH_ID}:${AnomalyType.UnexpectedProviderStatus}`),
    ).resolves.toMatchObject({
      status: AnomalyStatus.Open,
      blocking: true,
    });
  });

  it("G48 EPL 返回 AET/PEN => blocking anomaly，不自动结算", async () => {
    for (const status of ["AET", "PEN"] as const) {
      const localMatchId = newUuid();
      const localProviderMatchId = String(44000200 + (status === "AET" ? 1 : 2));
      const repo = new InMemoryRepository();
      await repo.matches.insert(makeMatch({ match_id: localMatchId }));
      await repo.matchProviderMappings.insert({
        schema_version: 1,
        match_id: localMatchId,
        provider: Provider.ApiFootball,
        provider_match_id: localProviderMatchId,
        created_at: NOW,
        updated_at: NOW,
      });
      await repo.teams.insert(makeTeam(HOME_TEAM_ID, "Home FC"));
      await repo.teams.insert(makeTeam(AWAY_TEAM_ID, "Away FC"));
      await repo.teamProviderMappings.insert(makeTeamMapping(HOME_TEAM_ID, "1001"));
      await repo.teamProviderMappings.insert(makeTeamMapping(AWAY_TEAM_ID, "1002"));

      const fixture = makeFixture({
        status,
        fulltime: { home: 3, away: 2 },
      });
      fixture.fixture.id = Number(localProviderMatchId);

      const outcome = await new ProviderFixtureSyncService(repo).applyFixture(
        fixture,
        { case: `G48-${status}` },
        NOW,
      );
      expect(outcome).toMatchObject({
        kind: "failed",
        match_id: localMatchId,
        anomaly_types: [AnomalyType.UnexpectedProviderStatus],
      });
      await expect(repo.matches.findById(localMatchId)).resolves.toMatchObject({
        match_status: MatchStatus.Scheduled,
        settlement_status: SettlementStatus.Pending,
        result_version: 0,
        regular_home_score: null,
      });
      await expect(repo.matchResults.findLatestByMatch(localMatchId)).resolves.toBeNull();
      await expect(
        repo.anomalies.findByKey(`${localMatchId}:${AnomalyType.UnexpectedProviderStatus}`),
      ).resolves.toMatchObject({
        status: AnomalyStatus.Open,
        blocking: true,
      });
    }
  });

  it("G49 finished 后 Provider 返回 live => 不回退", async () => {
    const finished = makeMatch({
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Waiting,
      regular_home_score: 2,
      regular_away_score: 1,
      result_version: 1,
      result_source: ResultSource.Provider,
      prediction_closed_at: NOW,
      period_anchor_at: KICKOFF,
      finish_detected_at: NOW,
    });
    const { repo, service } = await setup(finished);
    await repo.matchResults.insert(
      makeResult({
        source: ResultSource.Provider,
        provider_status: "FT",
        admin_id: null,
        reason: null,
      }),
    );

    const outcome = await service.applyFixture(
      makeFixture({ status: "1H", goals: { home: 2, away: 1 } }),
      { case: "G49" },
      new Date(NOW.getTime() + 60_000),
    );

    expect(outcome).toMatchObject({
      kind: "conflict",
      match_id: MATCH_ID,
      match_status: MatchStatus.Finished,
      anomaly_type: AnomalyType.ProviderStateConflict,
    });
    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      match_status: MatchStatus.Finished,
      regular_home_score: 2,
      regular_away_score: 1,
      result_version: 1,
      settlement_status: SettlementStatus.Waiting,
    });
    await expect(
      repo.anomalies.findByKey(`${MATCH_ID}:${AnomalyType.ProviderStateConflict}`),
    ).resolves.toMatchObject({
      status: AnomalyStatus.Open,
      blocking: true,
    });
  });

  it("G50 admin result 后 Provider 不同比分 => 不覆盖", async () => {
    const finished = makeMatch({
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Settled,
      regular_home_score: 2,
      regular_away_score: 1,
      result_version: 1,
      settled_result_version: 1,
      result_source: ResultSource.Admin,
      prediction_closed_at: NOW,
      period_anchor_at: KICKOFF,
      finish_detected_at: NOW,
      settled_at: NOW,
    });
    const { repo, service } = await setup(finished);
    await repo.matchResults.insert(makeResult());

    const outcome = await service.applyFixture(
      makeFixture({ status: "FT", fulltime: { home: 1, away: 1 } }),
      { case: "G50" },
      new Date(NOW.getTime() + 60_000),
    );

    expect(outcome).toMatchObject({
      kind: "conflict",
      match_id: MATCH_ID,
      result_version: 1,
      anomaly_type: AnomalyType.AdminProviderResultConflict,
    });
    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      result_version: 1,
      result_source: ResultSource.Admin,
      regular_home_score: 2,
      regular_away_score: 1,
      settlement_status: SettlementStatus.Settled,
    });
    await expect(repo.matchResults.findByMatchAndVersion(MATCH_ID, 2)).resolves.toBeNull();
    await expect(
      repo.anomalies.findByKey(`${MATCH_ID}:${AnomalyType.AdminProviderResultConflict}`),
    ).resolves.toMatchObject({
      status: AnomalyStatus.Open,
    });
  });

  it("G51 有 prediction 后 Provider 改主客队 => blocking anomaly", async () => {
    const { repo, service } = await setup();
    const user = makeUser();
    await repo.users.insert(user);
    await repo.predictions.insert(makePrediction(user.user_id));
    await repo.teams.insert(makeTeam(NEXT_HOME_TEAM_ID, "Next Home"));
    await repo.teams.insert(makeTeam(NEXT_AWAY_TEAM_ID, "Next Away"));
    await repo.teamProviderMappings.insert(makeTeamMapping(NEXT_HOME_TEAM_ID, "2001"));
    await repo.teamProviderMappings.insert(makeTeamMapping(NEXT_AWAY_TEAM_ID, "2002"));

    const outcome = await service.applyFixture(
      makeFixture({
        status: "NS",
        homeTeamId: 2001,
        awayTeamId: 2002,
      }),
      { case: "G51" },
      NOW,
    );

    expect(outcome).toMatchObject({
      kind: "conflict",
      match_id: MATCH_ID,
      anomaly_type: AnomalyType.TeamChangeAfterPrediction,
    });
    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      home_team_id: HOME_TEAM_ID,
      away_team_id: AWAY_TEAM_ID,
      match_status: MatchStatus.Scheduled,
    });
    await expect(
      repo.anomalies.findByKey(`${MATCH_ID}:${AnomalyType.TeamChangeAfterPrediction}`),
    ).resolves.toMatchObject({
      status: AnomalyStatus.Open,
      blocking: true,
    });
  });

  it("G52 无 prediction 且 scheduled 时 Provider 改主客队可更新", async () => {
    const { repo, service } = await setup();
    await repo.teams.insert(makeTeam(NEXT_HOME_TEAM_ID, "Next Home"));
    await repo.teams.insert(makeTeam(NEXT_AWAY_TEAM_ID, "Next Away"));
    await repo.teamProviderMappings.insert(makeTeamMapping(NEXT_HOME_TEAM_ID, "2001"));
    await repo.teamProviderMappings.insert(makeTeamMapping(NEXT_AWAY_TEAM_ID, "2002"));

    const outcome = await service.applyFixture(
      makeFixture({
        status: "NS",
        homeTeamId: 2001,
        awayTeamId: 2002,
      }),
      { case: "G52" },
      NOW,
    );

    // fixture 主入口在 team change 成功后继续跑 scheduled 同步；outcome 可能为 applied/unchanged。
    expect(outcome).toMatchObject({
      match_id: MATCH_ID,
    });
    expect(outcome.kind === "applied" || outcome.kind === "unchanged").toBe(true);
    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      home_team_id: NEXT_HOME_TEAM_ID,
      away_team_id: NEXT_AWAY_TEAM_ID,
      match_status: MatchStatus.Scheduled,
    });
    await expect(
      repo.anomalies.findByKey(`${MATCH_ID}:${AnomalyType.TeamChangeAfterPrediction}`),
    ).resolves.toBeNull();
  });
});
