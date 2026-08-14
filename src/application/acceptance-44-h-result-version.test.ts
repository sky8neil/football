/**
 * 第 44 节 H. result_version 验收矩阵（H53-H59）。
 *
 * 覆盖规范第 12 节 result_version 与 match_results 不可变账本语义：
 * - H53 初始 result_version=0
 * - H54 首次正式比分 => 1
 * - H55 重复相同比分不增加 version
 * - H56 2:1 -> 1:1 => version +1
 * - H57 v1/v2/v3 match_results 均永久存在
 * - H58 waiting 内 v1->v2->v3，首次 settlement 可直接结算 v3
 * - H59 v1 settlement 已开始后 v2/v3 必须顺序处理
 */
import { describe, expect, it } from "vitest";
import {
  AnomalyStatus,
  MatchStatus,
  Provider,
  Result,
  ResultSource,
  SettlementDocStatus,
  SettlementStatus,
} from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { Match, MatchProviderMapping, MatchResult } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import type { NormalizedFixture } from "../provider/fixture-mapper.js";
import { ProviderResultSyncService } from "./provider-result-sync.js";
import { FirstSettlementService } from "./first-settlement-service.js";
import { CorrectionSettlementService } from "./correction-settlement-service.js";
import {
  createAtomicSettlementItemWorker,
  SettlementItemApplicationService,
} from "./settlement-item-application-service.js";
import { continuePendingCorrections } from "./settlement-orchestration-service.js";
import { nextSettlementVersion } from "./result-correction-plan.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const TEN_MINUTES_MS = 10 * 60 * 1000;
const MATCH_ID = "00000000-0000-4000-8000-000000000053";
const PROVIDER_MATCH_ID = "4400053";

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

function makeFixture(fulltime: { home: number; away: number }): NormalizedFixture {
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
    fulltime,
    rawStatus: "FT",
  };
}

