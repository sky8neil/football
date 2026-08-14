import { MatchStatus, Provider, SettlementStatus, SyncJobType } from "../domain/enums.js";
import { internalError } from "../domain/errors.js";
import type { Match } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import {
  createPostFinishVerifyLoader,
  type PostFinishVerifyFixtureClient,
} from "./provider-fixture-loader.js";
import {
  ProviderFixtureSyncJobService,
  type ProviderFixtureBatchItem,
  type ProviderFixtureBatchLoader,
  type ProviderFixtureSyncJobOutcome,
  type ProviderFixtureSyncRetryOptions,
} from "./provider-sync-job.js";
import { ProviderFixtureSyncService } from "./provider-fixture-sync.js";
import {
  ProviderTeamSyncService,
  type ProviderTeamClient,
  type ProviderTeamSyncOutcome,
} from "./provider-team-sync.js";
import { SYNC_TASKS_V1, type SyncTaskConfig } from "../sync/config.js";

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
  private readonly teamSync: ProviderTeamSyncService;
  private readonly fixtureJob: ProviderFixtureSyncJobService;
  private readonly postFinishLoader: ProviderFixtureBatchLoader;

  constructor(
    private readonly repo: AppRepository,
    client: ProviderPostFinishVerifyClient,
    retryOptions: ProviderFixtureSyncRetryOptions = {},
  ) {
    this.teamSync = new ProviderTeamSyncService(repo, client);
    this.postFinishLoader = createPostFinishVerifyLoader(client);
    this.fixtureJob = new ProviderFixtureSyncJobService(
      repo,
      new ProviderFixtureSyncService(repo),
      retryOptions,
    );
  }

  async run(serverNow: Date): Promise<ProviderPostFinishVerifyOutcome> {
    let teams: ProviderTeamSyncOutcome | null = null;
    const config = SYNC_TASKS_V1[SyncJobType.PostFinishVerify];
    const load: ProviderFixtureBatchLoader = async (loadNow) => {
      teams ??= await this.teamSync.sync(loadNow);
      const fixtures = await this.postFinishLoader(loadNow);
      if (!config.highFrequencyUntilFirstSettlement) {
        return fixtures;
      }
      const kept: ProviderFixtureBatchItem[] = [];
      for (const item of fixtures) {
        const mappings = this.repo.matchProviderMappings;
        if (mappings === undefined) {
          kept.push(item);
          continue;
        }
        const mapping = await mappings.findByProviderAndExternalId(
          Provider.ApiFootball,
          String(item.fixture.fixture.id),
        );
        if (mapping === null) {
          // 无本地 mapping：保持 fail-closed 交给下游（不静默丢弃）。
          kept.push(item);
          continue;
        }
        const match = await this.repo.matches.findById(mapping.match_id);
        if (match === null) {
          kept.push(item);
          continue;
        }
        if (includeInPostFinishHighFreq(match, config)) {
          kept.push(item);
        }
      }
      return kept;
    };
    const fixtures = await this.fixtureJob.run(
      SyncJobType.PostFinishVerify,
      load,
      serverNow,
    );
    if (fixtures.kind === "skipped") {
      return { kind: "skipped", fixtures };
    }
    if (teams === null) {
      throw internalError("post_finish_verify 已完成但未记录球队同步结果");
    }
    return { kind: "completed", teams, fixtures };
  }
}
