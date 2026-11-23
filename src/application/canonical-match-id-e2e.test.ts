import { describe, expect, it } from "vitest";
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import {
  MatchScoreValue,
  MatchStatus,
  PeriodType,
  Result,
  SettlementItemStatus,
  SettlementStatus,
  UserStatus,
} from "../domain/enums.js";
import { calculatePeriodKey, levelSeasonOf } from "../domain/time.js";
import type { Match, MatchResult, Team, User } from "../domain/types.js";
import { defaultLevelState } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { DailyConsistencyService } from "./daily-consistency-service.js";
import { RepositoryDailyConsistencySnapshotSource } from "./daily-consistency-snapshot.js";
import { CrowdQueryService } from "./crowd-query.js";
import { MatchQueryService } from "./match-query.js";
import { PredictionHistoryQueryService, PredictionQueryService } from "./prediction-query.js";
import { PredictionService } from "./predictions.js";
import { SettlementOrchestrationService } from "./settlement-orchestration-service.js";
import { ShareCardQueryService } from "./share-card.js";
import { RebuildUserStatsService } from "./stats-rebuild-service.js";

const USER_1_ID = "11111111-1111-4111-8111-111111111111";
const USER_2_ID = "22222222-2222-4222-8222-222222222222";
const HOME_TEAM_ID = "33333333-3333-4333-8333-333333333333";
const AWAY_TEAM_ID = "44444444-4444-4444-8444-444444444444";
const M_OLD_ID = "55555555-5555-4555-8555-555555555555";
const M_NEW_ID = "66666666-6666-4666-8666-666666666666";

const SUBMIT_AT = new Date("2026-08-08T10:00:00.000Z");
const KICKOFF_AT = new Date("2026-08-09T14:00:00.000Z");
const DEADLINE_AT = new Date("2026-08-09T13:50:00.000Z");
const FINISH_AT = new Date("2026-08-09T16:00:00.000Z");
const SETTLE_AT = new Date("2026-08-09T16:15:00.000Z");
const FIRST_EVAL = new Date("2026-08-03T02:00:00.000Z");

function makeUser(userId: string, openid: string): User {
  return {
    schema_version: 1,
    user_id: userId,
    openid,
    unionid: null,
    nickname: openid,
    favorite_team_id: null,
    status: UserStatus.Active,
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_level: 1,
    career_best_level: 1,
    career_last_scoring_match_at: null,
    career_level_state: defaultLevelState(),
    deleted_at: null,
    created_at: SUBMIT_AT,
    updated_at: SUBMIT_AT,
  };
}

function makeTeam(teamId: string, name: string): Team {
  return {
    schema_version: 1,
    team_id: teamId,
    league_id: "premier_league",
    name,
    short_name: name,
    primary_color: "#ff0000",
    secondary_color: "#ffffff",
    status: "active",
    created_at: SUBMIT_AT,
    updated_at: SUBMIT_AT,
  };
}

function makeMatch(matchId: string, overrides: Partial<Match> = {}): Match {
  return {
    schema_version: 1,
    match_id: matchId,
    canonical_match_id: matchId,
    superseded_by: null,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: HOME_TEAM_ID,
    away_team_id: AWAY_TEAM_ID,
    kickoff_at: KICKOFF_AT,
    kickoff_confirmed: true,
    prediction_deadline_at: DEADLINE_AT,
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
    created_at: SUBMIT_AT,
    updated_at: SUBMIT_AT,
    ...overrides,
  };
}

