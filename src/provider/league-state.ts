import type { ProviderBudgetJob } from "./budget.js";
import type { ProviderSourceId } from "./sources.js";

export interface ProviderLeagueState {
  source_id: ProviderSourceId;
  league_id: string;
  job_type: ProviderBudgetJob;
  last_success_at: Date;
}

export interface ProviderLeagueStateStore {
  get(sourceId: ProviderSourceId, leagueId: string, jobType: ProviderBudgetJob): Promise<ProviderLeagueState | null>;
  markSuccess(sourceId: ProviderSourceId, leagueId: string, jobType: ProviderBudgetJob, at: Date): Promise<void>;
}

export function providerLeagueStateId(sourceId: ProviderSourceId, leagueId: string, jobType: ProviderBudgetJob): string {
  return `provider_league_state_${sourceId}_${jobType}_${leagueId}`.replace(/[^a-zA-Z0-9_]/g, "_");
}

export class InMemoryProviderLeagueStateStore implements ProviderLeagueStateStore {
  private readonly states = new Map<string, ProviderLeagueState>();

  async get(sourceId: ProviderSourceId, leagueId: string, jobType: ProviderBudgetJob): Promise<ProviderLeagueState | null> {
    const state = this.states.get(providerLeagueStateId(sourceId, leagueId, jobType));
    return state ? { ...state, last_success_at: new Date(state.last_success_at) } : null;
  }

  async markSuccess(sourceId: ProviderSourceId, leagueId: string, jobType: ProviderBudgetJob, at: Date): Promise<void> {
    this.states.set(providerLeagueStateId(sourceId, leagueId, jobType), {
      source_id: sourceId,
      league_id: leagueId,
      job_type: jobType,
      last_success_at: new Date(at),
    });
  }
}
