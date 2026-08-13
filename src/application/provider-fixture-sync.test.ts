import { describe, expect, it, vi } from "vitest";
import {
  AnomalyStatus,
  AnomalyType,
  MatchStatus,
  Provider,
  SettlementStatus,
} from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { Match, Team, TeamProviderMapping } from "../domain/types.js";
import type { ApiFootballFixture } from "../provider/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { ProviderFixtureSyncService } from "./provider-fixture-sync.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    schema_version: 1,
    match_id: newUuid(),
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: newUuid(),
    away_team_id: newUuid(),
    kickoff_at: new Date("2026-08-09T12:00:00.000Z"),
    kickoff_confirmed: true,
    prediction_deadline_at: new Date("2026-08-09T11:50:00.000Z"),
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

function makeFixture(
  providerMatchId: string,
  status: string,
  score?: { home: number | null; away: number | null },
): ApiFootballFixture {
  return {
    fixture: {
      id: Number(providerMatchId),
      date: "2026-08-09T12:00:00.000Z",
      timestamp: Date.parse("2026-08-09T12:00:00.000Z") / 1000,
      status: { short: status },
    },
    league: {
      id: 39,
      season: 2026,
      round: "Regular Season - 1",
    },
    teams: {
      home: { id: 1001, name: "Home" },
      away: { id: 1002, name: "Away" },
    },
    ...(score === undefined ? {} : { score: { fulltime: score } }),
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

function makeTeam(teamId: string): Team {
  return {
    schema_version: 1,
    team_id: teamId,
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

async function seedChangedTeams(repo: InMemoryRepository): Promise<{
  home_team_id: string;
  away_team_id: string;
}> {
  const homeTeamId = newUuid();
  const awayTeamId = newUuid();
  await repo.teams.insert(makeTeam(homeTeamId));
  await repo.teams.insert(makeTeam(awayTeamId));
  await repo.teamProviderMappings.insert(makeTeamMapping(homeTeamId, "1001"));
  await repo.teamProviderMappings.insert(makeTeamMapping(awayTeamId, "1002"));
  return { home_team_id: homeTeamId, away_team_id: awayTeamId };
}

describe("ProviderFixtureSyncService", () => {
  it("无效 server_now 在 fixture 主入口和事实写入前 Fail Closed", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch();
    await seedMatch(repo, match, "1100006");
    const transactionSpy = vi.spyOn(repo, "withTransaction");

    await expect(
      new ProviderFixtureSyncService(repo).applyFixture(
        makeFixture("1100006", "TBD"),
        {},
        new Date("invalid"),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "server_now" },
    });

    expect(transactionSpy).not.toHaveBeenCalled();
    await expect(repo.matches.findById(match.match_id)).resolves.toEqual(match);
    await expect(repo.providerSnapshots.findByEntity("match", match.match_id)).resolves.toEqual(
      [],
    );
    await expect(repo.anomalies.findByKey(`${match.match_id}:${AnomalyType.LiveSyncStale}`)).resolves.toBeNull();
  });

  it("主入口同步 scheduled fixture 时应用 Provider 主客队变更保护", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch();
    await seedMatch(repo, match, "1100000");

    const nextTeams = await seedChangedTeams(repo);

    await expect(
      new ProviderFixtureSyncService(repo).applyFixture(
        makeFixture("1100000", "NS"),
        { fixture: { id: 1100000, teams_changed: true } },
        NOW,
      ),
    ).resolves.toMatchObject({ kind: "unchanged", match_id: match.match_id });

    await expect(repo.matches.findById(match.match_id)).resolves.toMatchObject({
      home_team_id: nextTeams.home_team_id,
      away_team_id: nextTeams.away_team_id,
    });
    await expect(
      repo.anomalies.findByKey(`${match.match_id}:${AnomalyType.TeamChangeAfterPrediction}`),
    ).resolves.toBeNull();
  });

  it("主入口首次发现已开赛 fixture 的球队变更时保持原比赛事实并报警", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch();
    await seedMatch(repo, match, "1100004");
    await seedChangedTeams(repo);

    await expect(
      new ProviderFixtureSyncService(repo).applyFixture(
        makeFixture("1100004", "1H"),
        { fixture: { id: 1100004, teams_changed: true } },
        NOW,
      ),
    ).resolves.toMatchObject({
      kind: "conflict",
      match_id: match.match_id,
      anomaly_type: AnomalyType.TeamChangeAfterPrediction,
    });

    await expect(repo.matches.findById(match.match_id)).resolves.toMatchObject({
      home_team_id: match.home_team_id,
      away_team_id: match.away_team_id,
      match_status: MatchStatus.Scheduled,
    });
    await expect(
      repo.anomalies.findByKey(`${match.match_id}:${AnomalyType.TeamChangeAfterPrediction}`),
    ).resolves.toMatchObject({ status: AnomalyStatus.Open, blocking: true });
  });

  it("将 scheduled fixture 交给状态同步并保持重复观察幂等", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch();
    await seedMatch(repo, match, "1100001");

    const service = new ProviderFixtureSyncService(repo);
    await expect(
      service.applyFixture(
        makeFixture("1100001", "TBD"),
        { fixture: { id: 1100001 } },
        NOW,
      ),
    ).resolves.toMatchObject({ kind: "applied", match_id: match.match_id });

    await expect(
      service.applyFixture(makeFixture("1100001", "TBD"), {}, NOW),
    ).resolves.toMatchObject({ kind: "unchanged", match_id: match.match_id });
    expect(await repo.matches.findById(match.match_id)).toMatchObject({
      match_status: MatchStatus.Scheduled,
      kickoff_confirmed: false,
    });
  });

  it("将 FT + fulltime 交给赛果同步并追加 result v1", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch();
    await seedMatch(repo, match, "1100002");

    const result = await new ProviderFixtureSyncService(repo).applyFixture(
      makeFixture("1100002", "FT", { home: 2, away: 1 }),
      { fixture: { id: 1100002 }, score: { fulltime: { home: 2, away: 1 } } },
      NOW,
    );

    expect(result).toMatchObject({
      kind: "applied",
      match_id: match.match_id,
      result_version: 1,
    });
    expect(await repo.matchResults.findByMatchAndVersion(match.match_id, 1)).toMatchObject({
      regular_home_score: 2,
      regular_away_score: 1,
    });
  });

  it("业务判断和 Provider 事实写入只使用注入的 server_now", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch();
    await seedMatch(repo, match, "1100008");
    const serverNow = new Date("2026-08-09T00:07:00.000Z");

    vi.useFakeTimers({ now: new Date("2026-08-10T12:00:00.000Z") });
    try {
      await expect(
        new ProviderFixtureSyncService(repo).applyFixture(
          makeFixture("1100008", "FT", { home: 2, away: 1 }),
          { fixture: { id: 1100008 }, score: { fulltime: { home: 2, away: 1 } } },
          serverNow,
        ),
      ).resolves.toMatchObject({ kind: "applied", match_id: match.match_id });

      await expect(repo.matches.findById(match.match_id)).resolves.toMatchObject({
        prediction_closed_at: serverNow,
        finish_detected_at: serverNow,
        updated_at: serverNow,
      });
      await expect(repo.matchResults.findByMatchAndVersion(match.match_id, 1)).resolves.toMatchObject({
        created_at: serverNow,
      });
      await expect(repo.providerSnapshots.findByEntity("match", match.match_id)).resolves.toEqual([
        expect.objectContaining({ created_at: serverNow }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("mapper 发现非法正式比分时不改比赛，追加 snapshot 与 blocking anomaly", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch();
    await seedMatch(repo, match, "1100003");

    const result = await new ProviderFixtureSyncService(repo).applyFixture(
      makeFixture("1100003", "FT", { home: null, away: 1 }),
      { fixture: { id: 1100003 }, score: { fulltime: { home: null, away: 1 } } },
      NOW,
    );

    expect(result).toMatchObject({
      kind: "failed",
      match_id: match.match_id,
      anomaly_types: [AnomalyType.InvalidFinalScore],
    });
    expect(await repo.matches.findById(match.match_id)).toEqual(match);
    expect(
      await repo.anomalies.findByKey(`${match.match_id}:${AnomalyType.InvalidFinalScore}`),
    ).toMatchObject({
      blocking: true,
      status: "open",
    });
    expect(await repo.providerSnapshots.findByEntity("match", match.match_id)).toHaveLength(1);
  });

  it("合法 Provider 观察后确定性 resolve PROVIDER_DATA_INVALID，且保留比赛事实", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch();
    await seedMatch(repo, match, "1100007");
    const service = new ProviderFixtureSyncService(repo);

    const invalidFixture = makeFixture("1100007", "NS");
    invalidFixture.fixture.date = "invalid-kickoff";
    await expect(
      service.applyFixture(invalidFixture, { fixture: { id: 1100007 } }, NOW),
    ).resolves.toMatchObject({
      kind: "failed",
      match_id: match.match_id,
      anomaly_types: [AnomalyType.ProviderDataInvalid],
    });

    await expect(
      service.applyFixture(
        makeFixture("1100007", "NS"),
        { fixture: { id: 1100007, status: "NS" } },
        new Date("2026-08-09T00:03:00.000Z"),
      ),
    ).resolves.toMatchObject({ kind: "unchanged", match_id: match.match_id });

    await expect(repo.matches.findById(match.match_id)).resolves.toEqual(match);
    await expect(
      repo.anomalies.findByKey(`${match.match_id}:${AnomalyType.ProviderDataInvalid}`),
    ).resolves.toMatchObject({
      status: AnomalyStatus.Resolved,
      resolved_at: new Date("2026-08-09T00:03:00.000Z"),
      resolution: "provider data valid",
    });
  });

  it("成功同步 live fixture 后评估并持久化 LIVE_TOO_LONG anomaly", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch({
      match_status: MatchStatus.Live,
      period_anchor_at: new Date("2026-08-01T00:00:00.000Z"),
    });
    await seedMatch(repo, match, "1100005");

    await expect(
      new ProviderFixtureSyncService(repo).applyFixture(
        makeFixture("1100005", "1H"),
        { fixture: { id: 1100005 } },
        NOW,
      ),
    ).resolves.toMatchObject({ kind: "applied", match_id: match.match_id });

    await expect(
      repo.anomalies.findByKey(`${match.match_id}:${AnomalyType.LiveTooLong}`),
    ).resolves.toMatchObject({
      status: AnomalyStatus.Open,
      blocking: true,
    });
  });
});
