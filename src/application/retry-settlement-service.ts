import { reconcileSettledMatch } from "./settlement-progress.js";
/**
 * 结算恢复入口：失败或租约释放后的 running 结算可恢复，包括 correction。
 * 准备、各 item、周榜和 finalize 分别提交；applied item 不随之后的失败回滚。
 */
import {
  SettlementDocStatus,
  SettlementItemStatus,
  SettlementPhase,
  SettlementStatus,
} from "../domain/enums.js";
import {
  conflictError,
  notFoundError,
  internalError,
} from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import type {
  AdminAuditLog,
  MatchResult,
  SettlementDoc,
} from "../domain/types.js";
import type {
  AppRepository,
  UnitOfWork,
} from "../infrastructure/repositories.js";
import { FirstSettlementCode } from "./first-settlement.js";
import {
  settlementMatchLockKey,
  startSettlementLockRenewal,
  transitionMatchSettlementStatus,
  type SettlementItemWorker,
  workerErrorInfo,
} from "./first-settlement-service.js";
import { assertValidServerNow } from "./period-finalize.js";
import { rebuildSettlementWeekRanks } from "./settlement-item-application-service.js";
import { prepareSettlementItems } from "./settlement-item-preparation.js";

/** 单个 settlement item 的领域应用动作（可注入；默认空实现）。 */
export type RetrySettlementItemWorker = SettlementItemWorker;

export interface SettlementRetryAuditSnapshot {
  settlement_id: string;
  settlement_status: SettlementStatus;
  phase: SettlementPhase;
  attempt_count: number;
  failed_item_count: number;
  pending_item_count: number;
  applied_item_count: number;
}

export type SettlementRetryAuditWriter = (
  tx: UnitOfWork,
  oldValue: SettlementRetryAuditSnapshot,
  newValue: SettlementRetryAuditSnapshot,
  serverNow: Date,
) => Promise<AdminAuditLog>;

export type RetrySettlementOutcome = (
  | {
      kind: "settled";
      settlement_id: string;
      processed_count: number;
      skipped_applied_count: number;
    }
  | {
      /** itemWorker 失败：item -> failed，settlement -> failed，match -> failed。 */
      kind: "failed";
      settlement_id: string;
      processed_count: number;
      skipped_applied_count: number;
    }
  | {
      kind: "already_settled";
      settlement_id: string;
    }
  | {
      kind: "already_running";
      settlement_id: string;
      code: string;
    }
  | {
      kind: "not_retryable";
      settlement_id: string;
      status: SettlementDocStatus;
    }
) & {
  audit_log?: AdminAuditLog;
};

export { settlementMatchLockKey } from "./first-settlement-service.js";

export class RetrySettlementService {
  constructor(
    private readonly repo: AppRepository,
    private readonly itemWorker: RetrySettlementItemWorker = async () => {},
  ) {}

