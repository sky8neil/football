import { reconcileSettledMatch } from "./settlement-progress.js";
/**
 * 首次结算入口：准备账本、逐 item 原子入账、重算周榜、完成结算。
 * 准备、各 item、周榜和 finalize 分别提交；applied item 不随之后的失败回滚。
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
import type {
  MatchResult,
  SettlementDoc,
  SettlementItem,
} from "../domain/types.js";
import type {
  AppRepository,
  UnitOfWork,
} from "../infrastructure/repositories.js";
import {
  decideFirstSettlement,
  FirstSettlementCode,
} from "./first-settlement.js";
import { assertValidServerNow } from "./period-finalize.js";
import { rebuildSettlementWeekRanks } from "./settlement-item-application-service.js";
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

export function workerErrorInfo(err: unknown): {
  code: string;
  message: string;
} {
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
    throw conflictError(
      "MATCH_STATE_CONFLICT",
      "比赛结算状态转移违反结算状态机",
      {
        from: match.settlement_status,
        to,
      },
    );
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
    const acquired = await this.repo.jobLocks.acquire(
      lockKey,
      ownerId,
      leaseUntil,
    );
    if (!acquired) {
      return {
        kind: "not_started" as const,
        code: FirstSettlementCode.AlreadyRunning,
      };
    }

    let workerError: unknown;
    let workerFailed = false;
    const lockRenewal = startSettlementLockRenewal(this.repo, lockKey, ownerId);

    try {
      await reconcileSettledMatch(this.repo, matchId);
      const outcome = await (async (): Promise<FirstSettlementStartOutcome> => {
        const prepared = await this.repo.withTransaction(async (tx) => {
          const match = await tx.matches.findById(matchId);
          if (match === null) {
            throw notFoundError("MATCH");
          }
          if ((await tx.anomalies?.findOpenBlockingByMatch(matchId))?.length) {
            return {
              kind: "not_started" as const,
              code: FirstSettlementCode.NotReady,
            };
          }

          const unfinished = (await tx.settlements.findByMatch(matchId))
            .filter(
              (row) =>
                !row.is_correction &&
                row.status !== SettlementDocStatus.Settled,
            )
            .sort((a, b) => a.result_version - b.result_version)[0];
          const decision = decideFirstSettlement({
            match_status: match.match_status,
            settlement_status:
              match.settlement_status === SettlementStatus.Settling &&
              unfinished !== undefined
                ? SettlementStatus.Waiting
                : match.settlement_status,
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
              kind: "already_settled" as const,
              settlement_id: settled?.settlement_id ?? null,
              processed_count: 0,
              skipped_applied_count: 0,
            };
          }

          if (decision.kind !== "start") {
            return { kind: "not_started" as const, code: decision.code };
          }

          const result = unfinished
            ? await tx.matchResults.findByMatchAndVersion(
                matchId,
                unfinished.result_version,
              )
            : await tx.matchResults.findLatestByMatch(matchId);
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
            settlement = buildSettlement(
              matchId,
              resultVersion,
              ruleVersion,
              serverNow,
            );
            await tx.settlements.insert(settlement);
            settlementCreated = true;
          } else if (existing.status === SettlementDocStatus.Settled) {
            return {
              kind: "already_settled" as const,
              settlement_id: existing.settlement_id,
              processed_count: 0,
              skipped_applied_count: 0,
            };
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

          const items = await prepareSettlementItems(
            tx,
            settlement,
            result,
            serverNow,
          );
          return {
            kind: "prepared" as const,
            match,
            result,
            settlement,
            settlementCreated,
            runningSettlement,
            items,
            resultVersion,
          };
        });
        if (prepared.kind !== "prepared")
          return prepared as FirstSettlementStartOutcome;
        const {
          match,
          result,
          settlement,
          settlementCreated,
          runningSettlement,
          items,
          resultVersion,
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
            workerFailed = true;
            workerError = err;
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
                matchId,
                SettlementStatus.Failed,
                serverNow,
              );
            });
            break;
          }

          lockRenewal.assertHealthy();
          processedCount += 1;
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
          const finalMatch = await tx.matches.findById(matchId);
          if (finalMatch === null) {
            throw notFoundError("MATCH");
          }

          await tx.settlements.update({
            ...finalizingSettlement,
            status: SettlementDocStatus.Settled,
            phase: SettlementPhase.Done,
            settled_at: serverNow,
            updated_at: serverNow,
          });

          // 49.3 / 15.9 finalize 顺序：先写 settled_result_version=v 与 settled_at，
          // 再重新读取 result_version 决定 settled 或 settling -> correcting。
          await tx.matches.updateSettlementProgress(
            finalMatch.match_id,
            resultVersion,
            serverNow,
          );
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
        });

        return {
          kind: "started",
          settlement_id: settlement.settlement_id,
          settlement_created: settlementCreated,
          processed_count: processedCount,
          skipped_applied_count: skippedAppliedCount,
        };
      })();

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
