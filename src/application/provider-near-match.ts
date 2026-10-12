import { SyncJobType } from "../domain/enums.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import type { NearMatchFixtureClient } from "./provider-fixture-loader.js";
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
import { loadActiveWindowFixtures } from "./provider-window-loader.js";

export interface ProviderNearMatchClient
  extends NearMatchFixtureClient,
    ProviderTeamClient {}

export type ProviderNearMatchOutcome =
  | {
      kind: "completed";
      teams: ProviderTeamSyncOutcome;
      fixtures: Extract<ProviderFixtureSyncJobOutcome, { kind: "completed" }>;
    }
  | {
      kind: "skipped";
      fixtures: Extract<ProviderFixtureSyncJobOutcome, { kind: "skipped" }>;
    };

/** 贯通 32.3 的 T-24h 到 T-2h 任务入口；Provider client 由调用方注入。 */
export class ProviderNearMatchService {
  private readonly fixtureJob: ProviderFixtureSyncJobService;

  constructor(
    private readonly repo: AppRepository,
    private readonly client: ProviderNearMatchClient,
    retryOptions: ProviderFixtureSyncRetryOptions = {},
  ) {
    this.fixtureJob = new ProviderFixtureSyncJobService(
      repo,
      new ProviderFixtureSyncService(repo),
      retryOptions,
    );
  }

  async run(serverNow: Date): Promise<ProviderNearMatchOutcome> {
    const load: ProviderFixtureBatchLoader = async (loadNow) => {
      return loadActiveWindowFixtures(this.repo, this.client, SyncJobType.NearMatch, loadNow);
    };
    const fixtures = await this.fixtureJob.run(
      SyncJobType.NearMatch,
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
