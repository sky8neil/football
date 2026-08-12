/**
 * 首次结算 orchestration 服务（阶段 4 切片 C）。
 *
 * FirstSettlementService.start(matchId, serverNow, hasBlockingAnomaly) 是首次结算
 * 唯一服务入口：必须读取 match，交由 decideFirstSettlement 纯决策；仅当 kind=start
 * 才继续。继续流程：
 * - 读取 match_results 最新版本；
 * - 按 (match_id, result_version, rule_version) 创建或复用 settlement；若已存在
 *   settled settlement 则不再创建、直接返回已完成（重复调用幂等）；
 * - match.settlement_status waiting -> settling；
 * - 读取该 settlement 的全部 items，仅处理 pending/failed，applied 跳过；
 * - 通过可注入 itemWorker(item, result) 处理 item，成功则 item -> applied；
 * - 全部成功：settlement -> settled/done，match -> settled（settled_result_version、
 *   settled_at）；无 items 同样成功 settled；
 * - itemWorker 失败：当前 item -> failed（attempt_count+1、记录 last_error），
 *   settlement -> failed/apply_items，match -> failed，抛出原错误；已 applied 的
 *   item 不回滚，重试只处理 pending/failed（规范 15.4 部分失败恢复）。
 */
import {
  SCHEMA_VERSION,
  SettlementDocStatus,
  SettlementItemStatus,
  SettlementPhase,
  SettlementStatus,
} from "../domain/enums.js";
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import {
  DomainError,
  conflictError,
  internalError,
  notFoundError,
} from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import { validateSettlementTransition } from "../domain/settlement-state-machine.js";
import type { MatchResult, SettlementDoc, SettlementItem } from "../domain/types.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";
import { decideFirstSettlement, FirstSettlementCode } from "./first-settlement.js";
import { assertValidServerNow } from "./period-finalize.js";
import { prepareSettlementItems } from "./settlement-item-preparation.js";

export interface SettlementItemWorkerContext {
  tx: UnitOfWork;
  server_now: Date;
}

export interface SettlementItemWorkerResult {
  /** worker 已在同一事务中把 item 标为 applied，orchestration 不再覆盖其字段。 */
  item_applied: boolean;
}

/** 单个 settlement item 的领域应用动作（可注入；默认空实现）。 */
export type SettlementItemWorker = (
  item: SettlementItem,
  result: MatchResult,
  context?: SettlementItemWorkerContext,
) => Promise<void | SettlementItemWorkerResult>;

export type FirstSettlementStartOutcome =
  | {
      kind: "started";
      settlement_id: string;
      settlement_created: boolean;
      processed_count: number;
      skipped_applied_count: number;
    }
  | {
      kind: "already_settled";
      settlement_id: string | null;
      processed_count: number;
      skipped_applied_count: number;
    }
  | {
      kind: "not_started";
      code: string;
    };

const ITEM_WORKER_FAILED_CODE = "SETTLEMENT_ITEM_FAILED";

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
    is_correction: false,
    started_at: null,
    settled_at: null,
    attempt_count: 0,
    last_error_code: null,
    last_error_message: null,
    created_at: serverNow,
    updated_at: serverNow,
  };
}

export function workerErrorInfo(err: unknown): { code: string; message: string } {
  const code =
    err instanceof DomainError
      ? err.code
      : ((err as { code?: string } | null)?.code ?? ITEM_WORKER_FAILED_CODE);
  const message = err instanceof Error ? err.message : String(err);
  return { code, message };
}

/** 单场结算并发锁 key：`settlement:match:{match_id}`。 */
export function settlementMatchLockKey(matchId: string): string {
  return `settlement:match:${matchId}`;
}

/**
 * 49.3 单一入口：所有 match settlement_status 变更先经合法表校验，非法 from→to Fail Closed。
 * from 与 to 相同时为保持（已处于 correcting 则保持），不产生写入。
 */
export async function transitionMatchSettlementStatus(
  tx: UnitOfWork,
  matchId: string,
  to: SettlementStatus,
  serverNow: Date,
): Promise<void> {
  const match = await tx.matches.findById(matchId);
  if (match === null) {
    throw notFoundError("MATCH");
  }
  if (match.settlement_status === to) {
    return;
  }
  if (!validateSettlementTransition(match.settlement_status, to)) {
    throw conflictError("MATCH_STATE_CONFLICT", "比赛结算状态转移违反结算状态机", {
      from: match.settlement_status,
      to,
    });
  }
  await tx.matches.updateSettlementStatus(matchId, to, serverNow);
}

const JOB_LEASE_MILLISECONDS = FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000;

export interface SettlementLockRenewal {
  assertHealthy(): void;
  stop(): void;
}

/** 在结算入口执行期间按半个 lease 周期续租，避免长时间 itemWorker 让锁过期。 */
export function startSettlementLockRenewal(
  repo: AppRepository,
  lockKey: string,
  ownerId: string,
): SettlementLockRenewal {
  let renewalFailure: DomainError | undefined;
  const markRenewalFailure = () => {
    renewalFailure ??= conflictError(
      FirstSettlementCode.AlreadyRunning,
      "结算锁续租失败，当前结算已终止",
    );
  };

  const timer = setInterval(() => {
    void Promise.resolve()
      .then(() =>
        repo.jobLocks.renew(
          lockKey,
          ownerId,
          new Date(Date.now() + JOB_LEASE_MILLISECONDS),
        ),
      )
      .then((renewed) => {
        if (!renewed) {
          markRenewalFailure();
        }
      }, markRenewalFailure);
  }, JOB_LEASE_MILLISECONDS / 2);

  return {
    assertHealthy: () => {
      if (renewalFailure !== undefined) {
        throw renewalFailure;
      }
    },
    stop: () => clearInterval(timer),
  };
}

