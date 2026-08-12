import { SyncJobType } from "../domain/enums.js";
import { internalError } from "../domain/errors.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import {
  createPostFinishVerifyLoader,
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
  ProviderTeamSyncService,
  type ProviderTeamClient,
  type ProviderTeamSyncOutcome,
} from "./provider-team-sync.js";

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
    const load: ProviderFixtureBatchLoader = async (loadNow) => {
      teams ??= await this.teamSync.sync(loadNow);
      return this.postFinishLoader(loadNow);
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
