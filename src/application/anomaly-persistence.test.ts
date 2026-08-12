import { describe, expect, it } from "vitest";
import { AnomalyStatus, AnomalyType } from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { AnomalyPersistenceService } from "./anomaly-persistence.js";

const MATCH_ID = newUuid();
const FIRST_SEEN = new Date("2026-08-09T00:00:00.000Z");
const SECOND_SEEN = new Date("2026-08-09T00:10:00.000Z");

function anomalyOf(result: Awaited<ReturnType<AnomalyPersistenceService["persist"]>>) {
  if (result.anomaly === null) {
    throw new Error("expected persisted anomaly");
  }
  return result.anomaly;
}

describe("AnomalyPersistenceService", () => {
  it("按 match_id:type 创建 anomaly，并重复 open 时更新同一记录", async () => {
    const repo = new InMemoryRepository();
    const service = new AnomalyPersistenceService(repo);

    const first = await service.persist(
      MATCH_ID,
      AnomalyType.LiveSyncStale,
      { open: true, blocking: false },
      { last_successful_sync_at: null },
      FIRST_SEEN,
    );
    const second = await service.persist(
      MATCH_ID,
      AnomalyType.LiveSyncStale,
      { open: true, blocking: false },
      { last_successful_sync_at: "2026-08-09T00:00:01.000Z" },
      SECOND_SEEN,
    );

    expect(first.kind).toBe("created");
    expect(second.kind).toBe("updated");
    expect(anomalyOf(second).anomaly_id).toBe(anomalyOf(first).anomaly_id);
    expect(anomalyOf(second)).toMatchObject({
      anomaly_key: `${MATCH_ID}:${AnomalyType.LiveSyncStale}`,
      match_id: MATCH_ID,
      type: AnomalyType.LiveSyncStale,
      blocking: false,
      status: AnomalyStatus.Open,
      first_seen_at: FIRST_SEEN,
      last_seen_at: SECOND_SEEN,
      occurrence_count: 2,
      details: { last_successful_sync_at: "2026-08-09T00:00:01.000Z" },
      resolved_at: null,
      resolution: null,
    });
  });

  it("仅按确定性 resolve 规则关闭已有 anomaly，恢复后再次 open 可重开", async () => {
    const repo = new InMemoryRepository();
    const service = new AnomalyPersistenceService(repo);

    const opened = await service.persist(
      MATCH_ID,
      AnomalyType.LiveSyncStale,
      { open: true, blocking: false },
      { source: "provider" },
      FIRST_SEEN,
    );
    const resolved = await service.persist(
      MATCH_ID,
      AnomalyType.LiveSyncStale,
      {
        open: false,
        blocking: false,
        resolve: { resolution: "sync recovered", resolvedAt: SECOND_SEEN },
      },
      { source: "provider" },
      SECOND_SEEN,
    );

    expect(resolved.kind).toBe("resolved");
    expect(anomalyOf(resolved)).toMatchObject({
      anomaly_id: anomalyOf(opened).anomaly_id,
      status: AnomalyStatus.Resolved,
      occurrence_count: 1,
      first_seen_at: FIRST_SEEN,
      last_seen_at: FIRST_SEEN,
      resolved_at: SECOND_SEEN,
      resolution: "sync recovered",
    });

    const reopened = await service.persist(
      MATCH_ID,
      AnomalyType.LiveSyncStale,
      { open: true, blocking: false },
      { source: "provider", retry: 2 },
      new Date("2026-08-09T00:20:00.000Z"),
    );
    expect(reopened.kind).toBe("updated");
    expect(anomalyOf(reopened)).toMatchObject({
      anomaly_id: anomalyOf(opened).anomaly_id,
      status: AnomalyStatus.Open,
      occurrence_count: 2,
      resolved_at: null,
      resolution: null,
      details: { source: "provider", retry: 2 },
    });
  });

  it("没有既有记录时不会凭空创建 resolved anomaly", async () => {
    const repo = new InMemoryRepository();
    const service = new AnomalyPersistenceService(repo);

    const result = await service.persist(
      MATCH_ID,
      AnomalyType.LiveSyncStale,
      {
        open: false,
        blocking: false,
        resolve: { resolution: "not applicable", resolvedAt: FIRST_SEEN },
      },
      {},
      FIRST_SEEN,
    );

    expect(result).toEqual({ kind: "unchanged", anomaly: null });
    expect(
      await repo.anomalies.findByKey(`${MATCH_ID}:${AnomalyType.LiveSyncStale}`),
    ).toBeNull();
  });

  it("无效 server_now 时在 anomaly 读写前 Fail Closed", async () => {
    const repo = new InMemoryRepository();
    const service = new AnomalyPersistenceService(repo);

    await expect(
      service.persist(
        MATCH_ID,
        AnomalyType.LiveSyncStale,
        { open: true, blocking: false },
        { source: "provider" },
        new Date("invalid"),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "server_now" },
    });

    await expect(
      repo.anomalies.findByKey(`${MATCH_ID}:${AnomalyType.LiveSyncStale}`),
    ).resolves.toBeNull();
  });
});
