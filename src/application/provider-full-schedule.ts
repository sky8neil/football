import { SyncJobType } from "../domain/enums.js";
import { internalError } from "../domain/errors.js";
import { type ProviderLeagueRefs } from "../domain/config.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import type { FullScheduleFixtureClient } from "./provider-fixture-loader.js";
import { createFullScheduleVerifyLoader, resolveRolloverTargetSeasons } from "./provider-fixture-loader.js";
import {
  ProviderFixtureSyncJobService,
  type ProviderFixtureBatchLoader,
  type ProviderFixtureSyncJobOutcome,
  type ProviderFixtureSyncLockOptions,
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
    }
  | {
      /** RP07：本轮因可重试错误延后，下一次调度到期再跑。 */
      kind: "deferred";
      fixtures: Extract<ProviderFixtureSyncJobOutcome, { kind: "deferred" }>;
    };

/** 贯通 32.2 的完整赛季校验入口；Provider client 由调用方注入。 */
export class ProviderFullScheduleVerifyService {
  private readonly teamSync: ProviderTeamSyncService;
  private readonly fixtureJob: ProviderFixtureSyncJobService;
  private readonly client: ProviderFullScheduleVerifyClient;

  constructor(
    private readonly repo: AppRepository,
    client: ProviderFullScheduleVerifyClient,
    retryOptions: ProviderFixtureSyncRetryOptions = {},
    lockOptions: ProviderFixtureSyncLockOptions = {},
    providerLeagueRefs?: ProviderLeagueRefs,
  ) {
    this.client = client;
    this.teamSync = new ProviderTeamSyncService(repo, client);
    this.fixtureJob = new ProviderFixtureSyncJobService(
      repo,
      new ProviderFixtureSyncService(repo, undefined, providerLeagueRefs),
      retryOptions,
      lockOptions,
    );
  }

  async run(serverNow: Date, leagueId?: string): Promise<ProviderFullScheduleVerifyOutcome> {
    const leagueIds = leagueId === undefined ? undefined : [leagueId];
    let teams: ProviderTeamSyncOutcome | null = null;
    const load: ProviderFixtureBatchLoader = async function* (this: ProviderFullScheduleVerifyService, loadNow: Date) {
      const targetSeasons = await resolveRolloverTargetSeasons(this.repo, loadNow, leagueIds);
      const fullScheduleLoader = createFullScheduleVerifyLoader(this.client, leagueIds, targetSeasons);
      teams ??= await this.teamSync.sync(loadNow, SyncJobType.FullScheduleVerify, leagueIds, targetSeasons);
      yield await fullScheduleLoader(loadNow);
    }.bind(this);
    const fixtures = await this.fixtureJob.run(
      SyncJobType.FullScheduleVerify,
      load,
      serverNow,
      leagueId,
    );
    if (fixtures.kind === "skipped") {
      return { kind: "skipped", fixtures };
    }
    if (fixtures.kind === "deferred") {
      return { kind: "deferred", fixtures };
    }
    if (teams === null) {
      throw internalError("full_schedule_verify 已完成但未记录球队同步结果");
    }
    return { kind: "completed", teams, fixtures };
  }
}