  async retry(
    settlementId: string,
    serverNow: Date,
    auditWriter?: SettlementRetryAuditWriter,
  ): Promise<RetrySettlementOutcome> {
    assertValidServerNow(serverNow);
    const existing = await this.repo.settlements.findById(settlementId);
    if (existing === null) {
      throw notFoundError("SETTLEMENT");
    }

    if (existing.status === SettlementDocStatus.Settled) {
      await reconcileSettledMatch(this.repo, existing.match_id);
      return { kind: "already_settled" as const, settlement_id: settlementId };
    }
    if (
      existing.status !== SettlementDocStatus.Failed &&
      existing.status !== SettlementDocStatus.Running
    ) {
      return {
        kind: "not_retryable" as const,
        settlement_id: settlementId,
        status: existing.status,
      };
    }

    const lockKey = settlementMatchLockKey(existing.match_id);
    const ownerId = newUuid();
    const leaseUntil = new Date(
      serverNow.getTime() + FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000,
    );
    const acquired = await this.repo.jobLocks.acquire(
      lockKey,
      ownerId,
      leaseUntil,
    );
    if (!acquired) {
      return {
        kind: "already_running",
        settlement_id: settlementId,
        code: FirstSettlementCode.AlreadyRunning,
      };
    }

    const lockRenewal = startSettlementLockRenewal(this.repo, lockKey, ownerId);
    try {
      return await (async (): Promise<RetrySettlementOutcome> => {
        const prepared = await this.repo.withTransaction(async (tx) => {
          const settlement = await tx.settlements.findById(settlementId);
          if (settlement === null) {
            throw notFoundError("SETTLEMENT");
          }
          if (settlement.status === SettlementDocStatus.Settled) {
            return {
              kind: "already_settled" as const,
              settlement_id: settlementId,
            };
          }
          if (
            settlement.status !== SettlementDocStatus.Failed &&
            settlement.status !== SettlementDocStatus.Running
          ) {
            return {
              kind: "not_retryable" as const,
              settlement_id: settlementId,
              status: settlement.status,
            };
          }

          const match = await tx.matches.findById(settlement.match_id);
          if (match === null) {
            throw notFoundError("MATCH");
          }
          if (
            (await tx.anomalies?.findOpenBlockingByMatch(settlement.match_id))
              ?.length
          ) {
            throw conflictError(
              "SETTLEMENT_NOT_READY",
              "比赛存在未解决的阻塞异常",
            );
          }

          if (settlement.result_version <= match.settled_result_version) {
            throw internalError("重试结算 result_version 不得回退已结算版本");
          }

          const result = await tx.matchResults.findByMatchAndVersion(
            settlement.match_id,
            settlement.result_version,
          );
          if (result === null) {
            throw internalError("重试结算缺少对应 match_results 版本");
          }

          const oldAuditValue = auditWriter
            ? await snapshotSettlementForAudit(tx, settlementId)
            : null;
          const items = await prepareSettlementItems(
            tx,
            settlement,
            result,
            serverNow,
          );
          const runningSettlement: SettlementDoc = {
            ...settlement,
            status: SettlementDocStatus.Running,
            phase: SettlementPhase.ApplyItems,
            started_at: serverNow,
            attempt_count: settlement.attempt_count + 1,
            last_error_code: null,
            last_error_message: null,
            updated_at: serverNow,
          };
          await tx.settlements.update(runningSettlement);

          await transitionMatchSettlementStatus(
            tx,
            settlement.match_id,
            settlement.is_correction
              ? SettlementStatus.Correcting
              : SettlementStatus.Settling,
            serverNow,
          );

          return {
            kind: "prepared" as const,
            match,
            result,
            settlement,
            runningSettlement,
            items,
            oldAuditValue,
          };
        });
        if (prepared.kind !== "prepared")
          return prepared as RetrySettlementOutcome;
        const {
          match,
          result,
          settlement,
          runningSettlement,
          items,
          oldAuditValue,
        } = prepared;
        const tx = this.repo;
        let processedCount = 0;
        let skippedAppliedCount = 0;

        for (const item of items) {
          if (item.status === SettlementItemStatus.Applied) {
            skippedAppliedCount += 1;
            continue;
          }

          lockRenewal.assertHealthy();
          try {
            // 单个 item 独立提交；失败项整笔回滚，已 applied 项不受后续失败影响。
            await this.repo.withTransaction(async (itemTx) => {
              const workResult = await this.itemWorker(item, result, {
                tx: itemTx,
                server_now: serverNow,
              });
              if (workResult?.item_applied !== true) {
                await itemTx.settlementItems.update({
                  ...item,
                  status: SettlementItemStatus.Applied,
                  applied_at: serverNow,
                  attempt_count: item.attempt_count + 1,
                  last_error_code: null,
                  last_error_message: null,
                  updated_at: serverNow,
                });
              }
            });
          } catch (err) {
            const { code, message } = workerErrorInfo(err);
            await this.repo.withTransaction(async (tx) => {
              await tx.settlementItems.update({
                ...item,
                status: SettlementItemStatus.Failed,
                attempt_count: item.attempt_count + 1,
                last_error_code: code,
                last_error_message: message,
                updated_at: serverNow,
              });
              await tx.settlements.update({
                ...runningSettlement,
                status: SettlementDocStatus.Failed,
                phase: SettlementPhase.ApplyItems,
                last_error_code: code,
                last_error_message: message,
                updated_at: serverNow,
              });
              await transitionMatchSettlementStatus(
                tx,
                settlement.match_id,
                SettlementStatus.Failed,
                serverNow,
              );
            });
            const outcome: RetrySettlementOutcome = {
              kind: "failed",
              settlement_id: settlementId,
              processed_count: processedCount,
              skipped_applied_count: skippedAppliedCount,
            };
            return auditWriter === undefined
              ? outcome
              : {
                  ...outcome,
                  audit_log: await auditWriter(
                    tx,
                    oldAuditValue ??
                      (await snapshotSettlementForAudit(tx, settlementId)),
                    await snapshotSettlementForAudit(tx, settlementId),
                    serverNow,
                  ),
                };
          }

          lockRenewal.assertHealthy();
          processedCount += 1;
        }

        lockRenewal.assertHealthy();
        await tx.settlements.update({
          ...runningSettlement,
          phase: SettlementPhase.RebuildRanks,
          updated_at: serverNow,
        });
        if (items.length > 0 && match.period_anchor_at !== null) {
          await this.repo.withTransaction((rankTx) =>
            rebuildSettlementWeekRanks(
              rankTx,
              match.period_anchor_at!,
              serverNow,
            ),
          );
        }
        await this.repo.withTransaction(async (tx) => {
          const finalizingSettlement: SettlementDoc = {
            ...runningSettlement,
            phase: SettlementPhase.Finalize,
            updated_at: serverNow,
          };
          await tx.settlements.update(finalizingSettlement);
          await tx.settlements.update({
            ...finalizingSettlement,
            status: SettlementDocStatus.Settled,
            phase: SettlementPhase.Done,
            settled_at: serverNow,
            updated_at: serverNow,
          });

          const finalMatch = await tx.matches.findById(settlement.match_id);
          if (finalMatch === null) {
            throw notFoundError("MATCH");
          }
          // 49.3 / 15.9 finalize 顺序：先写 settled_result_version=v 与 settled_at，
          // 再重新读取 result_version 决定 settled 或 settling -> correcting。
          await tx.matches.updateSettlementProgress(
            finalMatch.match_id,
            settlement.result_version,
            serverNow,
          );
          const afterFinalize = await tx.matches.findById(settlement.match_id);
          if (afterFinalize === null) {
            throw notFoundError("MATCH");
          }
          const hasNewerResult =
            afterFinalize.result_version > settlement.result_version;
          await transitionMatchSettlementStatus(
            tx,
            settlement.match_id,
            hasNewerResult
              ? SettlementStatus.Correcting
              : SettlementStatus.Settled,
            serverNow,
          );
        });

        const outcome: RetrySettlementOutcome = {
          kind: "settled",
          settlement_id: settlementId,
          processed_count: processedCount,
          skipped_applied_count: skippedAppliedCount,
        };
        return auditWriter === undefined
          ? outcome
          : {
              ...outcome,
              audit_log: await auditWriter(
                tx,
                oldAuditValue ??
                  (await snapshotSettlementForAudit(tx, settlementId)),
                await snapshotSettlementForAudit(tx, settlementId),
                serverNow,
              ),
            };
      })();
    } finally {
      lockRenewal.stop();
      await this.repo.jobLocks.release(lockKey, ownerId);
    }
  }
}

export async function snapshotSettlementForAudit(
  tx: UnitOfWork,
  settlementId: string,
): Promise<SettlementRetryAuditSnapshot> {
  const settlement = await tx.settlements.findById(settlementId);
  if (settlement === null) {
    throw internalError("retry settlement 审计缺少 settlement");
  }
  const match = await tx.matches.findById(settlement.match_id);
  if (match === null) {
    throw internalError("retry settlement 审计缺少 match");
  }
  const items = await tx.settlementItems.findBySettlement(settlementId);
  return {
    settlement_id: settlement.settlement_id,
    settlement_status: match.settlement_status,
    phase: settlement.phase,
    attempt_count: settlement.attempt_count,
    failed_item_count: items.filter(
      (item) => item.status === SettlementItemStatus.Failed,
    ).length,
    pending_item_count: items.filter(
      (item) => item.status === SettlementItemStatus.Pending,
    ).length,
    applied_item_count: items.filter(
      (item) => item.status === SettlementItemStatus.Applied,
    ).length,
  };
}
