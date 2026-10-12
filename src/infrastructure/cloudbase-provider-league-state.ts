import { SCHEMA_VERSION } from "../domain/enums.js";
import type { ProviderBudgetJob } from "../provider/budget.js";
import type { ProviderLeagueState, ProviderLeagueStateStore } from "../provider/league-state.js";
import { providerLeagueStateId } from "../provider/league-state.js";
import type { ProviderSourceId } from "../provider/sources.js";
import type { CloudBaseDb, CloudBaseDocument } from "./cloudbase-db.js";
import { cloudBaseCollectionName } from "./cloudbase-db.js";

function asDate(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return null;
}

export class CloudBaseProviderLeagueStateStore implements ProviderLeagueStateStore {
  private readonly collection: string;

  constructor(private readonly db: CloudBaseDb, namespace: string) {
    this.collection = cloudBaseCollectionName(namespace, "provider_league_state");
  }

  async get(sourceId: ProviderSourceId, leagueId: string, jobType: ProviderBudgetJob): Promise<ProviderLeagueState | null> {
    const document = await this.db.get(this.collection, providerLeagueStateId(sourceId, leagueId, jobType));
    const lastSuccess = asDate(document?.last_success_at);
    if (!document || !lastSuccess) return null;
    return { source_id: sourceId, league_id: leagueId, job_type: jobType, last_success_at: lastSuccess };
  }

  async markSuccess(sourceId: ProviderSourceId, leagueId: string, jobType: ProviderBudgetJob, at: Date): Promise<void> {
    const id = providerLeagueStateId(sourceId, leagueId, jobType);
    const existing = await this.db.get(this.collection, id);
    const values: CloudBaseDocument = {
      _id: id,
      source_id: sourceId,
      league_id: leagueId,
      job_type: jobType,
      last_success_at: at,
      updated_at: at,
      schema_version: SCHEMA_VERSION,
    };
    if (existing) await this.db.update(this.collection, id, values);
    else await this.db.add(this.collection, id, { ...values, created_at: at });
  }
}
