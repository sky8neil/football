/**
 * 赛果修正结算 orchestration 服务（阶段 4 切片 F）。
 *
 * CorrectionSettlementService.correct(matchId, serverNow, targetResultVersion?) 是
 * 赛果修正结算唯一服务入口：
 * - 读取 match，要求 match_status=finished、result_version>=1、settled_result_version>0
 *   且 current result_version > settled_result_version，否则抛对应 conflict error；
 * - 通过 nextSettlementVersion 只选择 settled_result_version+1，禁止跳过中间版本直达
 *   最新（targetResultVersion 若提供必须等于该下一版本，否则 RESULT_VERSION_SKIPPED）；
 * - 读取该版本的 match_results 与已有唯一 settlement，创建或复用（is_correction=true），
 *   已 settled 的 settlement 复用返回 already_settled，绝不重复创建；
 * - 按 settlement:match:{match_id} 获取 job lock（lease 复用现有 jobLocks、owner 为新
 *   UUID、finally 释放），无法获取 -> SETTLEMENT_ALREADY_RUNNING；
 * - match settlement_status -> correcting，处理 pending/failed items，applied 永不调用
 *   worker；
 * - item worker 成功立即 item -> applied（attempt_count+1）；失败立即 item -> failed
 *   （attempt_count+1、last_error）、settlement -> failed/apply_items（保留已 applied）、
 *   match 回退 failed，返回 kind=failed；
 * - 全部成功（含无 items）：settlement -> settled/done，match settled_result_version=
 *   targetVersion；若还有后续 result_version，match settlement_status 保持 correcting，
 *   否则 settled。
 *
 * 不实现 career、rankings、levels、admin、provider、frontend。
 */
