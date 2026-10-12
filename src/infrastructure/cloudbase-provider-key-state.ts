import type { CloudBaseDb, CloudBaseDocument } from "./cloudbase-db.js";
import { cloudBaseCollectionName } from "./cloudbase-db.js";
import type { ProviderKeyState, ProviderKeyStateStore } from "../provider/key-pool.js";

export class CloudBaseProviderKeyStateStore implements ProviderKeyStateStore {
  private readonly collection: string;

  constructor(private readonly db: CloudBaseDb, namespace: string) {
    this.collection = cloudBaseCollectionName(namespace, "provider_key_state");
  }

  async get(keyId: string): Promise<ProviderKeyState | null> {
    const row = await this.db.get(this.collection, stateId(keyId));
    if (row === null) return null;
    return deserialize(row);
  }

  async save(state: ProviderKeyState): Promise<void> {
    const id = stateId(state.key_id);
    const document: CloudBaseDocument = {
      _id: id,
      key_id: state.key_id,
      status: state.status,
      cooldown_until: state.cooldown_until,
      network_errors: state.network_errors,
      last_error_code: state.last_error_code,
      updated_at: state.updated_at,
      schema_version: 1,
    };
    if (await this.db.get(this.collection, id)) await this.db.update(this.collection, id, document);
    else await this.db.add(this.collection, id, document);
  }

  async list(keyIds: readonly string[]): Promise<ProviderKeyState[]> {
    const rows = await Promise.all(keyIds.map((keyId) => this.get(keyId)));
    return rows.filter((row): row is ProviderKeyState => row !== null);
  }
}

function stateId(keyId: string): string {
  return `provider_key_state_${keyId.replace(/[^a-zA-Z0-9]/g, "")}`;
}

function deserialize(row: CloudBaseDocument): ProviderKeyState {
  return {
    key_id: String(row.key_id),
    status: row.status === "invalid" || row.status === "cooldown" ? row.status : "healthy",
    cooldown_until: row.cooldown_until instanceof Date ? row.cooldown_until : null,
    network_errors: typeof row.network_errors === "number" ? row.network_errors : 0,
    last_error_code: typeof row.last_error_code === "string" ? row.last_error_code : null,
    updated_at: row.updated_at instanceof Date ? row.updated_at : new Date(String(row.updated_at)),
  };
}
