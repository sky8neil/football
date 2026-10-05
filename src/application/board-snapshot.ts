import { FIXED_CONFIG_V1 } from "../domain/config.js";
import {
  RankingBoard,
  SCHEMA_VERSION,
  SyncJobType,
  UserStatus,
} from "../domain/enums.js";
import { conflictError, internalError, validationError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import { compareRankingEntry, isRankEligible, isStrengthRankEligible } from "../domain/ranking.js";
import {
  BOARD_SNAPSHOT_HEAD_USER_ID,
  type BoardSnapshot,
  type User,
} from "../domain/types.js";
import { defaultLevelState } from "../domain/types.js";
import type { UnitOfWork } from "../infrastructure/repositories.js";
import { assertValidServerNow } from "./period-finalize.js";

const SNAPSHOT_LEASE_MILLISECONDS = FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000;

export type BoardSnapshotUnitOfWork = Pick<UnitOfWork, "users" | "boardSnapshots">;

export interface BoardSnapshotRepositoryContext {
  jobLocks: {
    acquire(lockKey: string, ownerId: string, leaseUntil: Date): Promise<boolean>;
    release(lockKey: string, ownerId: string): Promise<void>;
  };
  withTransaction<T>(fn: (tx: BoardSnapshotUnitOfWork) => Promise<T>): Promise<T>;
}

export function boardSnapshotJobLockKey(board: RankingBoard): string {
  if (board === RankingBoard.Career) {
    return `sync:${SyncJobType.BoardSnapshotCareer}`;
  }
  if (board === RankingBoard.Strength) {
    return `sync:${SyncJobType.BoardSnapshotStrength}`;
  }
  throw validationError("board snapshot 只支持 career 或 strength", { board });
}

function assertSnapshotBoard(
  board: RankingBoard,
): asserts board is typeof RankingBoard.Career | typeof RankingBoard.Strength {
  if (board !== RankingBoard.Career && board !== RankingBoard.Strength) {
    throw validationError("board snapshot 只支持 career 或 strength", { board });
  }
}

function careerUsers(users: readonly User[]): User[] {
  return users.filter(
    (user) => user.status === UserStatus.Active && isRankEligible(user.career_valid_predictions),
  );
}

function strengthUsers(users: readonly User[]): Array<{
  user: User;
  window_score_sum: number;
  window_n: number;
}> {
  return users.flatMap((user) => {
    if (user.status !== UserStatus.Active) {
      return [];
    }
    const levelState = user.career_level_state ?? defaultLevelState();
    if (!isStrengthRankEligible(levelState.last_eval_n)) {
      return [];
    }
    return [{
      user,
      window_score_sum: levelState.last_eval_score_sum,
      window_n: levelState.last_eval_n,
    }];
  });
}

function buildCareerSnapshots(users: readonly User[], snapshotAt: Date): BoardSnapshot[] {
  const ranked = careerUsers(users).sort((a, b) =>
    compareRankingEntry(RankingBoard.Career, {
      user_id: a.user_id,
      period_score: a.career_points,
      exact_hits: a.career_exact_hits,
      valid_predictions: a.career_valid_predictions,
      last_scoring_match_at: a.career_last_scoring_match_at ?? null,
    }, {
      user_id: b.user_id,
      period_score: b.career_points,
      exact_hits: b.career_exact_hits,
      valid_predictions: b.career_valid_predictions,
      last_scoring_match_at: b.career_last_scoring_match_at ?? null,
    }),
  );

  return ranked.map((user, index) => ({
    schema_version: SCHEMA_VERSION,
    snapshot_id: newUuid(),
    board: RankingBoard.Career,
    snapshot_at: snapshotAt,
    user_id: user.user_id,
    rank: index + 1,
    career_points: user.career_points,
    career_exact_hits: user.career_exact_hits,
    career_valid_predictions: user.career_valid_predictions,
    career_last_scoring_match_at: user.career_last_scoring_match_at ?? null,
    window_score_sum: null,
    window_n: null,
    created_at: snapshotAt,
  }));
}

function buildStrengthSnapshots(users: readonly User[], snapshotAt: Date): BoardSnapshot[] {
  const ranked = strengthUsers(users).sort((a, b) =>
    compareRankingEntry(RankingBoard.Strength, {
      user_id: a.user.user_id,
      window_score_sum: a.window_score_sum,
      window_n: a.window_n,
    }, {
      user_id: b.user.user_id,
      window_score_sum: b.window_score_sum,
      window_n: b.window_n,
    }),
  );

  return ranked.map(({ user, window_score_sum, window_n }, index) => ({
    schema_version: SCHEMA_VERSION,
    snapshot_id: newUuid(),
    board: RankingBoard.Strength,
    snapshot_at: snapshotAt,
    user_id: user.user_id,
    rank: index + 1,
    career_points: null,
    career_exact_hits: null,
    career_valid_predictions: null,
    career_last_scoring_match_at: null,
    window_score_sum,
    window_n,
    created_at: snapshotAt,
  }));
}

export function buildBoardSnapshotEntries(
  users: readonly User[],
  board: RankingBoard,
  snapshotAt: Date,
): BoardSnapshot[] {
  assertSnapshotBoard(board);
  return board === RankingBoard.Career
    ? buildCareerSnapshots(users, snapshotAt)
    : buildStrengthSnapshots(users, snapshotAt);
}

export async function writeBoardSnapshotInTransaction(
  tx: BoardSnapshotUnitOfWork,
  board: RankingBoard,
  snapshotAt: Date,
): Promise<BoardSnapshot[]> {
  assertSnapshotBoard(board);
  assertValidServerNow(snapshotAt);
  if (tx.boardSnapshots === undefined) {
    throw internalError("board_snapshots repository port 未配置");
  }
  const existing = await tx.boardSnapshots.findByBoardAndSnapshotAt(board, snapshotAt);
  if (existing.length > 0) {
    return existing
      .filter((snapshot) => snapshot.snapshot_kind !== "head")
      .sort((a, b) => a.rank - b.rank);
  }

  const users = await tx.users.findAll();
  const snapshots = buildBoardSnapshotEntries(users, board, snapshotAt);
  if (snapshots.length === 0) {
    await tx.boardSnapshots.insert({
      schema_version: SCHEMA_VERSION,
      snapshot_id: newUuid(),
      board,
      snapshot_at: snapshotAt,
      user_id: BOARD_SNAPSHOT_HEAD_USER_ID,
      snapshot_kind: "head",
      rank: 1,
      career_points: null,
      career_exact_hits: null,
      career_valid_predictions: null,
      career_last_scoring_match_at: null,
      window_score_sum: null,
      window_n: null,
      created_at: snapshotAt,
    });
    return [];
  }
  for (const snapshot of snapshots) {
    await tx.boardSnapshots.insert(snapshot);
  }
  return snapshots;
}

export class BoardSnapshotService {
  constructor(private readonly repo: BoardSnapshotRepositoryContext) {}

  async generate(board: RankingBoard, serverNow: Date): Promise<BoardSnapshot[]> {
    assertSnapshotBoard(board);
    assertValidServerNow(serverNow);

    const lockKey = boardSnapshotJobLockKey(board);
    const ownerId = newUuid();
    const acquired = await this.repo.jobLocks.acquire(
      lockKey,
      ownerId,
      new Date(serverNow.getTime() + SNAPSHOT_LEASE_MILLISECONDS),
    );
    if (!acquired) {
      throw conflictError("SETTLEMENT_ALREADY_RUNNING", "目标榜单快照任务锁被占用", {
        lock_key: lockKey,
      });
    }

    try {
      return await this.repo.withTransaction((tx) =>
        writeBoardSnapshotInTransaction(tx, board, serverNow),
      );
    } finally {
      await this.repo.jobLocks.release(lockKey, ownerId);
    }
  }
}
