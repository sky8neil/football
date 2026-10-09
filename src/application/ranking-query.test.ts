import { describe, expect, it } from "vitest";
import { GroupMemberStatus, GroupStatus, PeriodType, RankingBoard, RankingScope, UserStatus } from "../domain/enums.js";
import type {
  BoardSnapshot,
  Group,
  GroupMember,
  RankingEntry,
  User,
  UserSeasonStats,
} from "../domain/types.js";
import { defaultLevelState } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import {
  computeAvailableBoards,
  RankingCursorCodec,
  RankingQueryService,
} from "./ranking-query.js";
import { GroupsService } from "./groups.js";
import { RebuildPeriodRankingsService } from "./ranking-rebuild-service.js";
import { BoardSnapshotService } from "./board-snapshot.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const WEEK_KEY = "2026-W32";
const SECRET = "ranking-cursor-secret";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function makeUser(userId: string, overrides: Partial<User> = {}): User {
  return {
    schema_version: 1,
    user_id: userId,
    openid: `openid-${userId}`,
    unionid: null,
    nickname: `user-${userId.slice(-2)}`,
    favorite_team_id: null,
    status: UserStatus.Active,
    career_points: 30,
    career_valid_predictions: 5,
    career_wdl_hits: 1,
    career_exact_hits: 1,
    career_last_scoring_match_at: new Date("2026-08-08T14:00:00.000Z"),
    career_level: 1,
    career_best_level: 1,
    career_level_state: defaultLevelState(),
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeRanking(userId: string, rank: number, overrides: Partial<RankingEntry> = {}): RankingEntry {
  return {
    schema_version: 1,
    period_type: PeriodType.Week,
    period_key: WEEK_KEY,
    user_id: userId,
    period_score: 100 - rank,
    valid_predictions: 5,
    wdl_hits: 4,
    exact_hits: 1,
    last_scoring_match_at: new Date("2026-08-08T14:00:00.000Z"),
    global_rank: rank,
    is_final: false,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeSnapshot(board: "career" | "strength", userId: string, rank: number, at = NOW): BoardSnapshot {
  return {
    schema_version: 1,
    snapshot_id: `${board}-${userId}-${at.toISOString()}`,
    board,
    snapshot_at: at,
    level_season_id: null,
    is_final: false,
    user_id: userId,
    rank,
    career_points: board === RankingBoard.Career ? 100 - rank : null,
    career_exact_hits: board === RankingBoard.Career ? 1 : null,
    career_valid_predictions: board === RankingBoard.Career ? 5 : null,
    career_last_scoring_match_at: board === RankingBoard.Career ? NOW : null,
    window_score_sum: board === RankingBoard.Strength ? 120 : null,
    window_n: board === RankingBoard.Strength ? 50 : null,
    season_points: null,
    season_exact_hits: null,
    season_valid_predictions: null,
    season_last_scoring_match_at: null,
    created_at: at,
  };
}

function makeSeasonSnapshot(
  userId: string,
  rank: number,
  points: number,
  seasonId = "2026_2027",
  at = NOW,
): BoardSnapshot {
  return {
    schema_version: 1,
    snapshot_id: `season-${userId}-${seasonId}-${at.toISOString()}`,
    board: RankingBoard.Season,
    snapshot_at: at,
    level_season_id: seasonId,
    is_final: false,
    user_id: userId,
    rank,
    career_points: null,
    career_exact_hits: null,
    career_valid_predictions: null,
    career_last_scoring_match_at: null,
    window_score_sum: null,
    window_n: null,
    season_points: points,
    season_exact_hits: 1,
    season_valid_predictions: 2,
    season_last_scoring_match_at: at,
    created_at: at,
  };
}

function makeSeasonStats(
  userId: string,
  levelSeasonId: string,
  overrides: Partial<UserSeasonStats> = {},
): UserSeasonStats {
  return {
    schema_version: 1,
    user_id: userId,
    level_season_id: levelSeasonId,
    points: 12,
    valid_predictions: 2,
    wdl_hits: 1,
    exact_hits: 1,
    last_scoring_match_at: NOW,
    level: 1,
    best_level: 1,
    level_state: defaultLevelState(),
    is_level_frozen: false,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeGroup(): Group {
  return {
    schema_version: 1,
    group_id: id(900),
    owner_user_id: id(1),
    invite_code: "ABCDEFGH",
    status: GroupStatus.Active,
    member_count: 3,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeMember(userId: string, status: GroupMember["status"] = GroupMemberStatus.Active): GroupMember {
  return {
    schema_version: 1,
    group_id: id(900),
    user_id: userId,
    status,
    joined_at: NOW,
    left_at: status === GroupMemberStatus.Left ? NOW : null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function query(overrides: Partial<Parameters<RankingQueryService["list"]>[0]> = {}) {
  return {
    board: RankingBoard.Week,
    period_key: WEEK_KEY,
    scope: RankingScope.Global,
    group_id: null,
    limit: 20,
    cursor: null,
    server_now: NOW,
    authenticated_user_id: null,
    ...overrides,
  };
}

describe("RankingQueryService v2", () => {
  it("computes available boards from range counts and requester eligibility", () => {
    expect(computeAvailableBoards({
      scope: RankingScope.Global,
      seasons_participated: 1,
      strength_window_n: 49,
      career_entry_count: 0,
      current_season_entry_count: 0,
      previous_season_entry_count: 10,
    })).toEqual([RankingBoard.Week]);
    expect(computeAvailableBoards({
      scope: RankingScope.Global,
      seasons_participated: 2,
      strength_window_n: 50,
      career_entry_count: 2,
      current_season_entry_count: 0,
      previous_season_entry_count: 10,
    })).toEqual([
      RankingBoard.Week,
      RankingBoard.Career,
      RankingBoard.Strength,
      RankingBoard.Season,
    ]);
    expect(computeAvailableBoards({
      scope: RankingScope.Group,
      seasons_participated: 2,
      strength_window_n: 50,
      career_entry_count: 0,
      current_season_entry_count: 0,
      previous_season_entry_count: 10,
    })).toEqual([RankingBoard.Week, RankingBoard.Strength]);
  });

  it("K86 周榜不返回准确率字段，并为已入榜用户生成 me", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser(id(1));
    await repo.users.insert(user);
    await repo.rankings.insert(makeRanking(user.user_id, 1));

    const result = await new RankingQueryService(repo, SECRET).list(query({ authenticated_user_id: user.user_id }));

    expect(result.items[0]).toMatchObject({ rank: 1, user_id: user.user_id, period_score: 99, valid_predictions: 5, exact_hits: 1 });
    expect(result.items[0]).not.toHaveProperty("wdl_accuracy_percent");
    expect(result).toMatchObject({ updated_at: NOW.toISOString(), me: { status: "ranked", rank: 1, top_percent: null } });
    expect(result.current_period_key).toBe("2026-W32");
  });

  it("K82/K83：top_percent 使用 ceil 并将末位夹到 99", async () => {
    const repo = new InMemoryRepository();
    for (let rank = 1; rank <= 100; rank += 1) {
      const user = makeUser(id(rank));
      await repo.users.insert(user);
      await repo.rankings.insert(makeRanking(user.user_id, rank));
    }
    const service = new RankingQueryService(repo, SECRET);

    const atTwentyOne = await service.list(query({ authenticated_user_id: id(21) }));
    expect(atTwentyOne.me).toEqual({ status: "ranked", rank: null, top_percent: 21 });
    const atLast = await service.list(query({ authenticated_user_id: id(100) }));
    expect(atLast.me).toEqual({ status: "ranked", rank: null, top_percent: 99 });
  });

  it("未登录不返回 me，未入快照用户按 not_participated/below_threshold 返回", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser(id(1), { career_valid_predictions: 0, career_wdl_hits: 0, career_exact_hits: 0 });
    const lowStrengthUser = makeUser(id(2), {
      career_level_state: { ...defaultLevelState(), last_eval_n: 45, last_eval_score_sum: 50 },
    });
    await repo.users.insert(user);
    await repo.users.insert(lowStrengthUser);

    const service = new RankingQueryService(repo, SECRET);
    expect(await service.list(query())).not.toHaveProperty("me");
    expect((await service.list(query({ authenticated_user_id: user.user_id }))).me).toEqual({
      status: "not_participated",
    });
    expect((await service.list(query({ board: RankingBoard.Strength, period_key: null, authenticated_user_id: lowStrengthUser.user_id }))).me).toEqual({
      status: "below_threshold",
      remaining_valid_predictions: 5,
    });

    const missingCareerSnapshotUser = makeUser(id(3), { career_valid_predictions: 10 });
    const missingStrengthSnapshotUser = makeUser(id(4), {
      career_level_state: { ...defaultLevelState(), last_eval_n: 50, last_eval_score_sum: 100 },
    });
    await repo.users.insert(missingCareerSnapshotUser);
    await repo.users.insert(missingStrengthSnapshotUser);
    expect((await service.list(query({ authenticated_user_id: missingCareerSnapshotUser.user_id }))).me)
      .toEqual({ status: "not_participated" });
    expect((await service.list(query({
      board: RankingBoard.Strength,
      period_key: null,
      authenticated_user_id: missingStrengthSnapshotUser.user_id,
    }))).me).toEqual({ status: "not_participated" });
  });

  it("读取 career/strength 最新快照并按当前用户资料展示", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser(id(1)));
    await repo.users.insert(makeUser(id(2), {
      career_level_state: { ...defaultLevelState(), last_eval_n: 50, last_eval_score_sum: 120 },
    }));
    await repo.boardSnapshots.insert(makeSnapshot(RankingBoard.Career, id(1), 4, new Date("2026-08-01T00:00:00Z")));
    await repo.boardSnapshots.insert(makeSnapshot(RankingBoard.Career, id(1), 1, NOW));
    await repo.boardSnapshots.insert(makeSnapshot(RankingBoard.Strength, id(2), 2, new Date("2026-08-01T00:00:00Z")));
    await repo.boardSnapshots.insert(makeSnapshot(RankingBoard.Strength, id(2), 1, NOW));

    const service = new RankingQueryService(repo, SECRET);
    const result = await service.list(query({ board: RankingBoard.Career, period_key: null }));
    expect(result.updated_at).toBe(NOW.toISOString());
    expect(result.items[0]).toMatchObject({ rank: 1, career_points: 99, career_valid_predictions: 5 });
    const strength = await service.list(query({ board: RankingBoard.Strength, period_key: null }));
    expect(strength.items[0]).toMatchObject({ rank: 1, strength_index: "2.08", window_n: 50 });
  });

  it("season 列表照常包含首赛季用户，但 me 不泄漏名次", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser(id(1));
    await repo.users.insert(user);
    await repo.userSeasonStats.insert(makeSeasonStats(user.user_id, "2026_2027"));
    await repo.boardSnapshots.insert(makeSeasonSnapshot(user.user_id, 1, 24));

    const result = await new RankingQueryService(repo, SECRET).list(query({
      board: RankingBoard.Season,
      period_key: null,
      authenticated_user_id: user.user_id,
    }));

    expect(result).toMatchObject({
      level_season_id: "2026_2027",
      is_provisional: false,
      entry_count: 1,
      items: [{ rank: 1, user_id: user.user_id, season_points: 24 }],
      me: { status: "not_eligible", seasons_participated: 1 },
      available_boards: [RankingBoard.Week],
    });
  });

  it("uses the previous season's latest snapshot provisionally during the new-season gap", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser(id(1));
    const previousSnapshotAt = new Date("2026-06-30T10:00:00.000Z");
    await repo.users.insert(user);
    await repo.userSeasonStats.insert(makeSeasonStats(user.user_id, "2025_2026"));
    await repo.boardSnapshots.insert(makeSeasonSnapshot(
      user.user_id,
      1,
      48,
      "2025_2026",
      previousSnapshotAt,
    ));

    const result = await new RankingQueryService(repo, SECRET).list(query({
      board: RankingBoard.Season,
      period_key: null,
      authenticated_user_id: user.user_id,
    }));

    expect(result).toMatchObject({
      level_season_id: "2025_2026",
      is_provisional: true,
      updated_at: previousSnapshotAt.toISOString(),
      entry_count: 1,
      items: [{ rank: 1, user_id: user.user_id, season_points: 48 }],
    });
  });

  it("does not treat an empty previous-season sentinel as a provisional board", async () => {
    const repo = new InMemoryRepository();
    const previousSnapshotAt = new Date("2026-06-30T10:00:00.000Z");
    await repo.users.insert(makeUser(id(1)));
    await new RebuildPeriodRankingsService(repo).rebuildBoardSnapshot(
      RankingBoard.Season,
      previousSnapshotAt,
    );

    const result = await new RankingQueryService(repo, SECRET).list(query({
      board: RankingBoard.Season,
      period_key: null,
      authenticated_user_id: id(1),
    }));

    expect(result).toMatchObject({
      level_season_id: "2026_2027",
      is_provisional: false,
      updated_at: null,
      entry_count: 0,
      items: [],
      available_level_seasons: [],
    });
  });

  it("first operational season defaults to an empty non-provisional board", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser(id(1));
    await repo.users.insert(user);

    const result = await new RankingQueryService(repo, SECRET).list(query({
      board: RankingBoard.Season,
      period_key: null,
      authenticated_user_id: user.user_id,
    }));

    expect(result).toMatchObject({
      level_season_id: "2026_2027",
      is_provisional: false,
      entry_count: 0,
      items: [],
      available_boards: [RankingBoard.Week],
      available_level_seasons: [],
    });
  });

  it("returns 404 only when an explicitly requested season has no snapshot data", async () => {
    const repo = new InMemoryRepository();
    const service = new RankingQueryService(repo, SECRET);
    await expect(service.list(query({
      board: RankingBoard.Season,
      period_key: null,
      level_season_id: "2024_2025",
    }))).rejects.toMatchObject({ code: "LEVEL_SEASON_NOT_FOUND" });
  });

  it("serves explicit historical final snapshots with frozen ranks and deleted users", async () => {
    const repo = new InMemoryRepository();
    const deleted = makeUser(id(1), { status: "deleted", deleted_at: NOW });
    await repo.users.insert(deleted);
    await repo.userSeasonStats.insert(makeSeasonStats(deleted.user_id, "2025_2026", {
      valid_predictions: 3,
    }));
    const regular = makeSeasonSnapshot(deleted.user_id, 1, 24, "2025_2026", NOW);
    const final = {
      ...makeSeasonSnapshot(deleted.user_id, 3, 36, "2025_2026", new Date(NOW.getTime() + 60_000)),
      is_final: true,
    };
    await repo.boardSnapshots.insert(regular);
    await repo.boardSnapshots.insert(final);

    const result = await new RankingQueryService(repo, SECRET).list(query({
      board: RankingBoard.Season,
      period_key: null,
      level_season_id: "2025_2026",
    }));

    expect(result).toMatchObject({
      level_season_id: "2025_2026",
      is_provisional: false,
      updated_at: final.snapshot_at.toISOString(),
      entry_count: 1,
      items: [{ rank: 3, display_name: "已注销用户", season_points: 36 }],
      available_level_seasons: ["2025_2026"],
    });
  });

  it("lists only nonempty current, previous and final seasons, retaining deleted historical entrants", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser(id(1)));
    await repo.users.insert(makeUser(id(2), { status: UserStatus.Deleted, deleted_at: NOW }));
    await repo.boardSnapshots.insert(makeSeasonSnapshot(id(1), 1, 24));
    await repo.boardSnapshots.insert(makeSeasonSnapshot(id(1), 1, 24, "2025_2026", new Date("2026-06-30T00:00:00Z")));
    await repo.boardSnapshots.insert({
      ...makeSeasonSnapshot(id(2), 1, 24, "2024_2025"),
      is_final: true,
    });
    await new BoardSnapshotService(repo).generateSeasonFinal("2023_2024", NOW);
    const result = await new RankingQueryService(repo, SECRET).list(query({
      board: RankingBoard.Season,
      period_key: null,
    }));
    expect(result.available_level_seasons).toEqual(["2026_2027", "2025_2026", "2024_2025"]);
  });

  it("omits a current season whose only entrant has been deleted", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser(id(1), { status: UserStatus.Deleted, deleted_at: NOW }));
    await repo.boardSnapshots.insert(makeSeasonSnapshot(id(1), 1, 24));
    const result = await new RankingQueryService(repo, SECRET).list(query({
      board: RankingBoard.Season,
      period_key: null,
    }));
    expect(result.available_level_seasons).toEqual([]);
  });

  it("paginates an explicit historical final season snapshot", async () => {
    const repo = new InMemoryRepository();
    for (let rank = 1; rank <= 11; rank += 1) {
      const user = makeUser(id(rank));
      await repo.users.insert(user);
      await repo.boardSnapshots.insert({
        ...makeSeasonSnapshot(user.user_id, rank, 100 - rank, "2025_2026"),
        is_final: true,
      });
    }
    const service = new RankingQueryService(repo, SECRET);
    const firstPage = await service.list(query({
      board: RankingBoard.Season,
      period_key: null,
      level_season_id: "2025_2026",
      limit: 10,
    }));
    const secondPage = await service.list(query({
      board: RankingBoard.Season,
      period_key: null,
      level_season_id: "2025_2026",
      cursor: firstPage.next_cursor,
      limit: 10,
    }));

    expect(firstPage).toMatchObject({
      items: Array.from({ length: 10 }, (_, index) => ({ rank: index + 1 })),
      has_more: true,
    });
    expect(secondPage).toMatchObject({
      items: [{ rank: 11 }],
      has_more: false,
      next_cursor: null,
    });
  });

  it("defaults to the previous week on Monday and walks back within the selectable window", async () => {
    const monday = new Date("2026-08-09T16:00:00.000Z");
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser(id(1)));
    await repo.rankings.insert(makeRanking(id(1), 1, { period_key: "2026-W31" }));

    const result = await new RankingQueryService(repo, SECRET, { firstPeriodKey: "2026-W31" }).list(query({
      period_key: null,
      server_now: monday,
    }));

    expect(result).toMatchObject({
      current_period_key: "2026-W33",
      period_key: "2026-W31",
      entry_count: 1,
      items: [{ user_id: id(1) }],
    });
  });

  it("does not backtrack beyond four weeks or accept a period before the injected launch week", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser(id(1)));
    await repo.rankings.insert(makeRanking(id(1), 1, { period_key: "2026-W31" }));
    const service = new RankingQueryService(repo, SECRET, { firstPeriodKey: "2026-W31" });

    const outsideWindow = await service.list(query({
      period_key: null,
      server_now: new Date("2026-08-24T12:00:00.000Z"),
    }));
    expect(outsideWindow).toMatchObject({ period_key: "2026-W34", entry_count: 0, items: [] });
    await expect(service.list(query({ period_key: "2026-W30" })))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(new RankingQueryService(repo, SECRET, { firstPeriodKey: "2026-W32" })
      .list(query({ period_key: "2026-W31" })))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("按周期结束边界保留历史周榜注销用户及 global_rank", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser(id(1)));
    await repo.users.insert(makeUser(id(2), { status: UserStatus.Deleted, nickname: null, deleted_at: NOW }));
    await repo.rankings.insert(makeRanking(id(2), 1, { is_final: true }));
    await repo.rankings.insert(makeRanking(id(1), 2));
    await repo.rankings.insert(makeRanking(id(2), 1, { period_key: "2026-W31", is_final: false }));
    await repo.rankings.insert(makeRanking(id(1), 2, { period_key: "2026-W31", is_final: false }));
    const service = new RankingQueryService(repo, SECRET);

    const current = await service.list(query());
    expect(current.items.map((item) => [item.user_id, item.rank])).toEqual([[id(1), 1]]);
    const history = await service.list(query({ period_key: "2026-W31" }));
    expect(history.items.map((item) => [item.user_id, item.rank, item.display_name])).toEqual([
      [id(2), 1, "已注销用户"], [id(1), 2, "user-01"],
    ]);
  });

  it("K84：群榜仅保留 active 成员、独立重排，退群后立即消失", async () => {
    const repo = new InMemoryRepository();
    const group = makeGroup();
    await repo.groups.insert(group);
    for (let userNo = 1; userNo <= 3; userNo += 1) {
      await repo.users.insert(makeUser(id(userNo)));
      const rank = userNo === 2 ? 1 : userNo === 1 ? 2 : 3;
      await repo.rankings.insert(makeRanking(id(userNo), rank));
    }
    await repo.groupMembers.insert(makeMember(id(1)));
    await repo.groupMembers.insert(makeMember(id(2), GroupMemberStatus.Left));
    await repo.groupMembers.insert(makeMember(id(3)));
    const service = new RankingQueryService(repo, SECRET);
    const input = query({ scope: RankingScope.Group, group_id: group.group_id, authenticated_user_id: id(1) });

    const beforeLeave = await service.list(input);
    expect(beforeLeave.items.map((item) => [item.user_id, item.rank])).toEqual([[id(1), 1], [id(3), 2]]);
    await repo.groupMembers.update(makeMember(id(3), GroupMemberStatus.Left));
    const afterLeave = await service.list(input);
    expect(afterLeave.items.map((item) => [item.user_id, item.rank])).toEqual([[id(1), 1]]);
    await expect(service.list({ ...input, authenticated_user_id: id(3) })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await repo.groups.update({ ...group, status: GroupStatus.Dissolved });
    await expect(service.list(input)).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });
  });

  it("R2：经 GroupsService 解散后群榜返回 GROUP_NOT_FOUND", async () => {
    const repo = new InMemoryRepository();
    const group = makeGroup();
    await repo.groups.insert(group);
    await repo.users.insert(makeUser(id(1)));
    await repo.rankings.insert(makeRanking(id(1), 1));
    await repo.groupMembers.insert(makeMember(id(1)));
    const groupsService = new GroupsService(repo, { cursorSecret: SECRET });
    const service = new RankingQueryService(repo, SECRET);
    const input = query({ scope: RankingScope.Group, group_id: group.group_id, authenticated_user_id: id(1) });

    expect((await service.list(input)).items).toHaveLength(1);
    await groupsService.dissolveGroup(id(1), group.group_id, NOW);
    await expect(service.list(input)).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });
  });

  it("K87：明确请求第 3 页时返回空列表和 null cursor", async () => {
    const repo = new InMemoryRepository();
    for (let rank = 1; rank <= 20; rank += 1) {
      await repo.users.insert(makeUser(id(rank)));
      await repo.rankings.insert(makeRanking(id(rank), rank));
    }
    const service = new RankingQueryService(repo, SECRET);
    const firstPage = await service.list(query({ period_key: null }));
    const secondPage = await service.list(query({
      period_key: null,
      cursor: firstPage.next_cursor,
      server_now: new Date("2026-08-09T16:00:00.000Z"),
    }));
    expect(secondPage.items).toHaveLength(10);
    expect(secondPage.items[0]?.rank).toBe(11);
    const cursor = new RankingCursorCodec(SECRET).encode({
      board: RankingBoard.Week,
      scope: RankingScope.Global,
      group_id: null,
      period_key: WEEK_KEY,
      level_season_id: null,
      offset: 20,
    });
    const result = await service.list(query({ cursor }));
    expect(result).toMatchObject({ items: [], has_more: false, next_cursor: null });
  });

  it("拒绝非法 board、非 week period_key 与非法分页参数", async () => {
    const service = new RankingQueryService(new InMemoryRepository(), SECRET);
    await expect(service.list(query({ board: "month" as never }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.list(query({ board: RankingBoard.Career, period_key: WEEK_KEY }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.list(query({ scope: RankingScope.Group, group_id: null }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.list(query({ scope: RankingScope.Global, group_id: id(1) }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
