import { describe, expect, it, vi } from "vitest";
import { Provider, SyncJobType } from "../domain/enums.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { makeApiFixture } from "../provider/fixture-factory.js";
import { ProviderFixtureSyncJobService } from "./provider-sync-job.js";
import { ProviderLiveMatchService } from "./provider-live-match.js";
import { ProviderNearMatchService } from "./provider-near-match.js";

const now = new Date("2026-08-10T12:00:00.000Z");

describe("window service batch adapters", () => {
  it.each([
    [SyncJobType.NearMatch, ProviderNearMatchService],
    [SyncJobType.LiveMatch, ProviderLiveMatchService],
  ] as const)("%s yields exactly one unchanged fixture batch", async (jobType, Service) => {
    const fixture = makeApiFixture({ fixtureId: 1 });
    const repo = {
      matches: { findActiveWindow: vi.fn(async () => [{ match_id: "match", league_id: "premier_league", season_id: "2026_2027", kickoff_at: now }]), findLive: vi.fn(async () => []) },
      matchProviderMappings: { findByProviderAndExternalId: vi.fn(async () => ({ match_id: "match" })) },
    } as unknown as AppRepository;
    const getFixtures = vi.fn(async () => [fixture]);
    const run = vi.spyOn(ProviderFixtureSyncJobService.prototype, "run").mockImplementation(async (_job, load, loadNow) => {
      const batches = [];
      for await (const batch of load(loadNow)) batches.push(batch);
      expect(batches).toEqual([[{ fixture, payload: { fixture }, seasonId: "2026_2027" }]]);
      return { kind: "completed", job_type: jobType, items_read: 1, items_changed: 0, items_failed: 0 };
    });
    try {
      const outcome = await new Service(repo, { getTeams: vi.fn(async () => []), getFixtures }).run(now);
      expect(outcome).toMatchObject({ kind: "completed", fixtures: { job_type: jobType, items_read: 1 } });
      expect(getFixtures).toHaveBeenCalledTimes(1);
      expect(repo.matchProviderMappings!.findByProviderAndExternalId).toHaveBeenCalledWith(Provider.ApiFootball, "1");
    } finally {
      run.mockRestore();
    }
  });
});
