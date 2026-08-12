import { SyncJobType } from "../domain/enums.js";
import { internalError } from "../domain/errors.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import type { FutureScheduleFixtureClient } from "./provider-fixture-loader.js";
import {
  ProviderFixtureSyncJobService,
  type ProviderFixtureBatchLoader,
  type ProviderFixtureSyncJobOutcome,
  type ProviderFixtureSyncRetryOptions,
} from "./provider-sync-job.js";
import {
  ProviderFixtureSyncService,
} from "./provider-fixture-sync.js";
import {
  ProviderTeamSyncService,
  type ProviderTeamClient,
  type ProviderTeamSyncOutcome,
} from "./provider-team-sync.js";
import { createFutureScheduleLoader } from "./provider-fixture-loader.js";

export interface ProviderScheduleSyncClient
  extends FutureScheduleFixtureClient,
    ProviderTeamClient {}

export type ProviderFutureScheduleOutcome =
  | {
      kind: "completed";
      teams: ProviderTeamSyncOutcome;
      fixtures: Extract<ProviderFixtureSyncJobOutcome, { kind: "completed" }>;
    }
  | {
      kind: "skipped";
      fixtures: Extract<ProviderFixtureSyncJobOutcome, { kind: "skipped" }>;
    };

/**
 * 贯通 32.1 的应用入口：先确保 Provider 球队 mapping，再执行 fixture 批次同步。
 * Provider client 由调用方注入，本服务不读取凭证或主动连接网络。
 */
export class ProviderFutureScheduleService {
  private readonly teamSync: ProviderTeamSyncService;
  private readonly fixtureJob: ProviderFixtureSyncJobService;

  constructor(
    private readonly repo: AppRepository,
    client: ProviderScheduleSyncClient,
    retryOptions: ProviderFixtureSyncRetryOptions = {},
  ) {
    this.teamSync = new ProviderTeamSyncService(repo, client);
    this.futureScheduleLoader = createFutureScheduleLoader(client);
    this.fixtureJob = new ProviderFixtureSyncJobService(
      repo,
      new ProviderFixtureSyncService(repo),
      retryOptions,
    );
  }

  private readonly futureScheduleLoader: ProviderFixtureBatchLoader;

  async run(serverNow: Date): Promise<ProviderFutureScheduleOutcome> {
    let teams: ProviderTeamSyncOutcome | null = null;
    const load: ProviderFixtureBatchLoader = async (loadNow) => {
      teams ??= await this.teamSync.sync(loadNow);
      return this.futureScheduleLoader(loadNow);
    };
    const fixtures = await this.fixtureJob.run(
      SyncJobType.FutureSchedule,
      load,
      serverNow,
    );
    if (fixtures.kind === "skipped") {
      return { kind: "skipped", fixtures };
    }
    if (teams === null) {
      throw internalError("future_schedule 已完成但未记录球队同步结果");
    }
    return { kind: "completed", teams, fixtures };
  }
}
