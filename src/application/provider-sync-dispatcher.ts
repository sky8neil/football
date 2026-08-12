import { SyncJobType } from "../domain/enums.js";
import { validationError } from "../domain/errors.js";
import type { ProviderFullScheduleVerifyOutcome } from "./provider-full-schedule.js";
import type { ProviderFutureScheduleOutcome } from "./provider-sync-service.js";
import type { ProviderLiveMatchOutcome } from "./provider-live-match.js";
import type { ProviderNearMatchOutcome } from "./provider-near-match.js";
import type { ProviderPostFinishVerifyOutcome } from "./provider-post-finish.js";

export type ProviderSyncJobType =
  | typeof SyncJobType.FutureSchedule
  | typeof SyncJobType.FullScheduleVerify
  | typeof SyncJobType.NearMatch
  | typeof SyncJobType.LiveMatch
  | typeof SyncJobType.PostFinishVerify;

export type ProviderSyncOutcome =
  | ProviderFutureScheduleOutcome
  | ProviderFullScheduleVerifyOutcome
  | ProviderNearMatchOutcome
  | ProviderLiveMatchOutcome
  | ProviderPostFinishVerifyOutcome;

export type ProviderSyncRunner = (serverNow: Date) => Promise<ProviderSyncOutcome>;

export type ProviderSyncRunnerMap = {
  [jobType in ProviderSyncJobType]: ProviderSyncRunner;
};

function isProviderSyncJobType(value: unknown): value is ProviderSyncJobType {
  return (
    value === SyncJobType.FutureSchedule ||
    value === SyncJobType.FullScheduleVerify ||
    value === SyncJobType.NearMatch ||
    value === SyncJobType.LiveMatch ||
    value === SyncJobType.PostFinishVerify
  );
}

function assertServerNow(serverNow: Date): void {
  if (!(serverNow instanceof Date) || Number.isNaN(serverNow.getTime())) {
    throw validationError("server_now 必须是有效时间", { field: "server_now" });
  }
}

/** 按规范固定的 Provider job_type 分发到已组装的端到端任务 runner。 */
export class ProviderSyncDispatcher {
  constructor(private readonly runners: ProviderSyncRunnerMap) {}

  async run(
    jobType: ProviderSyncJobType,
    serverNow: Date,
  ): Promise<ProviderSyncOutcome> {
    if (!isProviderSyncJobType(jobType)) {
      throw validationError("未知 Provider job_type", { field: "job_type" });
    }
    assertServerNow(serverNow);
    return this.runners[jobType](serverNow);
  }
}
