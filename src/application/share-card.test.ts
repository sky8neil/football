import { describe, expect, it, vi } from "vitest";
import { MVP_SEASON } from "../domain/config.js";
import { levelSeasonOf } from "../domain/time.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { newUuid } from "../domain/ids.js";
import type { Match, Prediction, User } from "../domain/types.js";
import { formatSeasonLabel } from "../domain/season-label.js";
import { ShareCardQueryService } from "./share-card.js";
import { defaultLevelState } from "../domain/types.js";

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
    career_level: 6,
    career_best_level: 6,
    career_last_scoring_match_at: null,
    career_level_state: defaultLevelState(),
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeMatch(overrides: Partial<Match> = {}): Match {
  const canonicalMatchIdentity = overrides.match_id ?? (newUuid());
  return {
    schema_version: 1,
    match_id: canonicalMatchIdentity,
    canonical_match_id: overrides.canonical_match_id ?? canonicalMatchIdentity,
    superseded_by: overrides.superseded_by ?? null,
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
  const canonicalMatchIdentity = overrides.match_id ?? (matchId);
  return {
    schema_version: 1,
    prediction_id: newUuid(),
    user_id: userId,
    match_id: canonicalMatchIdentity,
    canonical_match_id: overrides.canonical_match_id ?? canonicalMatchIdentity,
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
      predictions: {
        findByUserAndMatch: async () => invalidPrediction,
        findByUserAndCanonicalMatch: async () => invalidPrediction,
      },
      matches: {
        findByLeagueSeasonRound: async () => [match],
        findLeagueSeasonCatalog: async () => [
          {
            league_id: "premier_league",
            season_id: MVP_SEASON.season_id,
            round_ids: ["01"],
          },
        ],
      },
    } as unknown as AppRepository;

    await expect(
      new ShareCardQueryService(repository).getShareCard(user.user_id, {
        league_id: "premier_league",
        season_id: MVP_SEASON.season_id,
        round_id: "01",
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("按指定 round 计算四项统计并从用户缓存读取 career_points", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);
    await repo.userSeasonStats?.insert({
      schema_version: 1,
      user_id: user.user_id,
      level_season_id: levelSeasonOf(new Date()),
      points: 0,
      valid_predictions: 20,
      wdl_hits: 0,
      exact_hits: 0,
      last_scoring_match_at: null,
      level: 5,
      best_level: 5,
      level_state: defaultLevelState(),
      is_level_frozen: false,
      created_at: NOW,
      updated_at: NOW,
    });

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
      league_id: "premier_league",
      season_id: MVP_SEASON.season_id,
      round_id: "01",
    }, NOW);

    expect(result).toEqual({
      user_id: user.user_id,
      display_name: "Sky",
      favorite_team_id: user.favorite_team_id,
      season_level: 5,
      league_id: "premier_league",
      season_id: MVP_SEASON.season_id,
      season_label: formatSeasonLabel(MVP_SEASON.season_id),
      round_id: "01",
      round_predictions: 2,
      round_wdl_hits: 2,
      round_exact_hits: 1,
      round_score: 15,
      career_points: user.career_points,
      level_season_id: levelSeasonOf(NOW),
      generated_at: NOW.toISOString(),
      pending_predictions: 1,
    });
  });

  it("deleted 用户不能访问个人分享卡", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({ status: "deleted", deleted_at: NOW });
    await repo.users.insert(user);
    await repo.matches.insert(makeMatch());

    await expect(
      new ShareCardQueryService(repo).getShareCard(user.user_id, {
        league_id: "premier_league",
        season_id: MVP_SEASON.season_id,
        round_id: "01",
      }),
    ).rejects.toMatchObject({ code: "USER_DELETED" });
  });

  it("按联赛校验 round 上限与登记 season", async () => {
    const repo = new InMemoryRepository();
    const service = new ShareCardQueryService(repo);
    await repo.matches.insert(makeMatch({
      league_id: "bundesliga",
      season_id: "2026_2027",
      round_id: "01",
    }));

    await expect(
      service.getShareCard(newUuid(), {
        league_id: "bundesliga",
        season_id: "2026_2027",
        round_id: "35",
      }),
    ).rejects.toMatchObject({
      code: "ROUND_NOT_FOUND",
    });
    await expect(
      service.getShareCard(newUuid(), {
        league_id: "chinese_super_league",
        season_id: "2026_2027",
        round_id: "01",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "season_id", reason: "FORMAT" },
    });
  });

  it("已接入的历史赛季与该赛季实际存在的轮次可正常返回", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);
    const match = makeMatch({ season_id: "2024_2025", round_id: "08" });
    await repo.matches.insert(match);
    await repo.predictions.insert(makePrediction(user.user_id, match.match_id));

    const result = await new ShareCardQueryService(repo).getShareCard(user.user_id, {
      league_id: "premier_league",
      season_id: "2024_2025",
      round_id: "08",
    }, NOW);

    expect(result).toEqual({
      user_id: user.user_id,
      display_name: "Sky",
      favorite_team_id: user.favorite_team_id,
      season_level: 1,
      league_id: "premier_league",
      season_id: "2024_2025",
      season_label: "2024/2025",
      round_id: "08",
      round_predictions: 1,
      round_wdl_hits: 1,
      round_exact_hits: 1,
      round_score: 12,
      career_points: user.career_points,
      level_season_id: levelSeasonOf(NOW),
      generated_at: NOW.toISOString(),
      pending_predictions: 0,
    });
  });

  it("未接入赛季拒绝为 NOT_ATTACHED", async () => {
    const repo = new InMemoryRepository();
    await repo.matches.insert(makeMatch({ season_id: "2024_2025" }));

    await expect(
      new ShareCardQueryService(repo).getShareCard(newUuid(), {
        league_id: "premier_league",
        season_id: "2023_2024",
        round_id: "01",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "season_id", reason: "NOT_ATTACHED" },
    });
  });

  it("赛季已接入但 round_id 不在目录中拒绝为 NOT_FOUND", async () => {
    const repo = new InMemoryRepository();
    await repo.matches.insert(makeMatch({ season_id: "2024_2025", round_id: "01" }));

    await expect(
      new ShareCardQueryService(repo).getShareCard(newUuid(), {
        league_id: "premier_league",
        season_id: "2024_2025",
        round_id: "02",
      }),
    ).rejects.toMatchObject({
      code: "ROUND_NOT_FOUND",
    });
  });

  it("premier_league 拒绝自然年赛季格式", async () => {
    const repo = new InMemoryRepository();

    await expect(
      new ShareCardQueryService(repo).getShareCard(newUuid(), {
        league_id: "premier_league",
        season_id: "2026",
        round_id: "01",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "season_id", reason: "FORMAT" },
    });
  });

  it("返回跨年赛季 season_id/season_label 以及当前等级赛季与 generated_at", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);
    const match = makeMatch({ season_id: "2025_2026" });
    await repo.matches.insert(match);
    await repo.predictions.insert(makePrediction(user.user_id, match.match_id));

    const result = await new ShareCardQueryService(repo).getShareCard(user.user_id, {
      league_id: "premier_league",
      season_id: "2025_2026",
      round_id: "01",
    }, NOW);

    expect(result.season_id).toBe("2025_2026");
    expect(result.season_label).toBe("2025/2026");
    expect(result.level_season_id).toBe(levelSeasonOf(NOW));
    expect(result.generated_at).toBe(NOW.toISOString());
  });

  it("返回自然年赛季 season_id/season_label 以及当前等级赛季与 generated_at", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);
    const match = makeMatch({
      league_id: "chinese_super_league",
      season_id: "2026",
    });
    await repo.matches.insert(match);
    await repo.predictions.insert(makePrediction(user.user_id, match.match_id));

    const result = await new ShareCardQueryService(repo).getShareCard(user.user_id, {
      league_id: "chinese_super_league",
      season_id: "2026",
      round_id: "01",
    }, NOW);

    expect(result.season_id).toBe("2026");
    expect(result.season_label).toBe("2026");
    expect(result.level_season_id).toBe(levelSeasonOf(NOW));
    expect(result.generated_at).toBe(NOW.toISOString());
  });

  it("1 场已结算 + 1 场未结算时 pending_predictions=1，round_predictions 只统计已结算", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);
    const settled = makeMatch();
    const unsettled = makeMatch({
      match_status: "scheduled",
      settlement_status: "pending",
      result_version: 0,
      settled_result_version: 0,
      regular_home_score: null,
      regular_away_score: null,
    });
    await repo.matches.insert(settled);
    await repo.matches.insert(unsettled);
    await repo.predictions.insert(makePrediction(user.user_id, settled.match_id));
    await repo.predictions.insert(makePrediction(user.user_id, unsettled.match_id, {
      match_score: null,
      wdl_hit: null,
      exact_hit: null,
      applied_result_version: 0,
    }));

    const result = await new ShareCardQueryService(repo).getShareCard(user.user_id, {
      league_id: "premier_league",
      season_id: MVP_SEASON.season_id,
      round_id: "01",
    }, NOW);

    expect(result.round_predictions).toBe(1);
    expect(result.pending_predictions).toBe(1);
  });

  it("全部已结算时 pending_predictions=0", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);
    const first = makeMatch();
    const second = makeMatch();
    await repo.matches.insert(first);
    await repo.matches.insert(second);
    await repo.predictions.insert(makePrediction(user.user_id, first.match_id));
    await repo.predictions.insert(makePrediction(user.user_id, second.match_id));

    const result = await new ShareCardQueryService(repo).getShareCard(user.user_id, {
      league_id: "premier_league",
      season_id: MVP_SEASON.season_id,
      round_id: "01",
    }, NOW);

    expect(result.round_predictions).toBe(2);
    expect(result.pending_predictions).toBe(0);
  });

  it("[Slice 3.3] getShareCard fetches predictions via one findByUserAndCanonicalMatchIds batch instead of N+1", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);
    const m1 = makeMatch();
    const m2 = makeMatch();
    const m3 = makeMatch();
    await repo.matches.insert(m1);
    await repo.matches.insert(m2);
    await repo.matches.insert(m3);
    await repo.predictions.insert(makePrediction(user.user_id, m1.match_id));
    await repo.predictions.insert(makePrediction(user.user_id, m3.match_id));

    const predictions = repo.predictions;
    const batchSpy = vi.spyOn(predictions, "findByUserAndCanonicalMatchIds");
    const singleSpy = vi.spyOn(predictions, "findByUserAndCanonicalMatch");
    const repoProxy = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "predictions") return predictions;
        return Reflect.get(target, prop, receiver);
      },
    });

    const result = await new ShareCardQueryService(repoProxy).getShareCard(user.user_id, {
      league_id: "premier_league",
      season_id: MVP_SEASON.season_id,
      round_id: "01",
    }, NOW);

    expect(result.round_predictions).toBe(2);
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(singleSpy).not.toHaveBeenCalled();
  });
});
