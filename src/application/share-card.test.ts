import { describe, expect, it } from "vitest";
import { MVP_SEASON } from "../domain/config.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { newUuid } from "../domain/ids.js";
import type { Match, Prediction, User } from "../domain/types.js";
import { ShareCardQueryService } from "./share-card.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");

function makeUser(overrides: Partial<User> = {}): User {
  return {
    schema_version: 1,
    user_id: newUuid(),
    openid: `openid_${newUuid()}`,
    unionid: null,
    nickname: "Sky",
    favorite_team_id: newUuid(),
    status: "active",
    career_points: 999,
    career_valid_predictions: 99,
    career_wdl_hits: 99,
    career_exact_hits: 99,
    career_level: 8,
    career_best_level: 8,
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    schema_version: 1,
    match_id: newUuid(),
    league_id: "premier_league",
    season_id: MVP_SEASON.season_id,
    round_id: "01",
    home_team_id: newUuid(),
    away_team_id: newUuid(),
    kickoff_at: NOW,
    kickoff_confirmed: true,
    prediction_deadline_at: new Date(NOW.getTime() - 10 * 60 * 1000),
    prediction_closed_at: NOW,
    period_anchor_at: NOW,
    match_status: "finished",
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
    finish_detected_at: NOW,
    settled_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makePrediction(
  userId: string,
  matchId: string,
  overrides: Partial<Prediction> = {},
): Prediction {
  return {
    schema_version: 1,
    prediction_id: newUuid(),
    user_id: userId,
    match_id: matchId,
    idempotency_key: newUuid(),
    pred_home_score: 2,
    pred_away_score: 1,
    derived_result: "HOME",
    submitted_at: NOW,
    scoring_rule_version: "scoring_v1",
    match_score: 12,
    wdl_hit: true,
    exact_hit: true,
    applied_result_version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe("ShareCardQueryService", () => {
  it("已结算 prediction 违反 exact_hit => wdl_hit 时 Fail Closed", async () => {
    const user = makeUser();
    const match = makeMatch();
    const invalidPrediction = makePrediction(user.user_id, match.match_id, {
      wdl_hit: false,
    });
    const repository = {
      users: { findById: async () => user },
      predictions: { findByUser: async () => [invalidPrediction] },
      matches: { findById: async () => match },
    } as unknown as AppRepository;

    await expect(
      new ShareCardQueryService(repository).getShareCard(user.user_id, {
        season_id: MVP_SEASON.season_id,
        round_id: "01",
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("从当前已结算 prediction + match 事实计算分享卡，不使用陈旧聚合缓存", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);

    const settledRoundOne = makeMatch({
      kickoff_at: new Date("2026-08-15T10:00:00Z"),
      round_id: "01",
    });
    const settledRoundOneAfterPostponement = makeMatch({
      kickoff_at: new Date("2026-08-22T10:00:00Z"),
      round_id: "01",
    });
    const settledRoundTwo = makeMatch({ round_id: "02" });
    const cancelled = makeMatch({
      match_status: "cancelled",
      settlement_status: "voided",
    });
    const unsettled = makeMatch({
      settlement_status: "waiting",
    });
    const previousSeason = makeMatch({ season_id: "2025_2026" });

    for (const match of [
      settledRoundOne,
      settledRoundOneAfterPostponement,
      settledRoundTwo,
      cancelled,
      unsettled,
      previousSeason,
    ]) {
      await repo.matches.insert(match);
    }

    await repo.predictions.insert(makePrediction(user.user_id, settledRoundOne.match_id));
    await repo.predictions.insert(
      makePrediction(user.user_id, settledRoundOneAfterPostponement.match_id, {
        match_score: 3,
        exact_hit: false,
      }),
    );
    await repo.predictions.insert(
      makePrediction(user.user_id, settledRoundTwo.match_id, {
        match_score: 12,
      }),
    );
    await repo.predictions.insert(
      makePrediction(user.user_id, cancelled.match_id, {
        match_score: 12,
      }),
    );
    await repo.predictions.insert(
      makePrediction(user.user_id, unsettled.match_id, {
        match_score: 12,
      }),
    );
    await repo.predictions.insert(
      makePrediction(user.user_id, previousSeason.match_id, {
        match_score: 12,
      }),
    );

    const result = await new ShareCardQueryService(repo).getShareCard(user.user_id, {
      season_id: MVP_SEASON.season_id,
      round_id: "01",
    });

    expect(result).toEqual({
      user_id: user.user_id,
      display_name: "Sky",
      favorite_team_id: user.favorite_team_id,
      season_level: 1,
      round_id: "01",
      round_predictions: 2,
      round_wdl_hits: 2,
      round_exact_hits: 1,
      round_score: 15,
      career_points: 39,
    });
  });

  it("deleted 用户不能访问个人分享卡", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({ status: "deleted", deleted_at: NOW });
    await repo.users.insert(user);

    await expect(
      new ShareCardQueryService(repo).getShareCard(user.user_id, {
        season_id: MVP_SEASON.season_id,
        round_id: "01",
      }),
    ).rejects.toMatchObject({ code: "USER_NOT_ACTIVE" });
  });
});
