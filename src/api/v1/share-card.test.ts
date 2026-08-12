import { describe, expect, it } from "vitest";
import { MVP_SEASON } from "../../domain/config.js";
import { newUuid } from "../../domain/ids.js";
import { InMemoryRepository } from "../../infrastructure/repositories.js";
import { ShareCardQueryService } from "../../application/share-card.js";
import { DomainError } from "../../domain/errors.js";
import {
  getShareCardMe,
  validateShareCardQuery,
} from "./share-card.js";
import { InMemoryRateLimiter } from "./rate-limit.js";

describe("share-card API query", () => {
  it("要求显式 season_id/round_id，并拒绝未知值与未知参数", () => {
    expect(validateShareCardQuery({ season_id: MVP_SEASON.season_id, round_id: "01" })).toEqual({
      season_id: MVP_SEASON.season_id,
      round_id: "01",
    });

    for (const query of [
      { round_id: "01" },
      { season_id: MVP_SEASON.season_id },
      { season_id: "2027_2028", round_id: "01" },
      { season_id: MVP_SEASON.season_id, round_id: "00" },
      { season_id: MVP_SEASON.season_id, round_id: "39" },
      { season_id: MVP_SEASON.season_id, round_id: "01", cursor: "x" },
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
    await repo.users.insert({
      schema_version: 1,
      user_id: userId,
      openid: "openid_share_card_api",
      unionid: null,
      nickname: "Sky",
      favorite_team_id: null,
      status: "active",
      career_points: 0,
      career_valid_predictions: 0,
      career_wdl_hits: 0,
      career_exact_hits: 0,
      career_level: 1,
      career_best_level: 1,
      deleted_at: null,
      created_at: new Date("2026-08-01T00:00:00Z"),
      updated_at: new Date("2026-08-01T00:00:00Z"),
    });

    const response = await getShareCardMe(new ShareCardQueryService(repo), {
      authenticated_user_id: userId,
      query: { season_id: MVP_SEASON.season_id, round_id: "01" },
      server_now: new Date("2026-08-11T00:00:00.000Z"),
      request_id: "request-share-card-1",
    });

    expect(response.status).toBe(200);
    expect(response.body.request_id).toBe("request-share-card-1");
    expect(response.body.data).toEqual({
      user_id: userId,
      display_name: "Sky",
      favorite_team_id: null,
      season_level: 1,
      round_id: "01",
      round_predictions: 0,
      round_wdl_hits: 0,
      round_exact_hits: 0,
      round_score: 0,
      career_points: 0,
    });
  });

  it("没有认证用户时拒绝访问", async () => {
    await expect(
      getShareCardMe(new ShareCardQueryService(new InMemoryRepository()), {
        authenticated_user_id: null,
        query: { season_id: MVP_SEASON.season_id, round_id: "01" },
        server_now: new Date("2026-08-11T00:00:00.000Z"),
        request_id: "request-share-card-2",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("按 authenticated user 每分钟限制 120 次分享卡读取", async () => {
    const repo = new InMemoryRepository();
    const userId = newUuid();
    const serverNow = new Date("2026-08-11T00:00:00.000Z");
    await repo.users.insert({
      schema_version: 1,
      user_id: userId,
      openid: "openid_share_card_rate_limit",
      unionid: null,
      nickname: "Sky",
      favorite_team_id: null,
      status: "active",
      career_points: 0,
      career_valid_predictions: 0,
      career_wdl_hits: 0,
      career_exact_hits: 0,
      career_level: 1,
      career_best_level: 1,
      deleted_at: null,
      created_at: serverNow,
      updated_at: serverNow,
    });
    const rateLimiter = new InMemoryRateLimiter();
    const input = {
      authenticated_user_id: userId,
      query: { season_id: MVP_SEASON.season_id, round_id: "01" },
      request_id: "request-share-card-rate-limit",
      server_now: serverNow,
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
});
