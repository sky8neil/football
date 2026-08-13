import { describe, expect, it, vi } from "vitest";
import { Provider, ResultSource, SettlementStatus, MatchStatus, AnomalyStatus, AnomalyType } from "../domain/enums.js";
import type { Match, MatchProviderMapping, MatchResult } from "../domain/types.js";
import { newUuid } from "../domain/ids.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";
import type { NormalizedFixture } from "../provider/fixture-mapper.js";
import { ProviderResultSyncService } from "./provider-result-sync.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const MATCH_ID = "00000000-0000-4000-8000-000000000010";
const PROVIDER_MATCH_ID = "1100001";
const ADMIN_ID = "00000000-0000-4000-8000-000000000099";

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    schema_version: 1,
    match_id: MATCH_ID,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: newUuid(),
    away_team_id: newUuid(),
    kickoff_at: new Date("2026-08-08T14:00:00.000Z"),
    kickoff_confirmed: true,
    prediction_deadline_at: new Date("2026-08-08T13:50:00.000Z"),
    prediction_closed_at: null,
    period_anchor_at: new Date("2026-08-08T14:00:00.000Z"),
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

function makeProviderMapping(): MatchProviderMapping {
  return {
    schema_version: 1,
    match_id: MATCH_ID,
    provider: Provider.ApiFootball,
    provider_match_id: PROVIDER_MATCH_ID,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeFixture(overrides: Partial<NormalizedFixture> = {}): NormalizedFixture {
  return {
    providerMatchId: PROVIDER_MATCH_ID,
    leagueProviderId: "39",
    season: "2026",
    round: "Round 1",
    homeTeamProviderId: "40",
    awayTeamProviderId: "41",
    kickoffAt: new Date("2026-08-08T14:00:00.000Z"),
    kickoffConfirmed: true,
    kickoffDeltaMs: 0,
    status: { kind: "finished" },
    fulltime: { home: 2, away: 1 },
    rawStatus: "FT",
    ...overrides,
  };
}

function makeResult(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    schema_version: 1,
    match_id: MATCH_ID,
    result_version: 1,
    regular_home_score: 2,
    regular_away_score: 1,
    source: ResultSource.Provider,
    provider_status: "FT",
    admin_id: null,
    reason: null,
    created_at: NOW,
    ...overrides,
  };
}

async function setup(
  matchOverrides: Partial<Match> = {},
  result?: MatchResult,
): Promise<InMemoryRepository> {
  const repo = new InMemoryRepository();
  await repo.matches.insert(makeMatch(matchOverrides));
  await repo.matchProviderMappings.insert(makeProviderMapping());
  if (result !== undefined) {
    await repo.matchResults.insert(result);
  }
  return repo;
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

describe("ProviderResultSyncService", () => {
  it("无效 server_now 在事务和 Provider 事实写入前 Fail Closed", async () => {
    const repo = await setup();
    const transactionSpy = vi.spyOn(repo, "withTransaction");

    await expect(
      new ProviderResultSyncService(repo).applyFinishedFixture(
        makeFixture(),
        {},
        new Date("invalid"),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "server_now" },
    });

    expect(transactionSpy).not.toHaveBeenCalled();
    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      match_status: MatchStatus.Scheduled,
      result_version: 0,
      regular_home_score: null,
      regular_away_score: null,
    });
    await expect(repo.matchResults.findLatestByMatch(MATCH_ID)).resolves.toBeNull();
    await expect(repo.providerSnapshots.findByEntity("match", MATCH_ID)).resolves.toEqual([]);
  });

  it("合法 FT 首次写入 immutable v1，并将比赛置为 finished/waiting", async () => {
    const repo = await setup();
    const payload = { fixture: { id: Number(PROVIDER_MATCH_ID) }, score: { fulltime: { home: 2, away: 1 } } };

    const outcome = await new ProviderResultSyncService(repo).applyFinishedFixture(
      makeFixture(),
      payload,
      NOW,
    );

    expect(outcome).toEqual({
      kind: "applied",
      match_id: MATCH_ID,
      result_version: 1,
      settlement_status: SettlementStatus.Waiting,
    });
    expect(await repo.matches.findById(MATCH_ID)).toMatchObject({
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Waiting,
      regular_home_score: 2,
      regular_away_score: 1,
      result_version: 1,
      result_source: ResultSource.Provider,
      prediction_closed_at: NOW,
      finish_detected_at: NOW,
    });
    expect(await repo.matchResults.findByMatchAndVersion(MATCH_ID, 1)).toMatchObject({
      source: ResultSource.Provider,
      regular_home_score: 2,
      regular_away_score: 1,
      provider_status: "FT",
    });
    expect(await repo.providerSnapshots.findByEntity("match", MATCH_ID)).toEqual([
      expect.objectContaining({
        provider_entity_id: PROVIDER_MATCH_ID,
        event_type: "result_observed",
        payload,
      }),
    ]);
  });

  it("首次 FT 的 settlement_status 变化必须经过既有 transition repository 入口", async () => {
    const repo = await setup();
    const writes: Array<{
      kind: "update" | "updateSettlementStatus";
      value: Partial<Match>;
    }> = [];

    const outcome = await new ProviderResultSyncService(
      withSettlementWriteGuard(repo, writes),
    ).applyFinishedFixture(makeFixture(), {}, NOW);

    expect(outcome).toMatchObject({ settlement_status: SettlementStatus.Waiting });
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

  it("合法 FT 观察到有效比分后 resolve 既有 INVALID_FINAL_SCORE anomaly", async () => {
    const repo = await setup();
    await repo.anomalies.insert({
      schema_version: 1,
      anomaly_id: newUuid(),
      anomaly_key: `${MATCH_ID}:${AnomalyType.InvalidFinalScore}`,
      match_id: MATCH_ID,
      type: AnomalyType.InvalidFinalScore,
      blocking: true,
      status: AnomalyStatus.Open,
      first_seen_at: new Date(NOW.getTime() - 60_000),
      last_seen_at: new Date(NOW.getTime() - 60_000),
      occurrence_count: 1,
      details: { fulltimeHome: null, fulltimeAway: null },
      resolved_at: null,
      resolution: null,
    });

    await new ProviderResultSyncService(repo).applyFinishedFixture(
      makeFixture(),
      {},
      NOW,
    );

    await expect(
      repo.anomalies.findByKey(`${MATCH_ID}:${AnomalyType.InvalidFinalScore}`),
    ).resolves.toMatchObject({
      status: AnomalyStatus.Resolved,
      blocking: true,
      resolved_at: NOW,
      resolution: "provider_valid_final_score",
    });
  });

  it("错过 live 轮询而直接发现 FT 时按 kickoff_at 初始化 period_anchor_at", async () => {
    const repo = await setup({ period_anchor_at: null });

    await new ProviderResultSyncService(repo).applyFinishedFixture(
      makeFixture(),
      {},
      NOW,
    );

    const match = await repo.matches.findById(MATCH_ID);
    expect(match?.period_anchor_at).toEqual(match?.kickoff_at);
  });

  it("重复相同 Provider 正式比分不创建新 result_version", async () => {
    const repo = await setup();
    const service = new ProviderResultSyncService(repo);

    await service.applyFinishedFixture(makeFixture(), {}, NOW);
    const outcome = await service.applyFinishedFixture(makeFixture(), {}, new Date(NOW.getTime() + 60_000));

    expect(outcome).toMatchObject({
      kind: "unchanged",
      match_id: MATCH_ID,
      result_version: 1,
    });
    expect(await repo.matchResults.findLatestByMatch(MATCH_ID)).toMatchObject({ result_version: 1 });
    expect(await repo.matchResults.findByMatchAndVersion(MATCH_ID, 2)).toBeNull();
  });

  it("Provider 赛果变化在已结算比赛上追加下一版本并进入 correcting", async () => {
    const repo = await setup(
      {
        match_status: MatchStatus.Finished,
        settlement_status: SettlementStatus.Settled,
        regular_home_score: 2,
        regular_away_score: 1,
        result_version: 1,
        settled_result_version: 1,
        result_source: ResultSource.Provider,
        prediction_closed_at: NOW,
        finish_detected_at: NOW,
        settled_at: NOW,
      },
      makeResult(),
    );

    const outcome = await new ProviderResultSyncService(repo).applyFinishedFixture(
      makeFixture({ fulltime: { home: 1, away: 1 } }),
      { changed: true },
      new Date(NOW.getTime() + 60_000),
    );

    expect(outcome).toEqual({
      kind: "applied",
      match_id: MATCH_ID,
      result_version: 2,
      settlement_status: SettlementStatus.Correcting,
    });
    expect(await repo.matchResults.findByMatchAndVersion(MATCH_ID, 1)).toEqual(makeResult());
    expect(await repo.matchResults.findByMatchAndVersion(MATCH_ID, 2)).toMatchObject({
      regular_home_score: 1,
      regular_away_score: 1,
      source: ResultSource.Provider,
    });
    expect(await repo.matches.findById(MATCH_ID)).toMatchObject({
      settlement_status: SettlementStatus.Correcting,
      result_version: 2,
      settled_result_version: 1,
      regular_home_score: 1,
      regular_away_score: 1,
    });
  });

  it("管理员正式结果优先：Provider 不覆盖，只记录 conflict snapshot/anomaly", async () => {
    const repo = await setup(
      {
        match_status: MatchStatus.Finished,
        settlement_status: SettlementStatus.Settled,
        regular_home_score: 2,
        regular_away_score: 1,
        result_version: 1,
        settled_result_version: 1,
        result_source: ResultSource.Admin,
        prediction_closed_at: NOW,
        finish_detected_at: NOW,
        settled_at: NOW,
      },
      makeResult({ source: ResultSource.Admin, admin_id: ADMIN_ID, reason: "manual correction" }),
    );

    const outcome = await new ProviderResultSyncService(repo).applyFinishedFixture(
      makeFixture({ fulltime: { home: 1, away: 1 } }),
      { changed: true },
      new Date(NOW.getTime() + 60_000),
    );

    expect(outcome).toMatchObject({ kind: "conflict", match_id: MATCH_ID, result_version: 1 });
    expect(await repo.matchResults.findByMatchAndVersion(MATCH_ID, 2)).toBeNull();
    expect(await repo.matches.findById(MATCH_ID)).toMatchObject({
      result_version: 1,
      result_source: ResultSource.Admin,
      regular_home_score: 2,
      regular_away_score: 1,
      settlement_status: SettlementStatus.Settled,
    });
    expect(await repo.anomalies.findByKey(`${MATCH_ID}:${AnomalyType.AdminProviderResultConflict}`)).toMatchObject({
      type: AnomalyType.AdminProviderResultConflict,
      status: AnomalyStatus.Open,
    });
    expect(await repo.providerSnapshots.findByEntity("match", MATCH_ID)).toEqual([
      expect.objectContaining({ event_type: "provider_conflict", payload: { changed: true } }),
    ]);
  });
});
