import { AnomalyStatus, SCHEMA_VERSION, type AnomalyType } from "../domain/enums.js";
import { internalError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import type { Anomaly } from "../domain/types.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";
import { assertValidServerNow } from "./period-finalize.js";

export interface PersistableAnomalyDecision {
  open: boolean;
  blocking: boolean;
  resolve?: {
    resolution: string;
    resolvedAt: Date;
  };
}

export type AnomalyPersistenceResult =
  | { kind: "created" | "updated" | "resolved"; anomaly: Anomaly }
  | { kind: "unchanged"; anomaly: Anomaly | null };

function requireAnomalies(repo: Pick<UnitOfWork, "anomalies">): NonNullable<UnitOfWork["anomalies"]> {
  if (repo.anomalies === undefined) {
    throw internalError("anomalies repository port 未配置");
  }
  return repo.anomalies;
}

/** 将 33.x 的确定性决策写入已有事务；同一 match/type 只维护一条记录。 */
export async function persistAnomalyInTransaction(
  tx: Pick<UnitOfWork, "anomalies">,
  matchId: string,
  type: AnomalyType,
  decision: PersistableAnomalyDecision,
  details: Record<string, unknown>,
  serverNow: Date,
): Promise<AnomalyPersistenceResult> {
  assertValidServerNow(serverNow);
  const anomalyKey = `${matchId}:${type}`;
  const anomalies = requireAnomalies(tx);
  const existing = await anomalies.findByKey(anomalyKey);

  if (decision.open) {
    if (existing === null) {
      const created: Anomaly = {
        schema_version: SCHEMA_VERSION,
        anomaly_id: newUuid(),
        anomaly_key: anomalyKey,
        match_id: matchId,
        type,
        blocking: decision.blocking,
        status: AnomalyStatus.Open,
        first_seen_at: serverNow,
        last_seen_at: serverNow,
        occurrence_count: 1,
        details,
        resolved_at: null,
        resolution: null,
      };
      await anomalies.insert(created);
      return { kind: "created", anomaly: created };
    }

    const updated: Anomaly = {
      ...existing,
      blocking: decision.blocking,
      status: AnomalyStatus.Open,
      last_seen_at: serverNow,
      occurrence_count: existing.occurrence_count + 1,
      details,
      resolved_at: null,
      resolution: null,
    };
    await anomalies.update(updated);
    return { kind: "updated", anomaly: updated };
  }

  if (existing === null || decision.resolve === undefined || existing.status === AnomalyStatus.Resolved) {
    return { kind: "unchanged", anomaly: existing };
  }

  const resolved: Anomaly = {
    ...existing,
    status: AnomalyStatus.Resolved,
    resolved_at: decision.resolve.resolvedAt,
    resolution: decision.resolve.resolution,
  };
  await anomalies.update(resolved);
  return { kind: "resolved", anomaly: resolved };
}

/** 将 33.x 的确定性决策写入 anomalies；同一 match/type 只维护一条记录。 */
export class AnomalyPersistenceService {
  constructor(private readonly repo: AppRepository) {}

  async persist(
    matchId: string,
    type: AnomalyType,
    decision: PersistableAnomalyDecision,
    details: Record<string, unknown>,
    serverNow: Date,
  ): Promise<AnomalyPersistenceResult> {
    assertValidServerNow(serverNow);
    return this.repo.withTransaction((tx) =>
      persistAnomalyInTransaction(tx, matchId, type, decision, details, serverNow),
    );
  }
}
