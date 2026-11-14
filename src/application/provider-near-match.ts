import { SyncJobType } from "../domain/enums.js";
import type { ProviderLeagueRefs } from "../domain/config.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import type { NearMatchFixtureClient } from "./provider-fixture-loader.js";
import {
  ProviderFixtureSyncJobService,
  type ProviderFixtureBatchLoader,
  type ProviderFixtureSyncJobOutcome,
  type ProviderFixtureSyncLockOptions,
  type ProviderFixtureSyncRetryOptions,
} from "./provider-sync-job.js";
import {
  ProviderFixtureSyncService,
  type ProviderFixtureSyncOptions,
} from "./provider-fixture-sync.js";
import {
  type ProviderTeamClient,
  type ProviderTeamSyncOutcome,
} from "./provider-team-sync.js";
import { loadActiveWindowFixturesWithStats } from "./provider-window-loader.js";

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
    }
  | {
      /** RP07：本轮因可重试错误延后，下一次调度到期再跑。 */
      kind: "deferred";
      fixtures: Extract<ProviderFixtureSyncJobOutcome, { kind: "deferred" }>;
    }
  | {
      /** 重试耗尽或批次终态失败；调用结果与持久化 failed 日志一致。 */
      kind: "failed";
      fixtures: Extract<ProviderFixtureSyncJobOutcome, { kind: "failed" }>;
    };

/** 贯通 32.3 的 T-24h 到 T-2h 任务入口；Provider client 由调用方注入。 */
export class ProviderNearMatchService {
  private readonly fixtureJob: ProviderFixtureSyncJobService;

  constructor(
    private readonly repo: AppRepository,
    private readonly client: ProviderNearMatchClient,
    retryOptions: ProviderFixtureSyncRetryOptions = {},
    lockOptions: ProviderFixtureSyncLockOptions = {},
    private readonly providerLeagueRefs?: ProviderLeagueRefs,
    fixtureSyncOptions?: ProviderFixtureSyncOptions,
  ) {
    this.fixtureJob = new ProviderFixtureSyncJobService(
      repo,
      new ProviderFixtureSyncService(repo, undefined, providerLeagueRefs, fixtureSyncOptions),
      retryOptions,
      lockOptions,
    );
  }

  async run(serverNow: Date): Promise<ProviderNearMatchOutcome> {
    const load: ProviderFixtureBatchLoader = async (loadNow) => {
      return loadActiveWindowFixturesWithStats(
        this.repo,
        this.client,
        SyncJobType.NearMatch,
        loadNow,
        this.providerLeagueRefs,
      );
    };
    const fixtures = await this.fixtureJob.run(
      SyncJobType.NearMatch,
      load,
      serverNow,
    );
    if (fixtures.kind === "skipped") {
      return { kind: "skipped", fixtures };
    }
    if (fixtures.kind === "deferred") {
      return { kind: "deferred", fixtures };
    }
    if (fixtures.kind === "failed") {
      return { kind: "failed", fixtures };
    }
    return {
      kind: "completed",
      teams: { kind: "completed", teams_read: 0, teams_created: 0, teams_unchanged: 0 },
      fixtures,
    };
  }
}
