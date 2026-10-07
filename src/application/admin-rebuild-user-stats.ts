import { FIXED_CONFIG_V1 } from "../domain/config.js";
import {
  AdminAuditAction,
  ADMIN_AUDIT_ENTITY_TYPE_BY_ACTION,
  SCHEMA_VERSION,
} from "../domain/enums.js";
import { conflictError, internalError, notFoundError, validationError } from "../domain/errors.js";
import { isValidUuid, newUuid } from "../domain/ids.js";
import type { AdminAuditLog, User, UserSeasonStats } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import {
  RebuildUserStatsService,
  type RebuildUserStatsOutcome,
  userStatsRebuildLockKey,
} from "./stats-rebuild-service.js";
import { AdminAuthorizationService, type AdminWriteAuthorizer } from "./admin.js";
import { assertValidServerNow } from "./period-finalize.js";

const REBUILD_LEASE_MILLISECONDS = FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000;

/** 第 48.3 节冻结的管理员审计 action。 */
export const ADMIN_REBUILD_USER_STATS_AUDIT_ACTION = AdminAuditAction.RebuildUserStats;

export const ADMIN_REBUILD_USER_STATS_AUDIT_REASON = "管理员用户统计重建";

function userStatsAuditValue(
  user: User,
  seasonStats: readonly UserSeasonStats[],
  seasonStatsChangedCount: number,
  levelStateChanged?: boolean,
): Record<string, unknown> {
  return {
    career_points: user.career_points,
    career_valid_predictions: user.career_valid_predictions,
    career_wdl_hits: user.career_wdl_hits,
    career_exact_hits: user.career_exact_hits,
    career_level: user.career_level,
    career_best_level: user.career_best_level,
    season_stats_changed_count: seasonStatsChangedCount,
    season_stats: [...seasonStats]
      .sort((a, b) => a.level_season_id.localeCompare(b.level_season_id))
      .map((stats) => ({
        level_season_id: stats.level_season_id,
        points: stats.points,
        valid_predictions: stats.valid_predictions,
        wdl_hits: stats.wdl_hits,
        exact_hits: stats.exact_hits,
        last_scoring_match_at: stats.last_scoring_match_at?.toISOString() ?? null,
      })),
    ...(levelStateChanged === undefined ? {} : { level_state_changed: levelStateChanged }),
  };
}

function seasonStatsBusinessValuesEqual(
  left: UserSeasonStats,
  right: UserSeasonStats,
): boolean {
  return (
    left.points === right.points &&
    left.valid_predictions === right.valid_predictions &&
    left.wdl_hits === right.wdl_hits &&
    left.exact_hits === right.exact_hits &&
    left.last_scoring_match_at?.getTime() === right.last_scoring_match_at?.getTime() &&
    left.level === right.level &&
    left.best_level === right.best_level
  );
}

function changedSeasonStatsCount(
  before: readonly UserSeasonStats[],
  after: readonly UserSeasonStats[],
): number {
  const beforeBySeason = new Map(before.map((stats) => [stats.level_season_id, stats]));
  let changed = 0;
  for (const current of after) {
    const previous = beforeBySeason.get(current.level_season_id);
    if (previous === undefined || !seasonStatsBusinessValuesEqual(previous, current)) {
      changed += 1;
    }
  }
  return changed;
}

export interface AdminRebuildUserStatsOutcome extends RebuildUserStatsOutcome {
  admin_id: string;
  audit_log: AdminAuditLog;
}

export interface AdminRebuildUserStatsCommand extends AdminWriteAuthorizer {
  rebuild(
    trustedOpenid: string | null | undefined,
    userId: string,
    serverNow: Date,
  ): Promise<AdminRebuildUserStatsOutcome>;
}

export class AdminRebuildUserStatsService implements AdminRebuildUserStatsCommand {
  private readonly authorization = new AdminAuthorizationService();
  private readonly rebuildService: RebuildUserStatsService;

  constructor(private readonly repo: AppRepository) {
    this.rebuildService = new RebuildUserStatsService(repo);
  }

  authorizeAdmin(trustedOpenid: string): Promise<void> {
    return this.authorization.authorizeAdmin(this.repo, trustedOpenid);
  }

  async rebuild(
    trustedOpenid: string | null | undefined,
    userId: string,
    serverNow: Date,
  ): Promise<AdminRebuildUserStatsOutcome> {
    if (!isValidUuid(userId)) {
      throw validationError("user_id 必须为 UUID v4", { field: "user_id" });
    }
    assertValidServerNow(serverNow);

    await this.authorization.requireActiveAdmin(this.repo, trustedOpenid);

    const lockKey = userStatsRebuildLockKey(userId);
    const ownerId = newUuid();
    const acquired = await this.repo.jobLocks.acquire(
      lockKey,
      ownerId,
      new Date(serverNow.getTime() + REBUILD_LEASE_MILLISECONDS),
    );
    if (!acquired) {
      throw conflictError("USER_STATS_REBUILD_ALREADY_RUNNING", "目标用户存在并发用户统计重建");
    }

    try {
      return await this.repo.withTransaction(async (tx) => {
        const admin = await this.authorization.requireActiveAdmin(tx, trustedOpenid);
        if (tx.adminAuditLogs === undefined) {
          throw internalError("admin_audit_logs repository port 未配置");
        }

        const oldUser = await tx.users.findById(userId);
        if (oldUser === null) {
          throw notFoundError("USER");
        }
        if (tx.userSeasonStats === undefined) {
          throw internalError("管理员 user stats rebuild 缺少 season stats repository");
        }
        const oldSeasonStats = await tx.userSeasonStats.findByUser(userId);

        const rebuilt = await this.rebuildService.rebuildUserStatsInTransaction(
          tx,
          userId,
          serverNow,
        );
        const seasonStatsChangedCount = changedSeasonStatsCount(
          oldSeasonStats,
          rebuilt.season_stats,
        );
        const auditLog: AdminAuditLog = {
          schema_version: SCHEMA_VERSION,
          audit_id: newUuid(),
          admin_id: admin.admin_id,
          action: ADMIN_REBUILD_USER_STATS_AUDIT_ACTION,
          entity_type: ADMIN_AUDIT_ENTITY_TYPE_BY_ACTION[ADMIN_REBUILD_USER_STATS_AUDIT_ACTION],
          entity_id: userId,
          old_value: userStatsAuditValue(oldUser, oldSeasonStats, 0),
          new_value: userStatsAuditValue(
            rebuilt.user,
            rebuilt.season_stats,
            seasonStatsChangedCount,
            rebuilt.level_state_changed,
          ),
          reason: ADMIN_REBUILD_USER_STATS_AUDIT_REASON,
          created_at: serverNow,
        };
        await tx.adminAuditLogs.insert(auditLog);

        return {
          ...rebuilt,
          admin_id: admin.admin_id,
          audit_log: auditLog,
        };
      });
    } finally {
      await this.repo.jobLocks.release(lockKey, ownerId);
    }
  }
}