describe("Slice 3 E2E: canonical_match_id across list, detail, settlement, rebuild, and consistency", () => {
  it("carries prediction P1 from superseded M_old through M_new query and first settlement", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser(USER_1_ID, "openid-u1"));
    await repo.users.insert(makeUser(USER_2_ID, "openid-u2"));
    await repo.teams.insert(makeTeam(HOME_TEAM_ID, "Arsenal"));
    await repo.teams.insert(makeTeam(AWAY_TEAM_ID, "Chelsea"));

    // 1. Insert M_old and submit prediction P1 (2-1) on M_old
    const mOld = makeMatch(M_OLD_ID);
    await repo.matches.insert(mOld);

    const predictionService = new PredictionService(repo);
    const submitted = await predictionService.submit(
      USER_1_ID,
      {
        match_id: M_OLD_ID,
        home_score: 2,
        away_score: 1,
        idempotency_key: "77777777-7777-4777-8777-777777777777",
      },
      SUBMIT_AT,
    );
    expect(submitted.created).toBe(true);
    const p1 = submitted.prediction;
    expect(p1.match_id).toBe(M_OLD_ID);
    expect(p1.canonical_match_id).toBe(M_OLD_ID);

    // 2. Provider ID change merges into M_new (same canonical_match_id, M_old.superseded_by = M_new)
    // Mark M_old as postponed with null scores (matching real provider postponement/re-ID flow)
    const mNew = makeMatch(M_NEW_ID, {
      canonical_match_id: M_OLD_ID,
      superseded_by: null,
    });
    await repo.matches.insert(mNew);
    await repo.matches.update({
      ...mOld,
      match_status: MatchStatus.Postponed,
      superseded_by: M_NEW_ID,
      updated_at: new Date(SUBMIT_AT.getTime() + 60_000),
    });

    // 3. GET /v1/matches hides M_old and shows only M_new
    const matchQuery = new MatchQueryService(repo, "slice3-cursor-secret");
    const listResult = await matchQuery.list({
      from: null,
      to: null,
      status: null,
      limit: 20,
      cursor: null,
      server_now: SUBMIT_AT,
      authenticated_user_id: USER_1_ID,
    });
    expect(listResult.items.map((item) => item.match_id)).toEqual([M_NEW_ID]);
    expect(listResult.items[0]).toMatchObject({
      match_id: M_NEW_ID,
      can_predict: false,
      can_predict_reason: "ALREADY_SUBMITTED",
    });

    // 4. GET /v1/matches/M_new returns my_prediction = P1, can_predict = false, ALREADY_SUBMITTED
    const newDetail = await matchQuery.get(M_NEW_ID, USER_1_ID, SUBMIT_AT);
    expect(newDetail).toMatchObject({
      match_id: M_NEW_ID,
      can_predict: false,
      can_predict_reason: "ALREADY_SUBMITTED",
      my_prediction: {
        prediction_id: p1.prediction_id,
        pred_home_score: 2,
        pred_away_score: 1,
        derived_result: Result.Home,
      },
    });

    // Historical GET /v1/matches/M_old does not 404, keeps my_prediction = P1, and never allows predicting
    const oldDetailU1 = await matchQuery.get(M_OLD_ID, USER_1_ID, SUBMIT_AT);
    expect(oldDetailU1).toMatchObject({
      match_id: M_OLD_ID,
      can_predict: false,
      can_predict_reason: "ALREADY_SUBMITTED",
      my_prediction: { prediction_id: p1.prediction_id },
    });
    const oldDetailU2 = await matchQuery.get(M_OLD_ID, USER_2_ID, SUBMIT_AT);
    expect(oldDetailU2).toMatchObject({
      match_id: M_OLD_ID,
      can_predict: false,
      can_predict_reason: "NOT_SCHEDULED",
      my_prediction: null,
    });

    // 5. M_new finishes and triggers first settlement -> settles P1 and updates user stats & rankings
    const finishedMNew: Match = {
      ...mNew,
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Waiting,
      prediction_closed_at: DEADLINE_AT,
      period_anchor_at: KICKOFF_AT,
      regular_home_score: 2,
      regular_away_score: 1,
      result_version: 1,
      result_source: "provider",
      finish_detected_at: FINISH_AT,
      updated_at: FINISH_AT,
    };
    await repo.matches.update(finishedMNew);
    const matchResult: MatchResult = {
      schema_version: 1,
      match_id: M_NEW_ID,
      result_version: 1,
      regular_home_score: 2,
      regular_away_score: 1,
      source: "provider",
      provider_status: "FT",
      admin_id: null,
      reason: null,
      created_at: FINISH_AT,
    };
    await repo.matchResults.insert(matchResult);

    const settlementOutcome = await new SettlementOrchestrationService(repo).startFirst(
      M_NEW_ID,
      SETTLE_AT,
      false,
    );
    expect(settlementOutcome.kind).toBe("started");

    const settlements = await repo.settlements.findByMatch(M_NEW_ID);
    expect(settlements).toHaveLength(1);
    const items = await repo.settlementItems.findBySettlement(settlements[0]!.settlement_id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      prediction_id: p1.prediction_id,
      user_id: USER_1_ID,
      new_score: MatchScoreValue.ExactHit,
      score_delta: 12,
      status: SettlementItemStatus.Applied,
    });

    expect(await repo.predictions.findById(p1.prediction_id)).toMatchObject({
      applied_result_version: 1,
      match_score: 12,
      wdl_hit: true,
      exact_hit: true,
    });
    expect(await repo.users.findById(USER_1_ID)).toMatchObject({
      career_points: 12,
      career_valid_predictions: 1,
      career_wdl_hits: 1,
      career_exact_hits: 1,
    });
    expect(
      await repo.userSeasonStats.findByUserAndSeason(USER_1_ID, levelSeasonOf(KICKOFF_AT)),
    ).toMatchObject({
      points: 12,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
    });
    const weekKey = calculatePeriodKey(PeriodType.Week, KICKOFF_AT);
    expect(
      await repo.rankings.findByPeriodAndUser(PeriodType.Week, weekKey, USER_1_ID),
    ).toMatchObject({
      period_score: 12,
      valid_predictions: 1,
      exact_hits: 1,
      global_rank: 1,
    });

    // Verify PredictionQueryService, PredictionHistoryQueryService, ShareCardQueryService, and CrowdQueryService
    const predDetail = await new PredictionQueryService(repo).getMyPrediction(
      USER_1_ID,
      p1.prediction_id,
    );
    expect(predDetail).toMatchObject({
      prediction_id: p1.prediction_id,
      match_id: M_NEW_ID,
      match_status: MatchStatus.Finished,
      regular_home_score: 2,
      regular_away_score: 1,
      match_score: 12,
      wdl_hit: true,
      exact_hit: true,
    });

    const predHistory = await new PredictionHistoryQueryService(
      repo,
      "slice3-history-secret",
    ).listMyPredictions(USER_1_ID, {
      league_id: "premier_league",
      season_id: "2026_2027",
      limit: 20,
      cursor: null,
    });
    expect(predHistory.items).toHaveLength(1);
    expect(predHistory.items[0]).toMatchObject({
      prediction_id: p1.prediction_id,
      match_id: M_NEW_ID,
      match_status: MatchStatus.Finished,
      regular_home_score: 2,
      regular_away_score: 1,
      match_score: 12,
      wdl_hit: true,
      exact_hit: true,
    });

    const shareCard = await new ShareCardQueryService(repo).getShareCard(
      USER_1_ID,
      { league_id: "premier_league", season_id: "2026_2027", round_id: "01" },
      SETTLE_AT,
    );
    expect(shareCard).toMatchObject({
      round_predictions: 1,
      round_wdl_hits: 1,
      round_exact_hits: 1,
      round_score: 12,
      career_points: 12,
    });

    // Seed remaining predictions on M_old (canonical = M_OLD_ID) to reach CROWD_MIN_PREDICTIONS
    // and verify CrowdQueryService on M_NEW_ID counts all predictions across canonical_match_id
    for (let i = 0; i < FIXED_CONFIG_V1.CROWD_MIN_PREDICTIONS - 1; i += 1) {
      const suffix = String(i).padStart(2, "0");
      const uid = `99999999-9999-4999-8999-9999999999${suffix}`;
      await repo.users.insert(makeUser(uid, `openid-crowd-${suffix}`));
      await repo.predictions.insert({
        ...p1,
        prediction_id: `88888888-8888-4888-8888-8888888888${suffix}`,
        user_id: uid,
        match_id: M_OLD_ID,
        canonical_match_id: M_OLD_ID,
        idempotency_key: `77777777-7777-4777-8777-7777777777${suffix}`,
      });
    }
    const crowd = await new CrowdQueryService(repo).get({
      authenticated_user_id: USER_1_ID,
      match_id: M_NEW_ID,
      server_now: SETTLE_AT,
    });
    expect(crowd).toMatchObject({
      match_id: M_NEW_ID,
      status: "available",
      distribution: { home: 100, draw: 0, away: 0 },
    });

    // Verify rebuild and daily consistency also accept P1 settled under M_new
    const rebuilt = await new RebuildUserStatsService(repo, FIRST_EVAL).rebuildUserStats(
      USER_1_ID,
      SETTLE_AT,
    );
    expect(rebuilt.user).toMatchObject({
      career_points: 12,
      career_valid_predictions: 1,
      career_exact_hits: 1,
    });
    const consistency = await new DailyConsistencyService(
      repo,
      new RepositoryDailyConsistencySnapshotSource(repo, FIRST_EVAL),
      FIRST_EVAL,
    ).run(SETTLE_AT);
    expect(consistency.kind).toBe("completed");
    if (consistency.kind === "completed") {
      expect(consistency.differences).toEqual([]);
    }
  });
});
