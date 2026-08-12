/**
 * 第 44 节 M. 注销与权限验收矩阵（M100-M104；M105-M107 见既有 API/admin 测试）。
 */
import { describe, expect, it } from "vitest";
import { UserStatus } from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { Match, Prediction, RankingEntry, User } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { ProfileMutationService } from "./profile-mutation.js";
import { ProfileQueryService } from "./profile.js";
import { SessionService } from "./session.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const ORIGINAL_OPENID = "openid-m100-original";

function makeUser(overrides: Partial<User> = {}): User {
  return {
    schema_version: 1,
    user_id: "00000000-0000-4000-8000-0000000000a1",
    openid: ORIGINAL_OPENID,
    unionid: "unionid-m",
    nickname: "OldName",
    favorite_team_id: "00000000-0000-4000-8000-0000000000b1",
    status: UserStatus.Active,
    career_points: 12,
    career_valid_predictions: 1,
    career_wdl_hits: 1,
    career_exact_hits: 0,
    career_level: 1,
    career_best_level: 1,
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeMatch(): Match {
  return {
    schema_version: 1,
    match_id: "00000000-0000-4000-8000-0000000000c1",
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: newUuid(),
    away_team_id: newUuid(),
    kickoff_at: new Date("2026-08-08T06:00:00.000Z"),
    kickoff_confirmed: true,
    prediction_deadline_at: new Date("2026-08-08T05:50:00.000Z"),
    prediction_closed_at: new Date("2026-08-08T05:50:00.000Z"),
    period_anchor_at: new Date("2026-08-08T06:00:00.000Z"),
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
  } as Match;
}

function makePrediction(userId: string, matchId: string): Prediction {
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
  } as Prediction;
}

function makeRanking(userId: string): RankingEntry {
  return {
    schema_version: 1,
    period_type: "week",
    period_key: "2026-W32",
    user_id: userId,
    period_score: 12,
    valid_predictions: 1,
    wdl_hits: 1,
    exact_hits: 1,
    last_scoring_match_at: NOW,
    global_rank: null,
    is_final: false,
    created_at: NOW,
    updated_at: NOW,
  };
}

describe("M. 注销与权限（规范 44-M）", () => {
  it("M100 注销后原 openid 从用户事实身份中移除", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);

    await new ProfileMutationService(repo).deleteMyProfile(user.user_id, NOW);

    const tombstone = await repo.users.findById(user.user_id);
    expect(tombstone).toMatchObject({
      user_id: user.user_id,
      openid: `deleted:${user.user_id}`,
      status: UserStatus.Deleted,
      unionid: null,
      nickname: null,
      favorite_team_id: null,
      deleted_at: NOW,
    });
    await expect(repo.users.findByOpenid(ORIGINAL_OPENID)).resolves.toBeNull();
    await expect(repo.users.findByOpenid(`deleted:${user.user_id}`)).resolves.toMatchObject({
      user_id: user.user_id,
    });
  });

  it("M101 注销历史 prediction 保留", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    const match = makeMatch();
    const prediction = makePrediction(user.user_id, match.match_id);
    await repo.users.insert(user);
    await repo.matches.insert(match);
    await repo.predictions.insert(prediction);

    await new ProfileMutationService(repo).deleteMyProfile(user.user_id, NOW);

    await expect(repo.predictions.findById(prediction.prediction_id)).resolves.toEqual(prediction);
    await expect(
      repo.predictions.findByUserAndMatch(user.user_id, match.match_id),
    ).resolves.toEqual(prediction);
  });

  it("M102 注销历史排行榜保留", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    const ranking = makeRanking(user.user_id);
    await repo.users.insert(user);
    await repo.rankings.insert(ranking);

    await new ProfileMutationService(repo).deleteMyProfile(user.user_id, NOW);

    await expect(
      repo.rankings.findByPeriodAndUser("week", "2026-W32", user.user_id),
    ).resolves.toEqual(ranking);
  });

  it("M103 公开显示名为 已注销用户", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);
    await new ProfileMutationService(repo).deleteMyProfile(user.user_id, NOW);

    const publicProfile = await new ProfileQueryService(repo).getPublicProfile(user.user_id);
    expect(publicProfile).toMatchObject({
      user_id: user.user_id,
      display_name: "已注销用户",
      favorite_team_id: null,
      career_points: 12,
    });
  });

  it("M104 同 openid 再注册创建新 user_id", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);
    await new ProfileMutationService(repo).deleteMyProfile(user.user_id, NOW);

    const reinit = await new SessionService(repo).init(
      { openid: ORIGINAL_OPENID, nickname: "NewFace" },
      new Date(NOW.getTime() + 60_000),
    );

    expect(reinit.created).toBe(true);
    expect(reinit.user.user_id).not.toBe(user.user_id);
    expect(reinit.user).toMatchObject({
      openid: ORIGINAL_OPENID,
      nickname: "NewFace",
      status: UserStatus.Active,
      career_points: 0,
    });

    const old = await repo.users.findById(user.user_id);
    expect(old).toMatchObject({
      openid: `deleted:${user.user_id}`,
      status: UserStatus.Deleted,
    });
    await expect(repo.users.findByOpenid(ORIGINAL_OPENID)).resolves.toMatchObject({
      user_id: reinit.user.user_id,
    });
  });
});
