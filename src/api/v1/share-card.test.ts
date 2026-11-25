import { readFile } from "node:fs/promises";
import Ajv from "ajv";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { MVP_SEASON, SUPPORTED_LEAGUES } from "../../domain/config.js";
import { MatchStatus, SettlementStatus } from "../../domain/enums.js";
import { newUuid } from "../../domain/ids.js";
import { formatSeasonLabel } from "../../domain/season-label.js";
import { levelSeasonOf } from "../../domain/time.js";
import { InMemoryRepository } from "../../infrastructure/repositories.js";
import { ShareCardQueryService } from "../../application/share-card.js";
import { DomainError } from "../../domain/errors.js";
import { defaultLevelState, type Match, type Prediction, type User } from "../../domain/types.js";
import {
  getShareCardForUser,
  getShareCardMe,
  validatePublicShareCardQuery,
  validateShareCardQuery,
} from "./share-card.js";
import { InMemoryRateLimiter } from "./rate-limit.js";

const NOW = new Date("2026-08-11T00:00:00.000Z");
const TEST_SHARE_SECRET = "api-share-card-secret";

function makeUser(userId: string, overrides: Partial<User> = {}): User {
  return {
    schema_version: 1,
    user_id: userId,
    openid: `openid_${userId}`,
    unionid: null,
    nickname: "Sky",
    favorite_team_id: null,
    status: "active",
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_last_scoring_match_at: null,
    career_level: 1,
    career_best_level: 1,
    career_level_state: defaultLevelState(),
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeMatch(overrides: Partial<Match> = {}): Match {
  const matchId = overrides.match_id ?? newUuid();
  return {
    schema_version: 1,
    match_id: matchId,
    canonical_match_id: matchId,
    superseded_by: null,
    league_id: MVP_SEASON.league_id,
    season_id: MVP_SEASON.season_id,
    round_id: "01",
    home_team_id: newUuid(),
    away_team_id: newUuid(),
    kickoff_at: NOW,
    kickoff_confirmed: true,
    prediction_deadline_at: NOW,
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

function makeSettledMatch(overrides: Partial<Match> = {}): Match {
  const matchId = overrides.match_id ?? newUuid();
  return makeMatch({
    match_id: matchId,
    canonical_match_id: matchId,
    match_status: MatchStatus.Finished,
    settlement_status: SettlementStatus.Settled,
    regular_home_score: 2,
    regular_away_score: 1,
    result_version: 1,
    settled_result_version: 1,
    result_source: "provider",
    prediction_closed_at: NOW,
    period_anchor_at: NOW,
    finish_detected_at: NOW,
    settled_at: NOW,
    ...overrides,
  });
}

function makePrediction(
  userId: string,
  matchId: string,
  overrides: Partial<Prediction> = {},
): Prediction {
  const canonicalMatchIdentity = overrides.match_id ?? matchId;
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

describe("share-card API query", () => {
  it("要求显式 league_id/season_id/round_id，并拒绝未知值与未知参数", () => {
    for (const league of SUPPORTED_LEAGUES) {
      expect(validateShareCardQuery({
        league_id: league.league_id,
        season_id: league.season_id,
        round_id: "01",
      })).toEqual({
        league_id: league.league_id,
        season_id: league.season_id,
        round_id: "01",
      });
    }

    expect(validateShareCardQuery({
      league_id: MVP_SEASON.league_id,
      season_id: "2027_2028",
      round_id: "01",
    })).toEqual({
      league_id: MVP_SEASON.league_id,
      season_id: "2027_2028",
      round_id: "01",
    });
    expect(validateShareCardQuery({
      league_id: MVP_SEASON.league_id,
      season_id: MVP_SEASON.season_id,
      round_id: "00",
    })).toEqual({
      league_id: MVP_SEASON.league_id,
      season_id: MVP_SEASON.season_id,
      round_id: "00",
    });
    expect(validateShareCardQuery({
      league_id: MVP_SEASON.league_id,
      season_id: MVP_SEASON.season_id,
      round_id: "39",
    })).toEqual({
      league_id: MVP_SEASON.league_id,
      season_id: MVP_SEASON.season_id,
      round_id: "39",
    });
    expect(validateShareCardQuery({
      league_id: MVP_SEASON.league_id,
      season_id: "2026",
      round_id: "01",
    })).toEqual({
      league_id: MVP_SEASON.league_id,
      season_id: "2026",
      round_id: "01",
    });

    for (const query of [
      { season_id: MVP_SEASON.season_id, round_id: "01" },
      { league_id: MVP_SEASON.league_id, round_id: "01" },
      { league_id: MVP_SEASON.league_id, season_id: MVP_SEASON.season_id },
      { league_id: "eredivisie", season_id: MVP_SEASON.season_id, round_id: "01" },
      { league_id: MVP_SEASON.league_id, season_id: MVP_SEASON.season_id, round_id: "1" },
      { league_id: MVP_SEASON.league_id, season_id: MVP_SEASON.season_id, round_id: "abc" },
      { league_id: MVP_SEASON.league_id, season_id: MVP_SEASON.season_id, round_id: "01", cursor: "x" },
    ]) {
      expect(() => validateShareCardQuery(query)).toThrow(DomainError);
      expect(() => validateShareCardQuery(query)).toThrowError(
        expect.objectContaining({ code: "VALIDATION_ERROR" }),
      );
    }
  });

  it("认证用户返回规范 snake_case 成功 envelope", async () => {
    const repo = new InMemoryRepository();
    const userId = newUuid();
    await repo.users.insert(makeUser(userId, {
      openid: "openid_share_card_api",
      created_at: new Date("2026-08-01T00:00:00Z"),
      updated_at: new Date("2026-08-01T00:00:00Z"),
    }));
    await repo.matches.insert(makeMatch());

    const service = new ShareCardQueryService(repo, TEST_SHARE_SECRET);
    const response = await getShareCardMe(service, {
      authenticated_user_id: userId,
      query: { league_id: MVP_SEASON.league_id, season_id: MVP_SEASON.season_id, round_id: "01" },
      server_now: NOW,
      request_id: "request-share-card-1",
    });

    expect(response.status).toBe(200);
    expect(response.body.request_id).toBe("request-share-card-1");
    expect(response.body.data).toEqual({
      user_id: userId,
      display_name: "Sky",
      favorite_team_id: null,
      season_level: 1,
      league_id: MVP_SEASON.league_id,
      season_id: MVP_SEASON.season_id,
      season_label: formatSeasonLabel(MVP_SEASON.season_id),
      round_id: "01",
      round_predictions: 0,
      round_wdl_hits: 0,
      round_exact_hits: 0,
      round_score: 0,
      career_points: 0,
      level_season_id: levelSeasonOf(NOW),
      generated_at: NOW.toISOString(),
      pending_predictions: 0,
      share_token: service.generateShareToken(userId, {
        league_id: MVP_SEASON.league_id,
        season_id: MVP_SEASON.season_id,
        round_id: "01",
      }),
      matches: [],
    });
  });

  it("没有认证用户时拒绝访问", async () => {
    await expect(
      getShareCardMe(new ShareCardQueryService(new InMemoryRepository()), {
        authenticated_user_id: null,
        query: { league_id: MVP_SEASON.league_id, season_id: MVP_SEASON.season_id, round_id: "01" },
        server_now: new Date("2026-08-11T00:00:00.000Z"),
        request_id: "request-share-card-2",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("按 authenticated user 每分钟限制 120 次分享卡读取", async () => {
    const repo = new InMemoryRepository();
    const userId = newUuid();
    await repo.users.insert(makeUser(userId, { openid: "openid_share_card_rate_limit" }));
    await repo.matches.insert(makeMatch());
    const rateLimiter = new InMemoryRateLimiter();
    const input = {
      authenticated_user_id: userId,
      query: { league_id: MVP_SEASON.league_id, season_id: MVP_SEASON.season_id, round_id: "01" },
      request_id: "request-share-card-rate-limit",
      server_now: NOW,
      rate_limiter: rateLimiter,
    };
    const service = new ShareCardQueryService(repo);

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await expect(getShareCardMe(service, input)).resolves.toBeDefined();
    }

    await expect(getShareCardMe(service, input)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("未接入赛季由 service 层拒绝，details 为 NOT_ATTACHED", async () => {
    const repo = new InMemoryRepository();
    const userId = newUuid();
    await repo.users.insert(makeUser(userId));
    await repo.matches.insert(makeMatch());

    await expect(getShareCardMe(new ShareCardQueryService(repo), {
      authenticated_user_id: userId,
      query: { league_id: MVP_SEASON.league_id, season_id: "2027_2028", round_id: "01" },
      server_now: NOW,
      request_id: "request-share-card-unattached-season",
    })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "season_id", reason: "NOT_ATTACHED" },
    });
  });

  it("赛季已接入但 round_id 不在目录中拒绝为 NOT_FOUND", async () => {
    const repo = new InMemoryRepository();
    const userId = newUuid();
    await repo.users.insert(makeUser(userId));
    await repo.matches.insert(makeMatch({ round_id: "01" }));
    const service = new ShareCardQueryService(repo);

    await expect(getShareCardMe(service, {
      authenticated_user_id: userId,
      query: { league_id: MVP_SEASON.league_id, season_id: MVP_SEASON.season_id, round_id: "00" },
      server_now: NOW,
      request_id: "request-share-card-round-00",
    })).rejects.toMatchObject({
      code: "ROUND_NOT_FOUND",
    });
    await expect(getShareCardMe(service, {
      authenticated_user_id: userId,
      query: { league_id: MVP_SEASON.league_id, season_id: MVP_SEASON.season_id, round_id: "39" },
      server_now: NOW,
      request_id: "request-share-card-round-39",
    })).rejects.toMatchObject({
      code: "ROUND_NOT_FOUND",
    });
  });

  it("premier_league 拒绝自然年赛季格式", async () => {
    const repo = new InMemoryRepository();
    const userId = newUuid();
    await repo.users.insert(makeUser(userId));

    await expect(getShareCardMe(new ShareCardQueryService(repo), {
      authenticated_user_id: userId,
      query: { league_id: "premier_league", season_id: "2026", round_id: "01" },
      server_now: NOW,
      request_id: "request-share-card-season-format",
    })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "season_id", reason: "FORMAT" },
    });
  });

  it("已接入的历史赛季与该赛季实际存在的轮次可正常返回", async () => {
    const repo = new InMemoryRepository();
    const userId = newUuid();
    await repo.users.insert(makeUser(userId));
    await repo.matches.insert(makeMatch({ season_id: "2024_2025", round_id: "08" }));

    const service = new ShareCardQueryService(repo, TEST_SHARE_SECRET);
    const response = await getShareCardMe(service, {
      authenticated_user_id: userId,
      query: { league_id: "premier_league", season_id: "2024_2025", round_id: "08" },
      server_now: NOW,
      request_id: "request-share-card-historical-season",
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      user_id: userId,
      display_name: "Sky",
      favorite_team_id: null,
      season_level: 1,
      league_id: "premier_league",
      season_id: "2024_2025",
      season_label: "2024/2025",
      round_id: "08",
      round_predictions: 0,
      round_wdl_hits: 0,
      round_exact_hits: 0,
      round_score: 0,
      career_points: 0,
      level_season_id: levelSeasonOf(NOW),
      generated_at: NOW.toISOString(),
      pending_predictions: 0,
      share_token: service.generateShareToken(userId, {
        league_id: "premier_league",
        season_id: "2024_2025",
        round_id: "08",
      }),
      matches: [],
    });
  });
});

describe("getShareCardForUser", () => {
  it("游客不传登录身份也能返回 200，且 user_id 等于路径里的分享者", async () => {
    const repo = new InMemoryRepository();
    const sharerId = newUuid();
    await repo.users.insert(makeUser(sharerId, { nickname: "Sharer" }));
    await repo.matches.insert(makeMatch());

    const response = await getShareCardForUser(new ShareCardQueryService(repo), {
      user_id: sharerId,
      query: { league_id: MVP_SEASON.league_id, season_id: MVP_SEASON.season_id, round_id: "01" },
      server_now: NOW,
      request_id: "request-share-card-for-user-guest",
    });

    expect(response.status).toBe(200);
    expect(response.body.data.user_id).toBe(sharerId);
    expect(response.body.request_id).toBe("request-share-card-for-user-guest");
  });

  it("分享者和另一个用户成绩不同时，返回的是分享者的成绩", async () => {
    const repo = new InMemoryRepository();
    const sharerId = newUuid();
    const viewerId = newUuid();
    await repo.users.insert(makeUser(sharerId, {
      nickname: "Sharer",
      career_points: 40,
    }));
    await repo.users.insert(makeUser(viewerId, {
      nickname: "Viewer",
      career_points: 7,
    }));
    const match = makeSettledMatch();
    await repo.matches.insert(match);
    await repo.predictions.insert(makePrediction(sharerId, match.match_id, {
      match_score: 12,
      wdl_hit: true,
      exact_hit: true,
    }));
    await repo.predictions.insert(makePrediction(viewerId, match.match_id, {
      match_score: 3,
      wdl_hit: true,
      exact_hit: false,
      pred_home_score: 1,
      pred_away_score: 0,
    }));

    const response = await getShareCardForUser(new ShareCardQueryService(repo), {
      user_id: sharerId,
      query: { league_id: MVP_SEASON.league_id, season_id: MVP_SEASON.season_id, round_id: "01" },
      server_now: NOW,
      request_id: "request-share-card-for-user-sharer",
    });

    expect(response.status).toBe(200);
    expect(response.body.data.user_id).toBe(sharerId);
    expect(response.body.data.display_name).toBe("Sharer");
    expect(response.body.data.round_score).toBe(12);
    expect(response.body.data.round_exact_hits).toBe(1);
    expect(response.body.data.career_points).toBe(40);
  });

  it("用户不存在时抛 USER_NOT_FOUND", async () => {
    const repo = new InMemoryRepository();
    await repo.matches.insert(makeMatch());

    await expect(getShareCardForUser(new ShareCardQueryService(repo), {
      user_id: newUuid(),
      query: { league_id: MVP_SEASON.league_id, season_id: MVP_SEASON.season_id, round_id: "01" },
      server_now: NOW,
      request_id: "request-share-card-for-user-missing",
    })).rejects.toMatchObject({
      code: "USER_NOT_FOUND",
    });
  });

  it("[D-S1-03] 用户已注销时返回 200 脱敏展示且不泄露未截止预测", async () => {
    const repo = new InMemoryRepository();
    const userId = newUuid();
    await repo.users.insert(makeUser(userId, {
      status: "deleted",
      nickname: null,
      favorite_team_id: newUuid(),
      deleted_at: NOW,
    }));
    const openMatch = makeMatch({
      prediction_deadline_at: new Date(NOW.getTime() + 60 * 60 * 1000),
      prediction_closed_at: null,
    });
    const settledMatch = makeSettledMatch();
    await repo.matches.insert(openMatch);
    await repo.matches.insert(settledMatch);
    await repo.predictions.insert(makePrediction(userId, openMatch.match_id, {
      match_score: null,
      wdl_hit: null,
      exact_hit: null,
      applied_result_version: 0,
    }));
    await repo.predictions.insert(makePrediction(userId, settledMatch.match_id));

    const service = new ShareCardQueryService(repo, TEST_SHARE_SECRET);
    const oldToken = service.generateShareToken(userId, {
      league_id: MVP_SEASON.league_id,
      season_id: MVP_SEASON.season_id,
      round_id: "01",
    });

    const response = await getShareCardForUser(service, {
      user_id: userId,
      query: {
        league_id: MVP_SEASON.league_id,
        season_id: MVP_SEASON.season_id,
        round_id: "01",
        share_token: oldToken ?? "",
      },
      server_now: NOW,
      request_id: "request-share-card-for-user-deleted",
    });

    expect(response.status).toBe(200);
    expect(response.body.data.display_name).toBe("已注销用户");
    expect(response.body.data.favorite_team_id).toBeNull();
    expect(response.body.data.share_token).toBeNull();
    expect(response.body.data.matches.map((item) => item.match_id)).toEqual([settledMatch.match_id]);
  });

  it("未接入轮次时抛 ROUND_NOT_FOUND", async () => {
    const repo = new InMemoryRepository();
    const userId = newUuid();
    await repo.users.insert(makeUser(userId));
    await repo.matches.insert(makeMatch({ round_id: "01" }));

    await expect(getShareCardForUser(new ShareCardQueryService(repo, TEST_SHARE_SECRET), {
      user_id: userId,
      query: { league_id: MVP_SEASON.league_id, season_id: MVP_SEASON.season_id, round_id: "00" },
      server_now: NOW,
      request_id: "request-share-card-for-user-round",
    })).rejects.toMatchObject({
      code: "ROUND_NOT_FOUND",
    });
  });

  it("validatePublicShareCardQuery 接受可选 share_token 并拒绝未知字段", () => {
    expect(validatePublicShareCardQuery({
      league_id: MVP_SEASON.league_id,
      season_id: MVP_SEASON.season_id,
      round_id: "01",
      share_token: "abc_123",
    })).toEqual({
      league_id: MVP_SEASON.league_id,
      season_id: MVP_SEASON.season_id,
      round_id: "01",
      share_token: "abc_123",
    });
    expect(() => validatePublicShareCardQuery({
      league_id: MVP_SEASON.league_id,
      season_id: MVP_SEASON.season_id,
      round_id: "01",
      cursor: "x",
    })).toThrow(DomainError);
  });

  it("持有有效 share_token 或本人登录态时返回未截止预测，否则严格过滤并校验 OpenAPI schema", async () => {
    const repo = new InMemoryRepository();
    const sharerId = newUuid();
    const viewerId = newUuid();
    await repo.users.insert(makeUser(sharerId, { nickname: "Sharer" }));
    await repo.users.insert(makeUser(viewerId, { nickname: "Viewer" }));
    const openMatch = makeMatch({
      kickoff_at: new Date("2026-08-12T18:00:00.000Z"),
      prediction_deadline_at: new Date("2026-08-12T17:50:00.000Z"),
      prediction_closed_at: null,
    });
    const settledMatch = makeSettledMatch({
      kickoff_at: new Date("2026-08-10T18:00:00.000Z"),
    });
    await repo.matches.insert(openMatch);
    await repo.matches.insert(settledMatch);
    await repo.predictions.insert(makePrediction(sharerId, openMatch.match_id, {
      pred_home_score: 4,
      pred_away_score: 2,
      match_score: null,
      wdl_hit: null,
      exact_hit: null,
      applied_result_version: 0,
    }));
    await repo.predictions.insert(makePrediction(sharerId, settledMatch.match_id));

    const service = new ShareCardQueryService(repo, TEST_SHARE_SECRET);
    const me = await getShareCardMe(service, {
      authenticated_user_id: sharerId,
      query: { league_id: MVP_SEASON.league_id, season_id: MVP_SEASON.season_id, round_id: "01" },
      server_now: NOW,
      request_id: "req-me",
    });
    expect(me.body.data.share_token).toEqual(expect.any(String));
    expect(me.body.data.matches).toHaveLength(2);

    const noToken = await getShareCardForUser(service, {
      user_id: sharerId,
      authenticated_user_id: viewerId,
      query: { league_id: MVP_SEASON.league_id, season_id: MVP_SEASON.season_id, round_id: "01" },
      server_now: NOW,
      request_id: "req-no-token",
    });
    expect(noToken.body.data.share_token).toBeNull();
    expect(noToken.body.data.matches.map((m) => m.match_id)).toEqual([settledMatch.match_id]);

    const badToken = await getShareCardForUser(service, {
      user_id: sharerId,
      query: {
        league_id: MVP_SEASON.league_id,
        season_id: MVP_SEASON.season_id,
        round_id: "01",
        share_token: "bad-token",
      },
      server_now: NOW,
      request_id: "req-bad-token",
    });
    expect(badToken.body.data.share_token).toBeNull();
    expect(badToken.body.data.matches.map((m) => m.match_id)).toEqual([settledMatch.match_id]);

    const validToken = await getShareCardForUser(service, {
      user_id: sharerId,
      query: {
        league_id: MVP_SEASON.league_id,
        season_id: MVP_SEASON.season_id,
        round_id: "01",
        share_token: me.body.data.share_token ?? "",
      },
      server_now: NOW,
      request_id: "req-valid-token",
    });
    expect(validToken.body.data.share_token).toBe(me.body.data.share_token);
    expect(validToken.body.data.matches.map((m) => m.match_id)).toEqual([
      settledMatch.match_id,
      openMatch.match_id,
    ]);

    const rawSpec = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
    const spec = YAML.parse(rawSpec) as { components: { schemas: Record<string, unknown> } };
    const ajv = new Ajv({ nullable: false, allErrors: true });
    ajv.addSchema({ $id: "https://football.local/openapi.json", components: spec.components });
    const validate = ajv.compile({
      $ref: "https://football.local/openapi.json#/components/schemas/ShareCardEnvelope",
    });
    expect(validate(me.body)).toBe(true);
    expect(validate(noToken.body)).toBe(true);
    expect(validate(validToken.body)).toBe(true);
  });
});
