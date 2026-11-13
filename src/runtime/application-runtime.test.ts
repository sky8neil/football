import { describe, expect, it, vi } from "vitest";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import type { CloudBaseDb } from "../infrastructure/cloudbase-db.js";
import { ProviderSyncDispatcher } from "../application/provider-sync-dispatcher.js";
import { createApplicationRuntime } from "./application-runtime.js";

function fakeDb(): CloudBaseDb {
  const impl: CloudBaseDb = {
    async get() { return null; },
    async add() {},
    async update() {},
    async query() { return []; },
    async count() { return 0; },
    async getCounter() { return 0; },
    async adjustCounter() {},
    async reserveCounter() { return true; },
    async transaction(work) { return work(impl); },
  };
  return impl;
}

describe("createApplicationRuntime", () => {
  it("assembles provider dispatcher, settlement options, and gateway services from injected db/repo", () => {
    const log = vi.fn();
    const repo = new InMemoryRepository();
    const runtime = createApplicationRuntime({
      env: {
        FOOTBALL_ENVIRONMENT: "test",
        FOOTBALL_MATCH_CURSOR_SECRET: "cursor-secret",
      },
      db: fakeDb(),
      namespace: "football_test",
      repo,
      matchCursorSecret: "cursor-secret",
      log,
    });
    expect(runtime.repo).toBe(repo);
    expect(runtime.namespace).toBe("football_test");
    expect(runtime.providerDispatcher).toBeInstanceOf(ProviderSyncDispatcher);
    expect(runtime.periodFinalize).toEqual(expect.objectContaining({ finalize: expect.any(Function) }));
    expect(runtime.dailyConsistency).toEqual(expect.objectContaining({ run: expect.any(Function) }));
    expect(runtime.weeklyLevelEval).toEqual(expect.objectContaining({ run: expect.any(Function) }));
    expect(runtime.boardSnapshot).toEqual(expect.objectContaining({ generate: expect.any(Function) }));
    expect(runtime.schedulerState).toEqual(expect.objectContaining({
      getSettlementFallback: expect.any(Function),
      upsertSettlementFallback: expect.any(Function),
      getPeriodicJobCycle: expect.any(Function),
      upsertPeriodicJobCycle: expect.any(Function),
    }));
    expect(runtime.settlementTimerOptions).toEqual(expect.objectContaining({
      env: expect.objectContaining({ FOOTBALL_ENVIRONMENT: "test" }),
      schedulerState: runtime.schedulerState,
    }));
    expect(runtime.services.session).toEqual(expect.objectContaining({ init: expect.any(Function) }));
    expect(runtime.services.matches).toEqual(expect.objectContaining({
      list: expect.any(Function),
      get: expect.any(Function),
    }));
    expect(runtime.providerSources.sources).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "provider_league_unconfigured",
      diag_code: "DIAG_PROVIDER_LEAGUE_UNCONFIGURED",
    }));
  });
});