async function setup(match: Match = makeMatch()): Promise<InMemoryRepository> {
  const repo = new InMemoryRepository();
  await repo.matches.insert(match);
  await repo.matchProviderMappings.insert(makeProviderMapping());
  return repo;
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

describe("H. result_version（规范 44-H / 12）", () => {
  it("H53 初始 result_version=0", async () => {
    const repo = await setup();
    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      result_version: 0,
      settled_result_version: 0,
      regular_home_score: null,
      regular_away_score: null,
      result_source: null,
    });
    await expect(repo.matchResults.findLatestByMatch(MATCH_ID)).resolves.toBeNull();
  });

  it("H54 首次正式比分 => 1", async () => {
    const repo = await setup();
    const outcome = await new ProviderResultSyncService(repo).applyFinishedFixture(
      makeFixture({ home: 2, away: 1 }),
      {},
      NOW,
    );

    expect(outcome).toMatchObject({ kind: "applied", result_version: 1 });
    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Waiting,
      result_version: 1,
      regular_home_score: 2,
      regular_away_score: 1,
    });
    await expect(repo.matchResults.findByMatchAndVersion(MATCH_ID, 1)).resolves.toMatchObject({
      result_version: 1,
      regular_home_score: 2,
      regular_away_score: 1,
    });
  });

  it("H55 重复相同比分不增加 version", async () => {
    const repo = await setup();
    const service = new ProviderResultSyncService(repo);
    await service.applyFinishedFixture(makeFixture({ home: 2, away: 1 }), {}, NOW);
    const outcome = await service.applyFinishedFixture(
      makeFixture({ home: 2, away: 1 }),
      {},
      new Date(NOW.getTime() + 60_000),
    );

    expect(outcome).toMatchObject({ kind: "unchanged", result_version: 1 });
    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({ result_version: 1 });
    await expect(repo.matchResults.findLatestByMatch(MATCH_ID)).resolves.toMatchObject({
      result_version: 1,
    });
    await expect(repo.matchResults.findByMatchAndVersion(MATCH_ID, 2)).resolves.toBeNull();
  });

  it("H56 2:1 -> 1:1 => version +1", async () => {
    const repo = await setup();
    const service = new ProviderResultSyncService(repo);
    await service.applyFinishedFixture(makeFixture({ home: 2, away: 1 }), {}, NOW);
    const outcome = await service.applyFinishedFixture(
      makeFixture({ home: 1, away: 1 }),
      {},
      new Date(NOW.getTime() + 60_000),
    );

    expect(outcome).toMatchObject({ kind: "applied", result_version: 2 });
    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      result_version: 2,
      regular_home_score: 1,
      regular_away_score: 1,
      settlement_status: SettlementStatus.Waiting,
    });
    await expect(repo.matchResults.findByMatchAndVersion(MATCH_ID, 2)).resolves.toMatchObject({
      result_version: 2,
      regular_home_score: 1,
      regular_away_score: 1,
    });
  });

  it("H57 v1/v2/v3 match_results 均永久存在", async () => {
    const repo = await setup();
    const service = new ProviderResultSyncService(repo);
    await service.applyFinishedFixture(makeFixture({ home: 2, away: 1 }), {}, NOW);
    await service.applyFinishedFixture(
      makeFixture({ home: 1, away: 1 }),
      {},
      new Date(NOW.getTime() + 60_000),
    );
    await service.applyFinishedFixture(
      makeFixture({ home: 0, away: 1 }),
      {},
      new Date(NOW.getTime() + 120_000),
    );

    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({ result_version: 3 });
    await expect(repo.matchResults.findByMatchAndVersion(MATCH_ID, 1)).resolves.toMatchObject({
      result_version: 1,
      regular_home_score: 2,
      regular_away_score: 1,
    });
    await expect(repo.matchResults.findByMatchAndVersion(MATCH_ID, 2)).resolves.toMatchObject({
      result_version: 2,
      regular_home_score: 1,
      regular_away_score: 1,
    });
    await expect(repo.matchResults.findByMatchAndVersion(MATCH_ID, 3)).resolves.toMatchObject({
      result_version: 3,
      regular_home_score: 0,
      regular_away_score: 1,
    });

    // 账本不可覆盖：已存在版本的再次写入被唯一约束拒绝，历史版本保持不变。
    await expect(
      repo.matchResults.insert(
        makeResult({ result_version: 1, regular_home_score: 9, regular_away_score: 9 }),
      ),
    ).rejects.toMatchObject({ name: "UniqueConstraintError" });
    await expect(repo.matchResults.findByMatchAndVersion(MATCH_ID, 1)).resolves.toMatchObject({
      regular_home_score: 2,
      regular_away_score: 1,
    });
  });

  it("H58 waiting 内 v1->v2->v3，带 prediction + 原子 worker 的首次 settlement 可直接结算 v3", async () => {
    const waiting = makeMatch({
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Waiting,
      regular_home_score: 0,
      regular_away_score: 1,
      result_version: 3,
      prediction_closed_at: NOW,
      finish_detected_at: new Date(NOW.getTime() - TEN_MINUTES_MS),
    });
    const repo = await setup(waiting);
    await repo.matchResults.insert(makeResult({ result_version: 1, regular_home_score: 2, regular_away_score: 1 }));
    await repo.matchResults.insert(makeResult({ result_version: 2, regular_home_score: 1, regular_away_score: 1 }));
    await repo.matchResults.insert(makeResult({ result_version: 3, regular_home_score: 0, regular_away_score: 1 }));

    const userId = newUuid();
    await repo.users.insert({
      schema_version: 1,
      user_id: userId,
      openid: "openid_h58",
      unionid: null,
      nickname: "H58",
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
    });
    await repo.predictions.insert({
      schema_version: 1,
      prediction_id: newUuid(),
      user_id: userId,
      match_id: MATCH_ID,
      idempotency_key: newUuid(),
      pred_home_score: 0,
      pred_away_score: 1,
      derived_result: Result.Away,
      submitted_at: NOW,
      scoring_rule_version: "scoring_v1",
      match_score: null,
      wdl_hit: null,
      exact_hit: null,
      applied_result_version: 0,
      created_at: NOW,
      updated_at: NOW,
    });

    const worker = createAtomicSettlementItemWorker(new SettlementItemApplicationService(repo));
    const service = new FirstSettlementService(repo, worker);
    const outcome = await service.start(MATCH_ID, NOW, false);

    expect(outcome).toMatchObject({ kind: "started", processed_count: 1 });
    const settlements = await repo.settlements.findByMatch(MATCH_ID);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      result_version: 3,
      status: SettlementDocStatus.Settled,
      is_correction: false,
    });
    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      settlement_status: SettlementStatus.Settled,
      settled_result_version: 3,
    });
    const applied = await repo.predictions.findByMatch(MATCH_ID);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      applied_result_version: 3,
      match_score: 12,
      wdl_hit: true,
      exact_hit: true,
    });
    expect(await repo.users.findById(userId)).toMatchObject({
      career_points: 12,
      career_valid_predictions: 1,
      career_wdl_hits: 1,
      career_exact_hits: 1,
    });
  });

  it("H59 v1 settlement 已开始后 v2/v3 必须顺序处理", async () => {
    const settled = makeMatch({
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
    });
    const repo = await setup(settled);
    await repo.matchResults.insert(
      makeResult({ result_version: 1, regular_home_score: 2, regular_away_score: 1 }),
    );
    await repo.settlements.insert({
      schema_version: 1,
      settlement_id: newUuid(),
      match_id: MATCH_ID,
      result_version: 1,
      rule_version: "scoring_v1",
      status: SettlementDocStatus.Settled,
      phase: "done",
      is_correction: false,
      started_at: NOW,
      settled_at: NOW,
      attempt_count: 1,
      last_error_code: null,
      last_error_message: null,
      created_at: NOW,
      updated_at: NOW,
    });

    // Provider 在 v1 结算后追加 v2/v3。
    const service = new ProviderResultSyncService(repo);
    await service.applyFinishedFixture(
      makeFixture({ home: 1, away: 1 }),
      {},
      new Date(NOW.getTime() + 60_000),
    );
    await service.applyFinishedFixture(
      makeFixture({ home: 0, away: 1 }),
      {},
      new Date(NOW.getTime() + 120_000),
    );
    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      settlement_status: SettlementStatus.Correcting,
      result_version: 3,
      settled_result_version: 1,
    });

    // 只能按 settled_result_version+1 顺序推进，禁止跳到最新。
    expect(nextSettlementVersion(3, 1)).toBe(2);

    const correction = new CorrectionSettlementService(repo, async () => {});
    const first = await correction.correct(MATCH_ID, new Date(NOW.getTime() + 180_000));
    expect(first).toMatchObject({ kind: "correcting", target_result_version: 2 });
    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      settlement_status: SettlementStatus.Correcting,
      settled_result_version: 2,
    });
    await expect(
      repo.settlements.findByMatchAndVersionAndRule(MATCH_ID, 2, "scoring_v1"),
    ).resolves.toMatchObject({ is_correction: true, status: SettlementDocStatus.Settled });

    const continued = await continuePendingCorrections(
      repo,
      correction,
      MATCH_ID,
      new Date(NOW.getTime() + 240_000),
    );
    expect(continued).toMatchObject({ kind: "settled", target_result_version: 3 });
    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      settlement_status: SettlementStatus.Settled,
      settled_result_version: 3,
    });
    await expect(
      repo.settlements.findByMatchAndVersionAndRule(MATCH_ID, 3, "scoring_v1"),
    ).resolves.toMatchObject({ is_correction: true, status: SettlementDocStatus.Settled });
  });
});
