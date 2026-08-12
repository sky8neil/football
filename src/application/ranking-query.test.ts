import { describe, expect, it } from "vitest";
import { PeriodType } from "../domain/enums.js";
import type { RankingEntry, User } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { RankingQueryService } from "./ranking-query.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const WEEK_KEY = "2026-W32";
const USER_1 = "00000000-0000-4000-8000-000000000001";
const USER_2 = "00000000-0000-4000-8000-000000000002";
const USER_3 = "00000000-0000-4000-8000-000000000003";

function makeUser(
  userId: string,
  overrides: Partial<User> = {},
): User {
  return {
    schema_version: 1,
    user_id: userId,
    openid: `openid-${userId}`,
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
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeRanking(
  userId: string,
  overrides: Partial<RankingEntry> = {},
): RankingEntry {
  return {
    schema_version: 1,
    period_type: PeriodType.Week,
    period_key: WEEK_KEY,
    user_id: userId,
    period_score: 33,
    valid_predictions: 3,
    wdl_hits: 2,
    exact_hits: 1,
    last_scoring_match_at: new Date("2026-08-08T14:00:00.000Z"),
    global_rank: 1,
    is_final: false,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe("RankingQueryService", () => {
  it("按 global_rank 返回符合最低场次的排名，并映射用户展示字段", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser(USER_1, { nickname: "Sky" }));
    await repo.users.insert(makeUser(USER_2, { nickname: "Moon" }));
    await repo.users.insert(makeUser(USER_3, {
      status: "deleted",
      nickname: null,
      deleted_at: NOW,
    }));
    await repo.rankings.insert(makeRanking(USER_2, {
      period_score: 20,
      wdl_hits: 3,
      exact_hits: 0,
      global_rank: 2,
    }));
    await repo.rankings.insert(makeRanking(USER_3, {
      period_score: 10,
      valid_predictions: 4,
      wdl_hits: 2,
      exact_hits: 0,
      global_rank: 3,
    }));
    await repo.rankings.insert(makeRanking(USER_1, {
      valid_predictions: 2,
      global_rank: null,
    }));

    await expect(new RankingQueryService(repo, "ranking-cursor-secret").list({
      period_type: PeriodType.Week,
      period_key: WEEK_KEY,
      limit: 20,
      cursor: null,
      server_now: NOW,
    })).resolves.toEqual({
      items: [
        {
          global_rank: 2,
          user_id: USER_2,
          display_name: "Moon",
          favorite_team_id: null,
          period_score: 20,
          valid_predictions: 3,
          wdl_hits: 3,
          exact_hits: 0,
          wdl_accuracy_percent: "100.0",
          last_scoring_match_at: "2026-08-08T14:00:00.000Z",
        },
        {
          global_rank: 3,
          user_id: USER_3,
          display_name: "已注销用户",
          favorite_team_id: null,
          period_score: 10,
          valid_predictions: 4,
          wdl_hits: 2,
          exact_hits: 0,
          wdl_accuracy_percent: "50.0",
          last_scoring_match_at: "2026-08-08T14:00:00.000Z",
        },
      ],
      has_more: false,
      next_cursor: null,
    });
  });

  it("使用签名 cursor 稳定翻页，并拒绝与 cursor 冲突的周期", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser(USER_1));
    await repo.users.insert(makeUser(USER_2));
    await repo.rankings.insert(makeRanking(USER_1, { global_rank: 1 }));
    await repo.rankings.insert(makeRanking(USER_2, { global_rank: 2 }));
    const service = new RankingQueryService(repo, "ranking-cursor-secret");

    const first = await service.list({
      period_type: PeriodType.Week,
      period_key: WEEK_KEY,
      limit: 1,
      cursor: null,
      server_now: NOW,
    });
    expect(first.items.map((item) => item.user_id)).toEqual([USER_1]);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toEqual(expect.any(String));

    await expect(service.list({
      period_type: PeriodType.Week,
      period_key: WEEK_KEY,
      limit: 1,
      cursor: first.next_cursor,
      server_now: NOW,
    })).resolves.toMatchObject({
      items: [expect.objectContaining({ user_id: USER_2, global_rank: 2 })],
      has_more: false,
      next_cursor: null,
    });

    await expect(service.list({
      period_type: PeriodType.Month,
      period_key: "2026-08",
      limit: 1,
      cursor: first.next_cursor,
      server_now: NOW,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("未传 period_key 时使用 server_now 周期，并拒绝非法游标", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser(USER_1));
    const service = new RankingQueryService(repo, "ranking-cursor-secret");

    await expect(service.list({
      period_type: PeriodType.Week,
      period_key: null,
      limit: 20,
      cursor: "invalid",
      server_now: NOW,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await expect(service.list({
      period_type: PeriodType.Week,
      period_key: null,
      limit: 20,
      cursor: null,
      server_now: NOW,
    })).resolves.toMatchObject({
      items: [],
    });
  });
});
