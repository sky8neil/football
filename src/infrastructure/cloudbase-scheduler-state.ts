import type { CloudBaseDb, CloudBaseDocument } from "./cloudbase-db.js";
import { cloudBaseCollectionName } from "./cloudbase-db.js";
import { SETTLEMENT_FALLBACK_STATE_ID } from "../application/settlement-todo-batch.js";
import { SyncJobType } from "../domain/enums.js";

export interface SettlementFallbackState {
  cursor_kickoff_at: Date | null;
  cursor_match_id: string | null;
  last_run_at: Date | null;
  updated_at: Date;
}

export interface StaleRecoveryGroupProgress {
  group_key: string;
  completed_primary_dates: string[];
}

export interface StaleRecoveryCursorState extends SettlementFallbackState {
  group_progress?: StaleRecoveryGroupProgress | null;
}

export interface PeriodicJobCycleState {
  job_type: string;
  completed_cycle_at: Date;
  updated_at: Date;
}

export interface SchedulerStateStore {
  getSettlementFallback(): Promise<SettlementFallbackState | null>;
  upsertSettlementFallback(state: SettlementFallbackState): Promise<void>;
  getStaleRecoveryCursor(): Promise<StaleRecoveryCursorState | null>;
  upsertStaleRecoveryCursor(state: StaleRecoveryCursorState): Promise<void>;
  getPeriodicJobCycle(jobType: string): Promise<PeriodicJobCycleState | null>;
  upsertPeriodicJobCycle(state: PeriodicJobCycleState): Promise<void>;
}

export const POST_FINISH_DAILY_FALLBACK_STATE_ID = "post_finish_daily_fallback";
export const STALE_RECOVERY_CURSOR_STATE_ID = "stale_recovery_cursor";

const PERIODIC_JOB_STATE_IDS = new Set<string>([
  SyncJobType.PeriodFinalize,
  SyncJobType.DailyConsistency,
  SyncJobType.WeeklyLevelEval,
  SyncJobType.LevelCorrectionReeval,
  SyncJobType.BoardSnapshotCareer,
  SyncJobType.BoardSnapshotStrength,
  SyncJobType.BoardSnapshotSeason,
  SyncJobType.BoardSnapshotSeasonFinal,
  "maintenance_cleanup",
  "league_seasons",
  POST_FINISH_DAILY_FALLBACK_STATE_ID,
]);

export function periodicJobStateId(jobType: string): string {
  if (!PERIODIC_JOB_STATE_IDS.has(jobType)) {
    throw new Error(`unsupported periodic scheduler_state job_type: ${jobType}`);
  }
  return jobType;
}

export class InMemorySchedulerStateStore implements SchedulerStateStore {
  private settlement: SettlementFallbackState | null = null;
  private staleRecoveryCursor: StaleRecoveryCursorState | null = null;
  private readonly cycles = new Map<string, PeriodicJobCycleState>();

  async getSettlementFallback(): Promise<SettlementFallbackState | null> {
    return this.settlement === null ? null : { ...this.settlement };
  }

  async upsertSettlementFallback(state: SettlementFallbackState): Promise<void> {
    this.settlement = { ...state };
  }

  async getStaleRecoveryCursor(): Promise<StaleRecoveryCursorState | null> {
    if (this.staleRecoveryCursor === null) return null;
    const progress = normalizeGroupProgress(this.staleRecoveryCursor.group_progress);
    return {
      cursor_kickoff_at: this.staleRecoveryCursor.cursor_kickoff_at,
      cursor_match_id: this.staleRecoveryCursor.cursor_match_id,
      last_run_at: this.staleRecoveryCursor.last_run_at,
      updated_at: this.staleRecoveryCursor.updated_at,
      ...(progress === null ? {} : { group_progress: progress }),
    };
  }

  async upsertStaleRecoveryCursor(state: StaleRecoveryCursorState): Promise<void> {
    const progress = normalizeGroupProgress(state.group_progress);
    this.staleRecoveryCursor = {
      cursor_kickoff_at: state.cursor_kickoff_at,
      cursor_match_id: state.cursor_match_id,
      last_run_at: state.last_run_at,
      updated_at: state.updated_at,
      ...(progress === null ? {} : { group_progress: progress }),
    };
  }

  async getPeriodicJobCycle(jobType: string): Promise<PeriodicJobCycleState | null> {
    const row = this.cycles.get(periodicJobStateId(jobType));
    return row === undefined ? null : { ...row };
  }

