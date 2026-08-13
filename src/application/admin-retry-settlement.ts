import {
  AdminAuditAction,
  ADMIN_AUDIT_ENTITY_TYPE_BY_ACTION,
  SCHEMA_VERSION,
  SettlementDocStatus,
  SettlementStatus,
} from "../domain/enums.js";
import { conflictError, internalError, notFoundError, validationError } from "../domain/errors.js";
import { isValidUuid, newUuid } from "../domain/ids.js";
import { validateSettlementTransition } from "../domain/settlement-state-machine.js";
import type { AdminAuditLog } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import {
  AdminAuthorizationService,
} from "./admin.js";
import {
  RetrySettlementService,
  type SettlementRetryAuditSnapshot,
  type SettlementRetryAuditWriter,
  type RetrySettlementItemWorker,
  type RetrySettlementOutcome,
} from "./retry-settlement-service.js";
import {
  CorrectionSettlementService,
  type CorrectionSettlementOutcome,
} from "./correction-settlement-service.js";
import {
  createAtomicSettlementItemWorker,
  SettlementItemApplicationService,
} from "./settlement-item-application-service.js";
import { continuePendingCorrections } from "./settlement-orchestration-service.js";
import { selectFailedSettlementTarget } from "./retry-settlement-target.js";
import { assertValidServerNow } from "./period-finalize.js";

export type AdminRetrySettlementOutcome = (RetrySettlementOutcome | CorrectionSettlementOutcome) & {
  result_version?: number;
};

export const ADMIN_RETRY_SETTLEMENT_AUDIT_ACTION = AdminAuditAction.RetrySettlement;
export const ADMIN_RETRY_SETTLEMENT_AUDIT_REASON = "管理员重试结算";

function auditValue(snapshot: SettlementRetryAuditSnapshot): Record<string, unknown> {
  return {
    settlement_status: snapshot.settlement_status,
    phase: snapshot.phase,
    attempt_count: snapshot.attempt_count,
    failed_item_count: snapshot.failed_item_count,
    pending_item_count: snapshot.pending_item_count,
    applied_item_count: snapshot.applied_item_count,
  };
}

function createRetryAuditWriter(adminId: string): SettlementRetryAuditWriter {
  return async (tx, oldValue, newValue, serverNow): Promise<AdminAuditLog> => {
    if (tx.adminAuditLogs === undefined) {
      throw internalError("admin_audit_logs repository port 未配置");
    }
    const auditLog: AdminAuditLog = {
      schema_version: SCHEMA_VERSION,
      audit_id: newUuid(),
      admin_id: adminId,
      action: ADMIN_RETRY_SETTLEMENT_AUDIT_ACTION,
      entity_type: ADMIN_AUDIT_ENTITY_TYPE_BY_ACTION[ADMIN_RETRY_SETTLEMENT_AUDIT_ACTION],
      entity_id: oldValue.settlement_id,
      old_value: auditValue(oldValue),
      new_value: auditValue(newValue),
      reason: ADMIN_RETRY_SETTLEMENT_AUDIT_REASON,
      created_at: serverNow,
    };
    await tx.adminAuditLogs.insert(auditLog);
    return auditLog;
  };
}

export interface RetrySettlementCommand {
  retry(
    trustedOpenid: string | null | undefined,
    matchId: string,
    serverNow: Date,
  ): Promise<AdminRetrySettlementOutcome>;
}

/**
 * 管理员 retry 的唯一按比赛入口：授权后解析失败 settlement，再按 settlement 类型复用
 * 普通或 correction retry 服务。
 * 管理员不直接改积分、prediction 或 settlement item。
 */
export class AdminRetrySettlementService implements RetrySettlementCommand {
  private readonly authorization = new AdminAuthorizationService();
  private readonly retryService: RetrySettlementService;
  private readonly correctionService: CorrectionSettlementService;

  constructor(
    private readonly repo: AppRepository,
    itemWorker?: RetrySettlementItemWorker,
  ) {
    const worker =
      itemWorker ??
      createAtomicSettlementItemWorker(new SettlementItemApplicationService(repo));
    this.retryService = new RetrySettlementService(repo, worker);
    this.correctionService = new CorrectionSettlementService(repo, worker);
  }

