/**
 * 全局领域枚举。
 *
 * 规范第 2.5 节：所有核心业务文档固定 schema_version = 1。
 * 规范第 2.2 节：内部 ID 使用 UUID v4；league_id/season_id/round_id 为稳定业务字符串。
 */

export const SCHEMA_VERSION = 1 as const;

export const MatchStatus = {
  Scheduled: "scheduled",
  Live: "live",
  Finished: "finished",
  Postponed: "postponed",
  Cancelled: "cancelled",
  Abandoned: "abandoned",
} as const;
export type MatchStatus = (typeof MatchStatus)[keyof typeof MatchStatus];

export const SettlementStatus = {
  Pending: "pending",
  Waiting: "waiting",
  Settling: "settling",
  Settled: "settled",
  Correcting: "correcting",
  Failed: "failed",
  Voided: "voided",
} as const;
export type SettlementStatus = (typeof SettlementStatus)[keyof typeof SettlementStatus];

export const Result = {
  Home: "HOME",
  Draw: "DRAW",
  Away: "AWAY",
} as const;
export type Result = (typeof Result)[keyof typeof Result];

export const Provider = {
  ApiFootball: "api_football",
} as const;
export type Provider = (typeof Provider)[keyof typeof Provider];

export const ResultSource = {
  Provider: "provider",
  Admin: "admin",
} as const;
export type ResultSource = (typeof ResultSource)[keyof typeof ResultSource];

export const PeriodType = {
  Week: "week",
  Month: "month",
} as const;
export type PeriodType = (typeof PeriodType)[keyof typeof PeriodType];

export const LevelScope = {
  Season: "season",
  Career: "career",
} as const;
export type LevelScope = (typeof LevelScope)[keyof typeof LevelScope];

export const UserStatus = {
  Active: "active",
  Deleted: "deleted",
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const TeamStatus = {
  Active: "active",
  Inactive: "inactive",
} as const;
export type TeamStatus = (typeof TeamStatus)[keyof typeof TeamStatus];

export const ScoringRuleVersion = {
  ScoringV1: "scoring_v1",
} as const;
export type ScoringRuleVersion =
  (typeof ScoringRuleVersion)[keyof typeof ScoringRuleVersion];

export const SettlementDocStatus = {
  Pending: "pending",
  Running: "running",
  Settled: "settled",
  Failed: "failed",
} as const;
export type SettlementDocStatus =
  (typeof SettlementDocStatus)[keyof typeof SettlementDocStatus];

export const SettlementPhase = {
  Prepare: "prepare",
  ApplyItems: "apply_items",
  RebuildRanks: "rebuild_ranks",
  Finalize: "finalize",
  Done: "done",
} as const;
export type SettlementPhase =
  (typeof SettlementPhase)[keyof typeof SettlementPhase];

export const SettlementItemStatus = {
  Pending: "pending",
  Applied: "applied",
  Failed: "failed",
} as const;
export type SettlementItemStatus =
  (typeof SettlementItemStatus)[keyof typeof SettlementItemStatus];

export const LevelHistoryReason = {
  Settlement: "settlement",
  Correction: "correction",
  Rebuild: "rebuild",
  SeasonStart: "season_start",
} as const;
export type LevelHistoryReason =
  (typeof LevelHistoryReason)[keyof typeof LevelHistoryReason];

export const SyncJobType = {
  FutureSchedule: "future_schedule",
  FullScheduleVerify: "full_schedule_verify",
  NearMatch: "near_match",
  LiveMatch: "live_match",
  PostFinishVerify: "post_finish_verify",
  PeriodFinalize: "period_finalize",
  DailyConsistency: "daily_consistency",
} as const;
export type SyncJobType = (typeof SyncJobType)[keyof typeof SyncJobType];

export const SyncJobStatus = {
  Running: "running",
  Success: "success",
  Failed: "failed",
} as const;
export type SyncJobStatus = (typeof SyncJobStatus)[keyof typeof SyncJobStatus];

export const AnomalyType = {
  LiveSyncStale: "LIVE_SYNC_STALE",
  LiveTooLong: "LIVE_TOO_LONG",
  FinishedNoScore: "FINISHED_NO_SCORE",
  InvalidFinalScore: "INVALID_FINAL_SCORE",
  ProviderStateConflict: "PROVIDER_STATE_CONFLICT",
  ProviderDataInvalid: "PROVIDER_DATA_INVALID",
  UnexpectedProviderStatus: "UNEXPECTED_PROVIDER_STATUS",
  TeamChangeAfterPrediction: "TEAM_CHANGE_AFTER_PREDICTION",
  KickoffChangeAfterAnchor: "KICKOFF_CHANGE_AFTER_ANCHOR",
  AdminProviderResultConflict: "ADMIN_PROVIDER_RESULT_CONFLICT",
} as const;
export type AnomalyType = (typeof AnomalyType)[keyof typeof AnomalyType];

export const AnomalyStatus = {
  Open: "open",
  Resolved: "resolved",
} as const;
export type AnomalyStatus = (typeof AnomalyStatus)[keyof typeof AnomalyStatus];

export const AdminStatus = {
  Active: "active",
  Disabled: "disabled",
} as const;
export type AdminStatus = (typeof AdminStatus)[keyof typeof AdminStatus];

export const AdminRole = {
  Admin: "admin",
} as const;
export type AdminRole = (typeof AdminRole)[keyof typeof AdminRole];

export const AdminAuditAction = {
  ResultCorrection: "result_correction",
  RetrySettlement: "retry_settlement",
  RebuildUserStats: "rebuild_user_stats",
  RebuildRankings: "rebuild_rankings",
} as const;
export type AdminAuditAction =
  (typeof AdminAuditAction)[keyof typeof AdminAuditAction];

export const AdminAuditEntityType = {
  Match: "match",
  Settlement: "settlement",
  User: "user",
  RankingPeriod: "ranking_period",
} as const;
export type AdminAuditEntityType =
  (typeof AdminAuditEntityType)[keyof typeof AdminAuditEntityType];

export const ADMIN_AUDIT_ENTITY_TYPE_BY_ACTION: Readonly<
  Record<AdminAuditAction, AdminAuditEntityType>
> = {
  [AdminAuditAction.ResultCorrection]: AdminAuditEntityType.Match,
  [AdminAuditAction.RetrySettlement]: AdminAuditEntityType.Settlement,
  [AdminAuditAction.RebuildUserStats]: AdminAuditEntityType.User,
  [AdminAuditAction.RebuildRankings]: AdminAuditEntityType.RankingPeriod,
};

/** 单场计分结果枚举：0 / 3 / 12（规范 9.2）。 */
export const MatchScoreValue = {
  Miss: 0,
  WdlHit: 3,
  ExactHit: 12,
} as const;
export type MatchScoreValue = (typeof MatchScoreValue)[keyof typeof MatchScoreValue];

export const UnlockConfigVersion = {
  UnlockV1: "unlock_v1",
} as const;
export type UnlockConfigVersion =
  (typeof UnlockConfigVersion)[keyof typeof UnlockConfigVersion];
