import { FIXED_CONFIG_V1 } from "../domain/config.js";
import {
  AdminAuditAction,
  ADMIN_AUDIT_ENTITY_TYPE_BY_ACTION,
  PeriodType,
  RankingBoard,
  SCHEMA_VERSION,
} from "../domain/enums.js";
import { conflictError, internalError, validationError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import { isValidPeriodKey, levelSeasonOf } from "../domain/time.js";
import type { AdminAuditLog, BoardSnapshot, RankingEntry } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { AdminAuthorizationService, type AdminWriteAuthorizer } from "./admin.js";
import {
  boardSnapshotRebuildLockKey,
  periodRankingsRebuildLockKey,
  RebuildPeriodRankingsService,
} from "./ranking-rebuild-service.js";
import { assertValidServerNow } from "./period-finalize.js";

const REBUILD_LEASE_MILLISECONDS = FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000;

export const ADMIN_REBUILD_RANKINGS_AUDIT_ACTION = AdminAuditAction.RebuildRankings;

export interface AdminRebuildRankingsInput {
  board: RankingBoard;
  period_key: string | null;
  reason: string;
}

export interface AdminRebuildRankingsOutcome {
  board: RankingBoard;
  period_key: string | null;
  rebuilt_entry_count: number;
  admin_id: string;
  audit_log: AdminAuditLog;
  rankings?: RankingEntry[];
  snapshots?: BoardSnapshot[];
  created_count?: number;
  updated_count?: number;
}

export interface AdminRebuildRankingsCommand extends AdminWriteAuthorizer {
  rebuild(
    trustedOpenid: string | null | undefined,
    board: RankingBoard,
    periodKey: string | null,
    reason: string,
    serverNow: Date,
  ): Promise<AdminRebuildRankingsOutcome>;
}

function isRankingBoard(board: unknown): board is RankingBoard {
  return Object.values(RankingBoard).includes(board as RankingBoard);
}

function assertInput(input: AdminRebuildRankingsInput): void {
  if (!isRankingBoard(input.board)) {
    throw validationError("board 必须是 week、career、strength 或 season", { field: "board" });
  }
  if (input.board === RankingBoard.Week) {
    if (
      typeof input.period_key !== "string" ||
      !isValidPeriodKey(PeriodType.Week, input.period_key)
    ) {
      throw validationError("week board 必须携带有效 period_key", { field: "period_key" });
    }
  } else if (input.period_key !== null) {
    throw validationError("career/strength/season board 禁止携带 period_key", {
      field: "period_key",
    });
  }
  if (
    typeof input.reason !== "string" ||
    input.reason.length < 1 ||
    input.reason.length > 500
  ) {
    throw validationError("reason 长度必须为 1..500", { field: "reason" });
  }
}

function rankingAuditValue(
  board: RankingBoard,
  rankings: readonly RankingEntry[],
): Record<string, unknown> {
  const ranked = rankings.filter((entry) => entry.global_rank !== null);
  return {
    board,
    entry_count: rankings.length,
    ranked_entry_count: ranked.length,
    total_period_score: rankings.reduce((total, entry) => total + entry.period_score, 0),
    max_global_rank: ranked.length === 0
      ? null
      : Math.max(...ranked.map((entry) => entry.global_rank as number)),
    is_final: rankings.length > 0 && rankings.every((entry) => entry.is_final),
  };
}

function snapshotAuditValue(
  board: BoardSnapshot["board"],
  snapshots: readonly BoardSnapshot[],
): Record<string, unknown> {
  if (board === RankingBoard.Career) {
    return {
      board,
      entry_count: snapshots.length,
      total_career_points: snapshots.reduce(
        (total, snapshot) => total + (snapshot.career_points ?? 0),
        0,
      ),
    };
  }
  if (board === RankingBoard.Season) {
    return {
      board,
      entry_count: snapshots.length,
      total_season_points: snapshots.reduce(
        (total, snapshot) => total + (snapshot.season_points ?? 0),
        0,
      ),
    };
  }
  return {
    board,
    entry_count: snapshots.length,
    total_window_score_sum: snapshots.reduce(
      (total, snapshot) => total + (snapshot.window_score_sum ?? 0),
      0,
    ),
  };
}

export class AdminRebuildRankingsService implements AdminRebuildRankingsCommand {
  private readonly authorization = new AdminAuthorizationService();
  private readonly rebuildService: RebuildPeriodRankingsService;

  constructor(private readonly repo: AppRepository) {
    this.rebuildService = new RebuildPeriodRankingsService(repo);
  }

  authorizeAdmin(trustedOpenid: string): Promise<void> {
    return this.authorization.authorizeAdmin(this.repo, trustedOpenid);
  }

  async rebuild(
    trustedOpenid: string | null | undefined,
    board: RankingBoard,
    periodKey: string | null,
    reason: string,
    serverNow: Date,
  ): Promise<AdminRebuildRankingsOutcome> {
    assertInput({ board, period_key: periodKey, reason });
    assertValidServerNow(serverNow);
    await this.authorization.requireActiveAdmin(this.repo, trustedOpenid);

    const lockKey = board === RankingBoard.Week
      ? periodRankingsRebuildLockKey(PeriodType.Week, periodKey as string)
      : boardSnapshotRebuildLockKey(board);
    const ownerId = newUuid();
    const acquired = await this.repo.jobLocks.acquire(
      lockKey,
      ownerId,
      new Date(serverNow.getTime() + REBUILD_LEASE_MILLISECONDS),
    );
    if (!acquired) {
      throw conflictError("SETTLEMENT_ALREADY_RUNNING", "目标榜单存在并发 rebuild", {
        lock_key: lockKey,
      });
    }

    try {
      return await this.repo.withTransaction(async (tx) => {
        const admin = await this.authorization.requireActiveAdmin(tx, trustedOpenid);
        if (tx.adminAuditLogs === undefined) {
          throw internalError("admin_audit_logs repository port 未配置");
        }

        let oldValue: Record<string, unknown>;
        let newValue: Record<string, unknown>;
        let outcome: Omit<AdminRebuildRankingsOutcome, "admin_id" | "audit_log">;
        if (board === RankingBoard.Week) {
          if (tx.rankings === undefined) {
            throw internalError("rankings repository port 未配置");
          }
          const periodKeyValue = periodKey as string;
          const oldRankings = await tx.rankings.findByPeriod(PeriodType.Week, periodKeyValue);
          const rebuilt = await this.rebuildService.rebuildPeriodRankingsInTransaction(
            tx,
            PeriodType.Week,
            periodKeyValue,
            serverNow,
          );
          const newRankings = await tx.rankings.findByPeriod(PeriodType.Week, periodKeyValue);
          oldValue = rankingAuditValue(board, oldRankings);
          newValue = rankingAuditValue(board, newRankings);
          outcome = {
            board,
            period_key: periodKeyValue,
            rebuilt_entry_count: rebuilt.rankings.length,
            rankings: rebuilt.rankings,
            created_count: rebuilt.created_count,
            updated_count: rebuilt.updated_count,
          };
        } else {
          if (tx.boardSnapshots === undefined) {
            throw internalError("board_snapshots repository port 未配置");
          }
          const oldSnapshotVersion = board === RankingBoard.Season
            ? await tx.boardSnapshots.findLatestBySeason(levelSeasonOf(serverNow))
            : await tx.boardSnapshots.findLatestByBoard(board);
          const oldSnapshots = oldSnapshotVersion
            .filter((snapshot) => snapshot.snapshot_kind !== "head");
          const rebuilt = await this.rebuildService.rebuildBoardSnapshotInTransaction(
            tx,
            board,
            serverNow,
          );
          oldValue = snapshotAuditValue(board, oldSnapshots);
          newValue = snapshotAuditValue(board, rebuilt.snapshots);
          outcome = {
            board,
            period_key: null,
            rebuilt_entry_count: rebuilt.rebuilt_entry_count,
            snapshots: rebuilt.snapshots,
            created_count: rebuilt.rebuilt_entry_count,
            updated_count: 0,
          };
        }

        const entityId = `${board}-${periodKey ?? "snapshot"}`;
        const auditLog: AdminAuditLog = {
          schema_version: SCHEMA_VERSION,
          audit_id: newUuid(),
          admin_id: admin.admin_id,
          action: ADMIN_REBUILD_RANKINGS_AUDIT_ACTION,
          entity_type: ADMIN_AUDIT_ENTITY_TYPE_BY_ACTION[ADMIN_REBUILD_RANKINGS_AUDIT_ACTION],
          entity_id: entityId,
          old_value: oldValue,
          new_value: newValue,
          reason,
          created_at: serverNow,
        };
        await tx.adminAuditLogs.insert(auditLog);

        return { ...outcome, admin_id: admin.admin_id, audit_log: auditLog };
      });
    } finally {
      await this.repo.jobLocks.release(lockKey, ownerId);
    }
  }
}
