import { MatchStatus, SettlementStatus, SyncJobType } from "../domain/enums.js";
import { internalError } from "../domain/errors.js";
import type { Match } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import {
  type PostFinishVerifyFixtureClient,
} from "./provider-fixture-loader.js";
import {
  ProviderFixtureSyncJobService,
  type ProviderFixtureBatchLoader,
  type ProviderFixtureSyncJobOutcome,
  type ProviderFixtureSyncRetryOptions,
} from "./provider-sync-job.js";
import { ProviderFixtureSyncService } from "./provider-fixture-sync.js";
import {
  type ProviderTeamClient,
  type ProviderTeamSyncOutcome,
} from "./provider-team-sync.js";
import { SYNC_TASKS_V1, type SyncTaskConfig } from "../sync/config.js";
import { loadActiveWindowFixtures } from "./provider-window-loader.js";

/**
 * P1-1 / P2-1（32.5）：post_finish 高频确认只持续到首次 settlement 开始。
 * highFrequencyUntilFirstSettlement=true 时仅保留"已 finished（或已发现 finish）
 * 且 settlement_status ∈ {pending, waiting}"的场次；settling/settled/correcting/
 * failed/voided 交给 daily full verify / admin retry。false 时走宽扫描。
 */
export function includeInPostFinishHighFreq(
  match: Match,
  cfg: SyncTaskConfig,
): boolean {
  if (!cfg.highFrequencyUntilFirstSettlement) {
    return true;
  }
  if (match.finish_detected_at === null && match.match_status !== MatchStatus.Finished) {
    return false;
  }
  return (
    match.settlement_status === SettlementStatus.Pending ||
    match.settlement_status === SettlementStatus.Waiting
  );
}

export interface ProviderPostFinishVerifyClient
  extends PostFinishVerifyFixtureClient,
    ProviderTeamClient {}

export type ProviderPostFinishVerifyOutcome =
  | {
      kind: "completed";
      teams: ProviderTeamSyncOutcome;
      fixtures: Extract<ProviderFixtureSyncJobOutcome, { kind: "completed" }>;
    }
  | {
      kind: "skipped";
      fixtures: Extract<ProviderFixtureSyncJobOutcome, { kind: "skipped" }>;
    };

/** 贯通 32.5 的 finished 后确认任务入口；Provider client 由调用方注入。 */
export class ProviderPostFinishVerifyService {
  private readonly fixtureJob: ProviderFixtureSyncJobService;

  constructor(
    private readonly repo: AppRepository,
    private readonly client: ProviderPostFinishVerifyClient,
    retryOptions: ProviderFixtureSyncRetryOptions = {},
  ) {
    this.fixtureJob = new ProviderFixtureSyncJobService(
      repo,
      new ProviderFixtureSyncService(repo),
      retryOptions,
    );
  }

  async run(serverNow: Date): Promise<ProviderPostFinishVerifyOutcome> {
    const load: ProviderFixtureBatchLoader = async (loadNow) => {
      return loadActiveWindowFixtures(this.repo, this.client, SyncJobType.PostFinishVerify, loadNow);
    };
    const fixtures = await this.fixtureJob.run(
      SyncJobType.PostFinishVerify,
      load,
      serverNow,
    );
    if (fixtures.kind === "skipped") {
      return { kind: "skipped", fixtures };
    }
    return {
      kind: "completed",
      teams: { kind: "completed", teams_read: 0, teams_created: 0, teams_unchanged: 0 },
      fixtures,
    };
  }
}
