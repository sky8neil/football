/**
 * 同步异常决策（阶段 3，规范 33.1-33.6）。
 *
 * 每个 anomaly type 对应一个确定性决策函数：触发条件满足 -> open；
 * 触发条件消失 -> resolve（33.6），绝不“一段时间没报错就默认恢复”。
 */
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { MatchStatus } from "../domain/enums.js";

export interface AnomalyDecision {
  open: boolean;
  blocking: boolean;
  resolve?: {
    resolution: string;
    resolvedAt: Date;
  };
}

/** 33.1：live 连续 10 分钟无法成功同步 -> open（blocking=false）；恢复成功自动 resolve。 */
export function liveSyncStaleDecision(
  status: MatchStatus,
  lastSuccessfulSyncAt: Date | null,
  now: Date,
): AnomalyDecision {
  if (status !== MatchStatus.Live) {
    return {
      open: false,
      blocking: false,
      resolve: {
        resolution: "match is no longer live",
        resolvedAt: now,
      },
    };
  }
  const staleMs =
    FIXED_CONFIG_V1.LIVE_SYNC_FAILURE_ALERT_MINUTES * 60_000;
  const stale =
    lastSuccessfulSyncAt === null ||
    now.getTime() - lastSuccessfulSyncAt.getTime() >= staleMs;
  if (stale) {
    return { open: true, blocking: false };
  }
  return {
    open: false,
    blocking: false,
    resolve: {
      resolution: "last successful sync within threshold",
      resolvedAt: now,
    },
  };
}

/** 33.2：server_now >= period_anchor_at + 150min 且仍 live -> open；无 anchor 无法判定返回 null。 */
export function liveTooLongDecision(
  status: MatchStatus,
  periodAnchorAt: Date | null,
  now: Date,
): AnomalyDecision | null {
  if (periodAnchorAt === null) {
    return null;
  }
  const tooLongMs =
    FIXED_CONFIG_V1.LIVE_TOO_LONG_AFTER_KICKOFF_MINUTES * 60_000;
  const tooLong =
    now.getTime() >= periodAnchorAt.getTime() + tooLongMs;
  if (status === MatchStatus.Live && tooLong) {
    return { open: true, blocking: true };
  }
  return {
    open: false,
    blocking: true,
    resolve: {
      resolution: "live duration within limit or no longer live",
      resolvedAt: now,
    },
  };
}

/** 33.3：finished 后 20 分钟仍无合法 regular score -> open（blocking=true，不结算）。 */
export function finishedNoScoreDecision(
  status: MatchStatus,
  finishDetectedAt: Date | null,
  hasLegalScore: boolean,
  now: Date,
): AnomalyDecision {
  if (
    status !== MatchStatus.Finished ||
    finishDetectedAt === null ||
    hasLegalScore
  ) {
    return {
      open: false,
      blocking: true,
      resolve: {
        resolution: "finished with legal score or not applicable",
        resolvedAt: now,
      },
    };
  }
  const alertMs =
    FIXED_CONFIG_V1.FINISHED_NO_SCORE_ALERT_MINUTES * 60_000;
  if (now.getTime() - finishDetectedAt.getTime() >= alertMs) {
    return { open: true, blocking: true };
  }
  return {
    open: false,
    blocking: true,
    resolve: {
      resolution: "score alert window not yet elapsed",
      resolvedAt: now,
    },
  };
}
