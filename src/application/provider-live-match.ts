import { SyncJobType } from "../domain/enums.js";
import { internalError } from "../domain/errors.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import {
  createLiveMatchLoader,
  type LiveMatchFixtureClient,
} from "./provider-fixture-loader.js";
import {
  ProviderFixtureSyncJobService,
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

export interface ProviderLiveMatchClient
  extends LiveMatchFixtureClient,
    ProviderTeamClient {}

export type ProviderLiveMatchOutcome =
  | {
      kind: "completed";
      teams: ProviderTeamSyncOutcome;
      fixtures: Extract<ProviderFixtureSyncJobOutcome, { kind: "completed" }>;
    }
  | {
      kind: "skipped";
      fixtures: Extract<ProviderFixtureSyncJobOutcome, { kind: "skipped" }>;
    };

/** 贯通 32.4 的 T-2h 到 finished 任务入口；Provider client 由调用方注入。 */
export class ProviderLiveMatchService {
  private readonly teamSync: ProviderTeamSyncService;
  private readonly fixtureJob: ProviderFixtureSyncJobService;
  private readonly liveMatchLoader: ProviderFixtureBatchLoader;

  constructor(
    private readonly repo: AppRepository,
    client: ProviderLiveMatchClient,
    retryOptions: ProviderFixtureSyncRetryOptions = {},
  ) {
    this.teamSync = new ProviderTeamSyncService(repo, client);
    this.liveMatchLoader = createLiveMatchLoader(client);
    this.fixtureJob = new ProviderFixtureSyncJobService(
      repo,
      new ProviderFixtureSyncService(repo),
      retryOptions,
    );
  }

  async run(serverNow: Date): Promise<ProviderLiveMatchOutcome> {
    let teams: ProviderTeamSyncOutcome | null = null;
    const load: ProviderFixtureBatchLoader = async (loadNow) => {
      teams ??= await this.teamSync.sync(loadNow);
      return this.liveMatchLoader(loadNow);
    };
    const fixtures = await this.fixtureJob.run(
      SyncJobType.LiveMatch,
      load,
      serverNow,
    );
    if (fixtures.kind === "skipped") {
      return { kind: "skipped", fixtures };
    }
    if (teams === null) {
      throw internalError("live_match 已完成但未记录球队同步结果");
    }
    return { kind: "completed", teams, fixtures };
  }
}
