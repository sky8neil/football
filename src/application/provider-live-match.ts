import { SyncJobType } from "../domain/enums.js";
import type { ProviderLeagueRefs } from "../domain/config.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import type { LiveMatchFixtureClient } from "./provider-fixture-loader.js";
import {
  ProviderFixtureSyncJobService,
  type ProviderFixtureBatchLoader,
  type ProviderFixtureSyncJobOutcome,
  type ProviderFixtureSyncLockOptions,
  type ProviderFixtureSyncRetryOptions,
} from "./provider-sync-job.js";
import { ProviderFixtureSyncService } from "./provider-fixture-sync.js";
import {
  type ProviderTeamClient,
  type ProviderTeamSyncOutcome,
} from "./provider-team-sync.js";
import { loadActiveWindowFixturesWithStats } from "./provider-window-loader.js";

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

/** 贯通 32.4 的 T-2h 到 finished 任务入口；Provider client 由调用方注入。 */
export class ProviderLiveMatchService {
  private readonly fixtureSync: ProviderFixtureSyncService;
  private readonly fixtureJob: ProviderFixtureSyncJobService;

  constructor(
    private readonly repo: AppRepository,
    private readonly client: ProviderLiveMatchClient,
    retryOptions: ProviderFixtureSyncRetryOptions = {},
    lockOptions: ProviderFixtureSyncLockOptions = {},
    private readonly providerLeagueRefs?: ProviderLeagueRefs,
  ) {
    this.fixtureSync = new ProviderFixtureSyncService(repo, undefined, providerLeagueRefs);
    this.fixtureJob = new ProviderFixtureSyncJobService(
      repo,
      this.fixtureSync,
      retryOptions,
      lockOptions,
    );
  }

  async run(serverNow: Date): Promise<ProviderLiveMatchOutcome> {
    const load: ProviderFixtureBatchLoader = (loadNow) =>
      loadActiveWindowFixturesWithStats(
        this.repo,
        this.client,
        SyncJobType.LiveMatch,
        loadNow,
        this.providerLeagueRefs,
      );
    const fixtures = await this.fixtureJob.run(
      SyncJobType.LiveMatch,
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
    // P0-1（33.1）：批次完成后巡检库内仍为 live 的 match，覆盖本批未触达的 stale。
    await this.fixtureSync.patrolLiveMatches(serverNow);
    return {
      kind: "completed",
      teams: { kind: "completed", teams_read: 0, teams_created: 0, teams_unchanged: 0 },
      fixtures,
    };
  }
}
