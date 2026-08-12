/**
 * 第 44 节 F. 无效比赛验收矩阵（F38-F42）。
 */
import { describe, expect, it } from "vitest";
import {
  MatchStatus,
  Provider,
  SettlementStatus,
} from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { Match, MatchProviderMapping, Prediction, User } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import type { NormalizedFixture } from "../provider/fixture-mapper.js";
import { mapProviderStatus } from "../provider/status.js";
import { decideFirstSettlement } from "./first-settlement.js";
import { ProviderResultSyncService } from "./provider-result-sync.js";
import { ProviderStatusSyncService } from "./provider-status-sync.js";

const MATCH_ID = "00000000-0000-4000-8000-0000000000f1";
const PROVIDER_MATCH_ID = "44000038";
const NOW = new Date("2026-08-09T00:00:00.000Z");
const KICKOFF = new Date("2026-08-09T01:00:00.000Z");

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    schema_version: 1,
    match_id: MATCH_ID,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: newUuid(),
    away_team_id: newUuid(),
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

function makeMapping(): MatchProviderMapping {
  return {
    schema_version: 1,
    match_id: MATCH_ID,
    provider: Provider.ApiFootball,
    provider_match_id: PROVIDER_MATCH_ID,
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
    idempotency_key: newUuid(),
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

function makeFixture(overrides: Partial<NormalizedFixture> = {}): NormalizedFixture {
  return {
    providerMatchId: PROVIDER_MATCH_ID,
    leagueProviderId: "39",
    season: "2026",
    round: "Round 1",
    homeTeamProviderId: "40",
    awayTeamProviderId: "41",
    kickoffAt: KICKOFF,
    kickoffConfirmed: true,
    kickoffDeltaMs: 0,
    status: { kind: "cancelled" },
    fulltime: null,
    rawStatus: "CANC",
    ...overrides,
  };
}

async function setup(match = makeMatch()) {
  const repo = new InMemoryRepository();
  await repo.matches.insert(match);
  await repo.matchProviderMappings.insert(makeMapping());
  return {
    repo,
    status: new ProviderStatusSyncService(repo),
    result: new ProviderResultSyncService(repo),
  };
}

describe("F. 无效比赛（规范 44-F）", () => {
  it("F38 cancelled 不计分、不计有效场次，prediction 结算字段保持 null", async () => {
    const { repo, status } = await setup();
    const user = makeUser();
    await repo.users.insert(user);
    const prediction = makePrediction(user.user_id);
    await repo.predictions.insert(prediction);

    await status.applyCancelledFixture(makeFixture(), { case: "F38" }, NOW);

    const match = await repo.matches.findById(MATCH_ID);
    expect(match).toMatchObject({
      match_status: MatchStatus.Cancelled,
      settlement_status: SettlementStatus.Voided,
      result_version: 0,
      regular_home_score: null,
      regular_away_score: null,
    });
    const kept = await repo.predictions.findById(prediction.prediction_id);
    expect(kept).toMatchObject({
      prediction_id: prediction.prediction_id,
      match_score: null,
      wdl_hit: null,
      exact_hit: null,
      applied_result_version: 0,
    });
    expect(
      decideFirstSettlement({
        match_status: match!.match_status,
        settlement_status: match!.settlement_status,
        finish_detected_at: match!.finish_detected_at,
        result_version: match!.result_version,
        regular_home_score: match!.regular_home_score,
        regular_away_score: match!.regular_away_score,
        server_now: new Date(NOW.getTime() + 20 * 60 * 1000),
        has_blocking_anomaly: false,
      }),
    ).toMatchObject({ kind: "not_ready", code: "SETTLEMENT_NOT_READY" });
    expect(user.career_valid_predictions).toBe(0);
  });

  it("F39 cancelled settlement_status=voided", async () => {
    const { repo, status } = await setup();
    await status.applyCancelledFixture(makeFixture(), { case: "F39" }, NOW);
    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      match_status: MatchStatus.Cancelled,
      settlement_status: SettlementStatus.Voided,
    });
  });

  it("F40 abandoned 不结算，settlement_status 保持 pending，不写正式赛果", async () => {
    const { repo, status } = await setup();
    await status.applyAbandonedFixture(
      makeFixture({ status: { kind: "abandoned" }, rawStatus: "ABD" }),
      { case: "F40" },
      NOW,
    );
    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      match_status: MatchStatus.Abandoned,
      settlement_status: SettlementStatus.Pending,
      result_version: 0,
      regular_home_score: null,
      regular_away_score: null,
    });
    await expect(repo.matchResults.findLatestByMatch(MATCH_ID)).resolves.toBeNull();
    expect(
      decideFirstSettlement({
        match_status: MatchStatus.Abandoned,
        settlement_status: SettlementStatus.Pending,
        finish_detected_at: null,
        result_version: 0,
        regular_home_score: null,
        regular_away_score: null,
        server_now: new Date(NOW.getTime() + 20 * 60 * 1000),
        has_blocking_anomaly: false,
      }),
    ).toMatchObject({ kind: "not_ready" });
  });

  it("F41 abandoned 后 finished 可进入正常结算", async () => {
    const { repo, status, result } = await setup();
    await status.applyAbandonedFixture(
      makeFixture({ status: { kind: "abandoned" }, rawStatus: "ABD" }),
      { case: "F41-abandoned" },
      NOW,
    );

    const finishAt = new Date(NOW.getTime() + 3 * 60 * 60 * 1000);
    const outcome = await result.applyFinishedFixture(
      {
        providerMatchId: PROVIDER_MATCH_ID,
        status: { kind: "finished" },
        fulltime: { home: 1, away: 0 },
        rawStatus: "FT",
      },
      { case: "F41-finished" },
      finishAt,
    );

    expect(outcome).toMatchObject({
      kind: "applied",
      result_version: 1,
      settlement_status: SettlementStatus.Waiting,
    });
    const match = await repo.matches.findById(MATCH_ID);
    expect(match).toMatchObject({
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Waiting,
      result_version: 1,
      regular_home_score: 1,
      regular_away_score: 0,
      finish_detected_at: finishAt,
    });
    expect(
      decideFirstSettlement({
        match_status: match!.match_status,
        settlement_status: match!.settlement_status,
        finish_detected_at: match!.finish_detected_at,
        result_version: match!.result_version,
        regular_home_score: match!.regular_home_score,
        regular_away_score: match!.regular_away_score,
        server_now: new Date(finishAt.getTime() + 10 * 60 * 1000),
        has_blocking_anomaly: false,
      }),
    ).toMatchObject({ kind: "start", code: "FIRST_SETTLEMENT_START" });
  });

  it("F42 AWD/WO 被业务视为 cancelled，不计统计", async () => {
    for (const raw of ["AWD", "WO"] as const) {
      expect(mapProviderStatus(raw)).toEqual({ kind: "cancelled" });
      const localRepo = new InMemoryRepository();
      await localRepo.matches.insert(makeMatch());
      await localRepo.matchProviderMappings.insert(makeMapping());
      const localStatus = new ProviderStatusSyncService(localRepo);

      await localStatus.applyCancelledFixture(
        makeFixture({ rawStatus: raw }),
        { case: `F42-${raw}` },
        NOW,
      );
      await expect(localRepo.matches.findById(MATCH_ID)).resolves.toMatchObject({
        match_status: MatchStatus.Cancelled,
        settlement_status: SettlementStatus.Voided,
        result_version: 0,
        regular_home_score: null,
      });
      await expect(localRepo.matchResults.findLatestByMatch(MATCH_ID)).resolves.toBeNull();
    }
  });
});
