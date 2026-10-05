import { describe, expect, it } from "vitest";
import { MatchStatus, UserStatus } from "../domain/enums.js";
import type { Match, Prediction, User } from "../domain/types.js";
import { DomainError } from "../domain/errors.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { newUuid } from "../domain/ids.js";
import {
  PredictionHistoryQueryService,
  PredictionQueryService,
} from "./prediction-query.js";
import { defaultLevelState } from "../domain/types.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";
const MATCH_ID = "00000000-0000-4000-8000-000000000010";
const PREDICTION_ID = "00000000-0000-4000-8000-000000000020";
const NOW = new Date("2026-08-09T00:00:00.000Z");

function makeUser(userId: string): User {
  return {
    schema_version: 1,
    user_id: userId,
    openid: `openid-${userId}`,
    unionid: null,
    nickname: "Sky",
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
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeMatch(): Match {
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
    prediction_closed_at: new Date("2026-08-08T13:50:00.000Z"),
    period_anchor_at: new Date("2026-08-08T14:00:00.000Z"),
    match_status: MatchStatus.Finished,
    settlement_status: "settled",
    regular_home_score: 2,
    regular_away_score: 1,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 1,
    settled_result_version: 1,
    result_source: "provider",
    scoring_rule_version: "scoring_v1",
    finish_detected_at: new Date("2026-08-08T16:00:00.000Z"),
    settled_at: new Date("2026-08-08T16:20:00.000Z"),
    created_at: NOW,
    updated_at: NOW,
  };
}

function makePrediction(userId: string): Prediction {
  return {
    schema_version: 1,
    prediction_id: PREDICTION_ID,
    user_id: userId,
    match_id: MATCH_ID,
    idempotency_key: newUuid(),
    pred_home_score: 2,
    pred_away_score: 1,
    derived_result: "HOME",
    submitted_at: new Date("2026-08-08T12:00:00.000Z"),
    scoring_rule_version: "scoring_v1",
    match_score: 12,
    wdl_hit: true,
    exact_hit: true,
    applied_result_version: 1,
    created_at: NOW,
    updated_at: NOW,
  };
}

async function setup(predictionUserId = USER_ID) {
  const repo = new InMemoryRepository();
  await repo.users.insert(makeUser(USER_ID));
  await repo.users.insert(makeUser(OTHER_USER_ID));
  await repo.matches.insert(makeMatch());
  await repo.predictions.insert(makePrediction(predictionUserId));
  return repo;
}

describe("PredictionQueryService.getMyPrediction", () => {
  it("returns the user's prediction with current match result and settlement fields", async () => {
    const repo = await setup();

    await expect(new PredictionQueryService(repo).getMyPrediction(USER_ID, PREDICTION_ID))
      .resolves.toEqual({
        prediction_id: PREDICTION_ID,
        match_id: MATCH_ID,
        pred_home_score: 2,
        pred_away_score: 1,
        derived_result: "HOME",
        submitted_at: "2026-08-08T12:00:00.000Z",
        scoring_rule_version: "scoring_v1",
        match_status: "finished",
        regular_home_score: 2,
        regular_away_score: 1,
        match_score: 12,
        wdl_hit: true,
        exact_hit: true,
      });
  });

  it("returns null settlement fields without formal scores or for cancelled matches", async () => {
    const user = makeUser(USER_ID);
    const prediction = makePrediction(USER_ID);
    for (const match of [
      { ...makeMatch(), regular_home_score: null, regular_away_score: null },
      { ...makeMatch(), match_status: MatchStatus.Cancelled },
    ]) {
      const repository = {
        users: { findById: async () => user },
        predictions: { findById: async () => prediction },
        matches: { findById: async () => match },
      } as unknown as InMemoryRepository;

      await expect(new PredictionQueryService(repository).getMyPrediction(USER_ID, PREDICTION_ID))
        .resolves.toMatchObject({ match_score: null, wdl_hit: null, exact_hit: null });
    }
  });

  it("does not reveal another user's prediction", async () => {
    const repo = await setup(OTHER_USER_ID);

    await expect(
      new PredictionQueryService(repo).getMyPrediction(USER_ID, PREDICTION_ID),
    ).rejects.toMatchObject({ code: "PREDICTION_NOT_FOUND" });
  });

  it("returns the same not-found error for a missing prediction", async () => {
    const repo = await setup();

    await expect(
      new PredictionQueryService(repo).getMyPrediction(USER_ID, newUuid()),
    ).rejects.toMatchObject({ code: "PREDICTION_NOT_FOUND" });
  });

  it("rejects invalid identifiers", async () => {
    const repo = await setup();

    await expect(
      new PredictionQueryService(repo).getMyPrediction("not-a-user", PREDICTION_ID),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(
      new PredictionQueryService(repo).getMyPrediction(USER_ID, "not-a-prediction"),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("PredictionHistoryQueryService 六联赛过滤", () => {
  it("缺省返回全部联赛；league_id 过滤；season_id 仅与 league_id 同时提供", async () => {
    const repo = await setup();
    const laLigaMatchId = "00000000-0000-4000-8000-000000000013";
    const laLigaPredictionId = "00000000-0000-4000-8000-000000000023";
    await repo.matches.insert({
      ...makeMatch(),
      match_id: laLigaMatchId,
      league_id: "la_liga",
    });
    await repo.predictions.insert({
      ...makePrediction(USER_ID),
      prediction_id: laLigaPredictionId,
      match_id: laLigaMatchId,
      submitted_at: new Date("2026-08-08T11:00:00.000Z"),
    });
    const service = new PredictionHistoryQueryService(repo, "prediction-query-secret");

    const all = await service.listMyPredictions(USER_ID, {
      league_id: null,
      season_id: null,
      limit: 20,
      cursor: null,
    });
    expect(all.items.map((item) => item.league_id).sort()).toEqual(["la_liga", "premier_league"]);

    const filtered = await service.listMyPredictions(USER_ID, {
      league_id: "la_liga",
      season_id: "2026_2027",
      limit: 20,
      cursor: null,
    });
    expect(filtered.items.map((item) => item.prediction_id)).toEqual([laLigaPredictionId]);

    await expect(service.listMyPredictions(USER_ID, {
      league_id: null,
      season_id: "2026_2027",
      limit: 20,
      cursor: null,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.listMyPredictions(USER_ID, {
      league_id: "chinese_super_league",
      season_id: "2026_2027",
      limit: 20,
      cursor: null,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("cursor 续页沿用绑定筛选，取消比赛的结算字段固定为 null", async () => {
    const repo = await setup();
    const laLigaMatchId = "00000000-0000-4000-8000-000000000013";
    const laLigaSecondMatchId = "00000000-0000-4000-8000-000000000014";
    const laLigaPredictionId = "00000000-0000-4000-8000-000000000023";
    const laLigaSecondPredictionId = "00000000-0000-4000-8000-000000000024";
    await repo.matches.insert({ ...makeMatch(), match_id: laLigaMatchId, league_id: "la_liga" });
    await repo.matches.insert({
      ...makeMatch(), match_id: laLigaSecondMatchId, league_id: "la_liga",
      match_status: MatchStatus.Cancelled,
    });
    await repo.predictions.insert({
      ...makePrediction(USER_ID), prediction_id: laLigaPredictionId, match_id: laLigaMatchId,
      submitted_at: new Date("2026-08-08T11:00:00.000Z"),
    });
    await repo.predictions.insert({
      ...makePrediction(USER_ID), prediction_id: laLigaSecondPredictionId,
      match_id: laLigaSecondMatchId, submitted_at: new Date("2026-08-08T10:00:00.000Z"),
    });
    const service = new PredictionHistoryQueryService(repo, "prediction-query-secret");
    const firstPage = await service.listMyPredictions(USER_ID, {
      league_id: "la_liga", season_id: "2026_2027", limit: 1, cursor: null,
    });
    expect(firstPage.has_more).toBe(true);

    const nextPage = await service.listMyPredictions(USER_ID, {
      league_id: null, season_id: null, limit: 1, cursor: firstPage.next_cursor,
    });
    expect(nextPage.items.map((item) => item.prediction_id)).toEqual([laLigaSecondPredictionId]);
    expect(nextPage.items[0]).toMatchObject({ match_score: null, wdl_hit: null, exact_hit: null });
  });
});
