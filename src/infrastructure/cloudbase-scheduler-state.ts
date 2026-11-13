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

export interface PeriodicJobCycleState {
  job_type: string;
  completed_cycle_at: Date;
  updated_at: Date;
}

export interface SchedulerStateStore {
  getSettlementFallback(): Promise<SettlementFallbackState | null>;
  upsertSettlementFallback(state: SettlementFallbackState): Promise<void>;
  getPeriodicJobCycle(jobType: string): Promise<PeriodicJobCycleState | null>;
  upsertPeriodicJobCycle(state: PeriodicJobCycleState): Promise<void>;
}

const PERIODIC_JOB_STATE_IDS = new Set<string>([
  SyncJobType.PeriodFinalize,
  SyncJobType.DailyConsistency,
  SyncJobType.WeeklyLevelEval,
  SyncJobType.BoardSnapshotCareer,
  SyncJobType.BoardSnapshotStrength,
  SyncJobType.BoardSnapshotSeason,
  SyncJobType.BoardSnapshotSeasonFinal,
]);

export function periodicJobStateId(jobType: string): string {
  if (!PERIODIC_JOB_STATE_IDS.has(jobType)) {
    throw new Error(`unsupported periodic scheduler_state job_type: ${jobType}`);
  }
  return jobType;
}

export class InMemorySchedulerStateStore implements SchedulerStateStore {
  private settlement: SettlementFallbackState | null = null;
  private readonly cycles = new Map<string, PeriodicJobCycleState>();

  async getSettlementFallback(): Promise<SettlementFallbackState | null> {
    return this.settlement === null ? null : { ...this.settlement };
  }

  async upsertSettlementFallback(state: SettlementFallbackState): Promise<void> {
    this.settlement = { ...state };
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
    const row = await this.db.get(this.collection, SETTLEMENT_FALLBACK_STATE_ID);
    if (row === null) return null;
    return deserializeSettlement(row);
  }

  async upsertSettlementFallback(state: SettlementFallbackState): Promise<void> {
    const document: CloudBaseDocument = {
      _id: SETTLEMENT_FALLBACK_STATE_ID,
      cursor_kickoff_at: state.cursor_kickoff_at,
      cursor_match_id: state.cursor_match_id,
      last_run_at: state.last_run_at,
      updated_at: state.updated_at,
    };
    await this.upsert(SETTLEMENT_FALLBACK_STATE_ID, document);
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
