import { describe, expect, it } from "vitest";
import { MatchScoreValue, RankingBoard, RankingScope, Result } from "../domain/enums.js";
import {
  defaultLevelState,
  type Prediction,
  type User,
  type UserSeasonStats,
} from "../domain/types.js";
import { InMemoryRepository, type UnitOfWork } from "../infrastructure/repositories.js";
import { BoardSnapshotService, boardSnapshotJobLockKey } from "./board-snapshot.js";
import { RankingQueryService } from "./ranking-query.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");

function makeUser(userId: string, overrides: Partial<User> = {}): User {
  return {
    schema_version: 1,
    user_id: userId,
    openid: `openid_${userId}`,
    unionid: null,
    nickname: userId,
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

function makePrediction(overrides: Partial<Prediction> = {}): Prediction {
  return {
    schema_version: 1,
    prediction_id: "prediction-1",
    user_id: "career-winner",
    match_id: "match-1",
    idempotency_key: "prediction-key-1",
    pred_home_score: 2,
    pred_away_score: 1,
    derived_result: Result.Home,
    submitted_at: NOW,
    scoring_rule_version: "scoring_v1",
    match_score: MatchScoreValue.Miss,
    wdl_hit: false,
    exact_hit: false,
    applied_result_version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeSeasonStats(
  userId: string,
  overrides: Partial<UserSeasonStats> = {},
): UserSeasonStats {
  return {
    schema_version: 1,
    user_id: userId,
    level_season_id: "2026_2027",
    points: 0,
    valid_predictions: 0,
    wdl_hits: 0,
    exact_hits: 0,
    last_scoring_match_at: null,
    level: 1,
    best_level: 1,
    level_state: defaultLevelState(),
    is_level_frozen: false,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe("BoardSnapshotService", () => {
  it("generates sorted career snapshots from active users and appends versions", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser("career-winner", {
      career_points: 24,
      career_wdl_hits: 2,
      career_exact_hits: 2,
      career_valid_predictions: 3,
      career_last_scoring_match_at: new Date("2026-08-01T00:00:00.000Z"),
    }));
    await repo.users.insert(makeUser("career-runner", {
      career_points: 12,
      career_wdl_hits: 1,
      career_exact_hits: 1,
      career_valid_predictions: 1,
    }));
    await repo.users.insert(makeUser("career-ineligible", { career_points: 100 }));
    await repo.users.insert(makeUser("career-deleted", {
      status: "deleted",
      deleted_at: NOW,
      career_points: 1000,
      career_valid_predictions: 100,
    }));

    const service = new BoardSnapshotService(repo);
    const first = await service.generate(RankingBoard.Career, NOW);
    const secondAt = new Date(NOW.getTime() + 60_000);
    const second = await service.generate(RankingBoard.Career, secondAt);

    expect(first.map(({ user_id, rank }) => [user_id, rank])).toEqual([
      ["career-winner", 1],
      ["career-runner", 2],
    ]);
    expect(first[0]).toMatchObject({
      board: RankingBoard.Career,
      career_points: 24,
      career_exact_hits: 2,
      career_valid_predictions: 3,
      window_score_sum: null,
      window_n: null,
    });
    expect(second.every((snapshot) => snapshot.snapshot_at.getTime() === secondAt.getTime()))
      .toBe(true);
    await expect(repo.boardSnapshots.findByBoardAndSnapshotAt(RankingBoard.Career, NOW))
      .resolves.toHaveLength(2);
    await expect(repo.boardSnapshots.findByBoardAndSnapshotAt(RankingBoard.Career, secondAt))
      .resolves.toHaveLength(2);
  });

  it("includes only strength users with a 50-match evaluation window", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser("strength-eligible", {
      career_level_state: {
        ...defaultLevelState(),
        last_eval_n: 50,
        last_eval_score_sum: 350,
      },
    }));
    await repo.users.insert(makeUser("strength-below", {
      career_level_state: {
        ...defaultLevelState(),
        last_eval_n: 49,
        last_eval_score_sum: 490,
      },
    }));
    await repo.users.insert(makeUser("strength-deleted", {
      status: "deleted",
      deleted_at: NOW,
      career_level_state: {
        ...defaultLevelState(),
        last_eval_n: 100,
        last_eval_score_sum: 1200,
      },
    }));

    const snapshots = await new BoardSnapshotService(repo).generate(RankingBoard.Strength, NOW);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      user_id: "strength-eligible",
      board: RankingBoard.Strength,
      rank: 1,
      career_points: null,
      window_score_sum: 350,
      window_n: 50,
    });
  });

  it("generates a current season snapshot from eligible active users in ranking order", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser("season-winner"));
    await repo.users.insert(makeUser("season-runner"));
    await repo.users.insert(makeUser("season-ineligible"));
    await repo.users.insert(makeUser("season-deleted", { status: "deleted", deleted_at: NOW }));
    await repo.userSeasonStats?.insert(makeSeasonStats("season-winner", {
      points: 24,
      exact_hits: 2,
      wdl_hits: 2,
      valid_predictions: 3,
      last_scoring_match_at: new Date("2026-08-02T00:00:00.000Z"),
    }));
    await repo.userSeasonStats?.insert(makeSeasonStats("season-runner", {
      points: 12,
      exact_hits: 1,
      wdl_hits: 1,
      valid_predictions: 2,
    }));
    await repo.userSeasonStats?.insert(makeSeasonStats("season-ineligible", {
      points: 0,
    }));
    await repo.userSeasonStats?.insert(makeSeasonStats("season-deleted", {
      points: 1000,
      valid_predictions: 100,
    }));

    const snapshots = await new BoardSnapshotService(repo).generate(RankingBoard.Season, NOW);

    expect(snapshots.map(({ user_id, rank }) => [user_id, rank])).toEqual([
      ["season-winner", 1],
      ["season-runner", 2],
    ]);
    expect(snapshots[0]).toMatchObject({
      board: RankingBoard.Season,
      level_season_id: "2026_2027",
      season_points: 24,
      season_exact_hits: 2,
      season_valid_predictions: 3,
      career_points: null,
      window_score_sum: null,
    });
    expect(boardSnapshotJobLockKey(RankingBoard.Season)).toBe("sync:board_snapshot_season");
  });

  it("empty snapshot advances the latest version without exposing a sentinel entry", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser("career-user", { career_valid_predictions: 1 });
    await repo.users.insert(user);
    const service = new BoardSnapshotService(repo);
    await service.generate(RankingBoard.Career, NOW);

    const emptyAt = new Date(NOW.getTime() + 60_000);
    await repo.users.update({
      ...user,
      status: "deleted",
      deleted_at: emptyAt,
      updated_at: emptyAt,
    });
    await expect(service.generate(RankingBoard.Career, emptyAt)).resolves.toEqual([]);
    await expect(repo.boardSnapshots.findLatestByBoard(RankingBoard.Career)).resolves.toMatchObject([
      { snapshot_at: emptyAt, snapshot_kind: "head" },
    ]);

    const result = await new RankingQueryService(repo, "ranking-cursor-secret").list({
      board: RankingBoard.Career,
      period_key: null,
      scope: RankingScope.Global,
      group_id: null,
      limit: 20,
      cursor: null,
      server_now: emptyAt,
    });
    expect(result).toMatchObject({ updated_at: emptyAt.toISOString(), items: [] });
  });

  it("empty season snapshot sentinel carries the snapshot's level season", async () => {
    const repo = new InMemoryRepository();

    await expect(new BoardSnapshotService(repo).generate(RankingBoard.Season, NOW))
      .resolves.toEqual([]);
    await expect(repo.boardSnapshots.findLatestByBoard(RankingBoard.Season))
      .resolves.toMatchObject([{ snapshot_kind: "head", level_season_id: "2026_2027" }]);
  });

  it("freezes a season once and excludes final rows from regular snapshot reads", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser("season-final-user");
    await repo.users.insert(user);
    await repo.userSeasonStats?.insert(makeSeasonStats(user.user_id, {
      level_season_id: "2025_2026",
      points: 48,
      valid_predictions: 4,
      exact_hits: 2,
      wdl_hits: 3,
      last_scoring_match_at: new Date("2026-06-28T10:00:00.000Z"),
    }));
    const service = new BoardSnapshotService(repo);
    const finalizedAt = new Date("2026-07-06T02:10:00.000Z");

    const first = await service.generateSeasonFinal("2025_2026", finalizedAt);
    await repo.userSeasonStats?.update({
      ...(await repo.userSeasonStats!.findByUserAndSeason(user.user_id, "2025_2026"))!,
      points: 60,
      updated_at: new Date(finalizedAt.getTime() + 60_000),
    });
    const second = await service.generateSeasonFinal(
      "2025_2026",
      new Date(finalizedAt.getTime() + 120_000),
    );

    expect(first).toMatchObject([{
      is_final: true,
      season_points: 48,
      snapshot_at: new Date("2026-07-06T02:00:00.000Z"),
      created_at: new Date("2026-07-06T02:00:00.000Z"),
    }]);
    expect(second).toEqual(first);
    await expect(repo.boardSnapshots.findFinalBySeason("2025_2026"))
      .resolves.toMatchObject([{ is_final: true, season_points: 48 }]);
    await expect(repo.boardSnapshots.findLatestBySeason("2025_2026")).resolves.toEqual([]);
    await expect(repo.boardSnapshots.findLatestByBoard(RankingBoard.Season)).resolves.toEqual([]);
    await expect(repo.boardSnapshots.listFinalSeasonIds()).resolves.toEqual(["2025_2026"]);
  });

  it("fails internally when a regular season snapshot shares the final evaluation timestamp", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser("same-snapshot-time-user");
    const finalOnlyUser = makeUser("same-snapshot-time-final-only");
    await repo.users.insert(user);
    await repo.users.insert(finalOnlyUser);
    await repo.userSeasonStats?.insert(makeSeasonStats(finalOnlyUser.user_id, {
      level_season_id: "2025_2026",
      points: 24,
      valid_predictions: 2,
    }));
    await repo.userSeasonStats?.insert(makeSeasonStats(user.user_id, {
      level_season_id: "2025_2026",
      points: 12,
      valid_predictions: 1,
    }));
    await repo.userSeasonStats?.insert(makeSeasonStats(user.user_id, {
      level_season_id: "2026_2027",
      points: 12,
      valid_predictions: 1,
    }));
    const finalEvalAsOf = new Date("2026-07-06T02:00:00.000Z");
    const service = new BoardSnapshotService(repo);

    const regular = await service.generate(RankingBoard.Season, finalEvalAsOf);
    await expect(service.generateSeasonFinal("2025_2026", finalEvalAsOf))
      .rejects.toMatchObject({ code: "INTERNAL_ERROR" });

    expect(regular).toMatchObject([{
      user_id: user.user_id,
      is_final: false,
      snapshot_at: finalEvalAsOf,
    }]);
    await expect(repo.boardSnapshots.findFinalBySeason("2025_2026")).resolves.toEqual([]);
    await expect(repo.boardSnapshots.findByBoardAndSnapshotAt(RankingBoard.Season, finalEvalAsOf))
      .resolves.toMatchObject([{ is_final: false, level_season_id: "2026_2027" }]);
  });

  it("records an empty final season with a final head that is not selectable", async () => {
    const repo = new InMemoryRepository();
    await expect(new BoardSnapshotService(repo).generateSeasonFinal("2024_2025", NOW))
      .resolves.toEqual([]);
    await expect(repo.boardSnapshots.findFinalBySeason("2024_2025"))
      .resolves.toMatchObject([{ snapshot_kind: "head", is_final: true }]);
    await expect(repo.boardSnapshots.listFinalSeasonIds()).resolves.toEqual([]);
  });

  it("ignores polluted prediction caches and does not read the predictions port", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser("career-winner", {
      career_points: 12,
      career_wdl_hits: 1,
      career_exact_hits: 1,
      career_valid_predictions: 1,
    }));
    await repo.predictions.insert(makePrediction({
      match_score: MatchScoreValue.Miss,
      wdl_hit: false,
      exact_hit: false,
    }));

    const guardedRepo = new Proxy(repo, {
      get(target, property, receiver) {
        if (property === "withTransaction") {
          return function withTransaction<T>(fn: (tx: UnitOfWork) => Promise<T>) {
            return target.withTransaction((tx) => fn(new Proxy(tx, {
              get(transaction, transactionProperty, transactionReceiver) {
                if (transactionProperty === "predictions") {
                  throw new Error("board snapshots must not read predictions");
                }
                return Reflect.get(transaction, transactionProperty, transactionReceiver);
              },
            }) as UnitOfWork));
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const snapshots = await new BoardSnapshotService(guardedRepo).generate(
      RankingBoard.Career,
      NOW,
    );

    expect(snapshots[0]).toMatchObject({
      user_id: "career-winner",
      career_points: 12,
      career_exact_hits: 1,
      career_valid_predictions: 1,
    });
  });
});
