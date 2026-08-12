import { internalError } from "../domain/errors.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import type { FirstSettlementStartOutcome } from "./first-settlement-service.js";
import { assertValidServerNow } from "./period-finalize.js";
import { SettlementOrchestrationService } from "./settlement-orchestration-service.js";

/** post_finish_verify 的首次结算入口：阻塞异常由仓储事实决定。 */
export class PostFinishSettlementService {
  private readonly orchestration: SettlementOrchestrationService;

  constructor(private readonly repo: AppRepository) {
    this.orchestration = new SettlementOrchestrationService(repo);
  }

  async start(matchId: string, serverNow: Date): Promise<FirstSettlementStartOutcome> {
    assertValidServerNow(serverNow);
    if (this.repo.anomalies === undefined) {
      throw internalError("anomalies repository port 未配置");
    }

    const blockingAnomalies = await this.repo.anomalies.findOpenBlockingByMatch(matchId);
    return this.orchestration.startFirst(
      matchId,
      serverNow,
      blockingAnomalies.length > 0,
    );
  }
}
