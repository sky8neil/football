import { FIXED_CONFIG_V1 } from "../domain/config.js";
import {
  RankingBoard,
  SCHEMA_VERSION,
  SyncJobType,
  UserStatus,
} from "../domain/enums.js";
import { conflictError, internalError, validationError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import {
  compareRankingEntry,
  isRankEligible,
  isSeasonRankEligible,
  isStrengthRankEligible,
} from "../domain/ranking.js";
import {
  BOARD_SNAPSHOT_HEAD_USER_ID,
  type BoardSnapshot,
  type User,
  type UserSeasonStats,
} from "../domain/types.js";
import { defaultLevelState } from "../domain/types.js";
import { levelSeasonOf, seasonFinalEvalAsOf } from "../domain/time.js";
import { UniqueConstraintError, type UnitOfWork } from "../infrastructure/repositories.js";
import { assertValidServerNow } from "./period-finalize.js";

const SNAPSHOT_LEASE_MILLISECONDS = FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000;

export type BoardSnapshotUnitOfWork = Pick<
  UnitOfWork,
  "users" | "boardSnapshots" | "userSeasonStats"
>;

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
  if (board === RankingBoard.Season) {
    return `sync:${SyncJobType.BoardSnapshotSeason}`;
  }
  throw validationError("不支持的 board snapshot 类型", { board });
}

function assertSnapshotBoard(
  board: RankingBoard,
): asserts board is typeof RankingBoard.Career | typeof RankingBoard.Strength | typeof RankingBoard.Season {
  if (
    board !== RankingBoard.Career &&
    board !== RankingBoard.Strength &&
    board !== RankingBoard.Season
  ) {
    throw validationError("不支持的 board snapshot 类型", { board });
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
    level_season_id: null,
    is_final: false,
    user_id: user.user_id,
    rank: index + 1,
    career_points: user.career_points,
    career_exact_hits: user.career_exact_hits,
    career_valid_predictions: user.career_valid_predictions,
    career_last_scoring_match_at: user.career_last_scoring_match_at ?? null,
    window_score_sum: null,
    window_n: null,
    season_points: null,
    season_exact_hits: null,
    season_valid_predictions: null,
    season_last_scoring_match_at: null,
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
    level_season_id: null,
    is_final: false,
    user_id: user.user_id,
    rank: index + 1,
    career_points: null,
    career_exact_hits: null,
    career_valid_predictions: null,
    career_last_scoring_match_at: null,
    window_score_sum,
    window_n,
    season_points: null,
    season_exact_hits: null,
    season_valid_predictions: null,
    season_last_scoring_match_at: null,
    created_at: snapshotAt,
  }));
}

function buildSeasonSnapshots(
  users: readonly User[],
  seasonStats: readonly UserSeasonStats[],
  levelSeasonId: string,
  snapshotAt: Date,
  isFinal = false,
): BoardSnapshot[] {
  const usersById = new Map(
    users.filter((user) => user.status === UserStatus.Active).map((user) => [user.user_id, user]),
  );
  const ranked = seasonStats.flatMap((stats) => {
    const user = usersById.get(stats.user_id);
    if (user === undefined || !isSeasonRankEligible(stats.valid_predictions)) {
      return [];
    }
    return [{ user, stats }];
  }).sort((a, b) =>
    compareRankingEntry(RankingBoard.Season, {
      user_id: a.user.user_id,
      period_score: a.stats.points,
      exact_hits: a.stats.exact_hits,
      valid_predictions: a.stats.valid_predictions,
      last_scoring_match_at: a.stats.last_scoring_match_at,
    }, {
      user_id: b.user.user_id,
      period_score: b.stats.points,
      exact_hits: b.stats.exact_hits,
      valid_predictions: b.stats.valid_predictions,
      last_scoring_match_at: b.stats.last_scoring_match_at,
    }),
  );

  return ranked.map(({ user, stats }, index) => ({
    schema_version: SCHEMA_VERSION,
    snapshot_id: newUuid(),
    board: RankingBoard.Season,
    snapshot_at: snapshotAt,
    level_season_id: levelSeasonId,
    is_final: isFinal,
    user_id: user.user_id,
    rank: index + 1,
    career_points: null,
    career_exact_hits: null,
    career_valid_predictions: null,
    career_last_scoring_match_at: null,
    window_score_sum: null,
    window_n: null,
    season_points: stats.points,
    season_exact_hits: stats.exact_hits,
    season_valid_predictions: stats.valid_predictions,
    season_last_scoring_match_at: stats.last_scoring_match_at,
    created_at: snapshotAt,
  }));
}

export function buildBoardSnapshotEntries(input: {
  users: readonly User[];
  seasonStats?: readonly UserSeasonStats[];
  levelSeasonId?: string;
  board: RankingBoard;
  snapshotAt: Date;
  isFinal?: boolean;
}): BoardSnapshot[] {
  const { users, board, snapshotAt } = input;
  assertSnapshotBoard(board);
  if (board === RankingBoard.Career) {
    return buildCareerSnapshots(users, snapshotAt);
  }
  if (board === RankingBoard.Strength) {
    return buildStrengthSnapshots(users, snapshotAt);
  }
  if (input.seasonStats === undefined || input.levelSeasonId === undefined) {
    throw internalError("season board snapshot 缺少赛季统计或 level_season_id");
  }
  return buildSeasonSnapshots(
    users,
    input.seasonStats,
    input.levelSeasonId,
    snapshotAt,
    input.isFinal ?? false,
  );
}

