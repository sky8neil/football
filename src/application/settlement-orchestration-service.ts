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

async function runCorrectionReeval(
  runner: LevelCorrectionReevalRunner,
  settlementId: string,
  serverNow: Date,
): Promise<void> {
  await runner.runForSettlement(settlementId, serverNow);
}

/** 在持有的 match 结算锁已释放后，按 settled_result_version+1 顺序消化 correcting 队列。 */
export async function continuePendingCorrections(
  repo: Pick<AppRepository, "matches">,
  correction: CorrectionSettlementService,
  matchId: string,
  serverNow: Date,
  reeval?: LevelCorrectionReevalRunner,
): Promise<CorrectionSettlementOutcome | null> {
  let last: CorrectionSettlementOutcome | null = null;

  for (;;) {
    const match = await repo.matches.findById(matchId);
    if (match === null) {
      return last;
    }
    if (match.settlement_status !== SettlementStatus.Correcting) {
      return last;
    }
    if (match.settled_result_version >= match.result_version) {
      return last;
    }

    const outcome = await correction.correct(matchId, serverNow);
    last = outcome;
    if (
      reeval !== undefined &&
      (outcome.kind === "settled" || outcome.kind === "correcting" || outcome.kind === "already_settled")
    ) {
      await runCorrectionReeval(reeval, outcome.settlement_id, serverNow);
    }
    if (outcome.kind === "correcting") {
      continue;
    }
    if (isTerminalCorrectionStop(outcome.kind)) {
      return last;
    }
    return last;
  }
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
    if (first.kind === "started") {
      const continued = await continuePendingCorrections(
        this.repo,
        this.correction,
        matchId,
        serverNow,
        this.levelCorrectionReeval,
      );
      if (continued?.kind === "failed" || continued?.kind === "already_running") {
        return continued;
      }
    }
    return first;
  }

  async retry(
    settlementId: string,
    serverNow: Date,
  ): Promise<RetrySettlementOutcome> {
    const outcome = await this.retryService.retry(settlementId, serverNow);
    if (outcome.kind === "settled") {
      const settlement = await this.repo.settlements.findById(settlementId);
      if (settlement !== null) {
        const continued = await continuePendingCorrections(
          this.repo,
          this.correction,
          settlement.match_id,
          serverNow,
          this.levelCorrectionReeval,
        );
        if (continued?.kind === "failed") {
          return {
            kind: "failed",
            settlement_id: continued.settlement_id,
            processed_count: continued.processed_count,
            skipped_applied_count: continued.skipped_applied_count,
          };
        }
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
      await runCorrectionReeval(this.levelCorrectionReeval, first.settlement_id, serverNow);
      // §15.9：本目标 settlement 已 settled 时仍需按 match 状态续跑更高未处理版本。
      // 返回语义保持本目标优先——下游 correction 结果不回写本次 outcome。
      await continuePendingCorrections(
        this.repo,
        this.correction,
        matchId,
        serverNow,
        this.levelCorrectionReeval,
      );
      return first;
    }
    if (first.kind !== "correcting") {
      return first;
    }
    await runCorrectionReeval(this.levelCorrectionReeval, first.settlement_id, serverNow);

    const continued = await continuePendingCorrections(
      this.repo,
      this.correction,
      matchId,
      serverNow,
      this.levelCorrectionReeval,
    );
    return continued ?? first;
  }
}
