import type { CloudBaseDb, CloudBaseDocument } from "./cloudbase-db.js";
import { cloudBaseCollectionName } from "./cloudbase-db.js";
import { SETTLEMENT_FALLBACK_STATE_ID } from "../application/settlement-todo-batch.js";

export interface SettlementFallbackState {
  cursor_kickoff_at: Date | null;
  cursor_match_id: string | null;
  last_run_at: Date | null;
  updated_at: Date;
}

export interface SchedulerStateStore {
  getSettlementFallback(): Promise<SettlementFallbackState | null>;
  upsertSettlementFallback(state: SettlementFallbackState): Promise<void>;
}

export class InMemorySchedulerStateStore implements SchedulerStateStore {
  private state: SettlementFallbackState | null = null;

  async getSettlementFallback(): Promise<SettlementFallbackState | null> {
    return this.state === null ? null : { ...this.state };
  }

  async upsertSettlementFallback(state: SettlementFallbackState): Promise<void> {
    this.state = { ...state };
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
    return deserialize(row);
  }

  async upsertSettlementFallback(state: SettlementFallbackState): Promise<void> {
    const document: CloudBaseDocument = {
      _id: SETTLEMENT_FALLBACK_STATE_ID,
      cursor_kickoff_at: state.cursor_kickoff_at,
      cursor_match_id: state.cursor_match_id,
      last_run_at: state.last_run_at,
      updated_at: state.updated_at,
    };
    if (await this.db.get(this.collection, SETTLEMENT_FALLBACK_STATE_ID)) {
      await this.db.update(this.collection, SETTLEMENT_FALLBACK_STATE_ID, document);
    } else {
      await this.db.add(this.collection, SETTLEMENT_FALLBACK_STATE_ID, document);
    }
  }
}

function deserialize(row: CloudBaseDocument): SettlementFallbackState {
  return {
    cursor_kickoff_at: toDateOrNull(row.cursor_kickoff_at),
    cursor_match_id: typeof row.cursor_match_id === "string" ? row.cursor_match_id : null,
    last_run_at: toDateOrNull(row.last_run_at),
    updated_at: toDateOrNull(row.updated_at) ?? new Date(0),
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