  async retry(
    trustedOpenid: string | null | undefined,
    matchId: string,
    serverNow: Date,
  ): Promise<AdminRetrySettlementOutcome> {
    if (typeof matchId !== "string" || !isValidUuid(matchId)) {
      throw validationError("match_id 必须为 UUID v4", { field: "match_id" });
    }
    assertValidServerNow(serverNow);

    const target = await this.repo.withTransaction(async (tx) => {
      const admin = await this.authorization.requireActiveAdmin(tx, trustedOpenid);
      if (tx.adminAuditLogs === undefined) {
        throw internalError("admin_audit_logs repository port 未配置");
      }

      const match = await tx.matches.findById(matchId);
      if (match === null) {
        throw notFoundError("MATCH");
      }

      const allSettlements = await tx.settlements.findByMatch(matchId);
      if (
        match.settlement_status === SettlementStatus.Settling ||
        match.settlement_status === SettlementStatus.Correcting
      ) {
        throw conflictError("SETTLEMENT_ALREADY_RUNNING", "比赛已有结算任务正在运行");
      }

      const runningSettlement = allSettlements.find(
        (settlement) => settlement.status === SettlementDocStatus.Running,
      );
      if (runningSettlement !== undefined) {
        throw conflictError("SETTLEMENT_ALREADY_RUNNING", "比赛已有结算任务正在运行", {
          settlement_id: runningSettlement.settlement_id,
          result_version: runningSettlement.result_version,
        });
      }

      const failedSettlements = allSettlements.filter(
        (settlement) => settlement.status === SettlementDocStatus.Failed,
      );
      const targetSettlement = selectFailedSettlementTarget(
        match,
        failedSettlements,
        allSettlements,
      );
      if (targetSettlement.is_correction) {
        if (!validateSettlementTransition(match.settlement_status, SettlementStatus.Correcting)) {
          throw conflictError(
            "MATCH_STATE_CONFLICT",
            "管理员 correction retry 不能绕过比赛结算状态机",
            { from: match.settlement_status, to: SettlementStatus.Correcting },
          );
        }
        return {
          admin_id: admin.admin_id,
          settlement_id: targetSettlement.settlement_id,
          is_correction: true as const,
          result_version: targetSettlement.result_version,
        };
      }
      if (!validateSettlementTransition(match.settlement_status, SettlementStatus.Settling)) {
        throw conflictError(
          "MATCH_STATE_CONFLICT",
          "管理员重试不能绕过比赛结算状态机",
          { from: match.settlement_status, to: SettlementStatus.Settling },
        );
      }
      return {
        admin_id: admin.admin_id,
        settlement_id: targetSettlement.settlement_id,
        is_correction: false as const,
        result_version: targetSettlement.result_version,
      };
    });

    if (typeof target.admin_id !== "string") {
      throw internalError("管理员身份读取失败");
    }
    const auditWriter = createRetryAuditWriter(target.admin_id);
    let outcome = target.is_correction
      ? await this.correctionService.correct(matchId, serverNow, target.result_version, auditWriter)
      : await this.retryService.retry(target.settlement_id, serverNow, auditWriter);

    if (
      (outcome.kind === "settled" || outcome.kind === "failed" || outcome.kind === "correcting") &&
      outcome.audit_log === undefined
    ) {
      throw internalError("管理员 retry 未生成审计记录");
    }

    // 第 15.9 节：retried settlement finalize 后继续消化更高未处理 result_version。
    if (outcome.kind === "settled" || outcome.kind === "correcting") {
      await continuePendingCorrections(
        this.repo,
        this.correctionService,
        matchId,
        serverNow,
      );
      if (outcome.kind === "correcting") {
        const matchAfter = await this.repo.matches.findById(matchId);
        if (matchAfter?.settlement_status === SettlementStatus.Settled) {
          outcome = {
            ...outcome,
            kind: "settled",
          };
        } else if (matchAfter?.settlement_status === SettlementStatus.Failed) {
          const failed: CorrectionSettlementOutcome = {
            kind: "failed",
            settlement_id: outcome.settlement_id,
            settlement_created: outcome.settlement_created,
            target_result_version: outcome.target_result_version,
            processed_count: outcome.processed_count,
            skipped_applied_count: outcome.skipped_applied_count,
            ...(outcome.audit_log === undefined ? {} : { audit_log: outcome.audit_log }),
          };
          outcome = failed;
        }
      }
    }

    if (
      outcome.kind === "settled" ||
      outcome.kind === "failed" ||
      outcome.kind === "correcting"
    ) {
      return {
        ...outcome,
        result_version: target.result_version,
      };
    }
    return outcome;
  }
}