import {
  MatchStatus,
  SCHEMA_VERSION,
  SettlementDocStatus,
  SettlementItemStatus,
  SettlementPhase,
  SettlementStatus,
} from "../domain/enums.js";
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { conflictError, internalError, notFoundError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import { assertMatchResultVersionInvariants } from "../domain/invariants.js";
import { validateSettlementTransition } from "../domain/settlement-state-machine.js";
import type { AdminAuditLog, Match, SettlementDoc } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import {
  startSettlementLockRenewal,
  transitionMatchSettlementStatus,
  type SettlementItemWorker,
  workerErrorInfo,
} from "./first-settlement-service.js";
import { nextSettlementVersion } from "./result-correction-plan.js";
import { assertValidServerNow } from "./period-finalize.js";
import {
  settlementMatchLockKey,
  snapshotSettlementForAudit,
  type SettlementRetryAuditWriter,
} from "./retry-settlement-service.js";
import { prepareSettlementItems } from "./settlement-item-preparation.js";

export const CorrectionSettlementCode = {
  MatchNotFinished: "MATCH_NOT_FINISHED",
  InvalidResultVersion: "INVALID_RESULT_VERSION",
  MatchNotSettled: "MATCH_NOT_SETTLED",
  NothingToCorrect: "SETTLEMENT_NOTHING_TO_CORRECT",
  VersionSkipped: "RESULT_VERSION_SKIPPED",
  AlreadyRunning: "SETTLEMENT_ALREADY_RUNNING",
  MatchStateConflict: "MATCH_STATE_CONFLICT",
} as const;

export type CorrectionSettlementOutcome = (
  | {
      kind: "settled";
      settlement_id: string;
      settlement_created: boolean;
      target_result_version: number;
      processed_count: number;
      skipped_applied_count: number;
    }
  | {
      kind: "correcting";
      settlement_id: string;
      settlement_created: boolean;
      target_result_version: number;
      processed_count: number;
      skipped_applied_count: number;
    }
  | {
      kind: "already_settled";
      settlement_id: string;
      target_result_version: number;
    }
  | {
      kind: "failed";
      settlement_id: string;
      settlement_created: boolean;
      target_result_version: number;
      processed_count: number;
      skipped_applied_count: number;
    }
  | {
      kind: "already_running";
      settlement_id: string | null;
      code: string;
    }
  )
  & {
    audit_log?: AdminAuditLog;
  };

/** 修正结算：settlement 必须标记 is_correction=true（规范 11.1 结算账本）。 */
function buildSettlement(
  matchId: string,
  resultVersion: number,
  ruleVersion: string,
  serverNow: Date,
): SettlementDoc {
  return {
    schema_version: SCHEMA_VERSION,
    settlement_id: newUuid(),
    match_id: matchId,
    result_version: resultVersion,
    rule_version: ruleVersion,
    status: SettlementDocStatus.Pending,
    phase: SettlementPhase.Prepare,
    is_correction: true,
    started_at: null,
    settled_at: null,
    attempt_count: 0,
    last_error_code: null,
    last_error_message: null,
    created_at: serverNow,
    updated_at: serverNow,
  };
}

export class CorrectionSettlementService {
  constructor(
    private readonly repo: AppRepository,
    private readonly itemWorker: SettlementItemWorker = async () => {},
  ) {}

  /** 校验修正前置条件并决定本次目标版本：严格按 settled_result_version+1 顺序推进。 */
  private resolveTarget(
    match: Match,
    targetResultVersion: number | undefined,
  ): number {
    assertMatchResultVersionInvariants(match);
    if (match.match_status !== MatchStatus.Finished) {
      throw conflictError(
        CorrectionSettlementCode.MatchNotFinished,
        "只有 finished 状态的比赛才能修正结算",
      );
    }
    if (match.result_version < 1) {
      throw conflictError(
        CorrectionSettlementCode.InvalidResultVersion,
        "match 缺少结果版本，无法修正结算",
      );
    }
    if (match.settled_result_version < 1) {
      throw conflictError(
        CorrectionSettlementCode.MatchNotSettled,
        "赛果修正只对已结算（settled_result_version>0）的比赛生效",
      );
    }
    if (match.result_version <= match.settled_result_version) {
      throw conflictError(
        CorrectionSettlementCode.NothingToCorrect,
        "当前结果版本已全部结算，无待修正版本",
      );
    }
    if (
      match.settlement_status !== SettlementStatus.Correcting &&
      !validateSettlementTransition(
        match.settlement_status,
        SettlementStatus.Correcting,
      )
    ) {
      throw conflictError(
        CorrectionSettlementCode.MatchStateConflict,
        "修正结算不能绕过比赛结算状态机",
        {
          from: match.settlement_status,
          to: SettlementStatus.Correcting,
        },
      );
    }
    const next = nextSettlementVersion(match.result_version, match.settled_result_version);
    if (next === null) {
      throw conflictError(
        CorrectionSettlementCode.NothingToCorrect,
        "当前结果版本已全部结算，无待修正版本",
      );
    }
    if (targetResultVersion !== undefined && targetResultVersion !== next) {
      throw conflictError(
        CorrectionSettlementCode.VersionSkipped,
        "修正结算只能按 settled_result_version+1 顺序推进，禁止跳过中间版本",
      );
    }
    return next;
  }

  async correct(
    matchId: string,
    serverNow: Date,
    targetResultVersion?: number,
    auditWriter?: SettlementRetryAuditWriter,
  ): Promise<CorrectionSettlementOutcome> {
    assertValidServerNow(serverNow);
    const initial = await this.repo.matches.findById(matchId);
    if (initial === null) {
      throw notFoundError("MATCH");
    }
    this.resolveTarget(initial, targetResultVersion);

    const lockKey = settlementMatchLockKey(matchId);
    const ownerId = newUuid();
    const leaseUntil = new Date(
      serverNow.getTime() + FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000,
    );
    const acquired = await this.repo.jobLocks.acquire(lockKey, ownerId, leaseUntil);
    if (!acquired) {
      return {
        kind: "already_running",
        settlement_id: null,
        code: CorrectionSettlementCode.AlreadyRunning,
      };
    }

    const lockRenewal = startSettlementLockRenewal(this.repo, lockKey, ownerId);
    try {
      return await this.repo.withTransaction<CorrectionSettlementOutcome>(
        async (tx): Promise<CorrectionSettlementOutcome> => {
          const match = await tx.matches.findById(matchId);
          if (match === null) {
            throw notFoundError("MATCH");
          }
          const target = this.resolveTarget(match, targetResultVersion);

          const result = await tx.matchResults.findByMatchAndVersion(matchId, target);
          if (result === null) {
            throw internalError("修正结算缺少对应 match_results 版本");
          }

          let settlement: SettlementDoc;
          let settlementCreated = false;
          const existing = await tx.settlements.findByMatchAndVersionAndRule(
            matchId,
            target,
            match.scoring_rule_version,
          );
          if (existing === null) {
            settlement = buildSettlement(matchId, target, match.scoring_rule_version, serverNow);
            await tx.settlements.insert(settlement);
            settlementCreated = true;
          } else if (!existing.is_correction) {
            throw internalError("修正结算复用的 settlement 类型不一致");
          } else if (existing.status === SettlementDocStatus.Settled) {
            return {
              kind: "already_settled",
              settlement_id: existing.settlement_id,
              target_result_version: target,
            };
          } else if (existing.status === SettlementDocStatus.Running) {
            return {
              kind: "already_running",
              settlement_id: existing.settlement_id,
              code: CorrectionSettlementCode.AlreadyRunning,
            };
          } else {
            settlement = existing;
          }

          const oldAuditValue = auditWriter
            ? await snapshotSettlementForAudit(tx, settlement.settlement_id)
            : null;
          const items = await prepareSettlementItems(tx, settlement, result, serverNow);

          await transitionMatchSettlementStatus(
            tx,
            matchId,
            SettlementStatus.Correcting,
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

          let processedCount = 0;
          let skippedAppliedCount = 0;

          for (const item of items) {
            if (item.status === SettlementItemStatus.Applied) {
              skippedAppliedCount += 1;
              continue;
            }

            lockRenewal.assertHealthy();
            let itemAppliedByWorker = false;
            try {
              const workResult = await this.itemWorker(item, result, {
                tx,
                server_now: serverNow,
              });
              itemAppliedByWorker = workResult?.item_applied === true;
            } catch (err) {
              const { code, message } = workerErrorInfo(err);
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
                matchId,
                SettlementStatus.Failed,
                serverNow,
              );
              const outcome: CorrectionSettlementOutcome = {
                kind: "failed",
                settlement_id: settlement.settlement_id,
                settlement_created: settlementCreated,
                target_result_version: target,
                processed_count: processedCount,
                skipped_applied_count: skippedAppliedCount,
              };
              return auditWriter === undefined
                ? outcome
                : {
                    ...outcome,
                    audit_log: await auditWriter(
                      tx,
                      oldAuditValue ?? (await snapshotSettlementForAudit(tx, settlement.settlement_id)),
                      await snapshotSettlementForAudit(tx, settlement.settlement_id),
                      serverNow,
                    ),
                  };
            }

            lockRenewal.assertHealthy();
            processedCount += 1;
            if (!itemAppliedByWorker) {
              await tx.settlementItems.update({
                ...item,
                status: SettlementItemStatus.Applied,
                applied_at: serverNow,
                attempt_count: item.attempt_count + 1,
                last_error_code: null,
                last_error_message: null,
                updated_at: serverNow,
              });
            }
          }

          await tx.settlements.update({
            ...runningSettlement,
            status: SettlementDocStatus.Settled,
            phase: SettlementPhase.Done,
            settled_at: serverNow,
            updated_at: serverNow,
          });

          lockRenewal.assertHealthy();
          const finalMatch = await tx.matches.findById(matchId);
          if (finalMatch === null) {
            throw notFoundError("MATCH");
          }
          // 49.3 / 15.9 finalize 顺序：先写 settled_result_version=v 与 settled_at，
          // 再重新读取 result_version 决定 settled 或保持 correcting。
          await tx.matches.update({
            ...finalMatch,
            settled_result_version: target,
            settled_at: serverNow,
            updated_at: serverNow,
          });
          const afterFinalize = await tx.matches.findById(matchId);
          if (afterFinalize === null) {
            throw notFoundError("MATCH");
          }
          const remaining = nextSettlementVersion(afterFinalize.result_version, target) !== null;
          await transitionMatchSettlementStatus(
            tx,
            matchId,
            remaining ? SettlementStatus.Correcting : SettlementStatus.Settled,
            serverNow,
          );

          const outcome: CorrectionSettlementOutcome = {
            kind: remaining ? "correcting" : "settled",
            settlement_id: settlement.settlement_id,
            settlement_created: settlementCreated,
            target_result_version: target,
            processed_count: processedCount,
            skipped_applied_count: skippedAppliedCount,
          };
          return auditWriter === undefined
            ? outcome
            : {
                ...outcome,
                audit_log: await auditWriter(
                  tx,
                  oldAuditValue ?? (await snapshotSettlementForAudit(tx, settlement.settlement_id)),
                  await snapshotSettlementForAudit(tx, settlement.settlement_id),
                  serverNow,
                ),
              };
        },
      );
    } finally {
      lockRenewal.stop();
      await this.repo.jobLocks.release(lockKey, ownerId);
    }
  }
}