export class FirstSettlementService {
  constructor(
    private readonly repo: AppRepository,
    private readonly itemWorker: SettlementItemWorker = async () => {},
  ) {}

  async start(
    matchId: string,
    serverNow: Date,
    hasBlockingAnomaly: boolean,
  ): Promise<FirstSettlementStartOutcome> {
    assertValidServerNow(serverNow);
    const lockKey = settlementMatchLockKey(matchId);
    const ownerId = newUuid();
    const leaseUntil = new Date(
      serverNow.getTime() + FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000,
    );
    const acquired = await this.repo.jobLocks.acquire(lockKey, ownerId, leaseUntil);
    if (!acquired) {
      return { kind: "not_started", code: FirstSettlementCode.AlreadyRunning };
    }

    let workerError: unknown;
    let workerFailed = false;
    const lockRenewal = startSettlementLockRenewal(this.repo, lockKey, ownerId);

    try {
      const outcome = await this.repo.withTransaction(
        async (tx): Promise<FirstSettlementStartOutcome> => {
          const match = await tx.matches.findById(matchId);
          if (match === null) {
            throw notFoundError("MATCH");
          }

          const decision = decideFirstSettlement({
            match_status: match.match_status,
            settlement_status: match.settlement_status,
            finish_detected_at: match.finish_detected_at,
            result_version: match.result_version,
            regular_home_score: match.regular_home_score,
            regular_away_score: match.regular_away_score,
            server_now: serverNow,
            has_blocking_anomaly: hasBlockingAnomaly,
          });

          if (decision.kind === "settled") {
            const settled = await tx.settlements.findByMatchAndVersionAndRule(
              matchId,
              match.settled_result_version,
              match.scoring_rule_version,
            );
            return {
              kind: "already_settled",
              settlement_id: settled?.settlement_id ?? null,
              processed_count: 0,
              skipped_applied_count: 0,
            };
          }

          if (decision.kind !== "start") {
            return { kind: "not_started", code: decision.code };
          }

          const result = await tx.matchResults.findLatestByMatch(matchId);
          if (result === null) {
            throw internalError("首次结算前必须存在最新 match_results 版本");
          }
          const resultVersion = result.result_version;
          const ruleVersion = match.scoring_rule_version;

          let settlement: SettlementDoc;
          let settlementCreated = false;
          const existing = await tx.settlements.findByMatchAndVersionAndRule(
            matchId,
            resultVersion,
            ruleVersion,
          );
          if (existing === null) {
            settlement = buildSettlement(matchId, resultVersion, ruleVersion, serverNow);
            await tx.settlements.insert(settlement);
            settlementCreated = true;
          } else if (existing.status === SettlementDocStatus.Settled) {
            return {
              kind: "already_settled",
              settlement_id: existing.settlement_id,
              processed_count: 0,
              skipped_applied_count: 0,
            };
          } else if (existing.status === SettlementDocStatus.Running) {
            return { kind: "not_started", code: FirstSettlementCode.AlreadyRunning };
          } else {
            settlement = existing;
          }

          await transitionMatchSettlementStatus(
            tx,
            matchId,
            SettlementStatus.Settling,
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

          const items = await prepareSettlementItems(tx, settlement, result, serverNow);
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
              workerFailed = true;
              workerError = err;
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
              break;
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

          if (workerFailed) {
            return {
              kind: "started",
              settlement_id: settlement.settlement_id,
              settlement_created: settlementCreated,
              processed_count: processedCount,
              skipped_applied_count: skippedAppliedCount,
            };
          }

          lockRenewal.assertHealthy();
          const finalMatch = await tx.matches.findById(matchId);
          if (finalMatch === null) {
            throw notFoundError("MATCH");
          }

          await tx.settlements.update({
            ...runningSettlement,
            status: SettlementDocStatus.Settled,
            phase: SettlementPhase.Done,
            settled_at: serverNow,
            updated_at: serverNow,
          });

          // 49.3 / 15.9 finalize 顺序：先写 settled_result_version=v 与 settled_at，
          // 再重新读取 result_version 决定 settled 或 settling -> correcting。
          await tx.matches.update({
            ...finalMatch,
            settled_result_version: resultVersion,
            settled_at: serverNow,
            updated_at: serverNow,
          });
          const afterFinalize = await tx.matches.findById(matchId);
          if (afterFinalize === null) {
            throw notFoundError("MATCH");
          }
          const hasNewerResult = afterFinalize.result_version > resultVersion;
          await transitionMatchSettlementStatus(
            tx,
            matchId,
            hasNewerResult
              ? SettlementStatus.Correcting
              : SettlementStatus.Settled,
            serverNow,
          );

          return {
            kind: "started",
            settlement_id: settlement.settlement_id,
            settlement_created: settlementCreated,
            processed_count: processedCount,
            skipped_applied_count: skippedAppliedCount,
          };
        },
      );

      if (workerFailed) {
        throw workerError;
      }
      return outcome;
    } finally {
      lockRenewal.stop();
      await this.repo.jobLocks.release(lockKey, ownerId);
    }
  }
}
