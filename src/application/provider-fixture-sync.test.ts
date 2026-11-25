import { describe, expect, it, vi } from "vitest";
import {
  AnomalyStatus,
  AnomalyType,
  MatchStatus,
  Provider,
  ResultSource,
  SettlementStatus,
  SyncJobType,
} from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { Match, ProviderSnapshot, Team, TeamProviderMapping } from "../domain/types.js";
import type { ApiFootballFixture } from "../provider/types.js";
import { InMemoryRepository, type AppRepository, type UnitOfWork } from "../infrastructure/repositories.js";
import { ProviderFixtureSyncService } from "./provider-fixture-sync.js";
import { persistAnomalyInTransaction } from "./anomaly-persistence.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");

function makeMatch(overrides: Partial<Match> = {}): Match {
  const canonicalMatchIdentity = overrides.match_id ?? (newUuid());
  return {
    schema_version: 1,
    match_id: canonicalMatchIdentity,
    canonical_match_id: overrides.canonical_match_id ?? canonicalMatchIdentity,
    superseded_by: overrides.superseded_by ?? null,
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
  provider: Provider = Provider.ApiFootball,
): ApiFootballFixture {
  return {
    provider,
    fixture: {
      id: Number(providerMatchId),
      date: "2026-08-09T12:00:00.000Z",
      timestamp: Date.parse("2026-08-09T12:00:00.000Z") / 1000,
      status: { short: status },
    },
    league: {
      id: provider === Provider.FootballData ? "PL" : 39,
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
  provider: Provider = Provider.ApiFootball,
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
  provider: Provider = Provider.ApiFootball,
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

async function seedTeams(
  repo: InMemoryRepository,
  provider: Provider = Provider.ApiFootball,
): Promise<{ home_team_id: string; away_team_id: string }> {
  const homeTeamId = newUuid();
  const awayTeamId = newUuid();
  await repo.teams.insert(makeTeam(homeTeamId));
  await repo.teams.insert(makeTeam(awayTeamId));
  await repo.teamProviderMappings.insert(makeTeamMapping(homeTeamId, "1001", provider));
  await repo.teamProviderMappings.insert(makeTeamMapping(awayTeamId, "1002", provider));
  return { home_team_id: homeTeamId, away_team_id: awayTeamId };
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

function makeSuccessSnapshot(
  matchId: string,
  providerMatchId: string,
  createdAt: Date,
): ProviderSnapshot {
  return {
    schema_version: 1,
    snapshot_id: newUuid(),
    provider: Provider.ApiFootball,
    entity_type: "match",
    entity_id: matchId,
    provider_entity_id: providerMatchId,
    event_type: "status_changed",
    payload: { sync: "success" },
    created_at: createdAt,
  };
}

function withSettlementWriteGuard(
  repo: InMemoryRepository,
  writes: Array<{ kind: "update" | "updateSettlementStatus"; value: Partial<Match> }>,
): AppRepository {
  const guardedRepo = Object.create(repo) as AppRepository;
  Object.defineProperty(guardedRepo, "withTransaction", {
    value: <T>(fn: (tx: UnitOfWork) => Promise<T>) =>
      repo.withTransaction((tx) =>
        {
          const guardedTx = Object.create(tx) as UnitOfWork;
          Object.defineProperty(guardedTx, "matches", {
            value: {
              ...tx.matches,
              update: async (updated: Match) => {
                const current = await tx.matches.findById(updated.match_id);
                if (current !== null && current.settlement_status !== updated.settlement_status) {
                  throw new Error("raw settlement_status update");
                }
                writes.push({ kind: "update", value: updated });
                return tx.matches.update(updated);
              },
              updateSettlementStatus: async (
                matchId: string,
                status: Match["settlement_status"],
                updatedAt: Date,
              ) => {
                writes.push({
                  kind: "updateSettlementStatus",
                  value: { match_id: matchId, settlement_status: status, updated_at: updatedAt },
                });
                return tx.matches.updateSettlementStatus(matchId, status, updatedAt);
              },
            },
          });
          return fn(guardedTx);
        },
      ),
  });
  return guardedRepo;
}

describe("ProviderFixtureSyncService", () => {
  it("旧来源 ID 的采纳赛果观测写入有效记录", async () => {
    const repo = new InMemoryRepository();
    const original = makeMatch();
    await seedMatch(repo, original, "1199001");
    const effectiveId = newUuid();
    await repo.matches.insert({ ...original, match_id: effectiveId });
    await repo.matches.update({ ...original, superseded_by: effectiveId });
    const result = await new ProviderFixtureSyncService(repo).applyFixture(
      makeFixture("1199001", "FT", { home: 2, away: 1 }), {}, NOW,
    );
    expect(result).toMatchObject({ kind: "pending", match_id: effectiveId, anomaly_types: [AnomalyType.ProviderResultPending] });
    expect(await repo.providerSnapshots.findByEntity("match", effectiveId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_type: "result_observed", provider_entity_id: "1199001" }),
    ]));
    expect(await repo.providerSnapshots.findByEntity("match", original.match_id)).toEqual([]);
    expect(await repo.matches.findById(original.match_id)).toEqual({ ...original, superseded_by: effectiveId });
  });

  it("旧来源 ID 的无效赛果和异常写入有效记录", async () => {
    const repo = new InMemoryRepository();
    const original = makeMatch();
    await seedMatch(repo, original, "1199002");
    const effectiveId = newUuid();
    await repo.matches.insert({ ...original, match_id: effectiveId });
    await repo.matches.update({ ...original, superseded_by: effectiveId });
    const result = await new ProviderFixtureSyncService(repo).applyFixture(
      makeFixture("1199002", "FT", { home: null, away: null }), {}, NOW,
    );
    expect(result).toMatchObject({ kind: "failed", match_id: effectiveId, anomaly_types: [AnomalyType.InvalidFinalScore] });
    expect(await repo.matches.findById(effectiveId)).toMatchObject({ match_status: MatchStatus.Finished });
    expect(await repo.anomalies.findByKey(`${effectiveId}:${AnomalyType.InvalidFinalScore}`)).not.toBeNull();
    expect(await repo.matches.findById(original.match_id)).toEqual({ ...original, superseded_by: effectiveId });
  });
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

  it("RP11：同一 fixture 的球队映射只查一轮，不在事务内重复查询", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch();
    await seedMatch(repo, match, "1100042");
    await seedChangedTeams(repo);

    // 事务内会新建一个共享 store 的仓储实例，所以直接在 store 的 Map 上计读取次数。
    const store = (repo as unknown as {
      store: { teamProviderMappingsByKey: Map<string, TeamProviderMapping> };
    }).store;
    const inner = store.teamProviderMappingsByKey;
    let lookups = 0;
    store.teamProviderMappingsByKey = new Proxy(inner, {
      get(target, property) {
        if (property === "get") lookups += 1;
        const value = Reflect.get(target, property) as unknown;
        // Map 方法要求 receiver 是真实 Map，否则报 incompatible receiver。
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });

    await new ProviderFixtureSyncService(repo).applyFixture(
      makeFixture("1100042", "NS"),
      { fixture: { id: 1100042, teams_changed: true } },
      NOW,
    );

    // 预检读 home/away 各一次；applyTeamChange 复用预加载结果，不再重复查。
    expect(lookups).toBe(2);
  });

  it.each([
    ["NS", MatchStatus.Scheduled],
    ["1H", MatchStatus.Live],
    ["PST", MatchStatus.Postponed],
    ["CANC", MatchStatus.Cancelled],
    ["ABD", MatchStatus.Abandoned],
  ] as const)(
    "主赛程源首次发现 %s fixture 且比赛不存在时建立 match 并应用状态",
    async (statusShort, expectedStatus) => {
      const repo = new InMemoryRepository();
      const teams = await seedTeams(repo);
      const fixture = makeFixture("1200001", statusShort);

      const outcome = await new ProviderFixtureSyncService(repo).applyFixture(
        fixture,
        { fixture: { id: 1200001, status: statusShort } },
        NOW,
      );

      expect(outcome).toMatchObject({
        kind: "applied",
        match_status: expectedStatus,
      });
      const mapping = await repo.matchProviderMappings.findByProviderAndExternalId(
        Provider.ApiFootball,
        "1200001",
      );
      expect(mapping).not.toBeNull();
      expect(outcome.match_id).toBe(mapping!.match_id);
      await expect(repo.matches.findById(mapping!.match_id)).resolves.toMatchObject({
        home_team_id: teams.home_team_id,
        away_team_id: teams.away_team_id,
        match_status: expectedStatus,
        settlement_status:
          expectedStatus === MatchStatus.Cancelled
            ? SettlementStatus.Voided
            : SettlementStatus.Pending,
      });
    },
  );

  it("主赛程源首次发现已结束 fixture 时建档并走既有权威赛果采纳", async () => {
    const repo = new InMemoryRepository();
    const teams = await seedTeams(repo, Provider.FootballData);
    const fixture = makeFixture(
      "1200002",
      "FT",
      { home: 2, away: 1 },
      Provider.FootballData,
    );

    const outcome = await new ProviderFixtureSyncService(repo).applyFixture(
      fixture,
      { fixture: { id: 1200002 }, score: { fulltime: { home: 2, away: 1 } } },
      NOW,
    );

    expect(outcome).toMatchObject({
      kind: "applied",
      result_version: 1,
      settlement_status: SettlementStatus.Waiting,
    });
    const mapping = await repo.matchProviderMappings.findByProviderAndExternalId(
      Provider.FootballData,
      "1200002",
    );
    expect(mapping).not.toBeNull();
    expect(outcome.match_id).toBe(mapping!.match_id);
    await expect(repo.matches.findById(mapping!.match_id)).resolves.toMatchObject({
      home_team_id: teams.home_team_id,
      away_team_id: teams.away_team_id,
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Waiting,
      regular_home_score: 2,
      regular_away_score: 1,
      result_version: 1,
    });
    await expect(
      repo.matchResults.findByMatchAndVersion(mapping!.match_id, 1),
    ).resolves.toMatchObject({
      regular_home_score: 2,
      regular_away_score: 1,
    });
  });

  it("首次发现并重复输入同一已结束 fixture 时复用原 match_id 且不重复结算", async () => {
    const repo = new InMemoryRepository();
    await seedTeams(repo, Provider.FootballData);
    const service = new ProviderFixtureSyncService(repo);
    const fixture = makeFixture(
      "1200003",
      "FT",
      { home: 2, away: 1 },
      Provider.FootballData,
    );

    const first = await service.applyFixture(fixture, { fixture: { id: 1200003 } }, NOW);
    const second = await service.applyFixture(
      fixture,
      { fixture: { id: 1200003 } },
      new Date(NOW.getTime() + 60_000),
    );

    expect(second).toMatchObject({
      kind: "unchanged",
      match_id: first.match_id,
      result_version: 1,
    });
    expect(first.match_id).toBeTruthy();
    await expect(repo.matches.findBySeason("2026_2027")).resolves.toHaveLength(1);
    await expect(
      repo.matchResults.findByMatchAndVersion(first.match_id!, 2),
    ).resolves.toBeNull();
  });

  it("次要源首次出现不复制比赛，仍按既有比赛匹配失败处理", async () => {
    const repo = new InMemoryRepository();
    await seedTeams(repo, Provider.FiveDollar);
    const fixture = makeFixture(
      "1200004",
      "FT",
      { home: 1, away: 0 },
      Provider.FiveDollar,
    );
    fixture.league.id = "4160026622";

    await expect(
      new ProviderFixtureSyncService(repo).applyFixture(
        fixture,
        { fixture: { id: 1200004 } },
        NOW,
      ),
    ).resolves.toMatchObject({
      kind: "failed",
      match_id: null,
      anomaly_types: [AnomalyType.ProviderDataInvalid],
    });
    await expect(
      repo.matchProviderMappings.findByProviderAndExternalId(Provider.FiveDollar, "1200004"),
    ).resolves.toBeNull();
    await expect(repo.matches.findBySeason("2026_2027")).resolves.toEqual([]);
  });

  it("主赛程源延期且缺少可靠 kickoff 时不捏造比赛记录", async () => {
    const repo = new InMemoryRepository();
    await seedTeams(repo);
    const fixture = makeFixture("1200005", "PST");
    fixture.fixture.date = "";
    (fixture.fixture as { timestamp: unknown }).timestamp = null;

    await expect(
      new ProviderFixtureSyncService(repo).applyFixture(
        fixture,
        { fixture: { id: 1200005 } },
        NOW,
      ),
    ).resolves.toMatchObject({
      kind: "failed",
      match_id: null,
      anomaly_types: [AnomalyType.ProviderDataInvalid],
    });
    await expect(
      repo.matchProviderMappings.findByProviderAndExternalId(Provider.ApiFootball, "1200005"),
    ).resolves.toBeNull();
    await expect(repo.matches.findBySeason("2026_2027")).resolves.toEqual([]);
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
    await seedMatch(repo, match, "1100002", Provider.FootballData);

    const result = await new ProviderFixtureSyncService(repo).applyFixture(
      makeFixture("1100002", "FT", { home: 2, away: 1 }, Provider.FootballData),
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
    await seedMatch(repo, match, "1100008", Provider.FootballData);
    const serverNow = new Date("2026-08-09T00:07:00.000Z");

    vi.useFakeTimers({ now: new Date("2026-08-10T12:00:00.000Z") });
    try {
      await expect(
        new ProviderFixtureSyncService(repo).applyFixture(
          makeFixture("1100008", "FT", { home: 2, away: 1 }, Provider.FootballData),
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
        expect.objectContaining({ created_at: serverNow }),
        expect.objectContaining({ created_at: serverNow }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("mapper 发现非法正式比分时不写分，标记 finished 并追加 snapshot 与 blocking anomaly", async () => {
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
    expect(await repo.matches.findById(match.match_id)).toMatchObject({
      match_status: MatchStatus.Finished,
      finish_detected_at: NOW,
      regular_home_score: null,
      regular_away_score: null,
      result_version: 0,
      settlement_status: SettlementStatus.Waiting,
    });
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

  it("结构非法 fixture（缺可识别标识）逐条失败并留 provider_error snapshot 证据", async () => {
    const repo = new InMemoryRepository();
    const service = new ProviderFixtureSyncService(repo);

    await expect(
      service.applyFixture({} as ApiFootballFixture, { fixture: {} }, NOW),
    ).resolves.toMatchObject({
      kind: "failed",
      match_id: null,
      anomaly_types: [AnomalyType.ProviderDataInvalid],
    });

    const evidence = await repo.providerSnapshots.findByEntity("match", null);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      event_type: "provider_error",
      provider_entity_id: "",
      payload: { fixture: {} },
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

  it("live 且 10 分钟无成功同步时，conflict 路径也评估并 open LIVE_SYNC_STALE", async () => {
    const repo = new InMemoryRepository();
    const staleSince = new Date(NOW.getTime() - 11 * 60 * 1000);
    const match = makeMatch({
      match_status: MatchStatus.Live,
      period_anchor_at: new Date("2026-08-08T12:00:00.000Z"),
    });
    await seedMatch(repo, match, "1100090");
    await repo.providerSnapshots.insert(makeSuccessSnapshot(match.match_id, "1100090", staleSince));

    await expect(
      new ProviderFixtureSyncService(repo).applyFixture(
        makeFixture("1100090", "NS"),
        { fixture: { id: 1100090, status: "NS" } },
        NOW,
      ),
    ).resolves.toMatchObject({
      kind: "conflict",
      match_id: match.match_id,
      anomaly_type: AnomalyType.ProviderStateConflict,
    });

    await expect(
      repo.anomalies.findByKey(`${match.match_id}:${AnomalyType.LiveSyncStale}`),
    ).resolves.toMatchObject({
      status: AnomalyStatus.Open,
      blocking: false,
      details: { last_successful_sync_at: staleSince.toISOString() },
    });
  });

  it("live stale 后成功 apply live fixture 会刷新成功时间并 resolve LIVE_SYNC_STALE", async () => {
    const repo = new InMemoryRepository();
    const staleSince = new Date(NOW.getTime() - 11 * 60 * 1000);
    const match = makeMatch({
      match_status: MatchStatus.Live,
      period_anchor_at: new Date("2026-08-08T12:00:00.000Z"),
    });
    await seedMatch(repo, match, "1100091");
    await repo.providerSnapshots.insert(makeSuccessSnapshot(match.match_id, "1100091", staleSince));
    const service = new ProviderFixtureSyncService(repo);

    await expect(
      service.applyFixture(makeFixture("1100091", "NS"), {}, NOW),
    ).resolves.toMatchObject({ kind: "conflict", match_id: match.match_id });

    await expect(
      service.applyFixture(makeFixture("1100091", "1H"), {}, new Date(NOW.getTime() + 60_000)),
    ).resolves.toMatchObject({ match_id: match.match_id });

    await expect(
      repo.anomalies.findByKey(`${match.match_id}:${AnomalyType.LiveSyncStale}`),
    ).resolves.toMatchObject({
      status: AnomalyStatus.Resolved,
      resolution: "last successful sync within threshold",
      resolved_at: new Date(NOW.getTime() + 60_000),
    });
  });

  it("live 且 2 分钟前刚成功同步时，失败路径不 open LIVE_SYNC_STALE", async () => {
    const repo = new InMemoryRepository();
    const lastOk = new Date(NOW.getTime() - 2 * 60 * 1000);
    const match = makeMatch({
      match_status: MatchStatus.Live,
      period_anchor_at: new Date("2026-08-08T12:00:00.000Z"),
    });
    await seedMatch(repo, match, "1100092");
    await repo.providerSnapshots.insert(makeSuccessSnapshot(match.match_id, "1100092", lastOk));

    await expect(
      new ProviderFixtureSyncService(repo).applyFixture(
        makeFixture("1100092", "NS"),
        { fixture: { id: 1100092, status: "NS" } },
        NOW,
      ),
    ).resolves.toMatchObject({ kind: "conflict", match_id: match.match_id });

    await expect(
      repo.anomalies.findByKey(`${match.match_id}:${AnomalyType.LiveSyncStale}`),
    ).resolves.toBeNull();
  });

  it("mapper fail-closed 的 FT 无分观察会标记 finished + finish_detected_at，不写比分", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch();
    await seedMatch(repo, match, "1100100");

    const result = await new ProviderFixtureSyncService(repo).applyFixture(
      makeFixture("1100100", "FT", { home: null, away: 1 }),
      { fixture: { id: 1100100 }, score: { fulltime: { home: null, away: 1 } } },
      NOW,
    );

    expect(result).toMatchObject({
      kind: "failed",
      match_id: match.match_id,
      anomaly_types: [AnomalyType.InvalidFinalScore],
    });
    await expect(repo.matches.findById(match.match_id)).resolves.toMatchObject({
      match_status: MatchStatus.Finished,
      finish_detected_at: NOW,
      period_anchor_at: match.kickoff_at,
      regular_home_score: null,
      regular_away_score: null,
      result_version: 0,
      settlement_status: SettlementStatus.Waiting,
    });
    await expect(
      repo.anomalies.findByKey(`${match.match_id}:${AnomalyType.InvalidFinalScore}`),
    ).resolves.toMatchObject({
      status: AnomalyStatus.Open,
      blocking: true,
    });
    expect(await repo.providerSnapshots.findByEntity("match", match.match_id)).toHaveLength(1);
  });

  it("无分 finished 超过 20 分钟时 FINISHED_NO_SCORE open blocking，未到则不开", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch();
    await seedMatch(repo, match, "1100101");
    const service = new ProviderFixtureSyncService(repo);
    const invalidFixture = makeFixture("1100101", "FT", { home: null, away: 1 });
    const payload = { fixture: { id: 1100101 }, score: { fulltime: { home: null, away: 1 } } };

    await service.applyFixture(invalidFixture, payload, NOW);

    await service.applyFixture(
      invalidFixture,
      payload,
      new Date(NOW.getTime() + 19 * 60 * 1000),
    );
    await expect(
      repo.anomalies.findByKey(`${match.match_id}:${AnomalyType.FinishedNoScore}`),
    ).resolves.toBeNull();

    await service.applyFixture(
      invalidFixture,
      payload,
      new Date(NOW.getTime() + 21 * 60 * 1000),
    );
    await expect(
      repo.anomalies.findByKey(`${match.match_id}:${AnomalyType.FinishedNoScore}`),
    ).resolves.toMatchObject({
      status: AnomalyStatus.Open,
      blocking: true,
    });
  });

  it("无分 finished 后合法 FT 到达：写分、进入 waiting 并 resolve 两规则", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch();
    await seedMatch(repo, match, "1100102", Provider.FootballData);
    const service = new ProviderFixtureSyncService(repo);
    const invalidFixture = makeFixture("1100102", "FT", { home: null, away: 1 }, Provider.FootballData);
    const invalidPayload = { fixture: { id: 1100102 }, score: { fulltime: { home: null, away: 1 } } };

    await service.applyFixture(invalidFixture, invalidPayload, NOW);

    await service.applyFixture(
      invalidFixture,
      invalidPayload,
      new Date(NOW.getTime() + 21 * 60 * 1000),
    );
    await expect(
      repo.anomalies.findByKey(`${match.match_id}:${AnomalyType.FinishedNoScore}`),
    ).resolves.toMatchObject({ status: AnomalyStatus.Open, blocking: true });

    const legalAt = new Date(NOW.getTime() + 25 * 60 * 1000);
    await expect(
      service.applyFixture(
        makeFixture("1100102", "FT", { home: 2, away: 1 }, Provider.FootballData),
        { fixture: { id: 1100102 }, score: { fulltime: { home: 2, away: 1 } } },
        legalAt,
      ),
    ).resolves.toMatchObject({ kind: "applied", match_id: match.match_id, result_version: 1 });

    await expect(repo.matches.findById(match.match_id)).resolves.toMatchObject({
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Waiting,
      regular_home_score: 2,
      regular_away_score: 1,
      result_version: 1,
      finish_detected_at: NOW,
    });
    await expect(
      repo.anomalies.findByKey(`${match.match_id}:${AnomalyType.FinishedNoScore}`),
    ).resolves.toMatchObject({ status: AnomalyStatus.Resolved });
    await expect(
      repo.anomalies.findByKey(`${match.match_id}:${AnomalyType.InvalidFinalScore}`),
    ).resolves.toMatchObject({ status: AnomalyStatus.Resolved });
  });
  it("采纳权威赛果后 resolve 遗留的 PROVIDER_RESULT_PENDING 异常", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch();
    await seedMatch(repo, match, "1100400", Provider.FootballData);
    const anomalyKey = `${match.match_id}:${AnomalyType.ProviderResultPending}`;

    // 模拟"非权威单源等待"阶段留下的异常：open + 非阻塞
    await repo.withTransaction(async (tx) => {
      await persistAnomalyInTransaction(
        tx,
        match.match_id,
        AnomalyType.ProviderResultPending,
        { open: true, blocking: false },
        { reason: "non_authoritative_single_source" },
        NOW,
      );
    });
    await expect(repo.anomalies.findByKey(anomalyKey)).resolves.toMatchObject({
      status: AnomalyStatus.Open,
    });

    const service = new ProviderFixtureSyncService(repo);
    await expect(
      service.applyFixture(
        makeFixture("1100400", "FT", { home: 3, away: 0 }, Provider.FootballData),
        { fixture: { id: 1100400 }, score: { fulltime: { home: 3, away: 0 } } },
        NOW,
      ),
    ).resolves.toMatchObject({ kind: "applied", result_version: 1 });

    await expect(repo.anomalies.findByKey(anomalyKey)).resolves.toMatchObject({
      status: AnomalyStatus.Resolved,
      resolution: "provider_result_adopted",
    });
  });

  it("首次无分 FT 的 settlement_status 变化必须经过既有 transition repository 入口", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch();
    await seedMatch(repo, match, "1100200");
    const writes: Array<{ kind: "update" | "updateSettlementStatus"; value: Partial<Match> }> = [];

    const outcome = await new ProviderFixtureSyncService(
      withSettlementWriteGuard(repo, writes),
    ).applyFixture(
      makeFixture("1100200", "FT", { home: null, away: 1 }),
      { fixture: { id: 1100200 }, score: { fulltime: { home: null, away: 1 } } },
      NOW,
    );

    expect(outcome).toMatchObject({ kind: "failed", match_id: match.match_id });
    expect(writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "updateSettlementStatus",
          value: expect.objectContaining({
            settlement_status: SettlementStatus.Waiting,
          }),
        }),
      ]),
    );
  });

  it("settlement 已 waiting 时再次无分观察保持 waiting，不重复非法转移", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch();
    await seedMatch(repo, match, "1100201");
    const service = new ProviderFixtureSyncService(repo);
    const fixture = makeFixture("1100201", "FT", { home: null, away: 1 });
    const payload = { fixture: { id: 1100201 }, score: { fulltime: { home: null, away: 1 } } };

    await service.applyFixture(fixture, payload, NOW);
    await expect(repo.matches.findById(match.match_id)).resolves.toMatchObject({
      settlement_status: SettlementStatus.Waiting,
    });

    await expect(
      service.applyFixture(fixture, payload, new Date(NOW.getTime() + 60_000)),
    ).resolves.toMatchObject({ kind: "failed", match_id: match.match_id });
    await expect(repo.matches.findById(match.match_id)).resolves.toMatchObject({
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Waiting,
      regular_home_score: null,
      regular_away_score: null,
      result_version: 0,
      finish_detected_at: NOW,
    });
  });

  it("PostgreSQL JSONB 往返反序列化（observed_at 为 ISO 字符串）时仍能采纳完场赛果", async () => {
    const repo = new InMemoryRepository();
    const teams = await seedTeams(repo, Provider.FootballData);
    const match = makeMatch({
      home_team_id: teams.home_team_id,
      away_team_id: teams.away_team_id,
    });
    await seedMatch(repo, match, "1100202", Provider.FootballData);
    const origFindByEntity = repo.providerSnapshots.findByEntity.bind(repo.providerSnapshots);
    repo.providerSnapshots.findByEntity = async (entityType, entityId) => {
      const rows = await origFindByEntity(entityType, entityId);
      return rows.map((row) => ({
        ...row,
        payload: JSON.parse(JSON.stringify(row.payload)) as Record<string, unknown>,
      }));
    };

    const outcome = await new ProviderFixtureSyncService(repo).applyFixture(
      makeFixture("1100202", "FT", { home: 3, away: 0 }, Provider.FootballData),
      { fixture: { id: 1100202 }, score: { fulltime: { home: 3, away: 0 } } },
      NOW,
    );

    expect(outcome).toMatchObject({
      kind: "applied",
      match_id: match.match_id,
      result_version: 1,
    });
  });

  it("非权威副源禁止改写状态或作废比赛，且滞后 LIVE 不打开阻塞性 PROVIDER_STATE_CONFLICT (A-S3-01)", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch({
      match_status: MatchStatus.Finished,
      finish_detected_at: NOW,
      period_anchor_at: new Date("2026-08-09T12:00:00.000Z"),
      settlement_status: SettlementStatus.Waiting,
    });
    await seedMatch(repo, match, "1199100", Provider.FootballData);
    await repo.matchProviderMappings.insert({
      schema_version: 1, match_id: match.match_id, provider: Provider.OpenFoot, provider_match_id: "1199101", created_at: NOW, updated_at: NOW,
    });
    await repo.matchProviderMappings.insert({
      schema_version: 1, match_id: match.match_id, provider: Provider.FiveDollar, provider_match_id: "1199102", created_at: NOW, updated_at: NOW,
    });

    const service = new ProviderFixtureSyncService(repo);
    const ofCanc = makeFixture("1199101", "CANC", undefined, Provider.OpenFoot);
    ofCanc.league.id = "comp_premier_league_eng";
    expect(await service.applyFixture(ofCanc, {}, NOW)).toMatchObject({ kind: "unchanged", ignored: true });

    const ofLive = makeFixture("1199101", "1H", undefined, Provider.OpenFoot);
    ofLive.league.id = "comp_premier_league_eng";
    expect(await service.applyFixture(ofLive, {}, NOW)).toMatchObject({ kind: "unchanged", ignored: true });

    const fiveDLaggingLive = makeFixture("1199102", "1H", undefined, Provider.FiveDollar);
    fiveDLaggingLive.league.id = "4160026622";
    expect(await service.applyFixtureForJob(fiveDLaggingLive, {}, NOW, undefined, SyncJobType.PostFinishVerify))
      .toMatchObject({ kind: "unchanged", ignored: true });

    expect(await repo.matches.findById(match.match_id)).toMatchObject({ match_status: MatchStatus.Finished });
    expect(await repo.anomalies.findOpenBlockingByMatch(match.match_id)).toEqual([]);
  });

  it("5d ±180d 越界告警保留日志、快照与非阻塞异常；Admin 终果不被 ProviderResultConflict 锁死 (A-S3-14)", async () => {
    const repo = new InMemoryRepository();
    const outOfBufferMatch = makeMatch({
      kickoff_at: new Date("2028-06-01T12:00:00.000Z"),
    });
    await seedMatch(repo, outOfBufferMatch, "1199200", Provider.FiveDollar);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const fiveDFixture = makeFixture("1199200", "1H", undefined, Provider.FiveDollar);
      fiveDFixture.league.id = "4160026622";
      fiveDFixture.fixture.date = "2028-06-01T12:00:00.000Z";
      fiveDFixture.fixture.timestamp = Date.parse("2028-06-01T12:00:00.000Z") / 1000;
      const service = new ProviderFixtureSyncService(repo);
      await expect(service.applyFixture(fiveDFixture, { fixture: fiveDFixture }, NOW))
        .resolves.toMatchObject({ kind: "applied", match_id: outOfBufferMatch.match_id });

      expect(warn).toHaveBeenCalledWith(
        "[provider_fixture_mapper_warning]",
        expect.objectContaining({ provider: "5dollar", provider_match_id: "1199200" }),
      );
      expect(await repo.anomalies.findByKey(`${outOfBufferMatch.match_id}:${AnomalyType.ProviderDataInvalid}`)).toMatchObject({
        status: AnomalyStatus.Open,
        blocking: false,
      });
      expect(await repo.providerSnapshots.findByEntity("match", outOfBufferMatch.match_id)).toEqual(
        expect.arrayContaining([expect.objectContaining({ event_type: "provider_error" })]),
      );
    } finally {
      warn.mockRestore();
    }

    // Admin 终果优先保护：上游双源分歧时不打开阻塞 ProviderResultConflict，直接收敛为非阻塞 ADMIN_PROVIDER_RESULT_CONFLICT。
    const adminMatch = makeMatch({
      match_status: MatchStatus.Finished,
      finish_detected_at: NOW,
      period_anchor_at: NOW,
      settlement_status: SettlementStatus.Waiting,
      regular_home_score: 2,
      regular_away_score: 0,
      result_version: 1,
      result_source: ResultSource.Admin,
    });
    await seedMatch(repo, adminMatch, "1199300", Provider.FootballData);
    await repo.matchResults.insert({
      schema_version: 1, match_id: adminMatch.match_id, result_version: 1,
      regular_home_score: 2, regular_away_score: 0, source: ResultSource.Admin,
      provider_status: null, admin_id: "admin-1", reason: "official", created_at: NOW,
    });
    await repo.matchProviderMappings.insert({
      schema_version: 1, match_id: adminMatch.match_id, provider: Provider.FiveDollar,
      provider_match_id: "1199301", created_at: NOW, updated_at: NOW,
    });
    const service = new ProviderFixtureSyncService(repo);
    const fdRes = makeFixture("1199300", "FT", { home: 1, away: 0 }, Provider.FootballData);
    const fiveDRes = makeFixture("1199301", "FT", { home: 0, away: 0 }, Provider.FiveDollar);
    fiveDRes.league.id = "4160026622";

    expect(await service.applyFixture(fdRes, { fixture: fdRes }, NOW))
      .toMatchObject({ kind: "conflict", anomaly_type: AnomalyType.AdminProviderResultConflict });
    expect(await service.applyFixture(fiveDRes, { fixture: fiveDRes }, NOW))
      .toMatchObject({ kind: "conflict", anomaly_type: AnomalyType.AdminProviderResultConflict });
    expect(await repo.matches.findById(adminMatch.match_id)).toMatchObject({
      regular_home_score: 2,
      regular_away_score: 0,
      result_source: ResultSource.Admin,
    });
    expect(await repo.anomalies.findOpenBlockingByMatch(adminMatch.match_id)).toEqual([]);
  });

  it("[CR-08] 非权威副源 entityFailed 不得修改 matches 状态或打开 blocking: true 异常", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch({
      match_status: MatchStatus.Scheduled,
      settlement_status: SettlementStatus.Pending,
    });
    await seedMatch(repo, match, "500001", Provider.FiveDollar);

    const badFiveDFixture = makeFixture("500001", "FT", { home: null, away: null }, Provider.FiveDollar);
    badFiveDFixture.league.id = "4160026622";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const outcome = await new ProviderFixtureSyncService(repo).applyFixture(
        badFiveDFixture,
        { fixture: badFiveDFixture },
        NOW,
      );
      expect(outcome).toMatchObject({ kind: "failed", match_id: match.match_id });
    } finally {
      warn.mockRestore();
    }

    expect(await repo.matches.findById(match.match_id)).toMatchObject({
      match_status: MatchStatus.Scheduled,
      settlement_status: SettlementStatus.Pending,
    });
    expect(await repo.anomalies.findOpenBlockingByMatch(match.match_id)).toEqual([]);
    expect(await repo.providerSnapshots.findByEntity("match", match.match_id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ event_type: "provider_error", provider: Provider.FiveDollar })]),
    );
  });

  it("[CR-21] applyAdoptableResult 冲突清空 compared_providers 使用 findByIdForUpdate 与 patchFields", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch({
      match_status: MatchStatus.Finished,
      finish_detected_at: NOW,
      period_anchor_at: NOW,
      settlement_status: SettlementStatus.Waiting,
      compared_providers: [Provider.FootballData, Provider.FiveDollar],
    });
    await seedMatch(repo, match, "600001", Provider.FootballData);
    await repo.providerSnapshots.insert({
      schema_version: 1,
      snapshot_id: newUuid(),
      provider: Provider.FiveDollar,
      entity_type: "match",
      entity_id: match.match_id,
      provider_entity_id: "600002",
      event_type: "result_observed",
      payload: {
        provider_result_observation: {
          provider: Provider.FiveDollar,
          status: "finished",
          score: { home: 0, away: 0 },
          raw_status: "FT",
          observed_at: NOW.toISOString(),
        },
      },
      created_at: NOW,
    });

    const ops: string[] = [];
    const origWithTx = repo.withTransaction.bind(repo);
    repo.withTransaction = ((fn: Parameters<typeof origWithTx>[0]) =>
      origWithTx(async (tx) => {
        const matches = tx.matches;
        const wrapped = new Proxy(tx, {
          get(target, prop, receiver) {
            if (prop === "matches") {
              return {
                ...matches,
                findByIdForUpdate: async (id: string) => {
                  ops.push(`lock:${id}`);
                  return matches.findByIdForUpdate!(id);
                },
                patchFields: async (id: string, fields: Record<string, unknown>) => {
                  ops.push(`patch:${id}`);
                  return matches.patchFields!(id, fields);
                },
                update: async () => {
                  ops.push("update");
                },
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        return fn(wrapped);
      })) as typeof repo.withTransaction;

    const fdFixture = makeFixture("600001", "FT", { home: 2, away: 1 }, Provider.FootballData);
    await new ProviderFixtureSyncService(repo).applyFixture(fdFixture, { fixture: fdFixture }, NOW);

    expect(ops).toContain(`lock:${match.match_id}`);
    expect(ops).toContain(`patch:${match.match_id}`);
    expect(ops).not.toContain("update");
    expect((await repo.matches.findById(match.match_id))?.compared_providers).toEqual([]);
  });
});
