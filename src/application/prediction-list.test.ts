import { describe, expect, it } from "vitest";
import { MatchStatus, UserStatus } from "../domain/enums.js";
import type { Match, Prediction, User } from "../domain/types.js";
import { DomainError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import {
  PredictionHistoryCursorCodec,
  PredictionHistoryQueryService,
} from "./prediction-query.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-08-09T00:00:00.000Z");

function makeUser(userId = USER_ID): User {
  return {
    schema_version: 1,
    user_id: userId,
    openid: `prediction-list-user-${userId}`,
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
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeMatch(
  matchId: string,
  overrides: Partial<Match> = {},
): Match {
  return {
    schema_version: 1,
    match_id: matchId,
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
    ...overrides,
  };
}

function makePrediction(
  predictionId: string,
  matchId: string,
  submittedAt: string,
): Prediction {
  return {
    schema_version: 1,
    prediction_id: predictionId,
    user_id: USER_ID,
    match_id: matchId,
    idempotency_key: newUuid(),
    pred_home_score: 2,
    pred_away_score: 1,
    derived_result: "HOME",
    submitted_at: new Date(submittedAt),
    scoring_rule_version: "scoring_v1",
    match_score: 12,
    wdl_hit: true,
    exact_hit: true,
    applied_result_version: 1,
    created_at: NOW,
    updated_at: NOW,
  };
}

async function setup(): Promise<InMemoryRepository> {
  const repo = new InMemoryRepository();
  await repo.users.insert(makeUser());
  await repo.users.insert(makeUser(OTHER_USER_ID));
  await repo.matches.insert(makeMatch("00000000-0000-4000-8000-000000000010"));
  await repo.matches.insert(makeMatch("00000000-0000-4000-8000-000000000011", {
    match_status: MatchStatus.Scheduled,
    settlement_status: "pending",
    regular_home_score: null,
    regular_away_score: null,
    result_version: 0,
    settled_result_version: 0,
    result_source: null,
    finish_detected_at: null,
    settled_at: null,
  }));
  await repo.matches.insert(makeMatch("00000000-0000-4000-8000-000000000012", {
    season_id: "2025_2026",
  }));
  await repo.predictions.insert(makePrediction(
    "00000000-0000-4000-8000-000000000020",
    "00000000-0000-4000-8000-000000000010",
    "2026-08-08T13:00:00.000Z",
  ));
  await repo.predictions.insert(makePrediction(
    "00000000-0000-4000-8000-000000000021",
    "00000000-0000-4000-8000-000000000011",
    "2026-08-08T13:00:00.000Z",
  ));
  await repo.predictions.insert(makePrediction(
    "00000000-0000-4000-8000-000000000022",
    "00000000-0000-4000-8000-000000000012",
    "2026-08-08T14:00:00.000Z",
  ));
  return repo;
}

describe("PredictionHistoryQueryService.listMyPredictions", () => {
  it("按赛季和 submitted_at DESC、prediction_id DESC 分页，并返回当前比赛赛果", async () => {
    const repo = await setup();
    const service = new PredictionHistoryQueryService(repo, "prediction-list-secret");

    const first = await service.listMyPredictions(USER_ID, {
      season_id: "2026_2027",
      limit: 1,
      cursor: null,
    });

    expect(first.items).toEqual([expect.objectContaining({
      prediction_id: "00000000-0000-4000-8000-000000000021",
      match_id: "00000000-0000-4000-8000-000000000011",
      match_status: "scheduled",
      regular_home_score: null,
      regular_away_score: null,
      match_score: null,
      wdl_hit: null,
      exact_hit: null,
      season_id: "2026_2027",
    })]);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toEqual(expect.any(String));

    const second = await service.listMyPredictions(USER_ID, {
      season_id: "2026_2027",
      limit: 10,
      cursor: first.next_cursor,
    });
    expect(second.items.map((item) => item.prediction_id)).toEqual([
      "00000000-0000-4000-8000-000000000020",
    ]);
    expect(second.items[0]).toEqual(expect.objectContaining({
      regular_home_score: 2,
      regular_away_score: 1,
      match_score: 12,
      wdl_hit: true,
      exact_hit: true,
    }));
    expect(second.next_cursor).toBeNull();
  });

  it("cursor 绑定 season_id，非法赛季和跨用户访问 fail closed", async () => {
    const repo = await setup();
    const service = new PredictionHistoryQueryService(repo, "prediction-list-secret");

    await expect(service.listMyPredictions(USER_ID, {
      season_id: "2025_2026",
      limit: 20,
      cursor: null,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const first = await service.listMyPredictions(USER_ID, {
      season_id: "2026_2027",
      limit: 1,
      cursor: null,
    });
    await expect(service.listMyPredictions(USER_ID, {
      season_id: "2026_2027",
      limit: 20,
      cursor: `${first.next_cursor!.slice(0, -1)}x`,
    })).rejects.toBeInstanceOf(DomainError);

    await expect(service.listMyPredictions(OTHER_USER_ID, {
      season_id: "2026_2027",
      limit: 20,
      cursor: null,
    })).resolves.toMatchObject({ items: [] });
  });

  it("已注销用户返回 USER_DELETED", async () => {
    const repo = await setup();
    const deleted = makeUser("00000000-0000-4000-8000-000000000003");
    deleted.status = UserStatus.Deleted;
    deleted.nickname = null;
    deleted.deleted_at = NOW;
    await repo.users.insert(deleted);

    await expect(new PredictionHistoryQueryService(repo, "prediction-list-secret").listMyPredictions(
      deleted.user_id,
      { season_id: "2026_2027", limit: 20, cursor: null },
    )).rejects.toMatchObject({ code: "USER_DELETED" });
  });

  it("可信身份不存在时返回 USER_NOT_FOUND", async () => {
    const repo = await setup();

    await expect(new PredictionHistoryQueryService(repo, "prediction-list-secret").listMyPredictions(
      "00000000-0000-4000-8000-000000000099",
      { season_id: "2026_2027", limit: 20, cursor: null },
    )).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
  });

  it("拒绝签名有效但 season_id 不匹配的 cursor", async () => {
    const repo = await setup();
    const cursor = new PredictionHistoryCursorCodec("prediction-list-secret").encode({
      season_id: "2025_2026",
      submitted_at: "2026-08-08T13:00:00.000Z",
      prediction_id: "00000000-0000-4000-8000-000000000021",
    });

    await expect(new PredictionHistoryQueryService(repo, "prediction-list-secret").listMyPredictions(
      USER_ID,
      { season_id: "2026_2027", limit: 20, cursor },
    )).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