async function insertSnapshotOrThrowInternal(
  tx: BoardSnapshotUnitOfWork,
  snapshot: BoardSnapshot,
): Promise<void> {
  if (tx.boardSnapshots === undefined) {
    throw internalError("board_snapshots repository port 未配置");
  }
  try {
    await tx.boardSnapshots.insert(snapshot);
  } catch (error) {
    if (
      error instanceof UniqueConstraintError &&
      error.collection === "board_snapshots" &&
      error.indexName === "uk_board_snapshot_user"
    ) {
      throw internalError("board snapshot 与已有快照发生唯一键冲突");
    }
    throw error;
  }
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
  const levelSeasonId = board === RankingBoard.Season ? levelSeasonOf(snapshotAt) : null;
  let seasonStats: UserSeasonStats[] | undefined;
  if (board === RankingBoard.Season) {
    if (tx.userSeasonStats === undefined) {
      throw internalError("user_season_stats repository port 未配置");
    }
    seasonStats = await tx.userSeasonStats.findByLevelSeason(levelSeasonId as string);
  }
  const snapshots = buildBoardSnapshotEntries({
    users,
    ...(seasonStats === undefined ? {} : { seasonStats }),
    ...(levelSeasonId === null ? {} : { levelSeasonId }),
    board,
    snapshotAt,
  });
  if (snapshots.length === 0) {
    await insertSnapshotOrThrowInternal(tx, {
      schema_version: SCHEMA_VERSION,
      snapshot_id: newUuid(),
      board,
      snapshot_at: snapshotAt,
      level_season_id: levelSeasonId,
      is_final: false,
      user_id: BOARD_SNAPSHOT_HEAD_USER_ID,
      snapshot_kind: "head",
      rank: 1,
      career_points: null,
      career_exact_hits: null,
      career_valid_predictions: null,
      career_last_scoring_match_at: null,
      window_score_sum: null,
      window_n: null,
      season_points: null,
      season_exact_hits: null,
      season_valid_predictions: null,
      season_last_scoring_match_at: null,
      created_at: snapshotAt,
    });
    return [];
  }
  for (const snapshot of snapshots) {
    await insertSnapshotOrThrowInternal(tx, snapshot);
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

  async generateSeasonFinal(levelSeasonId: string, serverNow: Date): Promise<BoardSnapshot[]> {
    assertValidServerNow(serverNow);
    const lockKey = `sync:${SyncJobType.BoardSnapshotSeasonFinal}`;
    const ownerId = newUuid();
    const acquired = await this.repo.jobLocks.acquire(
      lockKey,
      ownerId,
      new Date(serverNow.getTime() + SNAPSHOT_LEASE_MILLISECONDS),
    );
    if (!acquired) {
      throw conflictError("SETTLEMENT_ALREADY_RUNNING", "赛季终榜任务锁被占用", { lock_key: lockKey });
    }

    try {
      return await this.repo.withTransaction(async (tx) => {
        if (tx.boardSnapshots === undefined || tx.userSeasonStats === undefined) {
          throw internalError("season final 缺少快照或赛季统计 repository");
        }
        const alreadyGenerated = await tx.boardSnapshots.findFinalBySeason(levelSeasonId);
        if (alreadyGenerated.length > 0) {
          return alreadyGenerated.filter((snapshot) => snapshot.snapshot_kind !== "head");
        }
        const finalEvalAsOf = seasonFinalEvalAsOf(levelSeasonId);
        const snapshots = buildBoardSnapshotEntries({
          users: await tx.users.findAll(),
          seasonStats: await tx.userSeasonStats.findByLevelSeason(levelSeasonId),
          levelSeasonId,
          board: RankingBoard.Season,
          snapshotAt: finalEvalAsOf,
          isFinal: true,
        });
        if (snapshots.length === 0) {
          await insertSnapshotOrThrowInternal(tx, {
            schema_version: SCHEMA_VERSION,
            snapshot_id: newUuid(),
            board: RankingBoard.Season,
            snapshot_at: finalEvalAsOf,
            level_season_id: levelSeasonId,
            is_final: true,
            user_id: BOARD_SNAPSHOT_HEAD_USER_ID,
            snapshot_kind: "head",
            rank: 1,
            career_points: null,
            career_exact_hits: null,
            career_valid_predictions: null,
            career_last_scoring_match_at: null,
            window_score_sum: null,
            window_n: null,
            season_points: null,
            season_exact_hits: null,
            season_valid_predictions: null,
            season_last_scoring_match_at: null,
            created_at: finalEvalAsOf,
          });
          return [];
        }
        for (const snapshot of snapshots) await insertSnapshotOrThrowInternal(tx, snapshot);
        return snapshots;
      });
    } finally {
      await this.repo.jobLocks.release(lockKey, ownerId);
    }
  }
}
