/**
 * 结算组合入口：默认把 settlement item 接到原子聚合应用服务。
 * 具体状态机和版本队列仍由 First/Retry/Correction 服务负责。
 * 第 15.9 节：某 version finalize 后若仍有更高 result_version，按最小未处理版本
 * 继续启动 correction settlement，不得在中间版本停住。
 */
import { SettlementStatus } from "../domain/enums.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import {
  LevelCorrectionReevalService,
  type LevelCorrectionReevalOutcome,
} from "./level-correction-reeval.js";
import {
  CorrectionSettlementService,
  type CorrectionSettlementOutcome,
} from "./correction-settlement-service.js";
import {
  FirstSettlementService,
  type FirstSettlementStartOutcome,
} from "./first-settlement-service.js";
import {
  RetrySettlementService,
  type RetrySettlementOutcome,
} from "./retry-settlement-service.js";
import {
  createAtomicSettlementItemWorker,
  SettlementItemApplicationService,
} from "./settlement-item-application-service.js";

function isTerminalCorrectionStop(kind: CorrectionSettlementOutcome["kind"]): boolean {
  return (
    kind === "settled" ||
    kind === "failed" ||
    kind === "already_running" ||
    kind === "already_settled"
  );
}

export interface LevelCorrectionReevalRunner {
  runForSettlement(
    settlementId: string,
    serverNow: Date,
  ): Promise<LevelCorrectionReevalOutcome>;
}

export async function runCorrectionReeval(
  runner: LevelCorrectionReevalRunner,
  settlementId: string,
  serverNow: Date,
): Promise<void> {
  await runner.runForSettlement(settlementId, serverNow);
}

export interface CorrectionReevalTarget {
  settlementId: string;
  serverNow: Date;
}

/** 在持有的 match 结算锁已释放后，按 settled_result_version+1 顺序消化 correcting 队列，完成后再执行等级重评。 */
export async function continuePendingCorrections(
  repo: Pick<AppRepository, "matches">,
  correction: CorrectionSettlementService,
  matchId: string,
  serverNow: Date,
  reeval?: LevelCorrectionReevalRunner,
  preSettledCorrections: readonly CorrectionReevalTarget[] = [],
): Promise<CorrectionSettlementOutcome | null> {
  let last: CorrectionSettlementOutcome | null = null;
  const pendingReevals: CorrectionReevalTarget[] = [...preSettledCorrections];

  for (;;) {
    const match = await repo.matches.findById(matchId);
    if (match === null) {
      break;
    }
    if (match.settlement_status !== SettlementStatus.Correcting) {
      break;
    }
    if (match.settled_result_version >= match.result_version) {
      break;
    }

    const stepNow =
      match.settled_at === null || match.settled_at.getTime() < serverNow.getTime()
        ? serverNow
        : new Date(match.settled_at.getTime() + 1);
    const outcome = await correction.correct(matchId, stepNow);
    last = outcome;
    if (
      outcome.kind === "settled" ||
      outcome.kind === "correcting" ||
      outcome.kind === "already_settled"
    ) {
      pendingReevals.push({ settlementId: outcome.settlement_id, serverNow: stepNow });
    }
    if (outcome.kind === "correcting") {
      continue;
    }
    if (isTerminalCorrectionStop(outcome.kind)) {
      break;
    }
    break;
  }

  if (reeval !== undefined) {
    for (const target of pendingReevals) {
      await runCorrectionReeval(reeval, target.settlementId, target.serverNow);
    }
  }
  return last;
}

export class SettlementOrchestrationService {
  private readonly first: FirstSettlementService;
  private readonly retryService: RetrySettlementService;
  private readonly correction: CorrectionSettlementService;
  private readonly levelCorrectionReeval: LevelCorrectionReevalRunner;

  constructor(
    private readonly repo: AppRepository,
    levelCorrectionReeval?: LevelCorrectionReevalRunner,
  ) {
    const worker = createAtomicSettlementItemWorker(
      new SettlementItemApplicationService(repo),
    );
    this.first = new FirstSettlementService(repo, worker);
    this.retryService = new RetrySettlementService(repo, worker);
    this.correction = new CorrectionSettlementService(repo, worker);
    this.levelCorrectionReeval = levelCorrectionReeval ?? new LevelCorrectionReevalService(repo);
  }

  async startFirst(
    matchId: string,
    serverNow: Date,
    hasBlockingAnomaly: boolean,
  ): Promise<FirstSettlementStartOutcome | CorrectionSettlementOutcome> {
    const first = await this.first.start(matchId, serverNow, hasBlockingAnomaly);
    if (first.kind === "started" || first.kind === "already_settled" ||
        (await this.repo.matches.findById(matchId))?.settlement_status === SettlementStatus.Correcting) {
      await continuePendingCorrections(
        this.repo,
        this.correction,
        matchId,
        serverNow,
        this.levelCorrectionReeval,
      );
    }
    return first;
  }

  async retry(
    settlementId: string,
    serverNow: Date,
  ): Promise<RetrySettlementOutcome> {
    const outcome = await this.retryService.retry(settlementId, serverNow);
    if (outcome.kind === "settled" || outcome.kind === "already_settled") {
      const settlement = await this.repo.settlements.findById(settlementId);
      if (settlement !== null) {
        const preSettled = settlement.is_correction
          ? [{ settlementId, serverNow }]
          : [];
        await continuePendingCorrections(
          this.repo,
          this.correction,
          settlement.match_id,
          serverNow,
          this.levelCorrectionReeval,
          preSettled,
        );
      }
    }
    return outcome;
  }

  async correct(
    matchId: string,
    serverNow: Date,
    targetResultVersion?: number,
  ): Promise<CorrectionSettlementOutcome> {
    const first = await this.correction.correct(matchId, serverNow, targetResultVersion);
    if (first.kind === "settled" || first.kind === "already_settled") {
      // §15.9：本目标 settlement 已 settled 时仍需按 match 状态续跑更高未处理版本，
      // 待队列完全收敛后再按序执行修正重评；返回语义保持本目标优先。
      await continuePendingCorrections(
        this.repo,
        this.correction,
        matchId,
        serverNow,
        this.levelCorrectionReeval,
        [{ settlementId: first.settlement_id, serverNow }],
      );
      return first;
    }
    if (first.kind !== "correcting") {
      return first;
    }

    const continued = await continuePendingCorrections(
      this.repo,
      this.correction,
      matchId,
      serverNow,
      this.levelCorrectionReeval,
      [{ settlementId: first.settlement_id, serverNow }],
    );
    return continued ?? first;
  }
}
