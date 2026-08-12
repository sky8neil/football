/**
 * 结算组合入口：默认把 settlement item 接到原子聚合应用服务。
 * 具体状态机和版本队列仍由 First/Retry/Correction 服务负责。
 * 第 15.9 节：某 version finalize 后若仍有更高 result_version，按最小未处理版本
 * 继续启动 correction settlement，不得在中间版本停住。
 */
import { SettlementStatus } from "../domain/enums.js";
import type { AppRepository } from "../infrastructure/repositories.js";
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

/** 在持有的 match 结算锁已释放后，按 settled_result_version+1 顺序消化 correcting 队列。 */
export async function continuePendingCorrections(
  repo: Pick<AppRepository, "matches">,
  correction: CorrectionSettlementService,
  matchId: string,
  serverNow: Date,
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

  constructor(private readonly repo: AppRepository) {
    const worker = createAtomicSettlementItemWorker(
      new SettlementItemApplicationService(repo),
    );
    this.first = new FirstSettlementService(repo, worker);
    this.retryService = new RetrySettlementService(repo, worker);
    this.correction = new CorrectionSettlementService(repo, worker);
  }

  async startFirst(
    matchId: string,
    serverNow: Date,
    hasBlockingAnomaly: boolean,
  ): Promise<FirstSettlementStartOutcome> {
    const first = await this.first.start(matchId, serverNow, hasBlockingAnomaly);
    if (first.kind === "started") {
      await continuePendingCorrections(this.repo, this.correction, matchId, serverNow);
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
    if (first.kind !== "correcting" && first.kind !== "settled") {
      return first;
    }
    if (first.kind === "settled") {
      return first;
    }

    const continued = await continuePendingCorrections(
      this.repo,
      this.correction,
      matchId,
      serverNow,
    );
    return continued ?? first;
  }
}
