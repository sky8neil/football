import { describe, expect, it, vi } from "vitest";
import { SyncJobType } from "../domain/enums.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import type { ApiFootballFixture } from "../provider/types.js";
import { ProviderNearMatchService } from "./provider-near-match.js";

const NOW = new Date("2026-08-10T12:34:56.000Z");

describe("ProviderNearMatchService", () => {
  it("本地没有 T-24h 到 T-2h 比赛时零 Provider 请求", async () => {
    const repo = new InMemoryRepository();
    const getTeams = vi.fn(async () => []);
    const getFixtures = vi.fn(async () => [] as readonly ApiFootballFixture[]);

    const outcome = await new ProviderNearMatchService(repo, {
      getTeams,
      getFixtures,
    }).run(NOW);

    expect(outcome).toMatchObject({
      teams: { kind: "completed", teams_read: 0, teams_created: 0, teams_unchanged: 0 },
      fixtures: {
        kind: "completed",
        job_type: SyncJobType.NearMatch,
        items_read: 0,
        items_changed: 0,
        items_failed: 0,
      },
    });
    expect(getTeams).not.toHaveBeenCalled();
    expect(getFixtures).not.toHaveBeenCalled();
  });

  it("near_match 锁被占用时跳过整个任务，不调用 Provider client", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const repo = new InMemoryRepository();
      await repo.jobLocks.acquire(
        "sync:near_match",
        "other-owner",
        new Date(NOW.getTime() + 60_000),
      );
      const getTeams = vi.fn(async () => []);
      const getFixtures = vi.fn(async () => [] as readonly ApiFootballFixture[]);

      const outcome = await new ProviderNearMatchService(repo, {
        getTeams,
        getFixtures,
      }).run(NOW);

      expect(outcome).toEqual({
        kind: "skipped",
        fixtures: {
          kind: "skipped",
          job_type: SyncJobType.NearMatch,
          reason: "lock_held",
        },
      });
      expect(getTeams).not.toHaveBeenCalled();
      expect(getFixtures).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
