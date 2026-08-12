import { FIXED_CONFIG_V1 } from "../domain/config.js";
import {
  AdminAuditAction,
  ADMIN_AUDIT_ENTITY_TYPE_BY_ACTION,
  PeriodType,
  SCHEMA_VERSION,
} from "../domain/enums.js";
import { conflictError, internalError, validationError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import type { AdminAuditLog, RankingEntry } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { AdminAuthorizationService } from "./admin.js";
import {
  assertPeriodKey,
  assertPeriodType,
  periodRankingsRebuildLockKey,
  RebuildPeriodRankingsService,
  type RebuildPeriodRankingsOutcome,
} from "./ranking-rebuild-service.js";
import { assertValidServerNow } from "./period-finalize.js";

const REBUILD_LEASE_MILLISECONDS = FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000;

/** 第 48.3 节冻结的管理员审计 action。 */
export const ADMIN_REBUILD_RANKINGS_AUDIT_ACTION = AdminAuditAction.RebuildRankings;

export interface AdminRebuildRankingsInput {
  period_type: PeriodType;
  period_key: string;
  reason: string;
}

export interface AdminRebuildRankingsOutcome extends RebuildPeriodRankingsOutcome {
  admin_id: string;
  audit_log: AdminAuditLog;
}

export interface AdminRebuildRankingsCommand {
  rebuild(
    trustedOpenid: string | null | undefined,
    periodType: PeriodType,
    periodKey: string,
    reason: string,
    serverNow: Date,
  ): Promise<AdminRebuildRankingsOutcome>;
}

function rankingAuditValue(rankings: readonly RankingEntry[]): Record<string, unknown> {
  const ranked = rankings.filter((entry) => entry.global_rank !== null);
  return {
    entry_count: rankings.length,
    ranked_entry_count: ranked.length,
    total_period_score: rankings.reduce((total, entry) => total + entry.period_score, 0),
    max_global_rank: ranked.length === 0
      ? null
      : Math.max(...ranked.map((entry) => entry.global_rank as number)),
    is_final: rankings.length > 0 && rankings.every((entry) => entry.is_final),
  };
}

function assertInput(input: AdminRebuildRankingsInput): void {
  assertPeriodType(input.period_type);
  assertPeriodKey(input.period_type, input.period_key);
  if (
    typeof input.reason !== "string" ||
    input.reason.length < 1 ||
    input.reason.length > 500
  ) {
    throw validationError("reason 长度必须为 1..500", { field: "reason" });
  }
}

export class AdminRebuildRankingsService implements AdminRebuildRankingsCommand {
  private readonly authorization = new AdminAuthorizationService();
  private readonly rebuildService: RebuildPeriodRankingsService;

  constructor(private readonly repo: AppRepository) {
    this.rebuildService = new RebuildPeriodRankingsService(repo);
  }

  async rebuild(
    trustedOpenid: string | null | undefined,
    periodType: PeriodType,
    periodKey: string,
    reason: string,
    serverNow: Date,
  ): Promise<AdminRebuildRankingsOutcome> {
    assertInput({ period_type: periodType, period_key: periodKey, reason });
    assertValidServerNow(serverNow);

    await this.authorization.requireActiveAdmin(this.repo, trustedOpenid);

    const lockKey = periodRankingsRebuildLockKey(periodType, periodKey);
    const ownerId = newUuid();
    const acquired = await this.repo.jobLocks.acquire(
      lockKey,
      ownerId,
      new Date(serverNow.getTime() + REBUILD_LEASE_MILLISECONDS),
    );
    if (!acquired) {
      throw conflictError("SETTLEMENT_ALREADY_RUNNING", "目标周期存在并发 rebuild");
    }

    try {
      return await this.repo.withTransaction(async (tx) => {
        const admin = await this.authorization.requireActiveAdmin(tx, trustedOpenid);
        if (tx.adminAuditLogs === undefined) {
          throw internalError("admin_audit_logs repository port 未配置");
        }
        if (tx.rankings === undefined) {
          throw internalError("rankings repository port 未配置");
        }

        const oldRankings = await tx.rankings.findByPeriod(periodType, periodKey);
        const rebuilt = await this.rebuildService.rebuildPeriodRankingsInTransaction(
          tx,
          periodType,
          periodKey,
          serverNow,
        );
        const newRankings = await tx.rankings.findByPeriod(periodType, periodKey);
        const entityId = `${periodType}:${periodKey}`;
        const auditLog: AdminAuditLog = {
          schema_version: SCHEMA_VERSION,
          audit_id: newUuid(),
          admin_id: admin.admin_id,
          action: ADMIN_REBUILD_RANKINGS_AUDIT_ACTION,
          entity_type: ADMIN_AUDIT_ENTITY_TYPE_BY_ACTION[ADMIN_REBUILD_RANKINGS_AUDIT_ACTION],
          entity_id: entityId,
          old_value: rankingAuditValue(oldRankings),
          new_value: rankingAuditValue(newRankings),
          reason,
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