  async upsertPeriodicJobCycle(state: PeriodicJobCycleState): Promise<void> {
    this.cycles.set(periodicJobStateId(state.job_type), { ...state });
  }
}

export class CloudBaseSchedulerStateStore implements SchedulerStateStore {
  private readonly collection: string;

  constructor(
    private readonly db: CloudBaseDb,
    namespace: string,
  ) {
    this.collection = cloudBaseCollectionName(namespace, "scheduler_state");
  }

  async getSettlementFallback(): Promise<SettlementFallbackState | null> {
    return this.readCursorState(SETTLEMENT_FALLBACK_STATE_ID);
  }

  async upsertSettlementFallback(state: SettlementFallbackState): Promise<void> {
    await this.writeCursorState(SETTLEMENT_FALLBACK_STATE_ID, state);
  }

  async getStaleRecoveryCursor(): Promise<StaleRecoveryCursorState | null> {
    const row = await this.db.get(this.collection, STALE_RECOVERY_CURSOR_STATE_ID);
    if (row === null) return null;
    const base = deserializeSettlement(row);
    const progress = normalizeGroupProgress(row.group_progress);
    return progress === null ? base : { ...base, group_progress: progress };
  }

  async upsertStaleRecoveryCursor(state: StaleRecoveryCursorState): Promise<void> {
    const progress = normalizeGroupProgress(state.group_progress);
    const document: CloudBaseDocument = {
      _id: STALE_RECOVERY_CURSOR_STATE_ID,
      cursor_kickoff_at: state.cursor_kickoff_at,
      cursor_match_id: state.cursor_match_id,
      group_progress: progress,
      last_run_at: state.last_run_at,
      updated_at: state.updated_at,
    };
    await this.upsert(STALE_RECOVERY_CURSOR_STATE_ID, document);
  }

  private async readCursorState(id: string): Promise<SettlementFallbackState | null> {
    const row = await this.db.get(this.collection, id);
    if (row === null) return null;
    return deserializeSettlement(row);
  }

  private async writeCursorState(id: string, state: SettlementFallbackState): Promise<void> {
    const document: CloudBaseDocument = {
      _id: id,
      cursor_kickoff_at: state.cursor_kickoff_at,
      cursor_match_id: state.cursor_match_id,
      last_run_at: state.last_run_at,
      updated_at: state.updated_at,
    };
    await this.upsert(id, document);
  }

  async getPeriodicJobCycle(jobType: string): Promise<PeriodicJobCycleState | null> {
    const id = periodicJobStateId(jobType);
    const row = await this.db.get(this.collection, id);
    if (row === null) return null;
    return deserializeCycle(row, jobType);
  }

  async upsertPeriodicJobCycle(state: PeriodicJobCycleState): Promise<void> {
    const id = periodicJobStateId(state.job_type);
    const document: CloudBaseDocument = {
      _id: id,
      job_type: state.job_type,
      completed_cycle_at: state.completed_cycle_at,
      updated_at: state.updated_at,
    };
    await this.upsert(id, document);
  }

  private async upsert(id: string, document: CloudBaseDocument): Promise<void> {
    if (await this.db.get(this.collection, id)) {
      await this.db.update(this.collection, id, document);
    } else {
      await this.db.add(this.collection, id, document);
    }
  }
}

function deserializeSettlement(row: CloudBaseDocument): SettlementFallbackState {
  return {
    cursor_kickoff_at: toDateOrNull(row.cursor_kickoff_at),
    cursor_match_id: typeof row.cursor_match_id === "string" ? row.cursor_match_id : null,
    last_run_at: toDateOrNull(row.last_run_at),
    updated_at: toDateOrNull(row.updated_at) ?? new Date(0),
  };
}

function deserializeCycle(row: CloudBaseDocument, jobType: string): PeriodicJobCycleState | null {
  const completed = toDateOrNull(row.completed_cycle_at);
  if (completed === null) return null;
  return {
    job_type: typeof row.job_type === "string" ? row.job_type : jobType,
    completed_cycle_at: completed,
    updated_at: toDateOrNull(row.updated_at) ?? completed,
  };
}

function normalizeGroupProgress(value: unknown): StaleRecoveryGroupProgress | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.group_key !== "string" || record.group_key.length === 0) {
    return null;
  }
  if (!Array.isArray(record.completed_primary_dates)) {
    return null;
  }
  const dates = record.completed_primary_dates.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  if (dates.length === 0) {
    return null;
  }
  return {
    group_key: record.group_key,
    completed_primary_dates: [...new Set(dates)].sort(),
  };
}

function toDateOrNull(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}
