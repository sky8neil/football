import { describe, expect, it } from "vitest";
import { MatchScoreValue, RankingBoard, RankingScope, Result } from "../domain/enums.js";
import { defaultLevelState, type Prediction, type User } from "../domain/types.js";
import { InMemoryRepository, type UnitOfWork } from "../infrastructure/repositories.js";
import { BoardSnapshotService } from "./board-snapshot.js";
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
