import { describe, expect, it } from "vitest";
import type { CloudBaseDb, CloudBaseDocument } from "./cloudbase-db.js";
import {
  CloudBaseSchedulerStateStore,
  InMemorySchedulerStateStore,
  STALE_RECOVERY_CURSOR_STATE_ID,
  periodicJobStateId,
} from "./cloudbase-scheduler-state.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const KICKOFF = new Date("2026-08-08T12:00:00.000Z");
const NAMESPACE = "ft-test";

class RecordingCloudBaseDb implements CloudBaseDb {
  readonly calls: Array<{
    op: "get" | "add" | "update";
    collection: string;
    id: string;
  }> = [];
  private readonly documents = new Map<string, CloudBaseDocument>();

  seed(collection: string, id: string, document: CloudBaseDocument): void {
    this.documents.set(`${collection}/${id}`, { ...document, _id: id });
  }

  async get(collection: string, id: string): Promise<CloudBaseDocument | null> {
    this.calls.push({ op: "get", collection, id });
    const row = this.documents.get(`${collection}/${id}`);
    return row === undefined ? null : { ...row };
  }

  async add(collection: string, id: string, document: CloudBaseDocument): Promise<void> {
    this.calls.push({ op: "add", collection, id });
    this.documents.set(`${collection}/${id}`, { ...document, _id: id });
  }

  async update(collection: string, id: string, document: CloudBaseDocument): Promise<void> {
    this.calls.push({ op: "update", collection, id });
    const key = `${collection}/${id}`;
    const existing = this.documents.get(key) ?? { _id: id };
    this.documents.set(key, { ...existing, ...document, _id: id });
  }

  async query(): Promise<CloudBaseDocument[]> {
    return [];
  }

  async count(): Promise<number> {
    return 0;
  }

  async transaction<T>(work: (transactionDb: CloudBaseDb) => Promise<T>): Promise<T> {
    return work(this);
  }
}

