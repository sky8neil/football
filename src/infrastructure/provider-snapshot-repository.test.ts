import { describe, expect, it } from "vitest";
import { Provider } from "../domain/enums.js";
import type { ProviderSnapshot } from "../domain/types.js";
import { newUuid } from "../domain/ids.js";
import { InMemoryRepository, UniqueConstraintError } from "./repositories.js";

const MATCH_ID = newUuid();
const NOW = new Date("2026-08-09T00:00:00.000Z");

function makeSnapshot(overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return {
    schema_version: 1,
    snapshot_id: newUuid(),
    provider: Provider.ApiFootball,
    entity_type: "match",
    entity_id: MATCH_ID,
    provider_entity_id: "123",
    event_type: "status_changed",
    payload: { status: "FT" },
    created_at: NOW,
    ...overrides,
  };
}

describe("InMemoryRepository - provider_snapshots", () => {
  it("按实体读取 append-only 快照并按创建时间倒序返回", async () => {
    const repo = new InMemoryRepository();
    const first = makeSnapshot({
      created_at: new Date("2026-08-09T00:00:00.000Z"),
    });
    const second = makeSnapshot({
      created_at: new Date("2026-08-09T00:01:00.000Z"),
    });
    await repo.providerSnapshots.insert(first);
    await repo.providerSnapshots.insert(second);

    await expect(repo.providerSnapshots.findByEntity("match", MATCH_ID)).resolves.toEqual([
      second,
      first,
    ]);
    expect("update" in repo.providerSnapshots).toBe(false);
  });

  it("snapshot_id 唯一冲突并参与事务回滚", async () => {
    const repo = new InMemoryRepository();
    const snapshot = makeSnapshot();
    await repo.providerSnapshots.insert(snapshot);

    await expect(repo.providerSnapshots.insert({ ...snapshot, payload: { retry: true } })).rejects.toEqual(
      expect.objectContaining<Partial<UniqueConstraintError>>({
        collection: "provider_snapshots",
        indexName: "pk_snapshot",
      }),
    );

    const transient = makeSnapshot();
    await expect(
      repo.withTransaction(async (tx) => {
        await tx.providerSnapshots?.insert(transient);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await expect(repo.providerSnapshots.findByEntity("match", MATCH_ID)).resolves.toEqual([
      snapshot,
    ]);
  });
});
