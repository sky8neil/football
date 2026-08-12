import { SyncJobType } from "../domain/enums.js";
import { internalError } from "../domain/errors.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import type { FullScheduleFixtureClient } from "./provider-fixture-loader.js";
import { createFullScheduleVerifyLoader } from "./provider-fixture-loader.js";
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

export interface ProviderFullScheduleVerifyClient
  extends FullScheduleFixtureClient,
    ProviderTeamClient {}

export type ProviderFullScheduleVerifyOutcome =
  | {
      kind: "completed";
      teams: ProviderTeamSyncOutcome;
      fixtures: Extract<ProviderFixtureSyncJobOutcome, { kind: "completed" }>;
    }
  | {
      kind: "skipped";
      fixtures: Extract<ProviderFixtureSyncJobOutcome, { kind: "skipped" }>;
    };

/** 贯通 32.2 的完整赛季校验入口；Provider client 由调用方注入。 */
export class ProviderFullScheduleVerifyService {
  private readonly teamSync: ProviderTeamSyncService;
  private readonly fixtureJob: ProviderFixtureSyncJobService;
  private readonly fullScheduleLoader: ProviderFixtureBatchLoader;

  constructor(
    private readonly repo: AppRepository,
    client: ProviderFullScheduleVerifyClient,
    retryOptions: ProviderFixtureSyncRetryOptions = {},
  ) {
    this.teamSync = new ProviderTeamSyncService(repo, client);
    this.fullScheduleLoader = createFullScheduleVerifyLoader(client);
    this.fixtureJob = new ProviderFixtureSyncJobService(
      repo,
      new ProviderFixtureSyncService(repo),
      retryOptions,
    );
  }

  async run(serverNow: Date): Promise<ProviderFullScheduleVerifyOutcome> {
    let teams: ProviderTeamSyncOutcome | null = null;
    const load: ProviderFixtureBatchLoader = async (loadNow) => {
      teams ??= await this.teamSync.sync(loadNow);
      return this.fullScheduleLoader(loadNow);
    };
    const fixtures = await this.fixtureJob.run(
      SyncJobType.FullScheduleVerify,
      load,
      serverNow,
    );
    if (fixtures.kind === "skipped") {
      return { kind: "skipped", fixtures };
    }
    if (teams === null) {
      throw internalError("full_schedule_verify 已完成但未记录球队同步结果");
    }
    return { kind: "completed", teams, fixtures };
  }
}