describe("CloudBaseSchedulerStateStore", () => {
  it("无记录时 getSettlementFallback 返回 null", async () => {
    const db = new RecordingCloudBaseDb();
    const store = new CloudBaseSchedulerStateStore(db, NAMESPACE);
    await expect(store.getSettlementFallback()).resolves.toBeNull();
  });

  it("upsertSettlementFallback 首次走 add，再次走 update", async () => {
    const db = new RecordingCloudBaseDb();
    const store = new CloudBaseSchedulerStateStore(db, NAMESPACE);
    const state = {
      cursor_kickoff_at: KICKOFF,
      cursor_match_id: "m1",
      last_run_at: NOW,
      updated_at: NOW,
    };

    await store.upsertSettlementFallback(state);
    expect(db.calls.filter((call) => call.op === "add")).toHaveLength(1);
    expect(db.calls.filter((call) => call.op === "update")).toHaveLength(0);

    await store.upsertSettlementFallback({
      ...state,
      cursor_match_id: "m2",
      updated_at: new Date(NOW.getTime() + 1000),
    });
    expect(db.calls.filter((call) => call.op === "add")).toHaveLength(1);
    expect(db.calls.filter((call) => call.op === "update")).toHaveLength(1);
  });

  it("日期字段写入后再读出是 Date（含字符串/数字兜底解析）", async () => {
    const db = new RecordingCloudBaseDb();
    const store = new CloudBaseSchedulerStateStore(db, NAMESPACE);

    await store.upsertSettlementFallback({
      cursor_kickoff_at: KICKOFF,
      cursor_match_id: "m1",
      last_run_at: NOW,
      updated_at: NOW,
    });
    const fromDates = await store.getSettlementFallback();
    expect(fromDates?.cursor_kickoff_at).toBeInstanceOf(Date);
    expect(fromDates?.last_run_at).toBeInstanceOf(Date);
    expect(fromDates?.updated_at).toBeInstanceOf(Date);
    expect(fromDates?.cursor_kickoff_at?.getTime()).toBe(KICKOFF.getTime());

    const collection = db.calls[0]!.collection;
    db.seed(collection, "settlement_fallback", {
      _id: "settlement_fallback",
      cursor_kickoff_at: KICKOFF.toISOString(),
      cursor_match_id: "m9",
      last_run_at: NOW.getTime(),
      updated_at: NOW.toISOString(),
    });
    const parsed = await store.getSettlementFallback();
    expect(parsed?.cursor_kickoff_at).toBeInstanceOf(Date);
    expect(parsed?.last_run_at).toBeInstanceOf(Date);
    expect(parsed?.updated_at).toBeInstanceOf(Date);
    expect(parsed?.cursor_kickoff_at?.getTime()).toBe(KICKOFF.getTime());
    expect(parsed?.last_run_at?.getTime()).toBe(NOW.getTime());
    expect(parsed?.cursor_match_id).toBe("m9");
  });

  it("persists periodic job cycle by job_type id, isolated from settlement_fallback", async () => {
    const db = new RecordingCloudBaseDb();
    const store = new CloudBaseSchedulerStateStore(db, NAMESPACE);
    await store.upsertSettlementFallback({
      cursor_kickoff_at: KICKOFF,
      cursor_match_id: "m1",
      last_run_at: NOW,
      updated_at: NOW,
    });
    await store.upsertPeriodicJobCycle({
      job_type: "period_finalize",
      completed_cycle_at: NOW,
      updated_at: NOW,
    });
    const cycle = await store.getPeriodicJobCycle("period_finalize");
    expect(cycle).toEqual({
      job_type: "period_finalize",
      completed_cycle_at: NOW,
      updated_at: NOW,
    });
    expect(await store.getSettlementFallback()).toEqual(expect.objectContaining({
      cursor_match_id: "m1",
    }));
    expect(db.calls.some((call) => call.id === periodicJobStateId("period_finalize"))).toBe(true);
    expect(db.calls.some((call) => call.id === "settlement_fallback")).toBe(true);
  });

  it("accepts weekly_level_eval as a periodic scheduler_state job_type", async () => {
    const db = new RecordingCloudBaseDb();
    const store = new CloudBaseSchedulerStateStore(db, NAMESPACE);
    await store.upsertPeriodicJobCycle({
      job_type: "weekly_level_eval",
      completed_cycle_at: NOW,
      updated_at: NOW,
    });
    await expect(store.getPeriodicJobCycle("weekly_level_eval")).resolves.toEqual({
      job_type: "weekly_level_eval",
      completed_cycle_at: NOW,
      updated_at: NOW,
    });
    expect(periodicJobStateId("weekly_level_eval")).toBe("weekly_level_eval");
  });

  it("accepts career/strength/season snapshot job types as periodic scheduler_state job_types", async () => {
    const db = new RecordingCloudBaseDb();
    const store = new CloudBaseSchedulerStateStore(db, NAMESPACE);
    for (const jobType of [
      "level_correction_reeval",
      "board_snapshot_career",
      "board_snapshot_strength",
      "board_snapshot_season",
      "board_snapshot_season_final",
      "maintenance_cleanup",
    ]) {
      await store.upsertPeriodicJobCycle({
        job_type: jobType,
        completed_cycle_at: NOW,
        updated_at: NOW,
      });
      await expect(store.getPeriodicJobCycle(jobType)).resolves.toEqual({
        job_type: jobType,
        completed_cycle_at: NOW,
        updated_at: NOW,
      });
      expect(periodicJobStateId(jobType)).toBe(jobType);
    }
  });

  it("[CR42-08] 读写 stale_recovery_cursor（CloudBase 与 InMemory）互不干扰", async () => {
    const db = new RecordingCloudBaseDb();
    const cloud = new CloudBaseSchedulerStateStore(db, NAMESPACE);
    expect(await cloud.getStaleRecoveryCursor()).toBeNull();

    await cloud.upsertStaleRecoveryCursor({
      cursor_kickoff_at: KICKOFF,
      cursor_match_id: "m-10",
      last_run_at: NOW,
      updated_at: NOW,
    });
    expect(await cloud.getStaleRecoveryCursor()).toEqual({
      cursor_kickoff_at: KICKOFF,
      cursor_match_id: "m-10",
      last_run_at: NOW,
      updated_at: NOW,
    });
    expect(db.calls.some((call) => call.id === STALE_RECOVERY_CURSOR_STATE_ID)).toBe(true);

    const memory = new InMemorySchedulerStateStore();
    expect(await memory.getStaleRecoveryCursor()).toBeNull();
    await memory.upsertStaleRecoveryCursor({
      cursor_kickoff_at: null,
      cursor_match_id: null,
      last_run_at: NOW,
      updated_at: NOW,
    });
    expect(await memory.getStaleRecoveryCursor()).toEqual({
      cursor_kickoff_at: null,
      cursor_match_id: null,
      last_run_at: NOW,
      updated_at: NOW,
    });
  });

  it("[CR44-01] stale_recovery_cursor 支持持久化与清空 group_progress（CloudBase 与 InMemory）", async () => {
    const db = new RecordingCloudBaseDb();
    const cloud = new CloudBaseSchedulerStateStore(db, NAMESPACE);
    const memory = new InMemorySchedulerStateStore();

    for (const store of [cloud, memory]) {
      await store.upsertStaleRecoveryCursor({
        cursor_kickoff_at: KICKOFF,
        cursor_match_id: "m-1",
        group_progress: {
          group_key: "premier_league|2026_2027|2026-09-01",
          completed_primary_dates: ["2026-09-01"],
        },
        last_run_at: NOW,
        updated_at: NOW,
      });
      expect(await store.getStaleRecoveryCursor()).toEqual({
        cursor_kickoff_at: KICKOFF,
        cursor_match_id: "m-1",
        group_progress: {
          group_key: "premier_league|2026_2027|2026-09-01",
          completed_primary_dates: ["2026-09-01"],
        },
        last_run_at: NOW,
        updated_at: NOW,
      });

      await store.upsertStaleRecoveryCursor({
        cursor_kickoff_at: null,
        cursor_match_id: null,
        last_run_at: NOW,
        updated_at: NOW,
      });
      expect(await store.getStaleRecoveryCursor()).toEqual({
        cursor_kickoff_at: null,
        cursor_match_id: null,
        last_run_at: NOW,
        updated_at: NOW,
      });
    }
  });
});
